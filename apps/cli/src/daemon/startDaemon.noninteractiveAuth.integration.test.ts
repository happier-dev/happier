import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, type Dirent } from 'node:fs';

import { projectPath } from '@/projectPath';

function findDaemonLockFiles(homeDir: string): string[] {
  const serversDir = join(homeDir, 'servers');
  if (!existsSync(serversDir)) return [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(serversDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = join(serversDir, e.name, 'daemon.state.json.lock');
    if (existsSync(p)) files.push(p);
  }
  return files;
}

function runNode(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error(`timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitFor(
  fn: () => boolean,
  opts: Readonly<{ timeoutMs: number; intervalMs?: number; label: string; debug?: () => string }>,
): Promise<void> {
  const start = Date.now();
  const intervalMs = opts.intervalMs ?? 50;
  while (Date.now() - start < opts.timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const debug = opts.debug ? `\n${opts.debug()}` : '';
  throw new Error(`timed out waiting for ${opts.label} after ${opts.timeoutMs}ms${debug}`);
}

describe.sequential('daemon start-sync auth gating', () => {
  it('fails fast without creating a lock when started non-interactively with no credentials', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const entry = join(projectPath(), 'src', 'index.ts');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: home,
      // Ensure we do not accidentally hit real infra
      HAPPIER_SERVER_URL: 'http://127.0.0.1:9',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:9',
      DEBUG: '1',
    };

    try {
      const res = await runNode(['--import', 'tsx', entry, 'daemon', 'start-sync'], env, 30_000);
      expect(res.code).not.toBe(0);
      expect(findDaemonLockFiles(home)).toHaveLength(0);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);

  it(
    'creates a lock and waits for credentials when HAPPIER_DAEMON_WAIT_FOR_AUTH=1',
    async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-cli-home-'));
    const entry = join(projectPath(), 'src', 'index.ts');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HAPPIER_HOME_DIR: home,
      // Ensure we do not accidentally hit real infra
      HAPPIER_SERVER_URL: 'http://127.0.0.1:9',
      HAPPIER_WEBAPP_URL: 'http://127.0.0.1:9',
      HAPPIER_DAEMON_WAIT_FOR_AUTH: '1',
      HAPPIER_DAEMON_WAIT_FOR_AUTH_TIMEOUT_MS: '0',
      DEBUG: '1',
    };

    const child = spawn(process.execPath, ['--import', 'tsx', entry, 'daemon', 'start-sync'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childStdout = '';
    let childStderr = '';
    const appendBounded = (current: string, next: string) => (current + next).slice(-20_000);
    child.stdout?.on('data', (d) => {
      childStdout = appendBounded(childStdout, String(d));
    });
    child.stderr?.on('data', (d) => {
      childStderr = appendBounded(childStderr, String(d));
    });

    try {
      await waitFor(() => {
        if (child.exitCode !== null) {
          throw new Error(
            `daemon exited early with code=${child.exitCode}\nstdout:\n${childStdout}\nstderr:\n${childStderr}`,
          );
        }
        return findDaemonLockFiles(home).length > 0;
      }, {
        timeoutMs: 30_000,
        label: 'daemon lock file creation',
        debug: () => `stdout:\n${childStdout}\nstderr:\n${childStderr}`,
      });
      const lockPath = findDaemonLockFiles(home)[0] ?? '';
      expect(lockPath).not.toBe('');
      expect(existsSync(lockPath)).toBe(true);

      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }

      await waitFor(() => child.exitCode !== null, {
        timeoutMs: 30_000,
        label: 'daemon process termination',
        debug: () => `stdout:\n${childStdout}\nstderr:\n${childStderr}`,
      });
      await waitFor(() => findDaemonLockFiles(home).length === 0, {
        timeoutMs: 30_000,
        label: 'lock file cleanup after daemon exit',
        debug: () => `stdout:\n${childStdout}\nstderr:\n${childStderr}`,
      });
      expect(findDaemonLockFiles(home)).toHaveLength(0);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await rm(home, { recursive: true, force: true });
    }
    },
    60_000,
  );
});
