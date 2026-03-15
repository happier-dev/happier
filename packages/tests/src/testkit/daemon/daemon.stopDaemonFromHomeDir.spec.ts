import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stopDaemonFromHomeDir } from './daemon';
import { terminateProcessTreeByPid, isProcessAlive } from '../process/processTree';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [k, v] = entry;
      if (String(k).toLowerCase() === name.toLowerCase()) return String(v);
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === name.toLowerCase()) return typeof v === 'string' ? v : Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return null;
}

describe('stopDaemonFromHomeDir', () => {
  it('uses the control token for /stop and requests session shutdown', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-stop-'));
    try {
      await writeFile(
        join(homeDir, 'daemon.state.json'),
        JSON.stringify({ pid: 999_999_123, httpPort: 31_999, controlToken: 'token-123' }),
        'utf8',
      );

      const calls: Array<{ url: string; headers: unknown; body: unknown }> = [];

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: any, init: any) => {
          calls.push({ url: String(url), headers: init?.headers, body: init?.body });
          const path = String(url).split('127.0.0.1:31999')[1] ?? '';
          if (path.startsWith('/stop')) {
            return new Response(JSON.stringify({ status: 'stopping' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', { status: 404 });
        }),
      );

      await stopDaemonFromHomeDir(homeDir, { gracefulTimeoutMs: 0, hardKill: false });

      const stopCalls = calls.filter((c) => c.url.includes('/stop') && !c.url.includes('/stop-session'));

      expect(stopCalls).toHaveLength(1);

      for (const call of stopCalls) {
        expect(readHeader(call.headers, 'x-happier-daemon-token')).toBe('token-123');
      }

      const stopBody = stopCalls[0]?.body;
      expect(typeof stopBody).toBe('string');
      expect(JSON.parse(String(stopBody))).toEqual({ stopSessions: true });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('kills leaked daemon-started sessions from disk markers when daemon is unreachable', async () => {
    if (process.platform === 'win32') {
      // The leak mode we care about is POSIX-daemon detached child processes; Windows uses different semantics.
      return;
    }

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-daemon-stop-orphans-'));
    let daemonPid: number | null = null;
    let sessionPid: number | null = null;
    try {
      const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      daemonPid = daemon.pid ?? null;
      expect(typeof daemonPid).toBe('number');
      expect(daemonPid && daemonPid > 1).toBe(true);

      const session = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
        detached: true,
      });
      sessionPid = session.pid ?? null;
      expect(typeof sessionPid).toBe('number');
      expect(sessionPid && sessionPid > 1).toBe(true);

      const ps = spawnSync('ps', ['-o', 'args=', '-p', String(sessionPid), '-ww'], { encoding: 'utf8' });
      expect(ps.status).toBe(0);
      const command = String(ps.stdout || '').trim();
      expect(command).toContain('setInterval');
      const processCommandHash = createHash('sha256').update(command).digest('hex');

      const markerDir = join(homeDir, 'tmp', 'daemon-sessions');
      await mkdir(markerDir, { recursive: true });
      await writeFile(
        join(markerDir, `pid-${sessionPid}.json`),
        JSON.stringify({ pid: sessionPid, happyHomeDir: homeDir, processCommandHash, startedBy: 'daemon' }),
        'utf8',
      );

      await writeFile(join(homeDir, 'daemon.state.json'), JSON.stringify({ pid: daemonPid, httpPort: 31_999 }), 'utf8');

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('unreachable');
        }),
      );

      await stopDaemonFromHomeDir(homeDir, {
        gracefulTimeoutMs: 0,
        hardKill: true,
        inspectProcess: () => ({ ok: true, command: 'node dist/index.mjs daemon start-sync', looksLikeDaemon: true }),
      });

      expect(isProcessAlive(sessionPid!)).toBe(false);
    } finally {
      if (sessionPid) await terminateProcessTreeByPid(sessionPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (daemonPid) await terminateProcessTreeByPid(daemonPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
