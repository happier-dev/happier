import { describe, expect, it } from 'vitest';
import {
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
  type PluginConnectedAccountAuthenticationModeV2,
  type PluginConnectedAccountAuthenticationV2,
  type QualifiedConnectedAccountProfileV4,
} from '@happier-dev/protocol';

import {
  resolveConnectedAccountPurposeTargetEligibility,
} from './connectedAccountPurposeTargetEligibility';

const service = Object.freeze({
  pluginId: 'acme.managed.provider',
  localId: 'gateway',
});

const connectedAccount = Object.freeze(
  QualifiedConnectedAccountProfileV4Schema.parse({
    ref: { service, accountId: 'work' },
    status: 'connected',
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true,
    configurationRevision: null,
    displayName: 'Work account',
    scopes: [],
  }),
);

const expiredAccount: QualifiedConnectedAccountProfileV4 = Object.freeze({
  ...connectedAccount,
  expiresAt: 1,
});

const legacyUnfencedAccount: QualifiedConnectedAccountProfileV4 = Object.freeze({
  ...connectedAccount,
  revisionSemantics: 'legacy_unfenced',
  credentialRevision: null,
});

const configurationBlockedAccount: QualifiedConnectedAccountProfileV4 = Object.freeze({
  ...connectedAccount,
  configurationReady: false,
});

function groupWith(activeConnectedAccountId: string) {
  return Object.freeze(
    QualifiedConnectedAccountGroupV4Schema.parse({
      v: 1,
      ref: { service, groupId: 'team' },
      incarnation: 'qualified-group-row-team',
      displayName: 'Team pool',
      policy: {},
      activeConnectedAccountId,
      generation: 1,
      runtimeStateRevision: 1,
      state: { status: 'ready' },
      createdAt: 1,
      updatedAt: 1,
      members: [{
        v: 1,
        connectedAccountId: activeConnectedAccountId,
        priority: 1,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
      }],
    }),
  );
}

const oauthMode: PluginConnectedAccountAuthenticationModeV2 = {
  id: 'oauth',
  kind: 'oauthAuthorizationCode',
  pkce: 'required',
  outcomeReconciliation: 'none',
};

const accountScopedConfigurationMode: PluginConnectedAccountAuthenticationModeV2 = {
  ...oauthMode,
  configuration: { scope: 'account', fields: [{ id: 'endpoint', title: 'Endpoint', schema: { type: 'string' } }] },
} as PluginConnectedAccountAuthenticationModeV2;

function authenticationWith(
  mode: PluginConnectedAccountAuthenticationModeV2 = oauthMode,
): PluginConnectedAccountAuthenticationV2 {
  return {
    defaultModeId: mode.id,
    modes: [mode],
  };
}

function resolve(input: Readonly<{
  target: Parameters<typeof resolveConnectedAccountPurposeTargetEligibility>[0]['target'];
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  groups?: Parameters<typeof resolveConnectedAccountPurposeTargetEligibility>[0]['groups'];
  authentication?: PluginConnectedAccountAuthenticationV2 | null;
}>) {
  return resolveConnectedAccountPurposeTargetEligibility({
    target: input.target,
    declaredServices: [service],
    accounts: input.accounts,
    groups: input.groups ?? [],
    resolveAuthentication: () => (
      input.authentication === undefined ? authenticationWith() : input.authentication
    ),
  });
}

describe('resolveConnectedAccountPurposeTargetEligibility', () => {
  it('accepts a current direct account', () => {
    expect(resolve({
      target: { kind: 'account', account: { service, accountId: 'work' } },
      accounts: [connectedAccount],
    })).toBe('usable');
  });

  it('reports unknown for a current direct account whose descriptor is unavailable', () => {
    expect(resolve({
      target: { kind: 'account', account: { service, accountId: 'work' } },
      accounts: [connectedAccount],
      authentication: null,
    })).toBe('unknown');
  });

  it('refuses a direct account whose credential has expired', () => {
    // The protocol group resolver already treats an expired account as unusable.
    // A direct account carries the same expiry, so the shared UI owner must not
    // offer a target the daemon will reject at materialization time.
    expect(resolve({
      target: { kind: 'account', account: { service, accountId: 'work' } },
      accounts: [expiredAccount],
    })).toBe('unusable');
  });

  it('refuses a direct legacy-unfenced V4 account', () => {
    expect(resolve({
      target: { kind: 'account', account: { service, accountId: 'work' } },
      accounts: [legacyUnfencedAccount],
    })).toBe('unusable');
  });

  it('refuses a group whose resolved active account has blocked account-scoped configuration', () => {
    expect(resolve({
      target: { kind: 'group', service, groupId: 'team' },
      accounts: [configurationBlockedAccount],
      groups: [groupWith('work')],
      authentication: authenticationWith(accountScopedConfigurationMode),
    })).toBe('unusable');
  });

  it('reports unknown for a group whose resolved active account has no descriptor mode yet', () => {
    expect(resolve({
      target: { kind: 'group', service, groupId: 'team' },
      accounts: [connectedAccount],
      groups: [groupWith('work')],
      authentication: null,
    })).toBe('unknown');
  });

  it('accepts a group whose resolved active account is current and configured', () => {
    expect(resolve({
      target: { kind: 'group', service, groupId: 'team' },
      accounts: [connectedAccount],
      groups: [groupWith('work')],
      authentication: authenticationWith(accountScopedConfigurationMode),
    })).toBe('usable');
  });
});
