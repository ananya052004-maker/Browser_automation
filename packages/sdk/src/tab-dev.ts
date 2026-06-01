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

function consoleLogBufferExpression(maxEntries: number, clearAfterRead: boolean): string {
  return `
(() => {
  const maxEntries = ${maxEntries};
  const clearAfterRead = ${clearAfterRead};
  const key = "__obuConsoleLogBuffer";
  const levels = ["debug", "log", "info", "warn", "error"];
  const textOf = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {}
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  };
  const safeValue = (value) => {
    if (value === undefined) return { type: "undefined" };
    if (typeof value === "bigint") return String(value) + "n";
    if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return textOf(value);
    }
  };
  const root = globalThis;
  if (!root[key]) {
    const entries = [];
    const original = {};
    const push = (level, args) => {
      entries.push({
        level,
        text: Array.from(args).map(textOf).join(" "),
        args: Array.from(args).map(safeValue),
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
