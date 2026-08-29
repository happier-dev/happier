import { describe, expect, it } from 'vitest';

import {
  CodexChatGptAuthTokensRefreshResponseSchema,
  CodexChatGptAuthTokensRefreshSelectionSchema,
  createCodexChatGptBridgeRefreshFailureClassification,
  readCodexChatGptRefreshPlanType,
  resolveCodexChatGptRefreshSelectionFromChildSelection,
  resolveCodexChatGptRefreshSelectionFromMetadata,
} from './refreshBridge.js';

describe('Codex ChatGPT auth-token refresh bridge contract', () => {
  it('accepts profile and group selections for the Codex connected service', () => {
    expect(CodexChatGptAuthTokensRefreshSelectionSchema.parse({
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
    })).toEqual({
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
    });

    expect(CodexChatGptAuthTokensRefreshSelectionSchema.parse({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'primary',
      fallbackProfileId: 'backup',
      generation: 7,
    })).toEqual({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'team',
      activeProfileId: 'primary',
      fallbackProfileId: 'backup',
      generation: 7,
    });
  });

  it('publishes only the Codex access token response fields used by the daemon bridge', () => {
    expect(CodexChatGptAuthTokensRefreshResponseSchema.parse({
      accessToken: 'access-token',
      chatgptAccountId: null,
      chatgptPlanType: 'plus',
    })).toEqual({
      accessToken: 'access-token',
      chatgptAccountId: null,
      chatgptPlanType: 'plus',
    });
    expect(CodexChatGptAuthTokensRefreshResponseSchema.parse({
      accessToken: 'access-token',
      refreshToken: 'must-not-cross-bridge',
      chatgptAccountId: null,
      chatgptPlanType: null,
    })).toEqual({
      accessToken: 'access-token',
      chatgptAccountId: null,
      chatgptPlanType: null,
    });
  });

  it('resolves metadata-backed group refreshes through the selected profile and preserves recovery group context', () => {
    expect(resolveCodexChatGptRefreshSelectionFromMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'main',
            profileId: 'backup',
          },
        },
      },
    })).toEqual({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'backup',
      },
      recoveryGroupId: 'main',
    });
  });

  it('reads session bindings only under the canonical qualified service key', () => {
    expect(resolveCodexChatGptRefreshSelectionFromMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
          },
        },
      },
    })).toBeNull();
  });

  it('consumes the typed binding projected from legacy Codex runtime descriptors by the host', () => {
    expect(resolveCodexChatGptRefreshSelectionFromMetadata({
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'legacy-profile',
          },
        },
      },
    })).toEqual({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'legacy-profile',
      },
      recoveryGroupId: null,
    });
  });

  it('resolves profile child selections onto the provider-local refresh wire identity', () => {
    expect(resolveCodexChatGptRefreshSelectionFromChildSelection({
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'work',
    })).toEqual({
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      recoveryGroupId: null,
    });
  });

  it('rejects child selections that do not carry the provider-local service id', () => {
    expect(resolveCodexChatGptRefreshSelectionFromChildSelection({
      kind: 'profile',
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
    })).toBeNull();
    expect(resolveCodexChatGptRefreshSelectionFromChildSelection({
      kind: 'group',
      serviceId: 'happier.agent.codex/openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      fallbackProfileId: 'backup',
      generation: 4,
    })).toBeNull();
  });

  it('builds refresh failure classifications from profile and group bridge selections', () => {
    const resolution = resolveCodexChatGptRefreshSelectionFromChildSelection({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'main',
      activeProfileId: 'primary',
      fallbackProfileId: 'backup',
      generation: 4,
      policy: null,
    });

    expect(resolution).not.toBeNull();
    if (!resolution) return;
    expect(resolution).toEqual({
      selection: {
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'main',
        activeProfileId: 'primary',
        fallbackProfileId: 'backup',
        generation: 4,
      },
      recoveryGroupId: 'main',
    });
    expect(createCodexChatGptBridgeRefreshFailureClassification(resolution)).toMatchObject({
      kind: 'refresh_failed',
      // Host-facing attribution carries the canonical qualified Plugin
      // contribution key, while the bridge selection above stays provider-local.
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'primary',
      groupId: 'main',
      source: 'provider_runtime_marker',
    });
  });

  it('reads trimmed ChatGPT plan type from refresh request parameters', () => {
    expect(readCodexChatGptRefreshPlanType({ chatgptPlanType: ' plus ' })).toBe('plus');
    expect(readCodexChatGptRefreshPlanType({ chatgptPlanType: '' })).toBeNull();
    expect(readCodexChatGptRefreshPlanType(null)).toBeNull();
  });
});
