import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForkSurfaceV1 } from '@happier-dev/agents';
import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  tryDecryptSessionOwnerMetadataView: vi.fn(),
  attemptProviderNativeFork: vi.fn(),
  attemptNativeForkOpen: vi.fn(),
  attemptAcpLatestFork: vi.fn(),
  createReplayForkSession: vi.fn(),
  isAcpForkEligibleForAgent: vi.fn(),
  evaluateAgentSessionCapabilitySupport: vi.fn(),
  nativeForkOpenModes: [] as string[],
}));

vi.mock('@happier-dev/agents', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/agents')>(),
  evaluateAgentSessionCapabilitySupport: (...args: unknown[]) => (
    mocks.evaluateAgentSessionCapabilitySupport(...args)
  ),
}));

vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  getResolvedContributionRegistry: () => ({
    agentDefinitionsById: new Map([['codex', {
      richDefinition: {
        definition: {
          primary: 'sessions',
          capabilities: {
            sessions: { open: mocks.nativeForkOpenModes },
          },
        },
      },
    }]]),
  }),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => mocks.readCredentials(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: (...args: unknown[]) => mocks.fetchSessionByIdCompat(...args),
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
}>): ReturnType<typeof getSessionHostBridge> {
  return {
    resolveSessionForkBackendTarget: vi.fn(async () => ({
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

describe('createForkSessionLifecycleActionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue({
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array([1]) },
    });
    mocks.fetchSessionByIdCompat.mockResolvedValue({
      id: 'parent-session',
      seq: 11,
      metadata: '{}',
    });
    mocks.tryDecryptSessionOwnerMetadataView.mockReturnValue({
      path: '/tmp/project',
    });
    mocks.attemptProviderNativeFork.mockResolvedValue(null);
    mocks.attemptNativeForkOpen.mockResolvedValue(null);
    mocks.attemptAcpLatestFork.mockResolvedValue(null);
    mocks.createReplayForkSession.mockResolvedValue({ ok: true, childSessionId: 'child-replay' });
    mocks.isAcpForkEligibleForAgent.mockReturnValue(false);
    mocks.evaluateAgentSessionCapabilitySupport.mockReturnValue('unsupported');
    mocks.nativeForkOpenModes.length = 0;
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
    })).resolves.toEqual({ ok: true, childSessionId: 'child-native-open' });
    expect(mocks.attemptNativeForkOpen).toHaveBeenCalledWith(expect.objectContaining({
      forkPoint: { type: 'seq', upToSeqInclusive: 7 },
      targetSeqInclusive: 7,
      awaitAgentSessionOpen,
    }));
    expect(mocks.attemptProviderNativeFork).not.toHaveBeenCalled();
    expect(mocks.createReplayForkSession).not.toHaveBeenCalled();
    expect(bridge.resolveExecutionSurfaces).not.toHaveBeenCalled();
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
      ownerMetadata: 'owner-ciphertext',
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
