import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { spawn } from 'node:child_process';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { readFile } from 'node:fs/promises';

import { z } from 'zod/mini';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { ErrorCode, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import { withHostProcessOwnerEnvironment } from '@/processes/ownerTag';
import { classifySpawnFailure } from '@/processes/spawnFailure/classifySpawnFailure';
import type { StdioMcpServerStartupFailure } from './stdioMcpServerStartupFailure';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';


const StdioMcpServerLauncherConfigSchema = lazyZodSchema(() => z.object({
  command: z.string().check(z.minLength(1)),
  args: z._default(z.optional(z.array(z.string())), []),
  env: z._default(z.optional(z.record(z.string(), z.string())), {}),
  cwd: z.optional(z.string().check(z.minLength(1))),
}));

type StdioMcpServerLauncherConfig = z.infer<typeof StdioMcpServerLauncherConfigSchema>;

function writeStderr(line: string): void {
  try {
    process.stderr.write(line.endsWith('\n') ? line : `${line}\n`);
  } catch {
    // ignore
  }
}

async function readLauncherConfig(configPath: string): Promise<StdioMcpServerLauncherConfig> {
  const raw = await readFile(configPath, 'utf8');
  return StdioMcpServerLauncherConfigSchema.parse(JSON.parse(raw));
}

export async function runStdioMcpServerLauncher(): Promise<void> {
  const configPath = typeof process.env.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE === 'string'
    ? process.env.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE
    : '';
  if (!configPath) {
    writeStderr('[happier-mcp-stdio-launcher] Missing HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE');
    process.exit(2);
  }

  let config: StdioMcpServerLauncherConfig;
  try {
    config = await readLauncherConfig(configPath);
  } catch (err) {
    writeStderr(`[happier-mcp-stdio-launcher] Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const env = withHostProcessOwnerEnvironment(buildScopedProcessEnv({ baseEnv: process.env, explicitEnv: config.env }));
  const invocation = process.platform === 'win32'
    ? resolveWindowsCommandInvocation({ command: config.command, args: config.args, env })
    : { command: config.command, args: config.args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: config.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    ...('windowsVerbatimArguments' in invocation ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}),
  });
  observeProcessLaunch(child);

  let startupFailure: StdioMcpServerStartupFailure | undefined;
  let childStarted = false;
  let initializeId: RequestId | undefined;
  let failureReported = false;
  const initialization = new ReadBuffer();
  const reportStartupFailure = () => {
    if (!startupFailure || initializeId === undefined || failureReported) return;
    failureReported = true;
    process.stdout.write(serializeMessage({ jsonrpc: '2.0', id: initializeId,
      error: { code: ErrorCode.InternalError, message: 'MCP child process could not be started', data: startupFailure } }),
    () => process.exit(1));
  };
  const observeInitialization = (chunk: Buffer) => {
    initialization.append(chunk);
    try {
      for (;;) {
        const message = initialization.readMessage();
        if (message === null) break;
        if ('method' in message && message.method === 'initialize' && 'id' in message) {
          initializeId = message.id;
          process.stdin.off('data', observeInitialization);
          initialization.clear();
          reportStartupFailure();
          return;
        }
      }
    } catch {
      // A failed child cannot serve malformed MCP input; stdin end/close still owns exit.
    }
  };
  process.stdin.on('data', observeInitialization);
  child.once('spawn', () => {
    childStarted = true;
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (startupFailure) process.exit(1);
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  const forwardSigint = () => forwardSignal('SIGINT');
  const forwardSigterm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', forwardSigint);
  process.on('SIGTERM', forwardSigterm);

  child.on('error', (err) => {
    writeStderr(`[happier-mcp-stdio-launcher] Failed to start child: ${err instanceof Error ? err.message : String(err)}`);
    if (childStarted) return;
    const code = classifySpawnFailure(err, { syscall: 'spawn' }).errno;
    const path = 'path' in err && typeof err.path === 'string' ? err.path : undefined;
    startupFailure = { t: 'happier-mcp-stdio-spawn-failure-v1',
      ...(code === undefined ? {} : { code }), ...(path === undefined ? {} : { path }) };
    reportStartupFailure();
    if (process.stdin.readableEnded && !failureReported) process.exit(1);
  });

  child.stdin.on('error', (err) => {
    // Pipe writes fail asynchronously when the child closes stdin. Preserve a
    // prior spawn diagnosis (e.g. ENOENT) and use the same typed MCP failure.
    const code = classifySpawnFailure(err).errno;
    startupFailure ??= { t: 'happier-mcp-stdio-spawn-failure-v1',
      ...(code === undefined ? {} : { code }), path: config.command };
    reportStartupFailure();
    child.kill();
    if (process.stdin.readableEnded && !failureReported) process.exit(1);
  });

  process.stdin.on('data', (chunk) => {
    if (!startupFailure) child.stdin.write(chunk);
  });
  process.stdin.on('end', () => {
    if (startupFailure && !failureReported) process.exit(1);
    child.stdin.end();
  });
  process.stdin.on('error', () => {
    if (startupFailure && !failureReported) process.exit(1);
    child.stdin.destroy();
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  await new Promise<never>((_resolve, _reject) => {
    child.on('close', (code, signal) => {
      if (startupFailure) return;
      if (signal) {
        // Re-emitting the child's signal must retain native exit semantics,
        // not re-enter this launcher's forwarding handlers on a dead child.
        process.off('SIGINT', forwardSigint);
        process.off('SIGTERM', forwardSigterm);
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(1);
        }
        return;
      }
      process.exit(code ?? 0);
    });
  });
}

runStdioMcpServerLauncher().catch((err) => {
  writeStderr(`[happier-mcp-stdio-launcher] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
