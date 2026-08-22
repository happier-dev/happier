import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dispatchProviderNativeFork: vi.fn(),
}));

vi.mock('@/session/fork/providerNativeForkDispatch', () => ({
  dispatchProviderNativeFork: (...args: unknown[]) => mocks.dispatchProviderNativeFork(...args),
}));

import { attemptProviderNativeFork } from './attemptProviderNativeFork';

/**
 * The fork strategy modal sends the generic `native` user intent. This owner is
 * the only place that decides whether a provider-native attempt happens, so the
 * intent has to be admitted here or the Native card can never produce a fork.
 */
function callWithStrategy(requestedStrategy: string) {
  return attemptProviderNativeFork({
    requestedStrategy,
    credentials: { token: 'token' },
    parentSessionId: 'parent-session',
    parentSession: { id: 'parent-session' },
    parentMetadata: { path: '/tmp/project' },
    directory: '/tmp/project',
    forkPoint: { type: 'latest' },
    targetSeqInclusive: 11,
    effectiveCutoffSeqInclusive: 11,
    spawnNonce: 'nonce:native',
    forkBackendResolution: {
      catalogAgentId: 'codex',
      configuredAcp: null,
      agentHintAgentId: 'codex',
      backendTargetV2: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
    },
    inheritedForkOverrides: { spawn: {} },
    forkSurface: { fork: vi.fn() },
    spawnSession: vi.fn(),
    stopSession: vi.fn(),
  } as unknown as Parameters<typeof attemptProviderNativeFork>[0]);
}

describe('attemptProviderNativeFork strategy admission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchProviderNativeFork.mockResolvedValue(null);
  });

  it('admits the generic native intent', async () => {
    await callWithStrategy('native');
    expect(mocks.dispatchProviderNativeFork).toHaveBeenCalledTimes(1);
  });

  it('still admits auto and the explicit provider_native strategy', async () => {
    await callWithStrategy('auto');
    await callWithStrategy('provider_native');
    expect(mocks.dispatchProviderNativeFork).toHaveBeenCalledTimes(2);
  });

  it('does not attempt a provider-native fork for an explicit replay request', async () => {
    await expect(callWithStrategy('replay')).resolves.toBeNull();
    expect(mocks.dispatchProviderNativeFork).not.toHaveBeenCalled();
  });

  it('makes an attempted provider-native fork terminal for auto instead of falling through to replay', async () => {
    mocks.dispatchProviderNativeFork.mockRejectedValue(
      new Error('transport interrupted after provider fork dispatch'),
    );

    await expect(callWithStrategy('auto')).resolves.toMatchObject({
      ok: false,
      errorCode: 'UNEXPECTED',
      errorMessage: expect.stringContaining('outcome is unknown'),
    });
  });
});
