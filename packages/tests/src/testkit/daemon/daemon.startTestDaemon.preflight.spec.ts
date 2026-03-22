import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from '../process/processTree';

const cliLaunchSpecMock = vi.hoisted(() => ({
  resolveCliTestLaunchSpec: vi.fn(),
}));

vi.mock('../process/cliLaunchSpec', async () => {
  const actual = await vi.importActual<typeof import('../process/cliLaunchSpec')>('../process/cliLaunchSpec');
  return {
    ...actual,
    resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
  };
});

import {
  resolveTestDaemonOwnershipLeasesDir,
  startTestDaemon,
} from './daemon';
import { spawnDetachedTestProcess } from '../process/testSpawn';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function writeHoldingDaemonScript(scriptPath: string, opts: { writesState: boolean; httpPort?: number }): Promise<void> {
  const contents = [
    "import { writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    opts.writesState
      ? `writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort ?? 32_222}, controlToken: 'fresh-control-token' }), 'utf8');`
      : '',
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ]
    .filter(Boolean)
    .join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

describe('startTestDaemon', () => {
  it('reclaims a stale daemon ownership lease from a dead worker before starting a fresh daemon', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-lease-preflight-'));
    const homeDir = resolve(testDir, 'home');
    let stalePid: number | null = null;
    let freshPid: number | null = null;

    try {
      const freshScriptDir = resolve(testDir, 'fresh-daemon', 'dist');
      await mkdir(freshScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(freshScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_224 });

      const staleProc = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);", 'daemon', 'start-sync'], {
        stdio: 'ignore',
      });
      stalePid = staleProc.pid ?? null;
      expect(typeof stalePid).toBe('number');
      expect(stalePid && stalePid > 1).toBe(true);

      const startTimeRes = spawnSync('ps', ['-o', 'lstart=', '-p', String(stalePid), '-ww'], { encoding: 'utf8' });
      expect(startTimeRes.status).toBe(0);

      const leaseDir = resolveTestDaemonOwnershipLeasesDir();
      await mkdir(leaseDir, { recursive: true });
      await writeFile(
        resolve(leaseDir, `pid-${stalePid}.json`),
        JSON.stringify({
          childPid: stalePid,
          childStartTime: String(startTimeRes.stdout ?? '').trim(),
          ownerPid: 999999001,
          ownerStartTime: 'Tue Mar 18 09:09:09 2026',
          createdAtMs: Date.now(),
          metadata: { happyHomeDir: homeDir },
        }),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(freshScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {
          HAPPIER_FAKE_DAEMON_HTTP_PORT: '32_224',
        },
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      freshPid = daemon.proc.child.pid ?? null;
      expect(typeof freshPid).toBe('number');
      expect(freshPid && freshPid > 1).toBe(true);
      expect(freshPid).not.toBe(stalePid);
      expect(isProcessAlive(stalePid!)).toBe(false);

      await daemon.stop();
    } finally {
      if (freshPid) await terminateProcessTreeByPid(freshPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (stalePid) await terminateProcessTreeByPid(stalePid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('reclaims a stale daemon before starting a fresh one for the same home dir', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-preflight-'));
    const homeDir = resolve(testDir, 'home');
    let stalePid: number | null = null;
    let freshPid: number | null = null;

    try {
      const staleScriptDir = resolve(testDir, 'stale-daemon', 'dist');
      const freshScriptDir = resolve(testDir, 'fresh-daemon', 'dist');
      await mkdir(staleScriptDir, { recursive: true });
      await mkdir(freshScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(staleScriptDir, 'index.mjs'), { writesState: false });
      await writeHoldingDaemonScript(resolve(freshScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_223 });

      const staleProc = spawnDetachedTestProcess(process.execPath, [resolve(staleScriptDir, 'index.mjs'), 'daemon', 'start-sync'], {
        stdio: 'ignore',
      });
      stalePid = staleProc.pid ?? null;
      expect(typeof stalePid).toBe('number');
      expect(stalePid && stalePid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: stalePid,
          httpPort: 0,
          controlToken: 'stale-control-token',
        }),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(freshScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {
          HAPPIER_FAKE_DAEMON_HTTP_PORT: '32_223',
        },
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      freshPid = daemon.proc.child.pid ?? null;
      expect(typeof freshPid).toBe('number');
      expect(freshPid && freshPid > 1).toBe(true);
      expect(daemon.state.pid).toBe(freshPid);
      expect(freshPid).not.toBe(stalePid);

      expect(isProcessAlive(stalePid!)).toBe(false);

      await daemon.stop();
    } finally {
      if (freshPid) await terminateProcessTreeByPid(freshPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (stalePid) await terminateProcessTreeByPid(stalePid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
