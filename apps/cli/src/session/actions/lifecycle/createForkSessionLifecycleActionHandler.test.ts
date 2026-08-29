import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForkSurfaceV1 } from '@happier-dev/agents';
import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  tryDecryptSessionOwnerMetadataView: vi.fn(),
  attemptProviderNativeFork: vi.fn(),
  attemptNativeForkOpen: vi.fn(),
  attemptAcpLatestFork: vi.fn(),
  createReplayForkSession: vi.fn(),
  isAcpForkEligibleForAgent: vi.fn(),
  evaluateAgentSessionCapabilitySupport: vi.fn(),
  forkAgentId: 'codex',
  nativeForkOpenModes: [] as string[],
  /**
   * Which registry generation declares the Agent. `cold` is the primed module
   * cache; `runtime` is a plugin reload the cache has not seen yet — the state
   * an externally installed Agent is in until something re-primes.
   */
  declarationSource: 'cold' as 'cold' | 'runtime',
}));

function buildForkAgentDefinitions() {
  return new Map([[mocks.forkAgentId, {
    richDefinition: {
      definition: {
        primary: 'sessions',
        capabilities: {
          sessions: { open: mocks.nativeForkOpenModes },
        },
      },
    },
  }]]);
}

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    getState: () => ({
      activeRegistry: mocks.declarationSource === 'runtime'
        ? { contributes: { agentDefinitionsById: buildForkAgentDefinitions() } }
        : null,
    }),
    isRuntimeRegistryCurrent: () => true,
  },
}));

vi.mock('@happier-dev/agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/agents')>(),
  evaluateAgentSessionCapabilitySupport: (...args: unknown[]) => (
    mocks.evaluateAgentSessionCapabilitySupport(...args)
  ),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: () => ({
    agentDefinitionsById: mocks.declarationSource === 'cold'
      ? buildForkAgentDefinitions()
      : new Map(),
  }),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => mocks.readCredentials(...args),
  readStoredCredentials: (...args: unknown[]) => mocks.readStoredCredentials(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: (...args: unknown[]) => mocks.fetchSessionByIdCompat(...args),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', () => ({
  fetchAccountEncryptionCurrentness: (...args: unknown[]) => (
    mocks.fetchAccountEncryptionCurrentness(...args)
  ),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionOwnerMetadataView: (...args: unknown[]) => (
    mocks.tryDecryptSessionOwnerMetadataView(...args)
  ),
}));

vi.mock('@/agent/acp/acpForkEligibility', () => ({
  isAcpForkEligibleForAgent: (...args: unknown[]) => mocks.isAcpForkEligibleForAgent(...args),
}));

vi.mock('./fork/attemptProviderNativeFork', () => ({
  attemptProviderNativeFork: (...args: unknown[]) => mocks.attemptProviderNativeFork(...args),
}));

vi.mock('./fork/attemptNativeForkOpen', () => ({
  attemptNativeForkOpen: (...args: unknown[]) => mocks.attemptNativeForkOpen(...args),
}));

vi.mock('./fork/attemptAcpLatestFork', () => ({
  attemptAcpLatestFork: (...args: unknown[]) => mocks.attemptAcpLatestFork(...args),
}));

vi.mock('./fork/createReplayForkSession', () => ({
  createReplayForkSession: (...args: unknown[]) => mocks.createReplayForkSession(...args),
}));

import { createForkSessionLifecycleActionHandler } from './createForkSessionLifecycleActionHandler';

const providerBindingV1 = {
  v: 1 as const,
  connectionId: 'pc_work',
  contributionKey: 'acme.gateway/gateway',
  connectionRevision: 1,
  protocol: 'openai-responses' as const,
  materialization: 'engineConfig' as const,
  adapterBindingKey: 'gateway',
  compatibilityFingerprint: 'compatibility:v1:one',
  bindingSecurityFingerprint: 'binding-security:v1:one',
  displaySnapshot: {
    providerName: 'Gateway',
    connectionName: 'Work',
    connectionRole: 'named' as const,
    connectionDisplayNameMode: 'custom' as const,
  },
};

