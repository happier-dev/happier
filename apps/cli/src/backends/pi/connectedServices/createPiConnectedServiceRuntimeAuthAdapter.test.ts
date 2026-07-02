import { describe, expect, it } from 'vitest';

import {
  createPiConnectedServiceRuntimeAuthAdapter,
  mapPiLimitCategoryToRuntimeAuthFailureKind,
} from './createPiConnectedServiceRuntimeAuthAdapter';

describe('createPiConnectedServiceRuntimeAuthAdapter', () => {
  it('does not classify ambiguous Pi runtime errors as provider-id connected services', () => {
    const adapter = createPiConnectedServiceRuntimeAuthAdapter();

    expect(adapter.classifyRuntimeAuthFailure({
      target: { agentId: 'pi' },
      error: new Error('usage limit reached'),
      selection: {
        openaiCodexProfileId: 'codex-work',
        anthropicProfileId: 'anthropic-work',
      },
    })).toBeNull();
  });

  it('classifies Pi assistant usage-limit messages for the matching connected-service group', () => {
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

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'claude-subscription',
      profileId: 'claude-primary',
      groupId: 'claude-main',
      retryAfterMs: 150_000,
      quotaScope: 'account',
      source: 'stable_provider_message',
    });
  });

  it('classifies encoded assistant content usage-limit messages for the matching Codex group', () => {
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

    expect(classification).toMatchObject({
      kind: 'usage_limit',
      limitCategory: 'usage_limit',
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: 'happier',
      quotaScope: 'account',
      source: 'stable_provider_message',
    });
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
        openaiCodexProfileId: 'codex-work',
        anthropicProfileId: 'anthropic-work',
      },
    })).resolves.toEqual({
      supported: true,
      activeProfiles: {
        'openai-codex': 'codex-work',
        anthropic: 'anthropic-work',
      },
    });
  });
});
