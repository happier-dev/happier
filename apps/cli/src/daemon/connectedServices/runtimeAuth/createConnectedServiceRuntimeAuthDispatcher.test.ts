import { describe, expect, it } from 'vitest';

import { createConnectedServiceRuntimeAuthDispatcher } from './createConnectedServiceRuntimeAuthDispatcher';
import type { ConnectedServiceProviderRuntimeAuthAdapter } from './types';

describe('createConnectedServiceRuntimeAuthDispatcher', () => {
  it('dispatches runtime auth operations through a provider adapter', async () => {
    const adapter: ConnectedServiceProviderRuntimeAuthAdapter = {
      classifyRuntimeAuthFailure: () => ({
        kind: 'usage_limit',
        serviceId: 'openai-codex',
        profileId: 'backup',
        groupId: 'main',
        resetsAtMs: 2_000,
        planType: 'pro',
        rateLimits: { primary: { usedPercent: 100 } },
        source: 'structured_provider_error',
      }),
      materializeActiveProfile: async () => ({ env: { PROVIDER_HOME: '/tmp/provider' } }),
      canHotApply: () => ({ supported: true }),
      hotApply: async () => ({ status: 'applied' }),
      recoverAfterRuntimeAuthSwitch: async () => ({ status: 'resumed' }),
      probeQuota: async () => ({ status: 'available', resetsAtMs: null }),
      refreshActiveProfile: async () => ({ status: 'refreshed' }),
    };
    const dispatcher = createConnectedServiceRuntimeAuthDispatcher({
      resolveAdapter: () => adapter,
    });

    expect(dispatcher.classifyRuntimeAuthFailure({ target: { agentId: 'fake' }, error: new Error('x') })?.kind).toBe('usage_limit');
    await expect(dispatcher.materializeActiveProfile({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).resolves.toEqual({
      env: { PROVIDER_HOME: '/tmp/provider' },
    });
    expect(dispatcher.canHotApply({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).toEqual({ supported: true });
    await expect(dispatcher.hotApply({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).resolves.toEqual({ status: 'applied' });
    await expect(dispatcher.recoverAfterRuntimeAuthSwitch({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).resolves.toEqual({ status: 'resumed' });
    await expect(dispatcher.probeQuota({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).resolves.toEqual({ status: 'available', resetsAtMs: null });
    await expect(dispatcher.refreshActiveProfile({ target: { agentId: 'fake' }, selection: { serviceId: 'openai-codex' } })).resolves.toEqual({ status: 'refreshed' });
  });
});
