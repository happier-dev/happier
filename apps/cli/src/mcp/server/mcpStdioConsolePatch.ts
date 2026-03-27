import util from 'node:util';

type PatchedConsoleState = Readonly<{
  log: typeof console.log;
  info: typeof console.info;
  debug: typeof console.debug;
  warn: typeof console.warn;
  error: typeof console.error;
}>;

let patched: PatchedConsoleState | null = null;

function writeStderrLine(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Ignore writes when stderr is closed (stdio MCP callers may terminate pipes).
  }
}

function createStderrConsoleWriter(): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    writeStderrLine(util.format(...args));
  };
}

export function enableMcpStdioConsolePatch(): void {
  if (patched) return;

  patched = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };

  const writer = createStderrConsoleWriter();

  console.log = writer;
  console.info = writer;
  console.debug = writer;
  console.warn = writer;
  console.error = writer;
}

export function disableMcpStdioConsolePatch(): void {
  if (!patched) return;

  console.log = patched.log;
  console.info = patched.info;
  console.debug = patched.debug;
  console.warn = patched.warn;
  console.error = patched.error;

  patched = null;
}
