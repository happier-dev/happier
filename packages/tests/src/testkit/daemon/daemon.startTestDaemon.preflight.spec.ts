import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('assigns an isolated direct-peer bind port when one is not explicitly configured', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-direct-peer-port-'));
    const homeDir = resolve(testDir, 'home');
    const observedEnvPath = resolve(testDir, 'observed-env.json');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      await writeFile(
        resolve(fakeScriptDir, 'index.mjs'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const homeDir = process.env.HAPPIER_HOME_DIR;",
          "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
          `writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify({ directPeerBindPort: process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT ?? null }), 'utf8');`,
          "writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: 32226, controlToken: 'fresh-control-token' }), 'utf8');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join('\n'),
        'utf8',
      );

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

      const observed = JSON.parse(await readFile(observedEnvPath, 'utf8')) as { directPeerBindPort?: unknown };
      expect(typeof observed.directPeerBindPort).toBe('string');
      expect(Number(observed.directPeerBindPort)).toBeGreaterThan(0);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('defaults daemon service inventory lookups to the requested home dir', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-service-home-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      await writeFile(
        resolve(fakeScriptDir, 'index.mjs'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const homeDir = process.env.HAPPIER_HOME_DIR;",
          "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
          "writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: 32227, controlToken: 'fresh-control-token' }), 'utf8');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join('\n'),
        'utf8',
      );

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

      const launchCall = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[0] as
        | Readonly<{ env?: NodeJS.ProcessEnv }>
        | undefined;
      expect(launchCall?.env?.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR).toBe(homeDir);
      expect(launchCall?.env?.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR).toBe(homeDir);
      expect(launchCall?.env?.HAPPIER_E2E_CLI_SNAPSHOT_NODE_MODULES_MODE).toBe('copy');

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('overrides conflicting daemon service inventory home env with the requested home dir', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-service-home-override-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      await writeFile(
        resolve(fakeScriptDir, 'index.mjs'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const homeDir = process.env.HAPPIER_HOME_DIR;",
          "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
          "writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: 32228, controlToken: 'fresh-control-token' }), 'utf8');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join('\n'),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const conflictingHomeDir = resolve(testDir, 'conflicting-home');
      await mkdir(conflictingHomeDir, { recursive: true });
      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {
          HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: conflictingHomeDir,
          HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: conflictingHomeDir,
        },
        startupTimeoutMs: 15_000,
      });

      const launchCall = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[0] as
        | Readonly<{ env?: NodeJS.ProcessEnv }>
        | undefined;
      expect(launchCall?.env?.HAPPIER_DAEMON_SERVICE_USER_HOME_DIR).toBe(homeDir);
      expect(launchCall?.env?.HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR).toBe(homeDir);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('reuses a prepared per-test CLI snapshot when available', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-snapshot-preflight-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_229 });

      const perTestSnapshotDir = resolve(testDir, 'cli-dist');
      await mkdir(resolve(perTestSnapshotDir, 'dist'), { recursive: true });
      await writeFile(resolve(perTestSnapshotDir, '.cli-dist-snapshot.ready.json'), '{}', 'utf8');
      await writeFile(resolve(perTestSnapshotDir, 'dist', 'index.mjs'), '// ready marker', 'utf8');

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

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(perTestSnapshotDir);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

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
