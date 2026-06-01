import { withSessionMeta } from "./session-meta.js";
import { Guards, type CommandabilityGuard } from "./guards.js";
import type { Transport } from "./wire/transport.js";
import * as M from "./wire/methods.js";

export type TabDevLogLevel = "debug" | "log" | "info" | "warn" | "error";

export type TabDevLogEntry = {
  level: TabDevLogLevel;
  text: string;
  args: unknown[];
  timestamp: number;
};

export type TabDevLogsOptions = {
  /** Maximum recent entries to return. Defaults to 100. */
  maxEntries?: number;
  /** Clear the page buffer after reading. Defaults to false. */
  clear?: boolean;
  timeout?: number;
};

type RuntimeEvaluateResponse = {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

export class TabDev {
  private readonly guards: Guards;
  private readonly tabId: string;

  constructor(
    private readonly transport: Transport,
    guardsOrTabId: Guards | string,
    tabId?: string,
    private readonly ensureCommandable?: CommandabilityGuard,
  ) {
    this.guards = guardsOrTabId instanceof Guards ? guardsOrTabId : new Guards();
    this.tabId = guardsOrTabId instanceof Guards ? (tabId ?? "") : guardsOrTabId;
  }

  async cdp<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeout?: number } = {},
  ): Promise<T> {
    this.ensureCommandable?.(M.EXECUTE_CDP);
    const command = {
      command: M.EXECUTE_CDP,
      tab_id: this.tabId,
      target: { tabId: this.tabId },
      method,
      commandParams: params,
    };
    const currentUrl = this.guards.needsCurrentUrl(M.EXECUTE_CDP)
      ? await this.transport.sendRequest<string>(M.TAB_URL, withSessionMeta({ tab_id: this.tabId }), opts.timeout)
      : undefined;
    await this.guards.ensureCommandAllowed(command, { currentUrl });
    return await this.transport.sendRequest<T>(
      M.EXECUTE_CDP,
      withSessionMeta({
        tab_id: this.tabId,
        target: { tabId: this.tabId },
        method,
        commandParams: params,
      }),
      opts.timeout,
    );
  }

  async logs(opts: TabDevLogsOptions = {}): Promise<TabDevLogEntry[]> {
    const maxEntries = positiveInt(opts.maxEntries, 100);
    const clearAfterRead = opts.clear === true;
    const cdpOpts: { timeout?: number } = {};
    if (opts.timeout !== undefined) cdpOpts.timeout = opts.timeout;
    const response = await this.cdp<RuntimeEvaluateResponse>(
      "Runtime.evaluate",
      {
        expression: consoleLogBufferExpression(maxEntries, clearAfterRead),
        awaitPromise: true,
        returnByValue: true,
      },
      cdpOpts,
    );
    if (response?.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          ?? response.exceptionDetails.text
          ?? "tab.dev.logs failed",
      );
    }
    return normalizeLogEntries(response?.result?.value);
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeLogEntries(value: unknown): TabDevLogEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: TabDevLogEntry[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (!isLogLevel(record.level) || typeof record.text !== "string") continue;
    rows.push({
      level: record.level,
      text: record.text,
      args: Array.isArray(record.args) ? record.args : [],
      timestamp: typeof record.timestamp === "number" ? record.timestamp : 0,
    });
  }
  return rows;
}

function isLogLevel(value: unknown): value is TabDevLogLevel {
  return value === "debug" || value === "log" || value === "info" || value === "warn" || value === "error";
}

export function consoleLogBufferExpression(maxEntries: number, clearAfterRead: boolean): string {
  return `
(() => {
  const maxEntries = ${maxEntries};
  const clearAfterRead = ${clearAfterRead};
  const key = "__obuConsoleLogBuffer";
  const levels = ["debug", "log", "info", "warn", "error"];
  const maxTextChars = 2000;
  const maxArgStringChars = 1000;
  const maxObjectEntries = 25;
  const maxDepth = 3;
  const truncateString = (value, limit) => {
    const s = String(value);
    if (s.length <= limit) return s;
    return s.slice(0, limit) + "...[truncated " + (s.length - limit) + " chars]";
  };
  const snapshotValue = (value, depth = 0, seen = new WeakSet()) => {
    if (value === undefined) return { type: "undefined" };
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return truncateString(value, maxArgStringChars);
    if (typeof value === "bigint") return truncateString(String(value) + "n", maxArgStringChars);
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) {
      return {
        name: truncateString(value.name || "Error", 120),
        message: truncateString(value.message || "", maxArgStringChars),
        stack: value.stack ? truncateString(value.stack, maxArgStringChars) : undefined,
      };
    }
    if (typeof value !== "object") return truncateString(String(value), maxArgStringChars);
    if (seen.has(value)) return "[Circular]";
    if (depth >= maxDepth) return Array.isArray(value) ? "[Array]" : "[Object]";
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        const out = value.slice(0, maxObjectEntries).map((item) => snapshotValue(item, depth + 1, seen));
        if (value.length > maxObjectEntries) out.push({ __truncatedItems: value.length - maxObjectEntries });
        return out;
      }
      const out = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, maxObjectEntries)) {
        try {
          out[key] = snapshotValue(value[key], depth + 1, seen);
        } catch (error) {
          out[key] = "[Unserializable: " + (error && error.message ? error.message : String(error)) + "]";
        }
      }
      if (keys.length > maxObjectEntries) out.__truncatedKeys = keys.length - maxObjectEntries;
      return out;
    } finally {
      seen.delete(value);
    }
  };
  const textOf = (value) => {
    if (typeof value === "string") return truncateString(value, maxArgStringChars);
    if (value instanceof Error) return truncateString(value.stack || value.message || String(value), maxArgStringChars);
    try {
      const json = JSON.stringify(snapshotValue(value));
      if (json !== undefined) return truncateString(json, maxArgStringChars);
    } catch {}
    try {
      return truncateString(String(value), maxArgStringChars);
    } catch {
      return "[unprintable]";
    }
  };
  const root = globalThis;
  if (!root[key]) {
    const entries = [];
    const original = {};
    const push = (level, args) => {
      const argList = Array.from(args);
      entries.push({
        level,
        text: truncateString(argList.map(textOf).join(" "), maxTextChars),
        args: argList.map((value) => snapshotValue(value)),
        timestamp: Date.now(),
      });
      if (entries.length > 500) entries.splice(0, entries.length - 500);
    };
    for (const level of levels) {
      const current = console && console[level];
      if (typeof current !== "function") continue;
      original[level] = current.bind(console);
      console[level] = (...args) => {
        try {
          push(level, args);
        } catch {}
        return original[level](...args);
      };
    }
    Object.defineProperty(root, key, {
      value: { entries, original },
      configurable: false,
    });
  }
  const entries = Array.isArray(root[key].entries) ? root[key].entries : [];
  const rows = entries.slice(Math.max(0, entries.length - maxEntries));
  if (clearAfterRead) entries.splice(0, entries.length);
  return rows;
})()
`;
}
