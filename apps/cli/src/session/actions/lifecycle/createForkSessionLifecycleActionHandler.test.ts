import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForkSurfaceV1 } from '@happier-dev/agents';
import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';

const mocks = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  fetchSessionByIdCompat: vi.fn(),
  tryDecryptSessionMetadata: vi.fn(),
  attemptProviderNativeFork: vi.fn(),
  attemptAcpLatestFork: vi.fn(),
  createReplayForkSession: vi.fn(),
  isAcpForkEligibleForProvider: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: (...args: unknown[]) => mocks.readCredentials(...args),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: (...args: unknown[]) => mocks.fetchSessionByIdCompat(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => mocks.tryDecryptSessionMetadata(...args),
}));

vi.mock('@/agent/acp/acpForkEligibility', () => ({
  isAcpForkEligibleForProvider: (...args: unknown[]) => mocks.isAcpForkEligibleForProvider(...args),
}));

vi.mock('./fork/attemptProviderNativeFork', () => ({
  attemptProviderNativeFork: (...args: unknown[]) => mocks.attemptProviderNativeFork(...args),
}));

vi.mock('./fork/attemptAcpLatestFork', () => ({
  attemptAcpLatestFork: (...args: unknown[]) => mocks.attemptAcpLatestFork(...args),
}));

vi.mock('./fork/createReplayForkSession', () => ({
  createReplayForkSession: (...args: unknown[]) => mocks.createReplayForkSession(...args),
}));

import { createForkSessionLifecycleActionHandler } from './createForkSessionLifecycleActionHandler';

function createBridge(params: Readonly<{
  forkSurface?: ForkSurfaceV1 | null;
}>): ReturnType<typeof getSessionHostBridge> {
  return {
    resolveSessionForkBackendTarget: vi.fn(async () => ({
      ok: true,
      providerAgentId: 'codex',
      providerHintProviderId: 'codex',
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
    mocks.tryDecryptSessionMetadata.mockReturnValue({
      path: '/tmp/project',
    });
    mocks.attemptProviderNativeFork.mockResolvedValue(null);
    mocks.attemptAcpLatestFork.mockResolvedValue(null);
    mocks.createReplayForkSession.mockResolvedValue({ ok: true, childSessionId: 'child-replay' });
    mocks.isAcpForkEligibleForProvider.mockReturnValue(false);
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
});
