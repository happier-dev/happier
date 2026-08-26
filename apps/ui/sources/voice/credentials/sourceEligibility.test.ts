import { describe, expect, it } from 'vitest';
import type {
  PluginConnectedAccountAuthenticationModeV2,
  PluginConnectedAccountAuthenticationV2,
} from '@happier-dev/protocol';

import { resolveVoiceConnectedAccountTargetEligibility } from './sourceEligibility';

const CODEX_SERVICE = Object.freeze({
  pluginId: 'happier.agent.codex',
  localId: 'openai-codex',
});

const account = Object.freeze({
  ref: Object.freeze({
    service: CODEX_SERVICE,
    accountId: 'codex-work',
  }),
  status: 'connected' as const,
  authenticationModeId: 'oauth',
  revisionSemantics: 'revisioned' as const,
  credentialRevision: 'cred-1',
  configurationReady: false,
  configurationRevision: null,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
});

const target = Object.freeze({
  kind: 'account' as const,
  account: account.ref,
});

const oauthMode = {
  id: 'oauth',
  kind: 'oauthAuthorizationCode',
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  pkce: 'required',
  outcomeReconciliation: 'none',
} satisfies PluginConnectedAccountAuthenticationModeV2;

function authenticationWith(
  mode: PluginConnectedAccountAuthenticationModeV2 = oauthMode,
): PluginConnectedAccountAuthenticationV2 {
  return {
    defaultModeId: mode.id,
    modes: [mode],
  };
}

describe('resolveVoiceConnectedAccountTargetEligibility', () => {
  it('keeps a connected account selectable when its authentication mode declares no configuration', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [account],
      groups: [],
      resolveAuthentication: () => authenticationWith(),
    })).toBe('usable');
  });

  it('reports an unresolvable authentication mode as unknown instead of unusable', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [account],
      groups: [],
      resolveAuthentication: () => null,
    })).toBe('unknown');
  });

  it('ignores stale configuration readiness when the authentication mode is unresolvable', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [{
        ...account,
        configurationReady: true,
        configurationRevision: 'configuration-1',
      }],
      groups: [],
      resolveAuthentication: () => null,
    })).toBe('unknown');
  });

  it('keeps a disconnected account unusable rather than unknown', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [{ ...account, status: 'needs_reauth' as const }],
      groups: [],
      resolveAuthentication: () => null,
    })).toBe('unusable');
  });

  it('keeps a passive legacy-unfenced account out of the voice runtime', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [{
        ...account,
        revisionSemantics: 'legacy_unfenced' as const,
        credentialRevision: null,
      }],
      groups: [],
      resolveAuthentication: () => authenticationWith(),
    })).toBe('unusable');
  });

  it('fails closed when the account authentication mode requires account configuration', () => {
    expect(resolveVoiceConnectedAccountTargetEligibility({
      target,
      declaredServices: [CODEX_SERVICE],
      accounts: [account],
      groups: [],
      resolveAuthentication: () => authenticationWith({
        id: 'oauth',
        kind: 'oauthAuthorizationCode',
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        pkce: 'required',
        outcomeReconciliation: 'none',
        configuration: {
          scope: 'account',
          changeBehavior: 'reconnect',
          fields: [{
            id: 'organization',
            title: 'Organization',
            schema: { type: 'string', minLength: 1 },
            required: true,
            secret: false,
          }],
        },
      } as PluginConnectedAccountAuthenticationModeV2),
    })).toBe('unusable');
  });
});
