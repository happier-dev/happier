import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';

import type { ProviderCliLaunchSpec } from '@/backends/opencode/utils/resolveOpenCodeCliCommand';

import {
  persistManagedOpenCodeBrokerActivationProof,
  readSharedManagedOpenCodeServerStateByBaseUrlBestEffort,
  readSharedManagedOpenCodeServerStateBestEffort,
  rehydrateManagedOpenCodeBrokerActivationProof,
  resolveManagedOpenCodeDaemonOwnerIdFromState,
  resolveSharedManagedOpenCodeServerStatePathForEnv,
  resolveSharedManagedOpenCodeServerBaseUrl,
  stopSharedManagedOpenCodeServerFromState,
  stopSharedManagedOpenCodeServerFromEnvBestEffort,
  type ManagedOpenCodeBrokerActivationExpectation,
  type SharedManagedOpenCodeServerState,
} from './sharedManagedServer';
import { resolveOpenCodeManagedServerLaunchFingerprint } from './openCodeManagedServerEnv';

function hashCommandLine(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('resolveManagedOpenCodeDaemonOwnerIdFromState', () => {
  it('changes owner when a daemon self-restart inherits the runtime id in a new process', () => {
    const beforeRestart = resolveManagedOpenCodeDaemonOwnerIdFromState({
      runtimeId: 'runtime-a',
      pid: 111,
      startedAt: 1_000,
    }, 'cloud');
    const afterRestart = resolveManagedOpenCodeDaemonOwnerIdFromState({
      runtimeId: 'runtime-a',
      pid: 222,
      startedAt: 2_000,
    }, 'cloud');

    expect(beforeRestart).toBe('runtime-a:111:1000');
    expect(afterRestart).toBe('runtime-a:222:2000');
  });
});

describe('managed OpenCode broker activation proof continuity', () => {
  const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
  const expectation: ManagedOpenCodeBrokerActivationExpectation = {
    runtimeKind: 'opencode_managed_server',
    selectionIdentity: 'opencode|connected|broker:1|openai-codex:primary:',
    loadNonce: 'exact-child-generation-nonce',
    providers: ['openai'],
    pluginVersion: '1',
  };

  function createState(
    overrides: Partial<SharedManagedOpenCodeServerState> = {},
  ): SharedManagedOpenCodeServerState {
    return {
      v: 2,
      baseUrl: 'http://127.0.0.1:1234',
      pid: 4242,
      startedAtMs: 1_000,
      status: 'ready',
      launchEnvFingerprint: 'connected-openai-primary',
      ownerToken: 'owner-token-a',
      startTimeMs: 2_500,
      processInstanceFingerprint: 'win32-cim:2026-07-30T10:00:00.0000000Z',
      expectedCmdlineHash: hashCommandLine(commandLine),
      activeServerDir: '/tmp/happy/servers/cloud',
      daemonInstanceId: 'old-daemon',
      brokerLoadNonce: expectation.loadNonce,
      ...overrides,
    };
  }

  function createProofDeps(
    initialStates: Readonly<Record<string, SharedManagedOpenCodeServerState>>,
    overrides: Partial<Readonly<{
      isPidAlive: (pid: number) => boolean;
      processCommand: string;
      observedStartTimeMs: number | null;
      observedProcessInstanceFingerprint: string | null;
      brokerStateUsable: boolean | (() => boolean);
    }>> = {},
  ) {
    const states = new Map(Object.entries(initialStates));
    return {
      states,
      deps: {
        listStateKeys: async () => [...states.keys()],
        withStateLock: async <T>(_stateKey: string, fn: () => Promise<T>) => await fn(),
        readState: async (stateKey: string) => states.get(stateKey) ?? null,
        writeState: async (stateKey: string, state: SharedManagedOpenCodeServerState) => {
          states.set(stateKey, state);
        },
        isPidAlive: overrides.isPidAlive ?? (() => true),
        getProcessInfo: async () => ({
          name: 'opencode',
          cmd: overrides.processCommand ?? commandLine,
        }),
        readProcessStartTimeMs: async () =>
          Object.prototype.hasOwnProperty.call(overrides, 'observedStartTimeMs')
            ? overrides.observedStartTimeMs ?? null
            : 2_501,
        readProcessInstanceFingerprint: async () =>
          overrides.observedProcessInstanceFingerprint !== undefined
            ? overrides.observedProcessInstanceFingerprint
            : 'win32-cim:2026-07-30T10:00:00.0000000Z',
        currentActiveServerDir: '/tmp/happy/servers/cloud',
        isCurrentBrokerStateUsable: async () => typeof overrides.brokerStateUsable === 'function'
          ? overrides.brokerStateUsable()
          : overrides.brokerStateUsable ?? true,
      },
    };
  }

  async function activate(
    harness: ReturnType<typeof createProofDeps>,
  ): Promise<SharedManagedOpenCodeServerState> {
    await expect(persistManagedOpenCodeBrokerActivationProof({
      ...expectation,
      processPid: 4242,
      observedAtMs: 3_000,
    }, harness.deps)).resolves.toBe(true);
    const state = harness.states.get('state');
    expect(state?.brokerActivationProof).toBeDefined();
    return state as SharedManagedOpenCodeServerState;
  }

  it('persists one exact current-daemon observation and rehydrates it after the daemon map is lost', async () => {
    const harness = createProofDeps({ state: createState() });
    await activate(harness);
    expect(harness.states.get('state')).toEqual(expect.objectContaining({
      brokerActivationProof: expect.objectContaining({
        v: 1,
        selectionIdentityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        loadNonce: expectation.loadNonce,
        providers: ['openai'],
        pluginVersion: '1',
        processPid: 4242,
        managedChildGenerationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    }));
    expect(harness.states.get('state')?.brokerActivationProof).not.toHaveProperty('selectionIdentity');

    // Daemon B has no process-local handshake map. Exact proof consumption is driven entirely by
    // the existing managed-child state plus final process/current-broker revalidation.
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, harness.deps),
    ).resolves.toBe(true);
  });

  it('uses the Windows CIM process-birth fingerprint when POSIX start-time evidence is unavailable', async () => {
    const matching = createProofDeps(
      { state: createState() },
      { observedStartTimeMs: null },
    );
    await activate(matching);
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, matching.deps),
    ).resolves.toBe(true);

    const mismatched = createProofDeps(
      { state: matching.states.get('state') as SharedManagedOpenCodeServerState },
      {
        observedStartTimeMs: null,
        observedProcessInstanceFingerprint: 'win32-cim:2026-07-30T10:00:01.0000000Z',
      },
    );
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, mismatched.deps),
    ).resolves.toBe(false);
  });

  it('does not treat plugin-file or nonce presence as activation proof', async () => {
    const harness = createProofDeps({ state: createState() });
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, harness.deps),
    ).resolves.toBe(false);
  });

  it.each([
    ['loadNonce', 'other-nonce'],
    ['processPid', 4343],
    ['providers', ['anthropic']],
    ['pluginVersion', '2'],
  ] as const)('rejects a proof with changed %s', async (field, value) => {
    const harness = createProofDeps({ state: createState() });
    const activatedState = await activate(harness);
    harness.states.set('state', {
      ...activatedState,
      brokerActivationProof: {
        ...(activatedState.brokerActivationProof as NonNullable<typeof activatedState.brokerActivationProof>),
        [field]: value,
      },
    });
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, harness.deps),
    ).resolves.toBe(false);
  });

  it.each([
    ['missing owner token', { ownerToken: undefined }],
    ['changed nonempty owner token', { ownerToken: 'owner-token-b' }],
    ['changed launch fingerprint', { launchEnvFingerprint: 'other-launch' }],
  ] as const)('rejects a generation whose %s no longer matches the activation fact', async (_label, change) => {
    const harness = createProofDeps({ state: createState() });
    const activatedState = await activate(harness);
    harness.states.set('state', { ...activatedState, ...change });
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, harness.deps),
    ).resolves.toBe(false);
  });

  it('rejects dead/reused processes, changed birth/command, unusable broker state, and duplicate owners', async () => {
    const seed = createProofDeps({ state: createState() });
    const activatedState = await activate(seed);

    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps(
        { state: activatedState },
        { isPidAlive: () => false },
      ).deps,
    )).resolves.toBe(false);
    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps(
        { state: activatedState },
        { observedProcessInstanceFingerprint: 'win32-cim:2026-07-30T11:00:00.0000000Z' },
      ).deps,
    )).resolves.toBe(false);
    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps(
        { state: activatedState },
        { processCommand: 'foreign serve --hostname=127.0.0.1 --port=1234' },
      ).deps,
    )).resolves.toBe(false);
    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps(
        { state: activatedState },
        { brokerStateUsable: false },
      ).deps,
    )).resolves.toBe(false);
    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps({
        a: activatedState,
        b: activatedState,
      }).deps,
    )).resolves.toBe(false);
  });

  it('retains start-time identity checks for legacy managed-child states', async () => {
    const seed = createProofDeps({
      state: createState({ processInstanceFingerprint: undefined }),
    });
    const activatedState = await activate(seed);

    await expect(rehydrateManagedOpenCodeBrokerActivationProof(
      expectation,
      createProofDeps(
        { state: activatedState },
        {
          observedStartTimeMs: 9_999,
          observedProcessInstanceFingerprint: null,
        },
      ).deps,
    )).resolves.toBe(false);
  });

  it('rechecks broker currentness after proof persistence and after every uniqueness scan await', async () => {
    let persistChecks = 0;
    const persistHarness = createProofDeps(
      { state: createState() },
      { brokerStateUsable: () => ++persistChecks < 3 },
    );
    await expect(persistManagedOpenCodeBrokerActivationProof({
      ...expectation,
      processPid: 4242,
      observedAtMs: 3_000,
    }, persistHarness.deps)).resolves.toBe(false);

    const seed = createProofDeps({ state: createState() });
    const activatedState = await activate(seed);
    let rehydrateChecks = 0;
    const rehydrateHarness = createProofDeps({
      matching: activatedState,
      laterUnmatched: createState({
        pid: 5252,
        brokerLoadNonce: 'other-generation',
      }),
    }, {
      brokerStateUsable: () => ++rehydrateChecks < 3,
    });
    await expect(
      rehydrateManagedOpenCodeBrokerActivationProof(expectation, rehydrateHarness.deps),
    ).resolves.toBe(false);
  });
});

