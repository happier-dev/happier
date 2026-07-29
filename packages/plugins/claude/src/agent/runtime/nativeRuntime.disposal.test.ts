import { describe, expect, it, vi } from 'vitest';

import { createClaudeNativeSessionRuntimeFromOperations } from './nativeRuntime.js';

describe('Claude native runtime disposal', () => {
  it('forwards host_shutdown to the provider session owner', async () => {
    const disposeProviderSession = vi.fn(async () => undefined);
    const runtime = createClaudeNativeSessionRuntimeFromOperations({
      subscribeEffectiveModel: () => () => undefined,
      subscribeCanonicalAgentSessionEvents: () => () => undefined,
      subscribeProviderEvents: () => () => undefined,
      beginProviderTurn: () => undefined,
      startProviderSession: async () => null,
      sendProviderTurnPrompt: async () => undefined,
      steerProviderTurn: async () => undefined,
      waitForProviderTurnCompletion: async () => undefined,
      respondToProviderPermission: async () => ({ delivered: true }),
      cancelProviderTurn: async () => undefined,
      readProviderIdentity: () => ({ sessionId: null }),
      updateProviderConfiguration: async () => ({ status: 'applied' }),
      disposeProviderSession,
    }, {
      kind: 'create',
      sessionId: 'session-disposal-reason',
      cwd: '/repo',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {},
      },
    });

    await runtime.dispose('host_shutdown');

    expect(disposeProviderSession).toHaveBeenCalledWith('host_shutdown');
  });
});
