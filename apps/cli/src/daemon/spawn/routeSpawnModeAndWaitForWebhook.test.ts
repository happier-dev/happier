import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { NativeForkSource } from '@/session/shared/spawnSessionContract';
import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import cliDistBuildManifest from '@happier-dev/cli-common/cliDistBuildManifest';
import { CLI_RUNTIME_SIDECAR_ENTRIES } from '@happier-dev/cli-common/cliRuntimeSidecars';

const mocks = vi.hoisted(() => ({
  prepareSourceDevSharedDepsForHappyCliSpawn: vi.fn(),
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: vi.fn(),
  spawnTmuxHostedSessionAndWaitForWebhook: vi.fn(),
  spawnRegularProcessAndWaitForWebhook: vi.fn(),
  spawnWindowsHostedSessionAndWaitForWebhook: vi.fn(),
  resolveWindowsRemoteSessionConsoleMode: vi.fn(() => 'hidden'),
  ensureManagedJavaScriptRuntimeCommand: vi.fn(),
}));

vi.mock('@/subprocess/sourceDevSharedDepsPreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/subprocess/sourceDevSharedDepsPreflight')>();
  return {
    ...actual,
    prepareSourceDevSharedDepsForHappyCliSpawn: mocks.prepareSourceDevSharedDepsForHappyCliSpawn,
    prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: mocks.prepareSourceDevSharedDepsForBundledPluginRuntimeLoad,
  };
});

vi.mock('./spawnTmuxHostedSessionAndWaitForWebhook', () => ({
  spawnTmuxHostedSessionAndWaitForWebhook: mocks.spawnTmuxHostedSessionAndWaitForWebhook,
}));

vi.mock('./spawnRegularProcessAndWaitForWebhook', () => ({
  spawnRegularProcessAndWaitForWebhook: mocks.spawnRegularProcessAndWaitForWebhook,
}));

vi.mock('./spawnWindowsHostedSessionAndWaitForWebhook', () => ({
  spawnWindowsHostedSessionAndWaitForWebhook: mocks.spawnWindowsHostedSessionAndWaitForWebhook,
}));

vi.mock('../platform/windows/windowsSessionConsoleMode', () => ({
  resolveWindowsRemoteSessionConsoleMode: mocks.resolveWindowsRemoteSessionConsoleMode,
}));

vi.mock('@/packagedRuntime/js/managedJavaScriptRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/packagedRuntime/js/managedJavaScriptRuntime')>();
  return {
    ...actual,
    ensureManagedJavaScriptRuntimeCommand: mocks.ensureManagedJavaScriptRuntimeCommand,
  };
});

const successResult: SpawnSessionResult = {
  type: 'success',
  sessionId: 'session-1',
};

const ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS = 90_000;
const envScope = createSpawnHappyCliEnvScope();

const nativeForkSource: NativeForkSource = {
  sessionId: 'source-session',
  providerSessionId: 'provider-session',
  cwd: '/tmp/source-project',
  target: {
    turnId: 'source-turn',
    providerCheckpoint: {
      providerCursor: 'checkpoint-1',
    },
  },
};

function createParams() {
  return {
    terminalRequest: { requested: null },
    directory: '/tmp/happier-project',
    options: { directory: '/tmp/happier-project' },
    trackedSpawnOptions: { directory: '/tmp/happier-project' },
    normalizedExistingSessionId: '',
    effectiveResume: '',
    effectiveBackendTargetV2: {
      kind: 'backend',
      sourceKind: 'built_in',
      backendId: 'opencode',
    },
    directoryCreated: false,
    extraEnvForChildWithMessage: {},
    processEnv: process.env,
    happyHomeDir: '/tmp/happier-home',
    pidToTrackedSession: new Map(),
    pidToAwaiter: new Map(),
    pidToSpawnResultResolver: new Map(),
    pidToSpawnWebhookTimeout: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited: vi.fn(),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForPid: vi.fn(),
      consumeSessionAttachCleanupForPid: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(),
    onUntrackedTmuxChild: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
  } as const;
}