describe('resolveSharedManagedOpenCodeServerBaseUrl', () => {
  it('finds the exact target state in another launch-fingerprint pool', async () => {
    const defaultState: SharedManagedOpenCodeServerState = {
      baseUrl: 'http://127.0.0.1:4100',
      pid: 4100,
      startedAtMs: 1,
      authPassword: 'default-secret',
    };
    const targetState: SharedManagedOpenCodeServerState = {
      baseUrl: 'http://127.0.0.1:4200',
      pid: 4200,
      startedAtMs: 2,
      authPassword: 'target-secret',
    };
    const statesByPath = new Map([
      ['/managed-servers/default.json', defaultState],
      ['/managed-servers/connected-profile.json', targetState],
    ]);

    await expect(readSharedManagedOpenCodeServerStateByBaseUrlBestEffort(
      'http://127.0.0.1:4200/',
      {
        readCurrentState: async () => defaultState,
        listPooledStatePaths: async () => [...statesByPath.keys()],
        readStatePath: async (statePath) => statesByPath.get(statePath) ?? null,
      },
    )).resolves.toEqual(targetState);
  });

  it('scopes the default managed-server state path by launch fingerprint without raw auth content', () => {
    const envA = {
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'sk-account-a' } }),
    };
    const envB = {
      HOME: '/Users/example',
      OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'sk-account-b' } }),
    };

    const statePathA = resolveSharedManagedOpenCodeServerStatePathForEnv(envA);
    const statePathB = resolveSharedManagedOpenCodeServerStatePathForEnv(envB);

    expect(statePathA).not.toBe(statePathB);
    expect(statePathA).toContain('managed-servers');
    expect(statePathA).not.toContain('sk-account-a');
    expect(statePathA).not.toContain(envA.OPENCODE_AUTH_CONTENT);
  });

  it('expands ~/ state path overrides against HOME when reading shared managed server state', async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), 'opencode-managed-state-'));
    const homeDir = join(tempRoot, 'home');
    const statePath = join(homeDir, '.opencode', 'managed-server.json');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

    await mkdir(join(homeDir, '.opencode'), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 1234,
        startedAtMs: 5,
        status: 'ready',
      }),
      'utf8',
    );

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = '~/.opencode/managed-server.json';

    try {
      await expect(readSharedManagedOpenCodeServerStateBestEffort()).resolves.toEqual({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 1234,
        startedAtMs: 5,
        status: 'ready',
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      if (previousStatePath === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousStatePath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('preserves the optional logPath when reading shared managed server state', async () => {
    const tempRoot = await mkdtemp(join(os.tmpdir(), 'opencode-managed-state-logpath-'));
    const homeDir = join(tempRoot, 'home');
    const statePath = join(homeDir, '.opencode', 'managed-server.json');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;

    await mkdir(join(homeDir, '.opencode'), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 1234,
        startedAtMs: 5,
        status: 'ready',
        logPath: '/logs/opencode-managed-servers/a.log',
      }),
      'utf8',
    );

    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = '~/.opencode/managed-server.json';

    try {
      await expect(readSharedManagedOpenCodeServerStateBestEffort()).resolves.toEqual({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 1234,
        startedAtMs: 5,
        status: 'ready',
        logPath: '/logs/opencode-managed-servers/a.log',
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
      if (previousStatePath === undefined) {
        delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
      } else {
        process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousStatePath;
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('reuses an existing healthy managed server when pid is alive', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        launchEnvFingerprint: 'scope-a',
      })),
      writeState: vi.fn(async (_state: unknown) => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      currentLaunchFingerprint: 'scope-a',
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('replaces a healthy brokered server whose pre-fix state has no generation nonce', async () => {
    const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        launchEnvFingerprint: 'scope-a',
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
      })),
      writeState: vi.fn(async (_state: unknown) => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: commandLine })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(async () => true),
      startServer: vi.fn(async (params?: {
        onSpawned?: (started: {
          baseUrl: string;
          pid: number;
          brokerLoadNonce?: string;
        }) => void | Promise<void>;
      }) => {
        const started = {
          baseUrl: 'http://127.0.0.1:9999',
          pid: 222,
          brokerLoadNonce: 'replacement-generation-nonce',
        };
        await params?.onSpawned?.(started);
        return started;
      }),
      currentLaunchFingerprint: 'scope-a',
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      currentBrokerLoadNonceRequired: true,
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({
      baseUrl: 'http://127.0.0.1:9999',
      didStart: true,
      brokerLoadNonce: 'replacement-generation-nonce',
    });
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState).toHaveBeenLastCalledWith(expect.objectContaining({
      pid: 222,
      status: 'ready',
      brokerLoadNonce: 'replacement-generation-nonce',
    }));
  });

  it('probes a reuse candidate with the credential retained for that server and keeps it across restarts', async () => {
    // Released OpenCode 2 answers 401 to an unauthenticated probe, so a reuse probe without the
    // retained credential would report a healthy managed server as unusable and churn a replacement.
    const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        launchEnvFingerprint: 'scope-a',
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'old-daemon',
        apiGeneration: 'auto' as const,
        authPassword: 'retained-secret',
      })),
      writeState: vi.fn(async (_state: unknown) => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: commandLine })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      currentLaunchFingerprint: 'scope-a',
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'new-daemon',
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toMatchObject({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.probeHealth).toHaveBeenCalledWith(
      'http://127.0.0.1:1234',
      'auto',
      { username: 'opencode', password: 'retained-secret' },
    );
    expect(deps.startServer).not.toHaveBeenCalled();
    // The recovery write must not drop the credential, or the next reader loses access to this server.
    expect(deps.writeState).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'ready',
      authPassword: 'retained-secret',
    }));
  });

  it('retains the password of a freshly started managed server from the first state write', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async (_state: unknown) => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve' })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: {
        onSpawned?: (started: {
          baseUrl: string;
          pid: number;
          authPassword?: string;
        }) => void | Promise<void>;
      }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222, authPassword: 'minted-secret' });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222, authPassword: 'minted-secret' };
      }),
      currentLaunchFingerprint: 'scope-a',
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toMatchObject({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.writeState.mock.calls.map(([state]) => state)).toEqual([
      expect.objectContaining({ status: 'starting', authPassword: 'minted-secret' }),
      expect.objectContaining({ status: 'ready', authPassword: 'minted-secret' }),
    ]);
  });

  it('reuses a healthy current-generation managed server across daemon replacement', async () => {
    const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        launchEnvFingerprint: 'scope-a',
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'old-daemon',
      })),
      writeState: vi.fn(async (_state: unknown) => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: commandLine })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      currentLaunchFingerprint: 'scope-a',
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'new-daemon',
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.probeHealth).toHaveBeenCalledWith('http://127.0.0.1:1234', undefined, null);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('Lane F: a same-account token refresh keeps the launch fingerprint stable so the managed server is reused (zero restarts)', async () => {
    // Compose the REAL fingerprint resolver (Lane A stable selection identity) with the managed-server
    // reuse path: a same-account token rotation (rotated OPENCODE_AUTH_CONTENT bytes, unchanged
    // connected-service selection identity) must yield an IDENTICAL launch fingerprint, so the server
    // is reused with no respawn and no kill. This is Lane F's prevention invariant: same-account
    // refresh => zero OpenCode server restarts and zero fingerprint changes (no churn => no TUI orphan,
    // no mid-turn teardown).
    const selectionIdentity = 'opencode|connected|openai-codex|profile-a';
    const fingerprintBeforeRefresh = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'access-1', refresh: 'refresh-1', expires: 111 } }),
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: selectionIdentity,
    });
    const fingerprintAfterRefresh = resolveOpenCodeManagedServerLaunchFingerprint({
      baseEnv: {
        HOME: '/Users/example',
        // Same account; only the rotating token bytes change.
        OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'oauth', access: 'access-2', refresh: 'refresh-2', expires: 222 } }),
      },
      xdgRootDir: '/xdg-root',
      isolateConfig: true,
      connectedServiceSelectionIdentity: selectionIdentity,
    });

    expect(fingerprintAfterRefresh).toBe(fingerprintBeforeRefresh);

    const killPid = vi.fn(() => true);
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        launchEnvFingerprint: fingerprintBeforeRefresh,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --hostname=127.0.0.1 --port=1234' })),
      killPid,
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      // After the refresh, the session re-materializes and resolves the SAME launch fingerprint.
      currentLaunchFingerprint: fingerprintAfterRefresh,
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('terminates a trusted healthy managed server when its launch env fingerprint no longer matches the current desired scope', async () => {
    const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: commandLine })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      readProcessInstanceFingerprint: vi.fn(async () => 'linux-proc:90'),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      currentLaunchFingerprint: 'scope-b',
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [
        {
          v: 2,
          baseUrl: 'http://127.0.0.1:9999',
          pid: 222,
          startedAtMs: 5,
          status: 'starting',
          launchEnvFingerprint: 'scope-b',
          processInstanceFingerprint: 'linux-proc:90',
          ownerToken: expect.any(String),
          startTimeMs: expect.any(Number),
          expectedCmdlineHash: expect.any(String),
          activeServerDir: '/tmp/happy/servers/cloud',
          daemonInstanceId: 'cloud',
        },
      ],
      [
        {
          v: 2,
          baseUrl: 'http://127.0.0.1:9999',
          pid: 222,
          startedAtMs: 5,
          status: 'ready',
          launchEnvFingerprint: 'scope-b',
          processInstanceFingerprint: 'linux-proc:90',
          ownerToken: expect.any(String),
          startTimeMs: expect.any(Number),
          expectedCmdlineHash: expect.any(String),
          activeServerDir: '/tmp/happy/servers/cloud',
          daemonInstanceId: 'cloud',
        },
      ],
    ]);
  });

  it('does not probe health for non-loopback state baseUrl (prevents SSRF if state file is tampered)', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://example.com:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => {
        throw new Error('probeHealth should not be called for non-loopback baseUrl');
      }),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
  });

  it('starts a new managed server when no state exists', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'ready' }],
    ]);
  });

  it('persists the managed-server logPath into the starting and ready state writes', async () => {
    const logPath = '/logs/opencode-managed-servers/2026-06-22-17-24-54-port-9999-pid-222.log';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number; logPath?: string; apiGeneration?: 'v2' }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222, logPath, apiGeneration: 'v2' });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222, logPath, apiGeneration: 'v2' as const };
      }),
      nowMs: () => 5,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'starting', logPath, apiGeneration: 'v2' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'ready', logPath, apiGeneration: 'v2' }],
    ]);
  });

  it('starts a new managed server when the recorded pid is dead', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 7,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 7, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 7, status: 'ready' }],
    ]);
  });

  it('retains unhealthy live legacy custody when only the broad opencode serve shape matches', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/Cannot release the previous managed OpenCode server/);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('retains failed live legacy custody when only the broad opencode serve shape matches', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/Cannot release the previous managed OpenCode server/);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('kills an unhealthy trusted v2 state when command hash and start time still match', async () => {
    const commandLine = 'node /tmp/custom-launch.js serve --hostname=127.0.0.1 --port=1234';
    const wrapperLaunchSpec = {
      command: 'node',
      args: ['/tmp/custom-launch.js'],
      resolvedPath: '/tmp/custom-launch.js',
      source: 'override',
    } as const satisfies ProviderCliLaunchSpec;
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({
        name: 'node',
        cmd: commandLine,
      })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      resolveLaunchSpec: vi.fn(() => wrapperLaunchSpec),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.startServer).toHaveBeenCalledTimes(1);
  });

  it('starts a replacement without killing when trusted v2 process identity mismatches', async () => {
    const recordedCommandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const liveCommandLine = 'opencode serve --hostname=127.0.0.1 --port=1234 --unrelated-owner';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(recordedCommandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({
        name: 'opencode',
        cmd: liveCommandLine,
      })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
  });

  it('retains unhealthy live legacy custody without exact launch identity', async () => {
    const wrapperLaunchSpec = {
      command: 'node',
      args: ['/tmp/custom-launch.js'],
      resolvedPath: '/tmp/custom-launch.js',
      source: 'override',
    } as const satisfies ProviderCliLaunchSpec;
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({
        name: 'opencode',
        cmd: 'opencode serve --hostname=127.0.0.1 --port=1234',
      })),
      resolveLaunchSpec: vi.fn(() => wrapperLaunchSpec),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/Cannot release the previous managed OpenCode server/);
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
  });

  it('starts a new managed server after a failed startup when the recorded pid no longer looks like opencode', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        ownerToken: 'previous-owner',
        expectedCmdlineHash: hashCommandLine('opencode serve --hostname=127.0.0.1 --port=1234'),
        startTimeMs: 2500,
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'python3', cmd: 'python worker.py' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      readProcessStartTimeMs: async () => 2500,
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it('starts a new managed server after a failed startup when the recorded pid is no longer alive', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:9999', didStart: true });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.startServer).toHaveBeenCalledTimes(1);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 9, status: 'ready' }],
    ]);
  });

  it.each(['termination failed', 'identity unavailable'] as const)('retains live managed-server custody when %s during replacement', async (failure) => {
    const commandLine = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        v: 2 as const,
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
        ownerToken: 'owner-token-a',
        startTimeMs: 2_500,
        expectedCmdlineHash: hashCommandLine(commandLine),
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'cloud',
      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => failure === 'identity unavailable' ? null : ({ name: 'opencode', cmd: commandLine })),
      readProcessStartTimeMs: vi.fn(async () => 2_501),
      killPid: vi.fn(() => {
        throw new Error('stuck process');
      }),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        return { baseUrl: 'http://127.0.0.1:9999', pid: 222 };
      }),
      currentActiveServerDir: '/tmp/happy/servers/cloud',
      currentDaemonInstanceId: 'cloud',
      nowMs: () => 9,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/Cannot release the previous managed OpenCode server/);
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
    if (failure === 'termination failed') expect(deps.killPid).toHaveBeenCalledWith(111);
    else expect(deps.killPid).not.toHaveBeenCalled();
  });

  it('reuses a previously failed managed server when the pid is alive and health probe now succeeds', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'failed' as const,
        lastFailureAtMs: 2,
        apiGeneration: 'v2' as const,
        v: 2 as const,
        ownerToken: 'recovered-owner',
        expectedCmdlineHash: hashCommandLine('opencode serve --port 1234'),
        startTimeMs: 2500,
        activeServerDir: '/tmp/happy/servers/cloud',
        daemonInstanceId: 'prior-daemon',

      })),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
      startServer: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:9999', pid: 222 })),
      nowMs: () => 9,
    };

    const out = await resolveSharedManagedOpenCodeServerBaseUrl(deps);

    expect(out).toEqual({ baseUrl: 'http://127.0.0.1:1234', didStart: false });
    expect(deps.startServer).not.toHaveBeenCalled();
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.writeState).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:1234',
      pid: 111,
      startedAtMs: 1,
      status: 'ready',
      apiGeneration: 'v2',
      v: 2,
      ownerToken: 'recovered-owner',
      expectedCmdlineHash: hashCommandLine('opencode serve --port 1234'),
      startTimeMs: 2500,
      activeServerDir: '/tmp/happy/servers/cloud',
      daemonInstanceId: 'prior-daemon',

    });
  });

  it('records a failed provisional state when startup fails after spawn', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => null),
      writeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => false),
      probeHealth: vi.fn(async () => false),
      startServer: vi.fn(async (params?: { onSpawned?: (started: { baseUrl: string; pid: number }) => void | Promise<void> }) => {
        await params?.onSpawned?.({ baseUrl: 'http://127.0.0.1:9999', pid: 222 });
        throw new Error('startup timeout');
      }),
      nowMs: () => 5,
    };

    await expect(resolveSharedManagedOpenCodeServerBaseUrl(deps)).rejects.toThrow(/startup timeout/);
    expect(deps.writeState.mock.calls).toEqual([
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'starting' }],
      [{ baseUrl: 'http://127.0.0.1:9999', pid: 222, startedAtMs: 5, status: 'failed', lastFailureAtMs: 5 }],
    ]);
  });
});

