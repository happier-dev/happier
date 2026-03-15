import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { logger } from '@/ui/logger';

import { resolveOpenCodeManagedServerChildEnv } from './openCodeManagedServerEnv';

async function waitForOkHealth(params: {
  baseUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw new Error('Aborted while waiting for OpenCode server health');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(1_500, params.pollIntervalMs * 5));
      timer.unref?.();
      const res = await fetch(`${params.baseUrl}/global/health`, { signal: ctrl.signal }).catch(() => null);
      clearTimeout(timer);
      if (res && res.ok) return;
    } catch {
      // ignore and retry until deadline
    }
    await new Promise((r) => setTimeout(r, params.pollIntervalMs));
  }
  throw new Error(`Timed out waiting for OpenCode server health after ${params.timeoutMs}ms`);
}

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
  xdgRootDir?: string | null;
  isolateConfig?: boolean;
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
    : (readPositiveIntEnv('HAPPIER_OPENCODE_SERVER_START_TIMEOUT_MS') ?? 30_000);

  const cmd = resolveOpenCodeCommand();
  const args = [`serve`, `--hostname=${hostname}`, `--port=${port}`];

  logger.debug('[OpenCodeServer] Spawning managed server', { cmd, args });

  const xdgRootDir = typeof params.xdgRootDir === 'string' ? params.xdgRootDir.trim() : '';
  const isolateConfig = params.isolateConfig === true;
  const childEnv = resolveOpenCodeManagedServerChildEnv({
    baseEnv: process.env,
    xdgRootDir: xdgRootDir.length > 0 ? xdgRootDir : null,
    isolateConfig,
  });

  const proc = spawn(cmd, args, {
    env: childEnv,
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

  const baseUrl = `http://${hostname}:${port}`;

  await new Promise<void>((resolve, reject) => {
    const tag = randomUUID();
    const timer = setTimeout(() => {
      close();
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms (${tag}). Output:\n${output}`));
    }, timeoutMs);
    timer.unref?.();

    let output = '';
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString();
    };

    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);
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

    void waitForOkHealth({ baseUrl, timeoutMs, pollIntervalMs: 200 })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timer);
        close();
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`OpenCode server did not become healthy: ${message}. Output:\\n${output}`));
      });
  });

  try {
    proc.stdout?.removeAllListeners('data');
    proc.stderr?.removeAllListeners('data');
    // Keep the pipe open and drain output so the managed server can keep logging without SIGPIPE/EPIPE crashes.
    proc.stdout?.resume();
    proc.stderr?.resume();
  } catch {
    // ignore
  }

  proc.unref?.();
  return { baseUrl, pid: proc.pid ?? -1, close };
}
