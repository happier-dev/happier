import { Console } from 'node:console';
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { addAbortSignal } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { isShellBridgeAgentMarkerV1 } from '@/cli/actions/shellBridgeActionSurface';

export type ScriptToolOperation = 'search' | 'describe' | 'call';
export type ScriptToolResult =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; errorCode: string; error: string; failureCause?: ActionFailureCauseV1 }>;

export type ScriptToolConnection = Readonly<{
  execute: (operation: ScriptToolOperation, input: Record<string, unknown>, signal: AbortSignal) => Promise<ScriptToolResult>;
  close: () => void | Promise<void>;
}>;

class ScriptToolRefusal extends Error {
  readonly code: string;
  readonly failureCause?: ActionFailureCauseV1;
  constructor(result: Extract<ScriptToolResult, { ok: false }>) {
    super(result.error);
    this.code = result.errorCode;
    this.failureCause = result.failureCause;
  }
}

function actionProxy(invoke: (id: string, args: unknown) => Promise<unknown>, path: readonly string[] = []): unknown {
  return new Proxy((args: unknown = {}) => invoke(path.join('.'), args), {
    get: (_target, key) => typeof key === 'string' && key !== 'then' ? actionProxy(invoke, [...path, key]) : undefined,
  });
}

function mcpProxy(invoke: (source: string, tool: string, args: unknown) => Promise<unknown>): unknown {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get: (_target, source) => typeof source === 'string' && source !== 'then'
      ? new Proxy(Object.create(null) as Record<string, unknown>, {
        get: (_server, tool) => typeof tool === 'string' && tool !== 'then'
          ? (args: unknown = {}) => invoke(source, tool, args) : undefined,
      }) : undefined,
  });
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...parameters: unknown[]) => Promise<unknown>;

/** Runs only inside the explicit CLI invocation. The Session host handles tool admission over MCP. */
export async function runToolsScript(params: Readonly<{
  argv: readonly string[];
  connect: (signal: AbortSignal) => Promise<ScriptToolConnection>;
  signal?: AbortSignal;
}>): Promise<void> {
  const lifetime = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, lifetime.signal]) : lifetime.signal;
  const cancel = () => lifetime.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const scriptConsole = new Console({ stdout: process.stderr, stderr: process.stderr });
  const calls: Array<{ operation: ScriptToolOperation; source?: string; tool?: string; ok?: boolean; errorCode?: string }> = [];
  let connection: ScriptToolConnection | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: params.argv.filter(arg => !isShellBridgeAgentMarkerV1(arg)), allowPositionals: true,
      options: {
        code: { type: 'string' }, raw: { type: 'boolean' }, json: { type: 'boolean' },
        'session-id': { type: 'string' }, directory: { type: 'string' },
      },
    });
    if (positionals.length !== (values.code === undefined ? 1 : 0)) {
      throw new ScriptToolRefusal({ ok: false, errorCode: 'invalid_arguments', error: 'Pass a file, - for stdin, or --code.' });
    }
    signal.throwIfAborted();
    connection = await params.connect(signal);
    const connected = connection;
    const code = values.code ?? (positionals[0] === '-' ? await text(addAbortSignal(signal, process.stdin))
      : await readFile(positionals[0]!, { encoding: 'utf8', signal }));
    signal.throwIfAborted();
    const execute = async (operation: ScriptToolOperation, input: Record<string, unknown>) => {
      signal.throwIfAborted();
      const call: (typeof calls)[number] = { operation,
        ...(typeof input.source === 'string' ? { source: input.source } : {}),
        ...(typeof input.tool === 'string' ? { tool: input.tool } : {}),
      };
      calls.push(call);
      const result = await connected.execute(operation, input, signal);
      call.ok = result.ok;
      if (result.ok) return result.result;
      call.errorCode = result.errorCode;
      throw new ScriptToolRefusal(result);
    };
    const tools = {
      search: (input: Record<string, unknown> = {}) => execute('search', input),
      describe: (input: Record<string, unknown>) => execute('describe', input),
      call: (input: Record<string, unknown>) => execute('call', input),
    };
    const happier = actionProxy((tool, args) => tools.call({ source: 'happier', tool, args }));
    const mcp = mcpProxy((source, tool, args) => tools.call({ source, tool, args }));
    const run = new AsyncFunction('tools', 'happier', 'mcp', 'console', 'signal', `"use strict";\n${code}`);
    const result = await run(tools, happier, mcp, scriptConsole, signal);
    signal.throwIfAborted();
    await writeJsonStdout(values.raw ? result ?? null : { ok: true, result: result ?? null, calls });
  } catch (error) {
    const code = error instanceof ScriptToolRefusal ? error.code : signal.aborted ? 'cancelled' : 'script_failed';
    process.exitCode = Math.max(process.exitCode ?? 0, 1);
    await writeJsonStdout({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error),
      ...(error instanceof ScriptToolRefusal && error.failureCause ? { failureCause: error.failureCause } : {}),
    }, calls });
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try { await connection?.close(); }
    catch { scriptConsole.error('Unable to close the tool connection.'); }
  }
}

export function refuseToolsScript(errorCode: string, error: string, failureCause?: ActionFailureCauseV1): never {
  throw new ScriptToolRefusal({ ok: false, errorCode, error, failureCause });
}
