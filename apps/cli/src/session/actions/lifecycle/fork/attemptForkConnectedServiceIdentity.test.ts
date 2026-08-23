import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ForkBackendResolution,
  ForkInheritedOverrides,
  ForkLifecycleRawSession,
  ForkSpawnSession,
} from './forkLifecycleTypes';
import type { ForkSurfaceV1 } from '@happier-dev/agents';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';

const mocks = vi.hoisted(() => ({
  dispatchProviderNativeFork: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
  fetchForkChildSessionOrThrow: vi.fn(),
  cleanupForkChildBestEffort: vi.fn(),
  archiveSessionBestEffort: vi.fn(),
  createConfiguredAcpBackend: vi.fn(),
  materializeConfiguredAcpEnvironment: vi.fn(),
}));

vi.mock('@/session/fork/providerNativeForkDispatch', () => ({
  dispatchProviderNativeFork: (...args: unknown[]) => mocks.dispatchProviderNativeFork(...args),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => mocks.updateSessionMetadataWithRetry(...args),
}));

vi.mock('./forkChildSessionRecovery', () => ({
  fetchForkChildSessionOrThrow: (...args: unknown[]) => mocks.fetchForkChildSessionOrThrow(...args),
  cleanupForkChildBestEffort: (...args: unknown[]) => mocks.cleanupForkChildBestEffort(...args),
  archiveSessionBestEffort: (...args: unknown[]) => mocks.archiveSessionBestEffort(...args),
}));

vi.mock('@/agent/acp/catalog/configured/createConfiguredAcpBackend', () => ({
  createConfiguredAcpBackend: (...args: unknown[]) => mocks.createConfiguredAcpBackend(...args),
}));

vi.mock('@/agent/acp/catalog/configured/materializeEnvironment', () => ({
  materializeConfiguredAcpEnvironment: (...args: unknown[]) => mocks.materializeConfiguredAcpEnvironment(...args),
}));

import { attemptAcpLatestFork } from './attemptAcpLatestFork';
import { attemptProviderNativeFork } from './attemptProviderNativeFork';

const CONNECTED_SERVICES = {
  v: 1,
  bindingsByServiceId: {
    'openai-codex': {
      source: 'connected',
      selection: 'profile',
      profileId: 'codex-work',
    },
  },
} as const;

const PARENT_MATERIALIZATION_IDENTITY = {
  v: 1,
  id: 'csm_parent_native_identity',
  createdAt: 100,
  source: 'first_spawn',
} as const;

function createBuiltInForkResolution(): ForkBackendResolution {
  return {
    ok: true,
    catalogAgentId: 'codex',
    agentHintAgentId: 'codex',
    backendTargetV2: {
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    },
    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    replayFlavor: 'codex',
    metadataOverlay: {},
    configuredAcp: null,
  };
}

function createOpenCodeForkResolution(): ForkBackendResolution {
  return {
    ok: true,
    catalogAgentId: 'opencode',
    agentHintAgentId: 'opencode',
    backendTargetV2: {
      kind: 'backend',
      backendId: 'opencode',
      sourceKind: 'built_in',
    },
    backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
    replayFlavor: 'opencode',
    metadataOverlay: {},
    configuredAcp: null,
  } as unknown as ForkBackendResolution;
}

function createConfiguredAcpForkResolution(): ForkBackendResolution {
  return {
    ok: true,
    catalogAgentId: null,
    agentHintAgentId: 'acp:review-bot',
    backendTargetV2: {
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    },
    backendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
    replayFlavor: 'acp:review-bot',
    metadataOverlay: {
      acpConfiguredBackendV1: {
        v: 1,
        backendId: 'review-bot',
        title: 'Review Bot',
      },
    },
    configuredAcp: {
      backendId: 'review-bot',
      title: 'Review Bot',
      providerSessionId: 'vendor-parent-acp',
      resolvedBackend: { backendId: 'review-bot' },
      accountSettings: { settingsVersion: 1 },
    },
  } as unknown as ForkBackendResolution;
}

