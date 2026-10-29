import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';
import { lazySchema } from '@happier-dev/protocol';

import { type CommandInvocation, resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

const StdioMcpServerLauncherConfigSchema = lazySchema(() => z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional().default({}),
  cwd: z.string().min(1).optional(),
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

  const env = { ...process.env, ...config.env };
  const invocation: CommandInvocation = process.platform === 'win32'
    ? resolveWindowsCommandInvocation({ command: config.command, args: config.args, env })
    : { command: config.command, args: config.args };
  const child = spawn(invocation.command, invocation.args, {
    cwd: config.cwd,
    env,
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => forwardSignal(signal));
  }

  child.on('error', (err) => {
    writeStderr(`[happier-mcp-stdio-launcher] Failed to start child: ${err instanceof Error ? err.message : String(err)}`);
  });

  process.stdin.on('data', (chunk) => {
    child.stdin.write(chunk);
  });
  process.stdin.on('end', () => {
    child.stdin.end();
  });
  process.stdin.on('error', () => {
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
      if (signal) {
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

if (process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE !== '1') {
  runStdioMcpServerLauncher().catch((err) => {
    writeStderr(`[happier-mcp-stdio-launcher] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