describe('stopSharedManagedOpenCodeServerFromEnvBestEffort daemon shutdown', () => {
  async function writeClaimMarker(happySessionId: string, metadata: Readonly<Record<string, unknown>>) {
    const { configuration } = await import('@/configuration');
    const { resolveReleaseRingScopedBasename } = await import('@/cli/runtime/publicReleaseChannel');
    const markerDir = join(configuration.happyHomeDir, 'tmp',
      resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing));
    await mkdir(markerDir, { recursive: true });
    const markerPath = join(markerDir, `pid-${process.pid}.json`);
    await writeFile(markerPath, JSON.stringify({ pid: process.pid, happySessionId,
      happyHomeDir: configuration.happyHomeDir, createdAt: 1, updatedAt: 1, flavor: 'opencode', metadata }));
    return markerPath;
  }

  it.each(['flavor-only', 'malformed', 'unreadable'] as const)(
    'retains owned servers when the real session registry has %s custody', async (kind) => {
      const { configuration } = await import('@/configuration');
      const { resolveReleaseRingScopedBasename } = await import('@/cli/runtime/publicReleaseChannel');
      const markerDir = join(configuration.happyHomeDir, 'tmp',
        resolveReleaseRingScopedBasename('daemon-sessions', configuration.publicReleaseRing));
      const markerPath = join(markerDir, `pid-${process.pid}.json`);
      const command = 'opencode serve --hostname=127.0.0.1 --port=1234';
      let state: SharedManagedOpenCodeServerState | null = {
        v: 2, baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1,
        daemonInstanceId: 'current-daemon', activeServerDir: '/tmp/current-server',
        ownerToken: 'exact-owner', expectedCmdlineHash: hashCommandLine(command),
        startTimeMs: 10_000, launchEnvFingerprint: 'connected-active',
      };
      const killed: number[] = [];
      try {
        await mkdir(markerDir, { recursive: true });
        if (kind === 'flavor-only') {
          await writeClaimMarker('active-session', { launchEnvFingerprint: 'connected-active' });
        } else if (kind === 'malformed') {
          await writeFile(markerPath, '{invalid-json', 'utf8');
        } else {
          await mkdir(markerPath);
        }
        await stopSharedManagedOpenCodeServerFromEnvBestEffort({ daemonInstanceId: 'current-daemon' }, {
          statePath: 'connected-active.json',
          listStateKeys: async () => ['connected-active.json'],
          withStateLock: async <T>(_key: string, fn: () => Promise<T>) => await fn(),
          readState: async () => state,
          removeState: async () => { state = null; },
          isPidAlive: () => true,
          probeHealth: async () => true,
          getProcessInfo: async () => ({ name: 'opencode', cmd: command }),
          killPid: (pid) => { killed.push(pid); return true; },
          currentActiveServerDir: '/tmp/current-server',
          readProcessStartTimeMs: async () => 10_000,
          readProcessInstanceFingerprint: async () => null,
        });

        expect(killed).toEqual([]);
        expect(state).not.toBeNull();
      } finally {
        await rm(markerPath, { recursive: kind === 'unreadable', force: true });
      }
    },
  );

  it('retires every owned idle pooled server and preserves live claims independently of ambient fingerprint', async () => {
    const poolPath = (name: string) => join(dirname(resolveSharedManagedOpenCodeServerStatePathForEnv({})), name);
    const command = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const makeState = (pid: number, launchEnvFingerprint: string): SharedManagedOpenCodeServerState => ({
      v: 2, baseUrl: 'http://127.0.0.1:1234', pid, startedAtMs: 1,
      daemonInstanceId: 'current-daemon', activeServerDir: '/tmp/current-server',
      ownerToken: `owner-${pid}`, expectedCmdlineHash: hashCommandLine(command),
      startTimeMs: 10_000, launchEnvFingerprint,
      apiGeneration: 'v2', authPassword: `secret-${pid}`,
    });
    const states = new Map([
      [poolPath('connected-one.json'), makeState(111, 'connected-one')],
      [poolPath('connected-two.json'), makeState(222, 'connected-two')],
      [poolPath('active.json'), makeState(333, 'active')],
      [poolPath('borrowed.json'), { ...makeState(444, 'borrowed'), daemonInstanceId: 'other-daemon' }],
    ]);
    const killed: number[] = [];
    const probes: unknown[] = [];
    const deps = {
      statePath: poolPath('ambient-default.json'),
      listStateKeys: async () => [...states.keys()],
      withStateLock: async <T>(_key: string, fn: () => Promise<T>) => await fn(),
      readState: async (key: string) => states.get(key) ?? null,
      removeState: async (key: string) => { states.delete(key); },
      isPidAlive: () => true,
      probeHealth: async (_url: string, _generation: 'auto' | 'v2' | undefined, auth: unknown) => { probes.push(auth); return true; },
      getProcessInfo: async () => ({ name: 'opencode', cmd: command }),
      killPid: (pid: number) => { killed.push(pid); return true; },
      currentActiveServerDir: '/tmp/current-server',
      readProcessStartTimeMs: async () => 10_000,
      readProcessInstanceFingerprint: async () => null,
    };
    const markerPath = await writeClaimMarker('active-session', { flavor: 'opencode', launchEnvFingerprint: 'active' });
    try {
      await stopSharedManagedOpenCodeServerFromEnvBestEffort({ daemonInstanceId: 'current-daemon' }, deps);

      expect(killed).toEqual([111, 222]);
      expect([...states.keys()]).toEqual(['active.json', 'borrowed.json'].map(poolPath));
      expect(probes).toEqual([
        { username: 'opencode', password: 'secret-111' },
        { username: 'opencode', password: 'secret-222' },
      ]);
      await writeClaimMarker('unknown-claim-session', { flavor: 'opencode' });
      states.set(poolPath('unknown-claim.json'), makeState(555, 'unknown-claim'));
      await stopSharedManagedOpenCodeServerFromEnvBestEffort({ daemonInstanceId: 'current-daemon' }, deps);
      expect(killed).toEqual([111, 222]);
      expect([...states.keys()]).toEqual(['active.json', 'borrowed.json', 'unknown-claim.json'].map(poolPath));
    } finally {
      await rm(markerPath, { force: true });
    }
  });
});