function createBridge(params: Readonly<{
  forkSurface?: ForkSurfaceV1 | null;
  catalogAgentId?: string;
}>): ReturnType<typeof getSessionHostBridge> {
  const catalogAgentId = params.catalogAgentId ?? mocks.forkAgentId;
  return {
    resolveSessionForkBackendTarget: vi.fn(async () => ({
      ok: true,
      catalogAgentId,
      agentHintAgentId: catalogAgentId,
      backendTargetV2: {
        kind: 'backend',
        backendId: catalogAgentId,
        sourceKind: 'built_in',
      },
      backendTarget: { kind: 'builtInAgent', agentId: catalogAgentId },
      replayFlavor: catalogAgentId,
      metadataOverlay: {},
      configuredAcp: null,
    })),
    resolveExecutionSurfaces: vi.fn(async () => ({
      terminalRuntime: null,
      externalSession: null,
      attach: null,
      handoff: null,
      fork: params.forkSurface ?? null,
      checkpoint: null,
    })),
  } as unknown as ReturnType<typeof getSessionHostBridge>;
}

function createConfiguredAcpBridge(params: Readonly<{
  supportsLoadSession: boolean;
  providerSessionId?: string | null;
}>): ReturnType<typeof getSessionHostBridge> {
  const bridge = createBridge({ forkSurface: { fork: vi.fn() } });
  const resolveSessionForkBackendTarget = vi.fn(async () => ({
    ok: true as const,
    catalogAgentId: null,
    agentHintAgentId: 'acp:review-bot',
    backendTargetV2: {
      kind: 'backend' as const,
      backendId: 'review-bot',
      sourceKind: 'configured' as const,
      configuredBackendId: 'review-bot',
    },
    backendTarget: { kind: 'configuredAcpBackend' as const, backendId: 'review-bot' },
    replayFlavor: 'acp:review-bot',
    metadataOverlay: {},
    configuredAcp: {
      backendId: 'review-bot',
      title: 'Review Bot',
      providerSessionId: params.providerSessionId ?? 'provider-parent',
      resolvedBackend: {
        capabilities: { supportsLoadSession: params.supportsLoadSession },
      },
      accountSettings: {},
    },
  }));
  return {
    ...bridge,
    resolveSessionForkBackendTarget,
  } as unknown as ReturnType<typeof getSessionHostBridge>;
}

describe('createForkSessionLifecycleActionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue(null);
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'token',
      encryption: null,
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'parent-session',
      seq: 11,
      metadata: '{}',
    });
    mocks.fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1 });
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
    });
    mocks.attemptProviderNativeFork.mockResolvedValue(null);
    mocks.attemptNativeForkOpen.mockResolvedValue(null);
    mocks.attemptAcpLatestFork.mockResolvedValue(null);
    mocks.createReplayForkSession.mockResolvedValue({ ok: true, childSessionId: 'child-replay' });
    mocks.isAcpForkEligibleForAgent.mockReturnValue(false);
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('unsupported');
    mocks.forkAgentId = 'codex';
    mocks.nativeForkOpenModes.length = 0;
    mocks.declarationSource = 'cold';
  });

  it('routes a load-session-capable configured ACP fork through daemon spawn preparation', async () => {
    mocks.attemptAcpLatestFork.mockResolvedValue({ ok: true, childSessionId: 'child-acp' });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createConfiguredAcpBridge({ supportsLoadSession: true }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-acp' });

    expect(mocks.attemptAcpLatestFork).toHaveBeenCalledWith(expect.objectContaining({
      forkIsConfiguredAcp: true,
      forkBackendResolution: expect.objectContaining({
        configuredAcp: expect.objectContaining({
          providerSessionId: 'provider-parent',
          resolvedBackend: expect.objectContaining({
            capabilities: { supportsLoadSession: true },
          }),
        }),
      }),
    }));
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('falls back to replay for automatic configured ACP fork without load-session support', async () => {
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createConfiguredAcpBridge({ supportsLoadSession: false }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-replay' });

    expect(mocks.attemptAcpLatestFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).toHaveBeenCalledOnce();
  });

  it('returns a typed refusal for explicit configured ACP latest without load-session support', async () => {
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createConfiguredAcpBridge({ supportsLoadSession: false }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'acp_fork_latest',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_REQUEST',
    });
    expect(mocks.attemptAcpLatestFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('acknowledges a cancellation signal before entering the fork mutation owner', async () => {
    const spawnSession = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession, stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
    }, { signal: controller.signal })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      errorMessage: 'cancelled',
    });
    expect(spawnSession).not.toHaveBeenCalled();
    expect(mocks.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

  it('terminalizes cancellation while a native fork owner is pending', async () => {
    mocks.nativeForkOpenModes.push('fork');
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('supported');
    const controller = new AbortController();
    const abortError = Object.assign(new Error('Action operation cancelled'), {
      name: 'AbortError',
    });
    let rejectNativeFork!: (error: unknown) => void;
    let nativeForkSignal: AbortSignal | undefined;
    mocks.attemptNativeForkOpen.mockImplementationOnce((input: Readonly<{ signal?: AbortSignal }>) => {
      nativeForkSignal = input.signal;
      return new Promise((_resolve, reject) => {
        rejectNativeFork = reject;
      });
    });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
      deps: { awaitAgentSessionOpen: vi.fn() },
    });

    const result = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'native',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.attemptNativeForkOpen).toHaveBeenCalledOnce());
    expect(nativeForkSignal).toBe(controller.signal);
    controller.abort(abortError);
    rejectNativeFork(abortError);

    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      errorMessage: 'cancelled',
    });
  });

  it('terminalizes cancellation while a provider fork surface is pending', async () => {
    const controller = new AbortController();
    const abortError = Object.assign(new Error('Action operation cancelled'), {
      name: 'AbortError',
    });
    let rejectProviderFork!: (error: unknown) => void;
    let providerForkSignal: AbortSignal | undefined;
    mocks.attemptProviderNativeFork.mockImplementationOnce((input: Readonly<{ signal?: AbortSignal }>) => {
      providerForkSignal = input.signal;
      return new Promise((_resolve, reject) => {
        rejectProviderFork = reject;
      });
    });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    const result = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.attemptProviderNativeFork).toHaveBeenCalledOnce());
    expect(providerForkSignal).toBe(controller.signal);
    controller.abort(abortError);
    rejectProviderFork(abortError);

    await expect(result).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      errorMessage: 'cancelled',
    });
  });

  it('routes a declared native fork through child spawn-open and does not invoke legacy or replay owners', async () => {
    mocks.nativeForkOpenModes.push('create', 'resume', 'fork');
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('supported');
    mocks.attemptNativeForkOpen.mockResolvedValue({
      ok: true,
      childSessionId: 'child-native-open',
    });
    const bridge = createBridge({ forkSurface: { fork: vi.fn() } });
    vi.mocked(bridge.resolveExecutionSurfaces).mockRejectedValue(
      new Error('legacy fork surface resolution must not gate native open'),
    );
    const awaitAgentSessionOpen = vi.fn();
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: bridge,
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
      deps: { awaitAgentSessionOpen },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'seq', upToSeqInclusive: 7 },
      strategy: 'provider_native',
      requestId: 'native-open-request',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-native-open' });
    expect(mocks.attemptNativeForkOpen).toHaveBeenCalledWith(expect.objectContaining({
      forkPoint: { type: 'seq', upToSeqInclusive: 7 },
      targetSeqInclusive: 7,
      awaitAgentSessionOpen,
      requestId: 'native-open-request',
    }));
    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
    expect(bridge.resolveExecutionSurfaces).not.toHaveBeenCalled();
  });

  it('routes an external Agent through the same capability policy using its declaration fallback', async () => {
    mocks.forkAgentId = 'acme.agent';
    mocks.declarationSource = 'runtime';
    mocks.nativeForkOpenModes.push('fork');
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('supported');
    mocks.attemptNativeForkOpen.mockResolvedValue({
      ok: true,
      childSessionId: 'child-external-native-open',
    });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-external-native-open' });

    expect(mocks.attemptNativeForkOpen).toHaveBeenCalledTimes(1);
    expect(mocks.evaluateAgentSessionCapabilitySupport).toHaveBeenCalledWith({
      agentId: 'acme.agent',
      capability: 'sessionFork.conversation',
      metadata: { path: '/tmp/project' },
      declaredSupport: 'supported',
    });
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('resolves the generic native intent through the existing native-open policy', async () => {
    mocks.nativeForkOpenModes.push('create', 'resume', 'fork');
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('supported');
    mocks.attemptNativeForkOpen.mockResolvedValue({ ok: true, childSessionId: 'child-native-open' });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
      deps: { awaitAgentSessionOpen: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'seq', upToSeqInclusive: 7 },
      strategy: 'native',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-native-open' });
    expect(mocks.attemptNativeForkOpen).toHaveBeenCalledTimes(1);
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('resolves the generic native intent through the existing provider-native policy', async () => {
    mocks.attemptProviderNativeFork.mockResolvedValue({ ok: true, childSessionId: 'child-native' });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'native',
      requestId: 'provider-native-request',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-native' });
    expect(mocks.attemptProviderNativeFork).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedStrategy: 'native',
        requestId: 'provider-native-request',
      }),
    );
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('routes the generic native intent to the ACP lifecycle when the parent is ACP-forkable', async () => {
    mocks.isAcpForkEligibleForAgent.mockReturnValue(true);
    mocks.attemptAcpLatestFork.mockResolvedValue({ ok: true, childSessionId: 'child-acp' });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'native',
      requestId: 'acp-request',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-acp' });
    expect(mocks.attemptAcpLatestFork).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'acp-request' }),
    );
    // `auto` routes an ACP-forkable parent straight to the ACP lifecycle so one
    // surface invocation has one authoritative persisted strategy; the generic
    // native intent must inherit exactly that ordering.
    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('never falls back to replay when no native path is usable for the generic native intent', async () => {
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'native',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'Requested fork strategy is not supported',
    });
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });

  it('uses the authenticated owner view so native fork receives the private runtime descriptor', async () => {
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'codex',
      agent: { providerSessionId: 'provider-parent' },
    };
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'parent-session',
      seq: 11,
      metadataLayoutVersion: 1,
      metadata: '{"v":1}',
      ownerMetadata: {
        t: 'encrypted',
        c: 'owner-ciphertext',
      },
    });
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
      runtimeDescriptorV1,
    });
    mocks.nativeForkOpenModes.push('fork');
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('supported');
    mocks.attemptNativeForkOpen.mockResolvedValue({
      ok: true,
      childSessionId: 'child-native-open',
    });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
      deps: { awaitAgentSessionOpen: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-native-open' });

    expect(mocks.tryDecryptSessionOwnerMetadataView).toHaveBeenCalledWith(
      expect.objectContaining({
        rawSession: expect.objectContaining({ id: 'parent-session' }),
      }),
    );
    expect(mocks.attemptNativeForkOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMetadata: expect.objectContaining({ runtimeDescriptorV1 }),
      }),
    );
  });

  it('does not invoke fork or spawn owners when linked-session metadata requires reconciliation', async () => {
    const bridge = createBridge({ forkSurface: { fork: vi.fn() } });
    vi.mocked(bridge.resolveSessionForkBackendTarget).mockResolvedValueOnce({
      ok: false,
      errorMessage: 'linked_session_reconciliation_required',
    });
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
      flavor: 'opencode',
      externalSessionV1: { v: 1 },
      directSessionV1: { v: 1 },
    });
    const spawnSession = vi.fn();
    const stopSession = vi.fn();
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: bridge,
      handlers: { spawnSession, stopSession },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'INVALID_REQUEST',
      errorMessage: 'linked_session_reconciliation_required',
    });

    expect(bridge.resolveExecutionSurfaces).not.toHaveBeenCalled();
    expect(mocks.attemptNativeForkOpen).not.toHaveBeenCalled();
    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.attemptAcpLatestFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
  });

  it('passes the bridge-resolved fork surface into provider-native fork attempts', async () => {
    const forkSurface = { fork: vi.fn() } satisfies ForkSurfaceV1;
    const bridge = createBridge({ forkSurface });
    mocks.attemptProviderNativeFork.mockImplementationOnce(async (params: { forkSurface?: ForkSurfaceV1 | null }) => {
      expect(params.forkSurface).toBe(forkSurface);
      return { ok: true, childSessionId: 'child-native' };
    });

    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: bridge,
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    const result = await handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    });

    expect(result).toEqual({ ok: true, childSessionId: 'child-native' });
    expect(bridge.resolveExecutionSurfaces).toHaveBeenCalledWith('codex');
  });

  it('coalesces concurrent duplicate forks for the same parent and fork point', async () => {
    let releaseReplay!: () => void;
    const replayPromise = new Promise<{ ok: true; childSessionId: string }>((resolve) => {
      releaseReplay = () => resolve({ ok: true, childSessionId: 'child-replay' });
    });
    mocks.createReplayForkSession.mockReturnValue(replayPromise);
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    const first = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });
    const second = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });
    releaseReplay();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      { ok: true, childSessionId: 'child-replay' },
      { ok: true, childSessionId: 'child-replay' },
    ]);
    expect(mocks.createReplayForkSession).toHaveBeenCalledTimes(1);
  });

  it('uses the same fork spawn nonce for repeated equivalent fork requests after single-flight clears', async () => {
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });
    const request = {
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    } as const;

    await handler(request);
    await handler(request);

    const firstSpawnNonce = mocks.createReplayForkSession.mock.calls[0]?.[0]?.spawnNonce;
    const secondSpawnNonce = mocks.createReplayForkSession.mock.calls[1]?.[0]?.spawnNonce;
    expect(firstSpawnNonce).toEqual(expect.any(String));
    expect(firstSpawnNonce).toBe(secondSpawnNonce);
  });

  it('keeps two distinct fork attempts distinct even when their request content is identical', async () => {
    // `requestId` is the caller's attempt identity. Two deliberate submissions
    // are two forks, so they must not share a single-flight slot or a spawn
    // nonce — content alone cannot tell them apart.
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });
    const request = {
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    } as const;

    await handler({ ...request, requestId: 'attempt-a' });
    await handler({ ...request, requestId: 'attempt-b' });

    expect(mocks.createReplayForkSession).toHaveBeenCalledTimes(2);
    const firstSpawnNonce = mocks.createReplayForkSession.mock.calls[0]?.[0]?.spawnNonce;
    const secondSpawnNonce = mocks.createReplayForkSession.mock.calls[1]?.[0]?.spawnNonce;
    expect(firstSpawnNonce).toEqual(expect.any(String));
    expect(firstSpawnNonce).not.toBe(secondSpawnNonce);
    expect(mocks.createReplayForkSession).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requestId: 'attempt-a' }),
    );
    expect(mocks.createReplayForkSession).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ requestId: 'attempt-b' }),
    );
  });

  it('coalesces concurrent deliveries of one fork attempt on its requestId', async () => {
    // A transport retry of one submission is the same operation whatever its
    // payload looks like on the wire, so the idempotency key — not the request
    // content — decides that it joins the in-flight fork.
    let releaseReplay!: () => void;
    const replayPromise = new Promise<{ ok: true; childSessionId: string }>((resolve) => {
      releaseReplay = () => resolve({ ok: true, childSessionId: 'child-replay' });
    });
    mocks.createReplayForkSession.mockReturnValue(replayPromise);
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    const first = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      requestId: 'attempt-a',
      replayMaxSeedChars: 2_000,
    });
    const second = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
      requestId: 'attempt-a',
      replayMaxSeedChars: 4_000,
    });
    releaseReplay();
    const results = await Promise.all([first, second]);

    expect(results).toEqual([
      { ok: true, childSessionId: 'child-replay' },
      { ok: true, childSessionId: 'child-replay' },
    ]);
    expect(mocks.createReplayForkSession).toHaveBeenCalledTimes(1);
  });

  it('uses distinct spawn nonces for native and replay fork strategy attempts', async () => {
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    await handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    const nativeSpawnNonce = mocks.attemptProviderNativeFork.mock.calls[0]?.[0]?.spawnNonce;
    const replaySpawnNonce = mocks.createReplayForkSession.mock.calls[0]?.[0]?.spawnNonce;
    expect(nativeSpawnNonce).toEqual(expect.stringContaining(':native'));
    expect(replaySpawnNonce).toEqual(expect.stringContaining(':replay'));
    expect(nativeSpawnNonce).not.toBe(replaySpawnNonce);
  });

  it('uses distinct spawn nonces for ACP-latest and replay fork strategy attempts', async () => {
    mocks.isAcpForkEligibleForAgent.mockReturnValue(true);
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    await handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });

    const acpSpawnNonce = mocks.attemptAcpLatestFork.mock.calls[0]?.[0]?.spawnNonce;
    const replaySpawnNonce = mocks.createReplayForkSession.mock.calls[0]?.[0]?.spawnNonce;
    expect(acpSpawnNonce).toEqual(expect.stringContaining(':acp_fork_latest'));
    expect(replaySpawnNonce).toEqual(expect.stringContaining(':replay'));
    expect(acpSpawnNonce).not.toBe(replaySpawnNonce);
  });

  it('does not coalesce concurrent forks that request different strategies', async () => {
    let releaseNativeFork!: () => void;
    const nativeForkPromise = new Promise<{ ok: true; childSessionId: string }>((resolve) => {
      releaseNativeFork = () => resolve({ ok: true, childSessionId: 'child-native' });
    });
    mocks.attemptProviderNativeFork.mockImplementation(async (params: { requestedStrategy: string }) => {
      if (params.requestedStrategy === 'auto') {
        return nativeForkPromise;
      }
      return null;
    });
    mocks.createReplayForkSession.mockResolvedValue({ ok: true, childSessionId: 'child-replay' });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: null }),
      handlers: {
        spawnSession: vi.fn(),
        stopSession: vi.fn(),
      },
    });

    const autoFork = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    });
    const replayFork = handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'replay',
    });
    releaseNativeFork();
    const results = await Promise.all([autoFork, replayFork]);

    expect(results).toEqual([
      { ok: true, childSessionId: 'child-native' },
      { ok: true, childSessionId: 'child-replay' },
    ]);
    expect(mocks.createReplayForkSession).toHaveBeenCalledTimes(1);
  });

  it('routes provider-bound automatic forks through replay before any vendor fork side effect', async () => {
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
      flavor: 'codex',
      providerBindingV1,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    });
    mocks.isAcpForkEligibleForAgent.mockReturnValue(true);
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'auto',
    })).resolves.toEqual({ ok: true, childSessionId: 'child-replay' });

    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.attemptAcpLatestFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).toHaveBeenCalledTimes(1);
  });

  it('refuses an explicit vendor-native fork for a provider-bound session before dispatch', async () => {
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
      flavor: 'codex',
      providerBindingV1,
      modelSelectionIntentV1: {
        v: 1,
        updatedAt: 1,
        selection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    });
    const handler = createForkSessionLifecycleActionHandler({
      sessionHostBridge: createBridge({ forkSurface: { fork: vi.fn() } }),
      handlers: { spawnSession: vi.fn(), stopSession: vi.fn() },
    });

    await expect(handler({
      v: 1,
      parentSessionId: 'parent-session',
      forkPoint: { type: 'latest' },
      strategy: 'provider_native',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: expect.any(String),
    });
    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.attemptAcpLatestFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
  });
});