function createConnectedServiceInheritedOverrides(): ForkInheritedOverrides {
  return {
    metadata: { connectedServices: CONNECTED_SERVICES },
    spawn: { connectedServices: CONNECTED_SERVICES },
  };
}

function readUpdatedMetadata(): Record<string, unknown> {
  const updater = mocks.updateSessionMetadataWithRetry.mock.calls[0]?.[0]?.updater as
    | ((metadata: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  if (!updater) throw new Error('Expected metadata updater');
  return updater({});
}

function createParentRawSessionFixture(): ForkLifecycleRawSession {
  // The fork modules pass the raw parent session through to the dispatch boundary; this unit test
  // does not exercise the transport session shape itself.
  return { id: 'parent-session', metadata: '{}' } as unknown as ForkLifecycleRawSession;
}

describe('fork connected-service child materialization identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cleanupForkChildBestEffort.mockResolvedValue(undefined);
    mocks.archiveSessionBestEffort.mockResolvedValue(undefined);
    mocks.dispatchProviderNativeFork.mockImplementation(async (params: {
      forkSurface?: ForkSurfaceV1 | null;
      parentSessionId: string;
      parentMetadata: Record<string, unknown>;
      directory: string;
      forkPoint: { type: 'latest' } | { type: 'seq'; upToSeqInclusive: number };
    }) => {
      const forkPoint = params.forkPoint.type === 'seq'
        ? { kind: 'message_seq' as const, upToSeqInclusive: params.forkPoint.upToSeqInclusive }
        : { kind: 'latest' as const };
      return await params.forkSurface?.fork?.({
        parentSessionId: params.parentSessionId,
        parentMetadata: params.parentMetadata,
        directory: params.directory,
        forkPoint,
      }) ?? null;
    });
    mocks.fetchForkChildSessionOrThrow.mockResolvedValue({ id: 'child-session', metadata: '{}' });
    mocks.updateSessionMetadataWithRetry.mockResolvedValue(undefined);
    mocks.materializeConfiguredAcpEnvironment.mockReturnValue({});
  });

  it('adds a fresh child identity to provider-native fork spawn options and metadata', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex-child-thread',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-native' });

    const input = {
      requestedStrategy: 'provider_native',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: createConnectedServiceInheritedOverrides(),
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    };
    const result = await attemptProviderNativeFork(input);

    const spawnIdentity = spawnSession.mock.calls[0]?.[0].connectedServiceMaterializationIdentityV1;
    const updatedMetadata = readUpdatedMetadata();
    expect(result).toEqual({ ok: true, childSessionId: 'child-native' });
    expect(mocks.dispatchProviderNativeFork).toHaveBeenCalledWith(expect.objectContaining({
      forkSurface: input.forkSurface,
    }));
    expect(fork).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/project',
      forkPoint: { kind: 'latest' },
    });
    expect(spawnIdentity).toEqual(expect.objectContaining({
      v: 1,
      id: expect.stringMatching(/^csm_/),
    }));
    expect(spawnIdentity?.id).not.toBe(PARENT_MATERIALIZATION_IDENTITY.id);
    expect(updatedMetadata.connectedServices).toEqual(CONNECTED_SERVICES);
    expect(updatedMetadata.connectedServiceMaterializationIdentityV1).toEqual(spawnIdentity);
  });

  it('fails closed without spawning when provider-native fork returns an empty vendor session id', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: '   ',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-native' });

    const input = {
      requestedStrategy: 'provider_native',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    };

    const result = await attemptProviderNativeFork(input);

    expect(result).toEqual({
      ok: false,
      errorCode: expect.any(String),
      errorMessage: expect.stringContaining('providerSessionId'),
    });
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('returns an indeterminate no-spawn result when provider-native fork returns owner-private Session state', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex-child-thread',
      launch: {
        sessionStateUpdates: [{
          fieldId: 'runtime.externalSessionOperation',
          value: 'private-operation',
        }],
      },
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-native' });

    const result = await attemptProviderNativeFork({
      requestedStrategy: 'provider_native',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'private-state-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: { metadata: {}, spawn: {} },
      forkSurface: { fork } as ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: expect.any(String),
    });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(spawnSession).not.toHaveBeenCalled();
    expect(mocks.fetchForkChildSessionOrThrow).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('does not fall back after provider-native auto fork times out waiting for webhook', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex-child-thread',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Timed out waiting for session webhook',
      });

    const result = await attemptProviderNativeFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-timeout-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();
    expect(mocks.cleanupForkChildBestEffort).not.toHaveBeenCalled();
  });

  it('does not fall back after provider-native auto fork commits but spawn returns a non-ambiguous error', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex-child-thread',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'spawn rejected after vendor fork',
      });

    const result = await attemptProviderNativeFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-error-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'spawn rejected after vendor fork',
    });
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();
    expect(mocks.cleanupForkChildBestEffort).not.toHaveBeenCalled();
  });

  it('does not fall back after provider-native child finalization reaches a terminal archive failure', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex-child-thread',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-native' });
    const stopSession = vi.fn();
    mocks.updateSessionMetadataWithRetry.mockRejectedValueOnce(
      new Error('metadata finalization failed'),
    );
    mocks.archiveSessionBestEffort.mockRejectedValueOnce(
      Object.assign(new Error('still active'), { code: 'session_active' }),
    );

    const result = await attemptProviderNativeFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-finalization-failure',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'metadata finalization failed',
    });
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      fallbackStopSession: stopSession,
      sessionId: 'child-native',
    });
    expect(mocks.archiveSessionBestEffort).toHaveBeenCalledOnce();
    expect(mocks.archiveSessionBestEffort).toHaveBeenCalledWith('token', 'child-native');
    expect(mocks.cleanupForkChildBestEffort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.archiveSessionBestEffort.mock.invocationCallOrder[0]!,
    );
  });

  it('waits for one machine-local stop before propagating a provider-native post-spawn authentication error', async () => {
    const authenticationError = Object.assign(new Error('expired credentials'), {
      response: { status: 401 },
    });
    mocks.fetchForkChildSessionOrThrow.mockRejectedValueOnce(authenticationError);
    let releaseCleanup: (() => void) | undefined;
    mocks.cleanupForkChildBestEffort.mockImplementationOnce(
      async (input: Readonly<{
        fallbackStopSession: (sessionId: string) => Promise<unknown>;
        sessionId: string;
      }>) => {
        await input.fallbackStopSession(input.sessionId);
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
      },
    );
    const stopSession = vi.fn();
    const attempt = attemptProviderNativeFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-auth-failure',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: {
        fork: vi.fn().mockResolvedValue({
          providerSessionId: 'codex-child-thread',
          launch: {},
        }),
      } satisfies ForkSurfaceV1,
      spawnSession: vi.fn<ForkSpawnSession>()
        .mockResolvedValue({ type: 'success', sessionId: 'child-native' }),
      stopSession,
    });
    let settled = false;
    void attempt.finally(() => {
      settled = true;
    }).catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    });
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      fallbackStopSession: stopSession,
      sessionId: 'child-native',
    });
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('child-native');
    expect(settled).toBe(false);
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();

    releaseCleanup?.();
    await expect(attempt).rejects.toBe(authenticationError);
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledOnce();
  });

  it('preserves non-Codex runtime backend mode in provider-native fork spawn and metadata', async () => {
    const runtimeDescriptorV1 = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'opencode-child-thread',
      },
    } as const;
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'opencode-child-thread',
      launch: {
        sessionStateUpdates: [
          {
            fieldId: 'identity.runtimeDescriptor',
            value: runtimeDescriptorV1,
          },
        ],
      },
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-opencode' });

    const result = await attemptProviderNativeFork({
      requestedStrategy: 'provider_native',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentSession: createParentRawSessionFixture(),
      parentMetadata: {},
      directory: '/tmp/project',
      forkPoint: { type: 'latest' as const },
      targetSeqInclusive: 10,
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'native-nonce',
      forkBackendResolution: createOpenCodeForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    const updatedMetadata = readUpdatedMetadata();
    expect(result).toEqual({ ok: true, childSessionId: 'child-opencode' });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeDescriptorV1,
    }));
    expect(updatedMetadata.forkV1).toMatchObject({
      agentHint: {
        agentId: 'opencode',
        backendMode: 'server',
        providerSessionId: 'opencode-child-thread',
      },
    });
  });

  it('adds a fresh child identity when configured ACP latest fork uses the bridge surface', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-acp',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-acp' });

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'acp_fork_latest',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'acp-nonce',
      forkIsConfiguredAcp: true,
      forkBackendResolution: createConfiguredAcpForkResolution(),
      inheritedForkOverrides: createConnectedServiceInheritedOverrides(),
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    const spawnIdentity = spawnSession.mock.calls[0]?.[0].connectedServiceMaterializationIdentityV1;
    const updatedMetadata = readUpdatedMetadata();
    expect(result).toEqual({ ok: true, childSessionId: 'child-acp' });
    expect(fork).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: {
        connectedServiceMaterializationIdentityV1: PARENT_MATERIALIZATION_IDENTITY,
      },
      directory: '/tmp/project',
      forkPoint: { kind: 'latest' },
    });
    expect(mocks.createConfiguredAcpBackend).not.toHaveBeenCalled();
    expect(spawnIdentity).toEqual(expect.objectContaining({
      v: 1,
      id: expect.stringMatching(/^csm_/),
    }));
    expect(spawnIdentity?.id).not.toBe(PARENT_MATERIALIZATION_IDENTITY.id);
    expect(updatedMetadata.connectedServices).toEqual(CONNECTED_SERVICES);
    expect(updatedMetadata.connectedServiceMaterializationIdentityV1).toEqual(spawnIdentity);
  });

  it('uses a bridge-resolved built-in fork surface for ACP latest fork without catalog fallback', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-surface',
      launch: {
        directory: '/tmp/surface-child',
        environmentVariables: { SURFACE_FORK: '1' },
      },
    });
    mocks.createConfiguredAcpBackend.mockReturnValue(null);
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-acp-surface' });

    const input = {
      requestedStrategy: 'acp_fork_latest',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { providerSessionId: 'vendor-parent' },
        },
      },
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'built-in-acp-nonce',
      forkIsConfiguredAcp: false,
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    };

    const result = await attemptAcpLatestFork(input);

    expect(result).toEqual({ ok: true, childSessionId: 'child-acp-surface' });
    expect(fork).toHaveBeenCalledWith({
      parentSessionId: 'parent-session',
      parentMetadata: input.parentMetadata,
      directory: '/tmp/project',
      forkPoint: { kind: 'latest' },
    });
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/surface-child',
      resume: 'vendor-child-surface',
      environmentVariables: { SURFACE_FORK: '1' },
    }));
  });

  it('fails closed without spawning when configured ACP bridge fork returns an empty vendor session id', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: '   ',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-acp' });

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'acp_fork_latest',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'empty-acp-nonce',
      forkIsConfiguredAcp: true,
      forkBackendResolution: createConfiguredAcpForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: expect.any(String),
      errorMessage: expect.stringContaining('providerSessionId'),
    });
    expect(fork).toHaveBeenCalled();
    expect(mocks.createConfiguredAcpBackend).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('fails closed before spawning when ACP latest fork returns owner-private Session state', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-acp',
      launch: {
        sessionStateUpdates: [{
          fieldId: 'runtime.externalSessionOperation',
          value: 'private-operation',
        }],
      },
    });
    const spawnSession = vi.fn<ForkSpawnSession>();

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'acp_fork_latest',
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      spawnNonce: 'private-state-acp',
      forkIsConfiguredAcp: true,
      forkBackendResolution: createConfiguredAcpForkResolution(),
      inheritedForkOverrides: { metadata: {}, spawn: {} },
      forkSurface: { fork } as ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toBeNull();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(mocks.fetchForkChildSessionOrThrow).not.toHaveBeenCalled();
    expect(mocks.updateSessionMetadataWithRetry).not.toHaveBeenCalled();
  });

  it('does not fall back after ACP latest auto fork times out waiting for webhook', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-surface',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
        errorMessage: 'Timed out waiting for session webhook',
      });

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      forkIsConfiguredAcp: false,
      spawnNonce: 'acp-timeout-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
    });
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();
    expect(mocks.cleanupForkChildBestEffort).not.toHaveBeenCalled();
  });

  it('does not fall back after ACP latest auto fork commits but spawn returns a non-ambiguous error', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-surface',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'ACP spawn rejected after vendor fork',
      });

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      forkIsConfiguredAcp: false,
      spawnNonce: 'acp-error-nonce',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      errorMessage: 'ACP spawn rejected after vendor fork',
    });
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();
    expect(mocks.cleanupForkChildBestEffort).not.toHaveBeenCalled();
  });

  it('does not fall back after ACP child finalization reaches a terminal archive failure', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'vendor-child-surface',
      launch: {},
    });
    const spawnSession = vi.fn<ForkSpawnSession>()
      .mockResolvedValue({ type: 'success', sessionId: 'child-acp' });
    const stopSession = vi.fn();
    mocks.updateSessionMetadataWithRetry.mockRejectedValueOnce(
      new Error('metadata finalization failed'),
    );
    mocks.archiveSessionBestEffort.mockRejectedValueOnce(
      Object.assign(new Error('still active'), { code: 'session_active' }),
    );

    const result = await attemptAcpLatestFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      forkIsConfiguredAcp: false,
      spawnNonce: 'acp-finalization-failure',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: { fork } satisfies ForkSurfaceV1,
      spawnSession,
      stopSession,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
      errorMessage: 'metadata finalization failed',
    });
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      fallbackStopSession: stopSession,
      sessionId: 'child-acp',
    });
    expect(mocks.archiveSessionBestEffort).toHaveBeenCalledOnce();
    expect(mocks.archiveSessionBestEffort).toHaveBeenCalledWith('token', 'child-acp');
    expect(mocks.cleanupForkChildBestEffort.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.archiveSessionBestEffort.mock.invocationCallOrder[0]!,
    );
  });

  it('waits for one machine-local stop before propagating an ACP post-spawn authentication error', async () => {
    const authenticationError = Object.assign(new Error('expired credentials'), {
      response: { status: 403 },
    });
    mocks.fetchForkChildSessionOrThrow.mockRejectedValueOnce(authenticationError);
    let releaseCleanup: (() => void) | undefined;
    mocks.cleanupForkChildBestEffort.mockImplementationOnce(
      async (input: Readonly<{
        fallbackStopSession: (sessionId: string) => Promise<unknown>;
        sessionId: string;
      }>) => {
        await input.fallbackStopSession(input.sessionId);
        await new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
      },
    );
    const stopSession = vi.fn();
    const attempt = attemptAcpLatestFork({
      requestedStrategy: 'auto',
      credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } },
      parentSessionId: 'parent-session',
      parentMetadata: {},
      directory: '/tmp/project',
      effectiveCutoffSeqInclusive: 10,
      forkIsConfiguredAcp: false,
      spawnNonce: 'acp-auth-failure',
      forkBackendResolution: createBuiltInForkResolution(),
      inheritedForkOverrides: {
        metadata: {},
        spawn: {},
      },
      forkSurface: {
        fork: vi.fn().mockResolvedValue({
          providerSessionId: 'vendor-child-surface',
          launch: {},
        }),
      } satisfies ForkSurfaceV1,
      spawnSession: vi.fn<ForkSpawnSession>()
        .mockResolvedValue({ type: 'success', sessionId: 'child-acp' }),
      stopSession,
    });
    let settled = false;
    void attempt.finally(() => {
      settled = true;
    }).catch(() => undefined);

    await vi.waitFor(() => {
      expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    });
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledWith({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1]) },
      },
      fallbackStopSession: stopSession,
      sessionId: 'child-acp',
    });
    expect(stopSession).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledWith('child-acp');
    expect(settled).toBe(false);
    expect(mocks.archiveSessionBestEffort).not.toHaveBeenCalled();

    releaseCleanup?.();
    await expect(attempt).rejects.toBe(authenticationError);
    expect(mocks.cleanupForkChildBestEffort).toHaveBeenCalledOnce();
    expect(stopSession).toHaveBeenCalledOnce();
  });
});
