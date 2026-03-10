import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import { logger } from '@/ui/logger';
import { requireProviderCliCommand } from '@/runtime/managedTools/requireProviderCliCommand';

import { resolveOpenCodeServerAuthHeadersFromEnv } from './openCodeServerAuth';
import { resolveOpenCodeManagedServerChildEnv } from './openCodeManagedServerEnv';
import { terminateManagedOpenCodeServerPidBestEffort } from './terminateManagedOpenCodeServerPidBestEffort';
import { waitForOpenCodeServerHealth } from './waitForOpenCodeServerHealth';

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
  return requireProviderCliCommand('opencode');
}

export async function startManagedOpenCodeServer(params: Readonly<{
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  xdgRootDir?: string | null;
  isolateConfig?: boolean;
  onSpawned?: (started: Readonly<{ baseUrl: string; pid: number }>) => void | Promise<void>;
}> = {}): Promise<{
  baseUrl: string;
  pid: number;
  close: () => Promise<void>;
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
  const healthHeaders = resolveOpenCodeServerAuthHeadersFromEnv();

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

  let closePromise: Promise<void> | null = null;
  const close = async () => {
    if (closePromise) {
      await closePromise;
      return;
    }
    closePromise = (async () => {
      try {
        if (proc.pid) {
          await terminateManagedOpenCodeServerPidBestEffort(proc.pid);
          return;
        }
        proc.kill();
      } catch {
        // best-effort only
      }
    })();
    await closePromise;
  };

  const baseUrl = `http://${hostname}:${port}`;

  // Call onSpawned and ensure cleanup if it throws
  try {
    await params.onSpawned?.({ baseUrl, pid: proc.pid ?? -1 });
  } catch (error) {
    await close();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    const tag = randomUUID();
    const timer = setTimeout(() => {
      void close();
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms (${tag}). Output:\n${output || '<no output captured>'}`));
    }, timeoutMs);
    timer.unref?.();

    let output = '';
    const appendOutput = (chunk: Buffer) => {
      output += chunk.toString();
    };

    proc.stdout?.on('data', appendOutput);
    proc.stderr?.on('data', appendOutput);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      void close();
      const codeLabel = code ?? 'unknown';
      const signalLabel = signal ?? 'none';
      reject(new Error(
        `OpenCode server exited before ready (code=${codeLabel}, signal=${signalLabel}). Output:\\n${output || '<no output captured>'}`,
      ));
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      void close();
      reject(error);
    });

    void waitForOpenCodeServerHealth({ baseUrl, timeoutMs, pollIntervalMs: 200, headers: healthHeaders })
      .then(() => {
        clearTimeout(timer);
        resolve();
      })
      .catch((error) => {
        clearTimeout(timer);
        void close();
        const message = error instanceof Error ? error.message : String(error);
        reject(new Error(`OpenCode server did not become healthy: ${message}. Output:\\n${output || '<no output captured>'}`));
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
