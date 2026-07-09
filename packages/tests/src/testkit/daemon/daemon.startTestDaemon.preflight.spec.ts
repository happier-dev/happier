import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive, terminateProcessTreeByPid } from '../process/processTree';

const cliLaunchSpecMock = vi.hoisted(() => ({
  resolveCliTestLaunchSpec: vi.fn(),
}));

const repoRootDirMock = vi.hoisted(() => vi.fn());

vi.mock('../process/cliLaunchSpec', async () => {
  const actual = await vi.importActual<typeof import('../process/cliLaunchSpec')>('../process/cliLaunchSpec');
  return {
    ...actual,
    resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
  };
});

vi.mock('../paths', async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  repoRootDirMock.mockImplementation(actual.repoRootDir);
  return {
    ...actual,
    repoRootDir: repoRootDirMock,
  };
});

import {
  replaceTestDaemonWithoutStoppingSessions,
  resolveTestDaemonOwnershipLeasesDir,
  startTestDaemon,
} from './daemon';
import { spawnDetachedTestProcess } from '../process/testSpawn';
import { seedCliAuthForServer } from '../cliAuth';
import { resolveTsxImportHookPath } from '../process/tsxImportHook';
import { repoRootDir } from '../paths';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../paths')>('../paths');
  repoRootDirMock.mockImplementation(actual.repoRootDir);
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

