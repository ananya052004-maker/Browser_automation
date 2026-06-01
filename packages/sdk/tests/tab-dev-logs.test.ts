import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { consoleLogBufferExpression } from "../src/tab-dev.js";

function makeContext(): vm.Context {
  return vm.createContext({
    console: {
      debug: () => undefined,
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  });
}

function readLogs(context: vm.Context, maxEntries = 100, clear = false) {
  return vm.runInContext(consoleLogBufferExpression(maxEntries, clear), context) as Array<{
    level: string;
    text: string;
    args: unknown[];
    timestamp: number;
  }>;
}

describe("consoleLogBufferExpression", () => {
  it("installs, reads, and clears the page console buffer", () => {
    const context = makeContext();

    expect(readLogs(context)).toEqual([]);
    vm.runInContext("console.log('hello', { value: 42 }); console.warn('careful');", context);

    expect(readLogs(context, 10, true).map((entry) => ({ level: entry.level, text: entry.text, args: entry.args }))).toEqual([
      { level: "log", text: "hello {\"value\":42}", args: ["hello", { value: 42 }] },
      { level: "warn", text: "careful", args: ["careful"] },
    ]);
    expect(readLogs(context)).toEqual([]);
  });

  it("snapshots object arguments at log time", () => {
    const context = makeContext();

    readLogs(context);
    vm.runInContext("const payload = { value: 1 }; console.log(payload); payload.value = 2;", context);

    expect(readLogs(context)[0]?.args[0]).toEqual({ value: 1 });
  });

  it("bounds text and argument payloads", () => {
    const context = makeContext();

    readLogs(context);
    vm.runInContext("console.log('x'.repeat(5000), { huge: 'y'.repeat(5000) });", context);
    const entry = readLogs(context)[0]!;

    expect(entry.text.length).toBeLessThanOrEqual(2200);
    expect(String(entry.args[0]).length).toBeLessThanOrEqual(1100);
    expect((entry.args[1] as { huge: string }).huge.length).toBeLessThanOrEqual(1100);
  });
});
