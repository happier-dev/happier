import { describe, expect, it } from 'vitest';

import {
  createPiConnectedServiceRuntimeAuthAdapter,
  mapPiLimitCategoryToRuntimeAuthFailureKind,
} from './runtimeAuthAdapter.js';

describe('createPiConnectedServiceRuntimeAuthAdapter', () => {
  it('does not classify ambiguous Pi runtime errors as provider-id connected services', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error: new Error('usage limit reached'),
      selection: {},
    })).toBeNull();
  });

  it('does not reclassify request-auth Anthropic terminal message text as recovery evidence', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'anthropic',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          stopReason: 'error',
          errorMessage: 'Usage limit reached. Please try again in 2m30s.',
        },
      },
      selection: new Map([
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-main',
          activeProfileId: 'claude-primary',
          fallbackProfileId: 'claude-backup',
          generation: 3,
        }],
      ]),
    });

    expect(classification).toBeNull();
  });

  it('does not reclassify request-auth Codex terminal message text after leaf-owned exact reporting', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'openai-codex',
        message: {
          role: 'assistant',
          provider: 'openai-codex',
          stopReason: 'error',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                type: 'usage_limit_reached',
                errorMessage: 'Usage limit reached',
              }),
            },
          ],
        },
      },
      selection: new Map([
        ['openai-codex', {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'happier',
          activeProfileId: 'leeroy',
          fallbackProfileId: 'backup',
          generation: 3,
        }],
      ]),
    });

    expect(classification).toBeNull();
  });

  it('classifies Pi auth failures against OpenAI API-key selections', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error: { provider: 'openai', message: 'No API key found for provider: openai' },
      selection: {
        kind: 'profile',
        serviceId: 'openai',
        profileId: 'openai-work',
      },
    });

    expect(classification).toMatchObject({
      kind: 'auth_expired',
      limitCategory: 'auth_invalid',
      serviceId: 'openai',
      profileId: 'openai-work',
      groupId: null,
      source: 'stable_provider_message',
    });
  });

  it('preserves structured fields attached to Pi Error instances', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();
    const error = Object.assign(new Error('request failed'), {
      status: 429,
      provider: 'openai',
      serviceId: 'openai',
    });

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error,
      selection: {
        kind: 'profile',
        serviceId: 'openai',
        profileId: 'openai-work',
      },
    });

    expect(classification).toMatchObject({
      kind: 'rate_limit',
      limitCategory: 'rate_limit',
      serviceId: 'openai',
      profileId: 'openai-work',
      source: 'structured_provider_error',
    });
    expect(classification).not.toHaveProperty('quotaScope');
  });

  it('classifies Pi compaction dependency failures separately from usage limits', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    const classification = adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi', targetId: 'pi-session-1' },
      error: {
        provider: 'anthropic',
        message: {
          role: 'assistant',
          provider: 'anthropic',
          stopReason: 'error',
          errorMessage: 'Compaction failed because the provider dependency is unavailable.',
        },
      },
      selection: new Map([
        ['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-main',
          activeProfileId: 'claude-primary',
        }],
      ]),
    });

    expect(classification).toMatchObject({
      kind: 'dependency_failure',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      source: 'stable_provider_message',
    });
  });

  it('maps every recoverable provider limit category, including temporary throttles', () => {
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('temporary_throttle')).toBe('temporary_throttle');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('usage_limit')).toBe('usage_limit');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('rate_limit')).toBe('rate_limit');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('capacity')).toBe('capacity');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('auth_invalid')).toBe('auth_expired');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('plan_invalid')).toBe('plan');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('validation_failed')).toBe('validation');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('disabled')).toBe('account_disabled');
    expect(mapPiLimitCategoryToRuntimeAuthFailureKind('unknown')).toBeNull();
  });

  it('reports independently active connected-service profiles for materialization diagnostics', async () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    await expect(adapter.materializeActiveProfile({
      target: { agentId: 'pi' },
      selection: {
        kind: 'group',
        serviceId: 'external.example/auth',
        activeProfileId: 'external-work',
        groupId: 'external-main',
      },
    })).resolves.toEqual({
      supported: true,
      activeProfiles: {
        'external.example/auth': 'external-work',
      },
    });
  });
});
