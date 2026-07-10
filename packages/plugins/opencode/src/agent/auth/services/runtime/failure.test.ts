import { describe, expect, it } from 'vitest';

import { createOpenCodeConnectedServiceRuntimeAuthAdapter } from './failure.js';

describe('createOpenCodeConnectedServiceRuntimeAuthAdapter', () => {
  it('classifies brokered OpenAI token refresh failures against the selected connected service', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode', targetId: 'happy-session-1' },
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        activeProfileId: 'codex-profile',
        groupId: 'team',
      },
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Token refresh failed: 401 Authorization: Bearer sk-live-secret',
        },
      },
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai-codex',
      profileId: 'codex-profile',
      groupId: 'team',
      connectedServiceRecovery: 'available',
      source: 'structured_provider_error',
    });
    expect(JSON.stringify(classification)).not.toContain('sk-live-secret');
  });

  it('classifies message-only direct OpenAI auth failures from provider error evidence', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai',
        profileId: 'api-key-profile',
      },
      error: {
        message: '401 Unauthorized: invalid api key',
      },
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai',
      profileId: 'api-key-profile',
      connectedServiceRecovery: 'available',
      source: 'stable_provider_message',
    });
  });

  it('returns null when no supported OpenCode connected service can be resolved', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode' },
      selection: { serviceId: 'gemini', profileId: 'gemini-profile' },
      error: { message: '401 Unauthorized' },
    })).toBeNull();
  });

  it('preserves structured OpenCode usage-limit classifications', () => {
    const adapter = createOpenCodeConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'opencode' },
      selection: {
        serviceId: 'openai-codex',
        activeProfileId: 'codex-profile',
      },
      error: {
        name: 'FreeUsageLimitError',
        headers: { 'retry-after-ms': '5000' },
      },
    });

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'codex-profile',
      quotaScope: 'account',
      providerLimitId: 'free_tier_limit',
      connectedServiceRecovery: 'available',
      source: 'structured_provider_error',
    });
  });
});
