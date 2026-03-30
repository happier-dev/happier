import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

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
import { seedCliAuthForServer } from '../cliAuth';

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

async function writeExitAfterStateDaemonScript(scriptPath: string, opts: { homeDir: string; serverId: string; httpPort: number }): Promise<void> {
  const contents = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    `const stateDir = resolve(homeDir, 'servers', ${JSON.stringify(opts.serverId)});`,
    "mkdirSync(stateDir, { recursive: true });",
    `writeFileSync(resolve(stateDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort}, controlToken: 'fresh-control-token' }), 'utf8');`,
    "process.exit(1);",
  ].join('\n');

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

  it('returns daemon state even if the daemon exits after persisting daemon.state.json', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-exit-after-state-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31111',
        token: 'token-for-start-test-daemon',
        secret: Uint8Array.from(randomBytes(32)),
      });

      await writeExitAfterStateDaemonScript(resolve(fakeScriptDir, 'index.mjs'), {
        homeDir,
        serverId,
        httpPort: 32_225,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        startupTimeoutMs: 15_000,
      });

      expect(daemon.state.httpPort).toBe(32_225);
      expect(daemon.state.pid).toBe(daemon.proc.child.pid);
      expect(daemon.proc.child.exitCode).toBe(1);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
