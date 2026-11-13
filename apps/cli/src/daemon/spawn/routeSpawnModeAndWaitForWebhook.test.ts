import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { NativeForkSource } from '@/session/shared/spawnSessionContract';
import type { DaemonPluginDevelopmentRootsOwner } from '@/plugins/daemon/developmentRoots';
import { createSpawnHappyCliEnvScope, publishPinnedRunnerSnapshotFixture } from '@/testkit/process/spawnHappyCliHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { SESSION_REQUESTED_DIRECTORY_ENV } from '@/agent/runtime/resolveRequestedSessionDirectory';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const mocks = vi.hoisted(() => ({
  prepareSourceDevSharedDepsForHappyCliSpawn: vi.fn(),
  prepareSourceDevSharedDepsForBundledPluginRuntimeLoad: vi.fn(),
  spawnTmuxHostedSessionAndWaitForWebhook: vi.fn(),
  spawnAdapterHostedSessionAndWaitForWebhook: vi.fn(),
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

vi.mock('./spawnAdapterHostedSessionAndWaitForWebhook', () => ({
  spawnAdapterHostedSessionAndWaitForWebhook: mocks.spawnAdapterHostedSessionAndWaitForWebhook,
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
let developmentRootsOwner: DaemonPluginDevelopmentRootsOwner | undefined;

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
  const processEnv = { ...process.env };
  delete processEnv.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  delete processEnv.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED;
  delete processEnv.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT;
  delete processEnv.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT;
  delete processEnv.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH;
  return {
    // Routing consumes placement captured by the admitted runtime, rather than
    // selecting it again from the Agent id or current account defaults.
    terminalPresentation: { kind: 'runner' as const, startingMode: 'remote' as const },
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
    extraEnvForChildWithMessage: { [SESSION_REQUESTED_DIRECTORY_ENV]: '/tmp/happier-project' },
    processEnv,
    happyHomeDir: '/tmp/happier-home',
    trackedSessionsByKey: new Map(),
    spawnAwaiterByKey: new Map(),
    spawnResultResolverByKey: new Map(),
    spawnWebhookTimeoutByKey: new Map(),
    resolveCanonicalTrackedSessionId: vi.fn(() => 'session-1'),
    onChildExited: vi.fn(),
    spawnLifecycleCallbacks: {
      registerConnectedServiceSpawnTarget: vi.fn(),
      registerSpawnResourceCleanupForSession: vi.fn(),
      consumeSessionAttachCleanupForSession: vi.fn(),
      cleanupPendingSessionAttach: vi.fn(async () => {}),
      persistAcceptedSpawnMarker: vi.fn(async () => {}),
      removeAcceptedSpawnMarkerIfOwned:
        vi.fn(async () => true),
    },
    cleanupSpawnResources: vi.fn(),
    onUntrackedHostedChild: vi.fn(),
    logDebug: vi.fn(),
    warn: vi.fn(),
  } as const;
}

function writeRuntimeBackedRunnerFixture(root: string): Readonly<{
  entrypoint: string;
  fingerprint: string;
  runtimeStatePath: string;
}> {
  const closure = publishPinnedRunnerSnapshotFixture({
    stagingRoot: join(root, '.runner-snapshots', '.staging'),
    workspaceRuntimeIdentity: '9'.repeat(64),
  });
  const runtimeStatePath = join(root, 'stack.runtime.json');
  writeFileSync(runtimeStatePath, JSON.stringify({ version: 1, stackName: 'session-spawn-test', daemon: {} }));
  return { entrypoint: closure.snapshotEntrypoint, fingerprint: closure.fingerprint, runtimeStatePath };
}

describe('routeSpawnModeAndWaitForWebhook', () => {
  beforeAll(async () => {
    // The daemon owns a real applied runtime before accepting any spawn request.
    mocks.prepareSourceDevSharedDepsForBundledPluginRuntimeLoad.mockResolvedValue({
      type: 'ready', checked: false, reason: 'not-source-dev',
    });
    const [{ configuration }, { resolveExecutablePluginRuntimeRegistry }, { pluginReloadController }, { createDaemonPluginDevelopmentRootsOwner }] = await Promise.all([
      import('@/configuration'),
      import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry'),
      import('@/plugins/runtime/reload/singleton'),
      import('@/plugins/daemon/developmentRoots'),
    ]);
    developmentRootsOwner = createDaemonPluginDevelopmentRootsOwner({
      happyHomeDir: configuration.happyHomeDir,
      submitObservation: async () => {
        throw new Error('The spawn fixture does not observe development source changes');
      },
    });
    const registry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: configuration.happyHomeDir,
      generation: 1,
      resolveDevelopmentSourceAuthority: developmentRootsOwner.resolveDevelopmentSourceAuthority,
    });
    const adoption = await pluginReloadController.adoptPreparedRuntimeRegistry({
      registry,
      changedPluginIds: [],
      durableRevision: 1,
      runningSessionDisposition: 'retainRunningSessions',
    });
    if (!adoption.ok) throw new Error('Failed to prepare the daemon runtime for spawn routing');
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  afterAll(async () => {
    const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
    await pluginReloadController.shutdown();
    await developmentRootsOwner?.stop();
  });

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
    mocks.spawnAdapterHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue(null);
    mocks.spawnRegularProcessAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.spawnWindowsHostedSessionAndWaitForWebhook.mockReset().mockResolvedValue(successResult);
    mocks.resolveWindowsRemoteSessionConsoleMode.mockReset().mockReturnValue('hidden');
    mocks.ensureManagedJavaScriptRuntimeCommand.mockReset();
  });

  afterEach(() => {
    envScope.restore();
  });

  it('routes an interactive Herdr request through the shared adapter-hosted launcher', async () => {
    mocks.spawnAdapterHostedSessionAndWaitForWebhook.mockResolvedValueOnce(successResult);
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
    })).resolves.toEqual(successResult);

    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook).toHaveBeenCalledWith(expect.objectContaining({
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
    }));
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it.each(['opencode', 'codex'])('keeps selected %s ACP headless even when Herdr is requested', async (agentId) => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalPresentation: { kind: 'none' },
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: agentId },
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
      options: {
        directory: '/tmp/happier-project',
        runtimeDescriptorV1: { v: 1, agentId, agent: { backendMode: 'acp' } },
      },
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0])).resolves.toEqual(successResult);

    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook.mock.calls[0]?.[0].terminalRequest).toEqual({ requested: 'plain' });
    expect(mocks.spawnRegularProcessAndWaitForWebhook).toHaveBeenCalledOnce();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it.each(['gemini', 'auggie'])('keeps %s headless when the RPC omits a runtime descriptor', async (agentId) => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalPresentation: { kind: 'none' },
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: agentId },
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
    })).resolves.toEqual(successResult);

    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook.mock.calls[0]?.[0].terminalRequest).toEqual({ requested: 'plain' });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it.each([
    ['claude', 'runner'],
    ['codex', 'provider_attach'],
    ['opencode', 'provider_attach'],
  ] as const)('consumes captured %s %s placement without selecting another controller host', async (agentId, kind) => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    const terminalRequest = { requested: 'herdr' as const, herdr: { sessionName: 'default' } };

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalPresentation: { kind, startingMode: kind === 'runner' ? 'remote' : 'terminal' },
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: agentId },
      terminalRequest,
    })).resolves.toEqual(successResult);

    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook.mock.calls[0]?.[0].terminalRequest)
      .toEqual(kind === 'runner' ? terminalRequest : { requested: 'plain' });
    if (kind === 'provider_attach') {
      expect(mocks.spawnRegularProcessAndWaitForWebhook.mock.calls[0]?.[0].args).toEqual(expect.arrayContaining([
        '--happy-starting-mode', 'terminal', '--happy-terminal-mode', 'plain',
        '--happy-terminal-requested', 'herdr',
      ]));
    }
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it.each(['codex', 'opencode'])('honors the %s config-selected ACP runtime without a descriptor', async (agentId) => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalPresentation: { kind: 'none' },
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: agentId },
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
      options: {
        directory: '/tmp/happier-project',
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {
          [`${agentId}BackendMode`]: { value: 'acp', updatedAt: 1 },
        } },
      },
    })).resolves.toEqual(successResult);
    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook.mock.calls[0]?.[0].terminalRequest).toEqual({ requested: 'plain' });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('keeps configured ACP targets headless even when their ID matches a built-in runtime', async () => {
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');
    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      terminalPresentation: { kind: 'none' },
      effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'configured', backendId: 'codex', configuredBackendId: 'codex' },
      terminalRequest: { requested: 'herdr', herdr: { sessionName: 'default' } },
    })).resolves.toEqual(successResult);
    expect(mocks.spawnAdapterHostedSessionAndWaitForWebhook.mock.calls[0]?.[0].terminalRequest).toEqual({ requested: 'plain' });
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('propagates a runtime bootstrap failure before any spawn host starts', async () => {
    await withTempDir('happier-runtime-backed-session-spawn-failure-', async (root) => {
      const { entrypoint, fingerprint, runtimeStatePath } = writeRuntimeBackedRunnerFixture(root);
      const homeDir = join(root, 'happier-home');
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
        HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: fingerprint,
        HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH: runtimeStatePath,
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
      processEnv: params.processEnv,
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
      trackingKey: legacyPidSessionTrackingKey(42), pid: 42,
      startedBy: 'daemon',
      processCommand: 'node /repo/apps/cli/.runner-snapshots/live-old/index.mjs opencode',
    };
    const params = createParams();
    const trackedSessionsByKey = new Map([[tracked.trackingKey, tracked]]);
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await routeSpawnModeAndWaitForWebhook({
      ...params,
      trackedSessionsByKey,
    } as Parameters<typeof routeSpawnModeAndWaitForWebhook>[0]);
    const tmuxOptions = mocks.spawnTmuxHostedSessionAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
    const regularOptions = mocks.spawnRegularProcessAndWaitForWebhook.mock.calls.at(-1)?.[0]?.runnerLaunchOptions;
    expect([...tmuxOptions.liveRunnerSnapshotFingerprints.fingerprints]).toEqual(['live-old']);
    expect(regularOptions).toEqual(tmuxOptions);

    mocks.resolveWindowsRemoteSessionConsoleMode.mockReturnValueOnce('console');
    await routeSpawnModeAndWaitForWebhook({
      ...params,
      trackedSessionsByKey,
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
      directory: process.cwd(),
      extraEnvForChildWithMessage: expect.objectContaining({ HAPPIER_SESSION_REQUESTED_DIRECTORY: '/tmp/happier-project' }),
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

    const onUntrackedHostedChild = vi.fn();
    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      onUntrackedHostedChild,
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
    expect(onUntrackedHostedChild).toHaveBeenCalledTimes(1);
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);

  it('returns a cleanup-safe no-fallback error after exact tmux absence is verified', async () => {
    mocks.spawnTmuxHostedSessionAndWaitForWebhook.mockResolvedValueOnce({
      spawnResult: null,
      tmuxRequested: true,
      tmuxFallbackReason: 'exact created window was verified absent',
      tmuxCreationDisposition: 'created_and_absent',
    });
    const onUntrackedHostedChild = vi.fn();
    const { routeSpawnModeAndWaitForWebhook } = await import('./routeSpawnModeAndWaitForWebhook');

    await expect(routeSpawnModeAndWaitForWebhook({
      ...createParams(),
      onUntrackedHostedChild,
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

    expect(onUntrackedHostedChild).not.toHaveBeenCalled();
    expect(mocks.spawnRegularProcessAndWaitForWebhook).not.toHaveBeenCalled();
    expect(mocks.spawnWindowsHostedSessionAndWaitForWebhook).not.toHaveBeenCalled();
  }, ROUTE_SPAWN_MODE_TEST_TIMEOUT_MS);
});
