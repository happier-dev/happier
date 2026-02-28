import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { logger } from '@/ui/logger';

function readPositiveIntEnv(name: string): number | null {
  const raw = typeof process.env[name] === 'string' ? process.env[name]!.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;
  if (n <= 0) return null;
  return n;
}

async function resolveEphemeralPort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve ephemeral port')));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function resolveOpenCodeCommand(): string {
  const override = typeof process.env.HAPPIER_OPENCODE_PATH === 'string' ? process.env.HAPPIER_OPENCODE_PATH.trim() : '';
  return override || 'opencode';
}

export async function startManagedOpenCodeServer(params: Readonly<{
  hostname?: string;
  port?: number;
  timeoutMs?: number;
}> = {}): Promise<{
  baseUrl: string;
  pid: number;
  close: () => void;
}> {
  const hostname = typeof params.hostname === 'string' && params.hostname.trim().length > 0 ? params.hostname.trim() : '127.0.0.1';
  const port = typeof params.port === 'number' && Number.isFinite(params.port) && params.port > 0
    ? Math.floor(params.port)
    : await resolveEphemeralPort(hostname);
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? Math.floor(params.timeoutMs)
    : (readPositiveIntEnv('HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS') ?? 5_000);

  const cmd = resolveOpenCodeCommand();
  const args = [`serve`, `--hostname=${hostname}`, `--port=${port}`];

  logger.debug('[OpenCodeServer] Spawning managed server', { cmd, args });

  const proc = spawn(cmd, args, {
    env: {
      ...process.env,
      // Ensure the subprocess has a stable, explicit config envelope.
      OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? '{}',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (proc.pid) {
        try {
          // Prefer killing the full process group when detached.
          process.kill(-proc.pid);
          return;
        } catch {
          // fall through
        }
      }
      proc.kill();
    } catch {
      // ignore
    }
  };

  const baseUrl = await new Promise<string>((resolve, reject) => {
    const tag = randomUUID();
    const timer = setTimeout(() => {
      close();
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms (${tag})`));
    }, timeoutMs);
    timer.unref?.();

    let output = '';
    const tryParse = (chunk: Buffer) => {
      output += chunk.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('opencode server listening')) continue;
        const match = trimmed.match(/on\s+(https?:\/\/[^\s]+)/i);
        if (!match) continue;
        clearTimeout(timer);
        resolve(match[1]!);
        return;
      }
    };

    proc.stdout?.on('data', tryParse);
    proc.stderr?.on('data', tryParse);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      close();
      reject(new Error(`OpenCode server exited before ready (code=${code ?? 'unknown'}). Output:\\n${output}`));
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      close();
      reject(error);
    });
  });

  try {
    proc.stdout?.removeAllListeners('data');
    proc.stderr?.removeAllListeners('data');
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  } catch {
    // ignore
  }

  proc.unref?.();
  return { baseUrl, pid: proc.pid ?? -1, close };
}