describe('stopSharedManagedOpenCodeServerFromState', () => {
  it.each([
    { case: 'another daemon', daemonInstanceId: 'other-daemon' },
    { case: 'another server scope', activeServerDir: '/tmp/other-server' },
    { case: 'a reused PID', startTimeMs: 1_000 },
    { case: 'unverified custody', v: undefined },
  ])('preserves a healthy server with $case during daemon shutdown', async ({ case: _case, ...overrides }) => {
    const command = 'opencode serve --hostname=127.0.0.1 --port=1234';
    const state: SharedManagedOpenCodeServerState = {
      v: 2, baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1,
      daemonInstanceId: 'current-daemon', activeServerDir: '/tmp/current-server',
      ownerToken: 'exact-owner', expectedCmdlineHash: hashCommandLine(command),
      startTimeMs: 10_000,
      ...overrides,
    };
    let retainedState: SharedManagedOpenCodeServerState | null = state;
    const killed: number[] = [];
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: async () => retainedState,
      removeState: async () => { retainedState = null; },
      isPidAlive: () => true,
      probeHealth: async () => true,
      getProcessInfo: async () => ({ name: 'opencode', cmd: command }),
      killPid: (pid: number) => { killed.push(pid); return true; },
      currentDaemonInstanceId: 'current-daemon',
      currentActiveServerDir: '/tmp/current-server',
      readProcessStartTimeMs: async () => 10_000,
      readProcessInstanceFingerprint: async () => null,
    };

    await expect(stopSharedManagedOpenCodeServerFromState(deps)).resolves.toEqual({ didKill: false });
    expect(killed).toEqual([]);
    expect(retainedState).toEqual(state);
  });

  it('probes the stopping server with its retained credential so a live server is never mistaken for dead', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:1234',
        pid: 111,
        startedAtMs: 1,
        status: 'ready' as const,
        apiGeneration: 'v2' as const,
        authPassword: 'retained-secret',
      })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => true),
    };

    await expect(stopSharedManagedOpenCodeServerFromState(deps)).resolves.toEqual({ didKill: true });

    expect(deps.probeHealth).toHaveBeenCalledWith(
      'http://127.0.0.1:1234',
      'v2',
      { username: 'opencode', password: 'retained-secret' },
    );
  });

  it('kills the managed server when health probe succeeds', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 111, startedAtMs: 1, status: 'ready' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: true });
    expect(deps.killPid).toHaveBeenCalledWith(111);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('does not kill during stop when health probe fails and launch identity cannot prove ownership', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 222, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
  });

  it('kills during stop when health probe fails and launch identity proves ownership', async () => {
    const wrapperLaunchSpec = {
      command: 'node',
      args: ['/tmp/custom-launch.js'],
      resolvedPath: '/tmp/custom-launch.js',
      source: 'override',
    } as const satisfies ProviderCliLaunchSpec;
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43111', pid: 225, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({
        name: 'node',
        cmd: 'node /tmp/custom-launch.js serve --hostname=127.0.0.1 --port=43111',
      })),
      resolveLaunchSpec: vi.fn(() => wrapperLaunchSpec),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: true });
    expect(deps.killPid).toHaveBeenCalledWith(225);
    expect(deps.removeState).toHaveBeenCalledTimes(1);
  });

  it('does not kill when health probe fails and pid does not look like opencode', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 333, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'node', cmd: 'node some-other-server.js' })),
      killPid: vi.fn(() => false),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
  });

  it('does not kill when only the process name mentions opencode but the command is not an opencode serve process', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 334, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode-helper', cmd: 'node helper.js' })),
      killPid: vi.fn(() => false),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
  });

  it('does not fail when the managed server pid resists shutdown', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1234', pid: 444, startedAtMs: 1, status: 'ready' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => true),
      getProcessInfo: vi.fn(async () => null),
      killPid: vi.fn(() => {
        throw new Error('stuck process');
      }),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).toHaveBeenCalledWith(444);
    expect(deps.removeState).not.toHaveBeenCalled();
  });

  it('does not probe health for non-loopback baseUrl while stopping (prevents SSRF if state file is tampered)', async () => {
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://example.com:1234', pid: 222, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => {
        throw new Error('probeHealth should not be called for non-loopback baseUrl');
      }),
      getProcessInfo: vi.fn(async () => ({ name: 'opencode', cmd: 'opencode serve --port 1234' })),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.probeHealth).not.toHaveBeenCalled();
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
  });

  it('does not kill during stop when the command only matches the broad opencode serve heuristic but not the launch spec identity', async () => {
    const wrapperLaunchSpec = {
      command: 'node',
      args: ['/tmp/custom-launch.js'],
      resolvedPath: '/tmp/custom-launch.js',
      source: 'override',
    } as const satisfies ProviderCliLaunchSpec;
    const deps = {
      withLock: async <T>(fn: () => Promise<T>) => await fn(),
      readState: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:43111', pid: 226, startedAtMs: 1, status: 'failed' as const })),
      removeState: vi.fn(async () => {}),
      isPidAlive: vi.fn(() => true),
      probeHealth: vi.fn(async () => false),
      getProcessInfo: vi.fn(async () => ({
        name: 'opencode',
        cmd: 'opencode serve --hostname=127.0.0.1 --port=43111',
      })),
      resolveLaunchSpec: vi.fn(() => wrapperLaunchSpec),
      killPid: vi.fn(() => true),
    };

    const out = await stopSharedManagedOpenCodeServerFromState(deps);

    expect(out).toEqual({ didKill: false });
    expect(deps.killPid).not.toHaveBeenCalled();
    expect(deps.removeState).not.toHaveBeenCalled();
  });
});
