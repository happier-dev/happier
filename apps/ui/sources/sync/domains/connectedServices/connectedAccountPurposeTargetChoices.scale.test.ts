import { describe, expect, it } from 'vitest';
import {
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
} from '@happier-dev/protocol';

import {
  buildConnectedAccountPurposeTargetChoices,
  connectedAccountPurposeTargetChoiceId,
} from './connectedAccountPurposeTargetChoices';

/**
 * Deterministic completeness coverage for the supported 501+ Connected
 * Account/group inventory path. Performance measurements belong in an
 * explicit benchmark, not a wall-clock assertion in the correctness suite.
 */

const service = Object.freeze({ pluginId: 'acme.managed.provider', localId: 'gateway' });

function makeAccounts(count: number) {
  return Array.from({ length: count }, (_, index) => QualifiedConnectedAccountProfileV4Schema.parse({
    ref: { service, accountId: `account-${index}` },
    status: 'connected',
    authenticationModeId: 'oauth',
    revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
    configurationReady: true,
    configurationRevision: null,
    displayName: `Account ${index}`,
    scopes: [],
  }));
}

function makeGroups(count: number, memberAccountId: string) {
  return Array.from({ length: count }, (_, index) => QualifiedConnectedAccountGroupV4Schema.parse({
    v: 1,
    ref: { service, groupId: `group-${index}` },
    incarnation: `qualified-group-row-${index}`,
    displayName: `Group ${index}`,
    policy: {},
    activeConnectedAccountId: memberAccountId,
    generation: 1,
    runtimeStateRevision: 1,
    state: { status: 'ready' },
    createdAt: 1,
    updatedAt: 1,
    members: [{
      v: 1,
      connectedAccountId: memberAccountId,
      priority: 1,
      enabled: true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    }],
  }));
}

const resolveAuthentication = () => ({
  defaultModeId: 'oauth',
  modes: [{
    id: 'oauth',
    kind: 'oauthAuthorizationCode' as const,
    pkce: 'required' as const,
    outcomeReconciliation: 'none' as const,
  }],
});

function project(input: Readonly<{
  accounts: ReturnType<typeof makeAccounts>;
  groups: ReturnType<typeof makeGroups>;
  selectedAccountId: string;
}>) {
  return buildConnectedAccountPurposeTargetChoices({
    declaration: { purpose: 'request-auth', service, required: false },
    selectedTarget: {
      kind: 'account',
      account: { service, accountId: input.selectedAccountId },
    },
    accounts: input.accounts,
    groups: input.groups,
    labelsByKey: {},
    serviceTitle: 'Acme Gateway',
    resolveAuthentication,
  });
}

describe('Connected Account purpose choices at supported 501+ inventory scale', () => {
  it('projects the complete selectable choice set for a 601-row Account/group inventory', () => {
    const accounts = makeAccounts(601);
    const groups = makeGroups(40, accounts[0]!.ref.accountId);
    const choices = project({ accounts, groups, selectedAccountId: accounts[600]!.ref.accountId });

    // One unbound choice, one choice per account, one choice per group, and no
    // synthetic unavailable row because the selected target still resolves.
    expect(choices).toHaveLength(1 + accounts.length + groups.length);
    expect(choices.filter((choice) => choice.selectable)).toHaveLength(accounts.length + groups.length + 1);
    expect(choices.filter((choice) => choice.kind === 'unavailable')).toHaveLength(0);

    const selected = choices.find((choice) => choice.current);
    expect(selected?.selectable).toBe(true);
    expect(connectedAccountPurposeTargetChoiceId(selected?.target ?? null)).toBe(
      connectedAccountPurposeTargetChoiceId({ kind: 'account', account: { service, accountId: 'account-600' } }),
    );

    // Account rows stay alphabetically sorted ahead of group rows.
    const accountLabels = choices.filter((choice) => choice.kind === 'account')
      .map((choice) => choice.presentation.primaryLabel);
    expect([...accountLabels].sort((left, right) => left.localeCompare(right))).toEqual(accountLabels);
    expect(choices.at(-1)?.kind).toBe('group');
  });
});