async function writeLegacyRingStateDaemonScript(scriptPath: string, opts: { serverId: string; httpPort: number }): Promise<void> {
  const contents = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    `const stateDir = resolve(homeDir, 'servers', ${JSON.stringify(opts.serverId)});`,
    "mkdirSync(stateDir, { recursive: true });",
    `writeFileSync(resolve(stateDir, 'daemon.dev.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort}, controlToken: 'legacy-ring-control-token' }), 'utf8');`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

async function writeReplacementDaemonScript(scriptPath: string, opts: { serverId: string; httpPort: number; stateWriteDelayMs?: number }): Promise<void> {
  const contents = [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    "const args = process.argv.slice(2).join(' ');",
    "if (args !== 'daemon start-sync --takeover') process.exit(7);",
    opts.stateWriteDelayMs ? `await new Promise((resolve) => setTimeout(resolve, ${opts.stateWriteDelayMs}));` : '',
    `const stateDir = resolve(homeDir, 'servers', ${JSON.stringify(opts.serverId)});`,
    "mkdirSync(stateDir, { recursive: true });",
    `writeFileSync(resolve(stateDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${opts.httpPort}, controlToken: 'replacement-control-token' }), 'utf8');`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join('\n');

  await writeFile(scriptPath, contents, 'utf8');
}

describe('startTestDaemon', () => {
  it('fails with phase diagnostics when daemon startup stalls before spawning the daemon', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-startup-phase-timeout-'));
    const homeDir = resolve(testDir, 'home');

    try {
      await mkdir(homeDir, { recursive: true });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementationOnce(async () => {
        await new Promise(() => {});
        throw new Error('unreachable');
      });

      const result = await Promise.race([
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {},
          startupTimeoutMs: 25,
        }).then(
          () => 'started',
          (error: unknown) => error,
        ),
        new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 250)),
      ]);

      expect(result).toBeInstanceOf(Error);
      expect(String((result as Error).message)).toContain('phase=resolveCliTestLaunchSpec');
      expect(String((result as Error).message)).toContain(`testDir=${testDir}`);
      expect(String((result as Error).message)).toContain(`happyHomeDir=${homeDir}`);
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.stdout.log'));
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.stderr.log'));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('uses the configured daemon startup phase timeout while waiting for daemon state', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-state-phase-timeout-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(resolve(homeDir, 'logs'), { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(resolve(homeDir, 'logs', 'daemon.log'), 'daemon boot line\nlast internal line\n', 'utf8');
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: false });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(fakeScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const result = await Promise.race([
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS: '25',
          },
        }).then(
          () => 'started',
          (error: unknown) => error,
        ),
        new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 5_000)),
      ]);

      expect(result).toBeInstanceOf(Error);
      expect(String((result as Error).message)).toContain('phase=waitForDaemonState');
      expect(String((result as Error).message)).toContain('timeoutMs=25');
      expect(String((result as Error).message)).toContain('daemonStateExists=no');
      expect(String((result as Error).message)).toContain('daemonStateEverWritten=no');
      expect(String((result as Error).message)).toContain('daemonStateEverRemoved=no');
      expect(String((result as Error).message)).toContain('internalDaemonLogTail=');
      expect(String((result as Error).message)).toContain('last internal line');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

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

  it('propagates a tsx-fallback subprocess contract when the daemon launches from a source snapshot', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-source-subprocess-'));
    const homeDir = resolve(testDir, 'home');
    const snapshotDir = resolve(testDir, 'cli-source-snapshot');
    const observedEnvPath = resolve(testDir, 'observed-env.json');
    const tsxHookPath = resolveTsxImportHookPath();

    try {
      expect(tsxHookPath).toBeTruthy();
      if (!tsxHookPath) {
        return;
      }

      await mkdir(resolve(snapshotDir, 'src'), { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(
        resolve(snapshotDir, 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli', type: 'module' }),
        'utf8',
      );
      await writeFile(resolve(snapshotDir, 'tsconfig.json'), '{}', 'utf8');
      await writeFile(
        resolve(snapshotDir, 'src', 'index.ts'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const homeDir = process.env.HAPPIER_HOME_DIR;",
          "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
          `writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify({`,
          "  subprocessRuntime: process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME ?? null,",
          "  subprocessEntrypoint: process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT ?? null,",
          "  subprocessAllowTsxFallback: process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK ?? null,",
          "  tsxTsconfigPath: process.env.TSX_TSCONFIG_PATH ?? null,",
          "}), 'utf8');",
          "writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: 32230, controlToken: 'fresh-control-token' }), 'utf8');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join('\n'),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [
          '--preserve-symlinks',
          '--preserve-symlinks-main',
          '--import',
          tsxHookPath,
          resolve(snapshotDir, 'src', 'index.ts'),
        ],
        cwd: snapshotDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {
          OBSERVED_ENV_PATH: observedEnvPath,
        },
        startupTimeoutMs: 15_000,
      });

      const observed = JSON.parse(
        await readFile(observedEnvPath, 'utf8'),
      ) as {
        subprocessRuntime: string | null;
        subprocessEntrypoint: string | null;
        subprocessAllowTsxFallback: string | null;
        tsxTsconfigPath: string | null;
      };

      expect(observed).toEqual({
        subprocessRuntime: 'node',
        subprocessEntrypoint: null,
        subprocessAllowTsxFallback: '1',
        tsxTsconfigPath: resolve(snapshotDir, 'tsconfig.json'),
      });

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('enables daemon child stdio diagnostics for no-dev source-snapshot launches', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-source-diagnostics-'));
    const homeDir = resolve(testDir, 'home');
    const snapshotDir = resolve(testDir, 'cli-source-snapshot');
    const observedEnvPath = resolve(testDir, 'observed-env.json');
    const tsxHookPath = resolveTsxImportHookPath();

    try {
      expect(tsxHookPath).toBeTruthy();
      if (!tsxHookPath) {
        return;
      }

      await mkdir(resolve(snapshotDir, 'src'), { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeFile(
        resolve(snapshotDir, 'package.json'),
        JSON.stringify({ name: '@happier-dev/cli', type: 'module' }),
        'utf8',
      );
      await writeFile(resolve(snapshotDir, 'tsconfig.json'), '{}', 'utf8');
      await writeFile(
        resolve(snapshotDir, 'src', 'index.ts'),
        [
          "import { writeFileSync } from 'node:fs';",
          "import { resolve } from 'node:path';",
          "const homeDir = process.env.HAPPIER_HOME_DIR;",
          "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
          `writeFileSync(${JSON.stringify(observedEnvPath)}, JSON.stringify({`,
          "  debug: process.env.DEBUG ?? null,",
          "}), 'utf8');",
          "writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: 32231, controlToken: 'fresh-control-token' }), 'utf8');",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join('\n'),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [
          '--preserve-symlinks',
          '--preserve-symlinks-main',
          '--import',
          tsxHookPath,
          resolve(snapshotDir, 'src', 'index.ts'),
        ],
        cwd: snapshotDir,
        env: {},
      });

      const daemon = await startTestDaemon({
        testDir,
        happyHomeDir: homeDir,
        env: {
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_E2E_UI_WEB_NO_DEV: '1',
        },
        startupTimeoutMs: 15_000,
      });

      const observed = JSON.parse(await readFile(observedEnvPath, 'utf8')) as {
        debug: string | null;
      };

      expect(observed).toEqual({
        debug: '1',
      });

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  }, 15_000);

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

  it('prefers a prepared shared CLI snapshot in testdir source-entrypoint mode', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-shared-snapshot-preflight-'));
    const homeDir = resolve(testDir, 'home');
    const repoRoot = resolve(testDir, 'repo-root');

    try {
      repoRootDirMock.mockReturnValue(repoRoot);

      const sharedSnapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
      await mkdir(homeDir, { recursive: true });
      await mkdir(resolve(sharedSnapshotDir, 'dist'), { recursive: true });
      await mkdir(resolve(sharedSnapshotDir, 'node_modules'), { recursive: true });
      await writeFile(resolve(sharedSnapshotDir, '.cli-dist-snapshot.ready.json'), '{}', 'utf8');
      await writeFile(resolve(sharedSnapshotDir, 'dist', 'index.mjs'), '// shared ready marker', 'utf8');

      vi.stubEnv('HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE', 'testdir');
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockRejectedValueOnce(new Error('stop after launch-spec capture'));

      await expect(
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
          startupTimeoutMs: 15_000,
        }),
      ).rejects.toThrow('stop after launch-spec capture');

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(sharedSnapshotDir);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('keeps source-entrypoint testdir mode on the per-test snapshot when no shared snapshot is prepared', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-testdir-source-snapshot-preflight-'));
    const homeDir = resolve(testDir, 'home');
    const repoRoot = resolve(testDir, 'repo-root');

    try {
      repoRootDirMock.mockReturnValue(repoRoot);
      await mkdir(homeDir, { recursive: true });

      vi.stubEnv('HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE', 'testdir');
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockRejectedValueOnce(new Error('stop after launch-spec capture'));

      await expect(
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
          startupTimeoutMs: 15_000,
        }),
      ).rejects.toThrow('stop after launch-spec capture');

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(testDir, 'cli-dist'));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('keeps source-entrypoint testdir mode on the per-test snapshot when e2e logs dir is provided', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-writable-snapshot-preflight-'));
    const homeDir = resolve(testDir, 'home');
    const repoRoot = resolve(testDir, 'repo-root');

    try {
      repoRootDirMock.mockReturnValue(repoRoot);

      const sharedSnapshotDir = resolve(repoRoot, '.project', 'tmp', 'cli-dist-snapshot');
      await mkdir(homeDir, { recursive: true });
      await mkdir(resolve(sharedSnapshotDir, 'dist'), { recursive: true });
      await mkdir(resolve(sharedSnapshotDir, 'node_modules'), { recursive: true });
      await writeFile(resolve(sharedSnapshotDir, '.cli-dist-snapshot.ready.json'), '{}', 'utf8');
      await writeFile(resolve(sharedSnapshotDir, 'dist', 'index.mjs'), '// shared ready marker', 'utf8');

      vi.stubEnv('HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE', 'testdir');
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockRejectedValueOnce(new Error('stop after launch-spec capture'));

      await expect(
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_LOGS_DIR: resolve(testDir, 'logs'),
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
          startupTimeoutMs: 15_000,
        }),
      ).rejects.toThrow('stop after launch-spec capture');

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(testDir, 'cli-dist'));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('uses a separate shared source snapshot in source-entrypoint default mode', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-source-snapshot-preflight-'));
    const homeDir = resolve(testDir, 'home');
    const repoRoot = resolve(testDir, 'repo-root');

    try {
      repoRootDirMock.mockReturnValue(repoRoot);
      await mkdir(homeDir, { recursive: true });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockRejectedValueOnce(new Error('stop after launch-spec capture'));

      await expect(
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          },
          startupTimeoutMs: 15_000,
        }),
      ).rejects.toThrow('stop after launch-spec capture');

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(repoRoot, '.project', 'tmp', 'cli-source-snapshot'));
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('keeps source freshness checks skipped when starting a daemon from ready snapshots', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-shared-snapshot-freshness-'));
    const homeDir = resolve(testDir, 'home');

    try {
      await mkdir(homeDir, { recursive: true });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockRejectedValueOnce(new Error('stop after launch-spec capture'));

      await expect(
        startTestDaemon({
          testDir,
          happyHomeDir: homeDir,
          env: {},
          startupTimeoutMs: 15_000,
        }),
      ).rejects.toThrow('stop after launch-spec capture');

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string; skipSourceFreshnessCheck?: boolean }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot'));
      expect(launchOptions?.skipSourceFreshnessCheck).toBe(true);
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('uses an explicit CLI snapshot override when starting a daemon', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-explicit-snapshot-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });
      await writeHoldingDaemonScript(resolve(fakeScriptDir, 'index.mjs'), { writesState: true, httpPort: 32_231 });

      const explicitSnapshotDir = resolve(testDir, 'cli-update-from');
      await mkdir(resolve(explicitSnapshotDir, 'dist'), { recursive: true });
      await writeFile(resolve(explicitSnapshotDir, '.cli-dist-snapshot.ready.json'), '{}', 'utf8');
      await writeFile(resolve(explicitSnapshotDir, 'dist', 'index.mjs'), '// ready marker', 'utf8');

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
        snapshotDir: explicitSnapshotDir,
        startupTimeoutMs: 15_000,
      });

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(explicitSnapshotDir);

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

  it('accepts a legacy ring-scoped daemon.dev.state.json written under the server dir', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-legacy-ring-startup-'));
    const homeDir = resolve(testDir, 'home');

    try {
      const fakeScriptDir = resolve(testDir, 'fake-daemon', 'dist');
      await mkdir(fakeScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31113',
        token: 'token-for-legacy-ring-start-test-daemon',
        secret: Uint8Array.from(randomBytes(32)),
      });

      await writeLegacyRingStateDaemonScript(resolve(fakeScriptDir, 'index.mjs'), {
        serverId,
        httpPort: 32_228,
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

      expect(daemon.state.httpPort).toBe(32_228);
      expect(daemon.state.pid).toBe(daemon.proc.child.pid);

      await daemon.stop();
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('starts replacement daemons through start-sync takeover and reads active-server daemon state', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;
    let replacementPid: number | null = null;

    try {
      const replacementScriptDir = resolve(testDir, 'replacement-daemon', 'dist');
      await mkdir(replacementScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31112',
        token: 'token-for-replace-test-daemon',
        secret: Uint8Array.from(randomBytes(32)),
      });

      const original = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);
      if (originalPid == null) {
        throw new Error('Expected original daemon pid');
      }

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_226,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      await writeReplacementDaemonScript(resolve(replacementScriptDir, 'index.mjs'), {
        serverId,
        httpPort: 32_227,
        stateWriteDelayMs: 500,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(replacementScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const state = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        snapshotDir: resolve(testDir, 'cli-update-to'),
        stdoutPath: resolve(testDir, 'replacement.stdout.log'),
        stderrPath: resolve(testDir, 'replacement.stderr.log'),
      });

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(testDir, 'cli-update-to'));

      replacementPid = state.pid;
      expect(state).toEqual(expect.objectContaining({
        httpPort: 32_227,
        controlToken: 'replacement-control-token',
      }));
      expect(replacementPid).not.toBe(originalPid);
      expect(isProcessAlive(originalPid!)).toBe(false);
      expect(isProcessAlive(replacementPid)).toBe(true);
    } finally {
      if (replacementPid) await terminateProcessTreeByPid(replacementPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('fails with phase diagnostics when replacement daemon setup stalls before takeover spawn', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-phase-timeout-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;

    try {
      await mkdir(homeDir, { recursive: true });
      const original = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);
      if (originalPid == null) {
        throw new Error('Expected original daemon pid');
      }

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_246,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementationOnce(async () => {
        await new Promise(() => {});
        throw new Error('unreachable');
      });

      const result = await Promise.race([
        replaceTestDaemonWithoutStoppingSessions({
          testDir,
          happyHomeDir: homeDir,
          env: {
            HAPPIER_E2E_DAEMON_STARTUP_PHASE_TIMEOUT_MS: '25',
          },
        }).then(
          () => 'replaced',
          (error: unknown) => error,
        ),
        new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 250)),
      ]);

      expect(result).toBeInstanceOf(Error);
      expect(String((result as Error).message)).toContain('phase=');
      expect(String((result as Error).message)).toContain(`testDir=${testDir}`);
      expect(String((result as Error).message)).toContain(`happyHomeDir=${homeDir}`);
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.replace.stdout.log'));
      expect(String((result as Error).message)).toContain(resolve(testDir, 'daemon.replace.stderr.log'));
    } finally {
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it('falls back to PID polling when the original daemon child handle never emits exit during replacement', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-child-exit-fallback-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;
    let replacementPid: number | null = null;

    try {
      const replacementScriptDir = resolve(testDir, 'replacement-daemon', 'dist');
      await mkdir(replacementScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31112',
        token: 'token-for-replace-child-exit-fallback',
        secret: Uint8Array.from(randomBytes(32)),
      });

      const original = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_256,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      await writeReplacementDaemonScript(resolve(replacementScriptDir, 'index.mjs'), {
        serverId,
        httpPort: 32_257,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(replacementScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const assuredOriginalPid = originalPid;
      if (assuredOriginalPid == null) {
        throw new Error('Expected original daemon pid');
      }

      const result = await Promise.race([
        replaceTestDaemonWithoutStoppingSessions({
          testDir,
          happyHomeDir: homeDir,
          env: {},
          originalDaemon: {
            happyHomeDir: homeDir,
            state: {
              pid: assuredOriginalPid,
              httpPort: 32_256,
              controlToken: 'original-control-token',
            },
            proc: {
              child: new EventEmitter() as any,
              stdoutPath: resolve(testDir, 'original.stdout.log'),
              stderrPath: resolve(testDir, 'original.stderr.log'),
              stop: async () => {},
            },
            stop: async () => {},
          },
        }).then(
          (state) => state,
          (error: unknown) => error,
        ),
        new Promise<'still-pending'>((resolvePending) => setTimeout(() => resolvePending('still-pending'), 5_000)),
      ]);

      expect(result).not.toBe('still-pending');
      expect(result).not.toBeInstanceOf(Error);
      replacementPid = (result as { pid: number }).pid;
      expect(replacementPid).not.toBe(originalPid);
      expect(isProcessAlive(replacementPid)).toBe(true);
    } finally {
      if (replacementPid) await terminateProcessTreeByPid(replacementPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('reuses the canonical default CLI snapshot selection when replacing a daemon', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-replacement-default-snapshot-'));
    const homeDir = resolve(testDir, 'home');
    let originalPid: number | null = null;
    let replacementPid: number | null = null;

    try {
      const replacementScriptDir = resolve(testDir, 'replacement-daemon', 'dist');
      await mkdir(replacementScriptDir, { recursive: true });
      await mkdir(homeDir, { recursive: true });

      const { serverId } = await seedCliAuthForServer({
        cliHome: homeDir,
        serverUrl: 'http://127.0.0.1:31112',
        token: 'token-for-replace-default-snapshot',
        secret: Uint8Array.from(randomBytes(32)),
      });

      const original = spawnDetachedTestProcess(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"], {
        stdio: 'ignore',
      });
      originalPid = original.pid ?? null;
      expect(typeof originalPid).toBe('number');
      expect(originalPid && originalPid > 1).toBe(true);

      await writeFile(
        resolve(homeDir, 'daemon.state.json'),
        JSON.stringify({
          pid: originalPid,
          httpPort: 32_236,
          controlToken: 'original-control-token',
        }),
        'utf8',
      );

      await writeReplacementDaemonScript(resolve(replacementScriptDir, 'index.mjs'), {
        serverId,
        httpPort: 32_237,
      });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce({
        command: process.execPath,
        args: [resolve(replacementScriptDir, 'index.mjs')],
        cwd: testDir,
        env: {},
      });

      const state = await replaceTestDaemonWithoutStoppingSessions({
        testDir,
        happyHomeDir: homeDir,
        env: {},
      });

      const launchOptions = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls[0]?.[1] as
        | Readonly<{ snapshotDir?: string; skipSourceFreshnessCheck?: boolean }>
        | undefined;
      expect(launchOptions?.snapshotDir).toBe(resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-snapshot'));
      expect(launchOptions?.skipSourceFreshnessCheck).toBe(true);

      replacementPid = state.pid;
      expect(replacementPid).not.toBe(originalPid);
      expect(isProcessAlive(originalPid!)).toBe(false);
      expect(isProcessAlive(replacementPid)).toBe(true);
    } finally {
      if (replacementPid) await terminateProcessTreeByPid(replacementPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      if (originalPid) await terminateProcessTreeByPid(originalPid, { graceMs: 0, pollMs: 25 }).catch(() => {});
      await rm(testDir, { recursive: true, force: true });
    }
  }, 20_000);
});