function writeRuntimeBackedRunnerFixture(root: string): Readonly<{
  entrypoint: string;
  fingerprint: string;
}> {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(join(distDir, 'chunk.mjs'), 'export const runner = true;\n', 'utf8');
  const entrypoint = join(distDir, 'index.mjs');
  writeFileSync(entrypoint, 'import "./chunk.mjs";\nexport {};\n', 'utf8');

  const scriptsDir = join(root, 'scripts');
  const toolsDir = join(root, 'tools', 'unpacked');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(toolsDir, { recursive: true });
  for (const relativePath of CLI_RUNTIME_SIDECAR_ENTRIES) {
    const targetPath = join(scriptsDir, ...relativePath);
    if (relativePath[0] === 'runtime' || relativePath[0] === 'shims') {
      mkdirSync(targetPath, { recursive: true });
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, `module.exports = ${JSON.stringify(relativePath.at(-1))};\n`, 'utf8');
  }
  writeFileSync(join(toolsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(join(toolsDir, 'happier-cliproxyapi-managed'), 'managed-runtime', 'utf8');

  const manifest = cliDistBuildManifest.writeCliDistBuildManifest(entrypoint, {
    outputDir: distDir,
    builtAt: '2026-08-25T00:00:00.000Z',
  });
  return { entrypoint, fingerprint: manifest.manifest.fingerprint };
}

function writeManagedJavaScriptRuntime(homeDir: string): string {
  const runtimeDir = join(homeDir, 'tools', 'js-runtime', 'current', 'runtime', 'bin');
  const binDir = join(homeDir, 'tools', 'js-runtime', 'current', 'bin');
  const nodePath = join(runtimeDir, 'node');
  const wrapperPath = join(binDir, 'happier-js-runtime');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(nodePath, '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(wrapperPath, '#!/bin/sh\nexec "$(dirname "$0")/../runtime/bin/node" "$@"\n', 'utf8');
  chmodSync(nodePath, 0o755);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

describe('routeSpawnModeAndWaitForWebhook', () => {
  beforeEach(() => {
    mocks.prepareSourceDevSharedDepsForHappyCliSpawn.mockReset().mockResolvedValue({
      type: 'ready',
      checked: false,
      reason: 'not-source-entrypoint',
    });
    mocks.prepareSourceDevSharedDepsForBundledPluginRuntimeLoad.mockReset().mockResolvedValue({
      type: 'ready',
      checked: false,
      reason: 'not-source-dev',
    });
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue({
      spawnResult: null,
      tmuxRequested: false,
      tmuxFallbackReason: null,
      tmuxCreationDisposition: 'not_created',
    });
    mocks.spawnRegularProcessAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.spawnWindowsHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.resolveWindowsRemoteSessionConsoleMode.mockReset().mockReturnValue('hidden');
    mocks.ensureManagedJavaScriptRuntimeCommand.mockReset();
  });

  afterEach(() => {
    envScope.restore();
  });

  it('provisions the managed runtime before resolving a runtime-backed pinned runner', async () => {
    await withTempDir('happier-runtime-backed-session-spawn-', async (root) => {
      const { entrypoint, fingerprint } = writeRuntimeBackedRunnerFixture(root);
      const homeDir = join(root, 'happier-home');
      const managedRuntimePath = join(homeDir, 'tools', 'js-runtime', 'current', 'bin', 'happier-js-runtime');
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: fingerprint,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_STACK_STACK: 'session-spawn-test',
      });
      const launchEnvironment = { ...process.env };
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: undefined,
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: undefined,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: undefined,
        HAPPIER_STACK_STACK: undefined,
      });
      mocks.ensureManagedJavaScriptRuntimeCommand.mockImplementationOnce(async () => writeManagedJavaScriptRuntime(homeDir));
      const originalExecPath = process.execPath;

      try {
        Object.defineProperty(process, 'execPath', {
          value: join(root, 'happier'),
          configurable: true,
        });
        const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

        await expect(routeSpawnModeAndWaitForWebhook({
          ...createParams(),
          processEnv: launchEnvironment,
        })).resolves.toEqual(successResult);

        expect(mocks.ensureManagedJavaScriptRuntimeCommand).toHaveBeenCalledWith(launchEnvironment);
        const runnerLaunchOptions = mocks.spawnRegularProcessAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
        expect(runnerLaunchOptions?.runtimeDecision).toMatchObject({ runtime: 'node' });
        const { buildHappyCliSubprocessLaunchSpec } = await import('@/utils/spawnHappyCLI');
        expect(buildHappyCliSubprocessLaunchSpec(['opencode'], runnerLaunchOptions)).toMatchObject({
          filePath: managedRuntimePath,
        });
      } finally {
        Object.defineProperty(process, 'execPath', {
          value: originalExecPath,
          configurable: true,
        });
      }
    });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('propagates a runtime bootstrap failure before any spawn host starts', async () => {
    await withTempDir('happier-runtime-backed-session-spawn-failure-', async (root) => {
      const { entrypoint, fingerprint } = writeRuntimeBackedRunnerFixture(root);
      const homeDir = join(root, 'happier-home');
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: fingerprint,
        HAPPIER_HOME_DIR: homeDir,
        HAPPIER_STACK_STACK: 'session-spawn-test',
      });
      const bootstrapFailure = new Error('Managed JavaScript runtime is unavailable: bootstrap failed');
      mocks.ensureManagedJavaScriptRuntimeCommand.mockRejectedValueOnce(bootstrapFailure);
      const originalExecPath = process.execPath;

      try {
        Object.defineProperty(process, 'execPath', {
          value: join(root, 'happier'),
          configurable: true,
        });
        const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

        await expect(routeSpawnModeAndWaitForWebhook({
          ...createParams(),
          processEnv: process.env,
        })).rejects.toBe(bootstrapFailure);
        expect(mocks.spawnTmuxHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
        expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
        expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'execPath', {
          value: originalExecPath,
          configurable: true,
        });
      }
    });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('does not provision a managed runtime for non-runtime-backed spawn paths', async () => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    const processEnv = {
      ...process.env,
      HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined,
    };

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      processEnv,
    })).resolves.toEqual(successResult);

    expect(mocks.ensureManagedJavaScriptRuntimeCommand).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('runs the source-dev shared-deps preflight before selecting a spawn host', async () => {
    const order: string[] = [];
    mocks.prepareSourceDevSharedDepsForHappyCliSpawn.mockImplementationOnce(async () => {
      order.push('preflight');
      return { type: 'ready', checked: true, reason: 'synced' };
    });
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockImplementationOnce(async () => {
      order.push('tmux');
      return {
        spawnResult: successResult,
        tmuxRequested: true,
        tmuxFallbackReason: null,
        tmuxCreationDisposition: 'created_or_uncertain',
      };
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    const params = createParams();

    await expect(routeSpawnModeAndWaitForWebhook({
      ...params,
      terminalRequest: {
        requested: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
          tmpDir: '/tmp/happier-home/tmux',
          source: 'typed',
        },
      },
      options: {
        directory: '/tmp/happier-project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      },
    })).resolves.toEqual(successResult);

    expect(order).toEqual(['preflight', 'tmux']);
    expect(mocks.prepareSourceDevSharedDepsForHappyCliSpawn).toHaveBeenCalledWith({
      args: expect.arrayContaining([
        'opencode',
        '--happy-starting-mode',
        'remote',
        '--started-by',
        'daemon',
      ]),
      launchOptions: { preferWindowsPackagedBinary: true },
      logDebug: params.logDebug,
      workspaceNames: ['plugins-opencode'],
    });
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('threads one provider diagnostic sanitizer through every spawn-mode owner', async () => {
    const sanitizeDiagnosticText = vi.fn((value: string) => value);
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    await routeSpawnModeAndWaitForWebhook({ ...createParams(), sanitizeDiagnosticText });
    expect(mocks.spawnTmuxHostedSessionAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({ sanitizeDiagnosticText }));
    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({ sanitizeDiagnosticText }));

    mocks.resolveWindowsRemoteSessionConsoleMode.mockReturnValueOnce('windows_terminal');
    await routeSpawnModeAndWaitForWebhook({ ...createParams(), sanitizeDiagnosticText });
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({ sanitizeDiagnosticText }));
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('forwards the admitted runner invocation context to regular, tmux, and Windows tracked-session producers', async () => {
    const runnerAgentInvocationContext = Object.freeze({
      cwd: '/tmp/happier-project',
      environment: Object.freeze({}),
      providerBindingActive: true,
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      runnerAgentInvocationContext,
    });

    expect(mocks.spawnTmuxHostedSessionAndWaitForWebhook)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        runnerAgentInvocationContext,
      }));
    expect(mocks.spawnRegularProcessAndWaitForWebhook)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        runnerAgentInvocationContext,
      }));

    mocks.resolveWindowsRemoteSessionConsoleMode
      .mockReturnValueOnce('windows_terminal');
    await routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      runnerAgentInvocationContext,
    });

    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        runnerAgentInvocationContext,
      }));
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('threads one live-runner retention decision through tmux, regular/cgroup, and Windows launch owners', async () => {
    const tracked = {
      pid: 42,
      startedBy: 'daemon',
      processCommand: 'node /repo/apps/cli/.runner-snapshots/live-old/index.mjs opencode',
    };
    const params = createParams();
    const pidToTrackedSession = new Map([[42, tracked]]);
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await routeSpawnModeAndWaitForWebhook({
      ...params,
      pidToTrackedSession,
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0]);
    const tmuxOptions = mocks.spawnTmuxHostedSessionAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
    const regularOptions = mocks.spawnRegularProcessAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
    expect([...tmuxOptions.liveRunnerSnapshotFingerprints.fingerprints]).toEqual(['live-old']);
    expect(regularOptions).toEqual(tmuxOptions);

    mocks.resolveWindowsRemoteSessionConsoleMode.mockReturnValueOnce('console');
    await routeSpawnModeAndWaitForWebhook({
      ...params,
      pidToTrackedSession,
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0]);
    const windowsOptions = mocks.spawnWindowsHostedSessionAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
    expect(windowsOptions).toEqual(tmuxOptions);
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('carries native fork source through tmux, regular, and Windows spawn modes', async () => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    const params = createParams();
    const forkParams = {
      ...params,
      options: {
        ...params.options,
        nativeForkSource,
      },
    };

    await routeSpawnModeAndWaitForWebhook(forkParams);

    const tmuxArgs = mocks.spawnTmuxHostedSessionAndWaitForWebhook.mock.calls.at(-1)?.[0]?.sessionControlArgs;
    const regularArgs = mocks.spawnRegularProcessAndWaitForWebhook.mock.calls.at(-1)?.[0]?.args;
    expect(partitionProviderSessionArgs({
      args: ['opencode', ...tmuxArgs],
      providerSubcommand: 'opencode',
    })).toMatchObject({
      nativeForkSource,
      providerArgs: [],
    });
    expect(partitionProviderSessionArgs({
      args: regularArgs,
      providerSubcommand: 'opencode',
    })).toMatchObject({
      nativeForkSource,
      providerArgs: [],
    });

    mocks.resolveWindowsRemoteSessionConsoleMode.mockReturnValueOnce('windows_terminal');
    await routeSpawnModeAndWaitForWebhook(forkParams);

    const windowsArgs = mocks.spawnWindowsHostedSessionAndWaitForWebhook.mock.calls.at(-1)?.[0]?.args;
    expect(partitionProviderSessionArgs({
      args: windowsArgs,
      providerSubcommand: 'opencode',
    })).toMatchObject({
      nativeForkSource,
      providerArgs: [],
    });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('returns an explicit source-dev preflight diagnostic before any spawn host starts', async () => {
    mocks.prepareSourceDevSharedDepsForHappyCliSpawn.mockResolvedValueOnce({
      type: 'error',
      errorMessage: 'Source-dev CLI shared dependency preflight failed before spawn: dist is stale',
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    const params = createParams();

    await expect(routeSpawnModeAndWaitForWebhook(params)).resolves.toEqual({
      type: 'error',
      errorCode: 'SPAWN_FAILED',
      errorMessage: 'Source-dev CLI shared dependency preflight failed before spawn: dist is stale',
    });

    expect(mocks.spawnTmuxHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
    expect(params.cleanupSpawnResources).toHaveBeenCalledTimes(1);
    expect(params.spawnLifecycleCallbacks.cleanupPendingSessionAttach).toHaveBeenCalledTimes(1);
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('runs the source-dev shared-deps preflight before Windows hosted session starts', async () => {
    const order: string[] = [];
    mocks.resolveWindowsRemoteSessionConsoleMode.mockReturnValueOnce('windows_terminal');
    mocks.prepareSourceDevSharedDepsForHappyCliSpawn.mockImplementationOnce(async () => {
      order.push('preflight');
      return { type: 'ready', checked: true, reason: 'synced' };
    });
    mocks.spawnWindowsHostedSessionAndWaitForWebhook.mockImplementationOnce(async () => {
      order.push('windows');
      return successResult;
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook(createParams())).resolves.toEqual(successResult);

    expect(order).toEqual(['preflight', 'windows']);
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('routes non-hosted remote starts to a regular background process with daemon metadata args', async () => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      accountSettingsVersionHint: 14,
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0] & { accountSettingsVersionHint: number })).resolves.toEqual(successResult);

    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      args: [
        'opencode',
        '--happy-starting-mode',
        'remote',
        '--started-by',
        'daemon',
      ],
      directory: '/tmp/happier-project',
    }));
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('marks tmux fallback regular starts as plain instead of implying a hosted terminal', async () => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockResolvedValueOnce({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'tmux unavailable',
      tmuxCreationDisposition: 'not_created',
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalRequest: {
        requested: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
          tmpDir: '/tmp/happier-home/tmux',
          source: 'typed',
        },
      },
      options: {
        directory: '/tmp/happier-project',
        terminal: { mode: 'tmux', tmux: { sessionName: 'happy', isolated: true } },
      },
    })).resolves.toEqual(successResult);

    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining([
        '--happy-terminal-mode',
        'plain',
        '--happy-terminal-requested',
        'tmux',
        '--happy-terminal-fallback-reason',
        'tmux unavailable',
      ]),
    }));
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('refuses an ambiguous tmux creation outcome without starting a second regular process', async () => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockResolvedValueOnce({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'tmux client timed out after new-window',
      tmuxCreationDisposition: 'created_or_uncertain',
    });
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    const onUntrackedTmuxChild = vi.fn();
    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      onUntrackedTmuxChild,
      terminalRequest: {
        requested: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
          tmpDir: '/tmp/happier-home/tmux',
          source: 'typed',
        },
      },
    })).resolves.toEqual({
      type: 'error',
      errorCode: 'SPAWN_FAILED',
      errorMessage: 'tmux client timed out after new-window',
    });

    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
    expect(onUntrackedTmuxChild).toHaveBeenCalledTimes(1);
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('returns a cleanup-safe no-fallback error after exact tmux absence is verified', async () => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockResolvedValueOnce({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'exact created window was verified absent',
      tmuxCreationDisposition: 'created_and_absent',
    });
    const onUntrackedTmuxChild = vi.fn();
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      onUntrackedTmuxChild,
      terminalRequest: {
        requested: 'tmux',
        tmux: {
          sessionName: 'happy',
          isolated: true,
          tmpDir: '/tmp/happier-home/tmux',
          source: 'typed',
        },
      },
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: 'SPAWN_FAILED',
    });

    expect(onUntrackedTmuxChild).not.toHaveBeenCalled();
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);
});
