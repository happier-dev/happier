import { describe, expect, it } from 'vitest';

import {
  connectedServiceProfileKey,
  qualifiedConnectedAccountPreferenceServiceKey,
} from './connectedServiceProfilePreferences';
import {
  presentQualifiedConnectedAccountTarget,
} from './qualifiedConnectedAccountTargetPresentation';
import { presentConnectedAccountIdentity, type ConnectedAccountIdentityInput } from './maskAccountEmail';
import { connectedEntitySubjectKeyV1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { t } from '@/text';

const service = Object.freeze({
  pluginId: 'example.external.gateway',
  localId: 'managed-accounts',
});
const account = Object.freeze({
  ref: Object.freeze({ service, accountId: 'account_opaque_123' }),
  displayName: 'Plugin-supplied account',
  providerIdentity: Object.freeze({
    email: 'work@example.com',
    accountId: 'provider-account-42',
  }),
  // Presentation must not read a credential/configuration shape even when one
  // happens to share the account projection object at a caller boundary.
  credential: 'secret-never-presented',
});
const group = Object.freeze({
  ref: Object.freeze({ service, groupId: 'pool_opaque_456' }),
  displayName: 'Team pool',
});

describe('presentQualifiedConnectedAccountTarget', () => {
  it('names the recorded vendor-native Team route without claiming direct disclosure', async () => {
    const { presentConnectedAccountPurposeTeamResource } = await import('./qualifiedConnectedAccountTargetPresentation');
    const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared', teamId: 'team', displayName: 'Company Gateway', resourceRevision: 1,
      readiness: { kind: 'available' }, recoveryAction: null, mayBroker: false, mayReceiveDirect: false,
      allowedRoutes: ['vendor-native'], directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', providerModels: [],
      sourcePresentation: { kind: 'connected_service', service },
    });
    const presentation = presentConnectedAccountPurposeTeamResource({ teamResource: { teamId: 'team',
      selection: { resourceId: 'shared', deliveryMode: 'vendor-native' } }, teamResources: [resource], serviceTitle: null });
    expect(presentation.accessibilityLabel).toContain(t('teams.credentials.delivery.vendorNative'));
    expect(presentation.accessibilityLabel).not.toContain(t('teams.credentials.delivery.direct'));
  });

  it('keeps retained account and pool names meaningful when their descriptor title is absent', () => {
    const unnamed = { ref: account.ref };
    const pool = { ref: group.ref };
    const input = { accounts: [unnamed], groups: [pool], labelsByKey: {}, serviceTitle: null };
    const accountPresentation = presentQualifiedConnectedAccountTarget({ ...input, target: { kind: 'account', account: unnamed.ref } });
    const poolPresentation = presentQualifiedConnectedAccountTarget({ ...input, target: { kind: 'group', ...pool.ref } });

    expect(accountPresentation.primaryLabel).toBe('Managed Accounts account');
    expect(poolPresentation.primaryLabel).toBe('Managed Accounts');
    expect(accountPresentation.accessibilityLabel).not.toContain(account.ref.accountId);
    expect(poolPresentation.accessibilityLabel).not.toContain(group.ref.groupId);
  });

  it('summarizes a pool by the accounts it rotates and the one in use, never by an id', () => {
    const second = { ref: { service, accountId: 'account_opaque_789' }, displayName: 'Bot account' };
    const member = (connectedAccountId: string, enabled = true) => ({ connectedAccountId, enabled });
    const present = (pool: Record<string, unknown>) => presentQualifiedConnectedAccountTarget({
      target: { kind: 'group', service, groupId: group.ref.groupId },
      accounts: [account, second], groups: [{ ...group, ...pool }], labelsByKey: {}, serviceTitle: 'External Gateway',
    });
    const inUse = present({ members: [member(account.ref.accountId), member(second.ref.accountId), member('gone', false)],
      activeConnectedAccountId: second.ref.accountId });
    expect(inUse.summaryLabel).toBe('2 accounts · using Bot account');
    expect(inUse.secondaryLabel).toContain('2 accounts · using Bot account');
    expect(present({ members: [member(account.ref.accountId)], activeConnectedAccountId: null }).summaryLabel).toBe('1 account');
    // An empty pool says nothing here: the eligibility owner's repair reason speaks for it.
    expect(present({ members: [], activeConnectedAccountId: null }).summaryLabel).toBeUndefined();
    expect(present({}).summaryLabel).toBeUndefined();
  });

  it('uses every resolved personal label when numbering unnamed siblings', () => {
    const accounts = ['a', 'b', 'c'].map(accountId => ({ ref: { service, accountId } }));
    const input = {
      accounts, groups: [], labelsByKey: {}, serviceTitle: 'Claude',
      accountLabelsByAccountId: { a: 'Primary' },
    };
    for (const order of [accounts, [...accounts].reverse()]) {
      const names = accounts.map(account => presentQualifiedConnectedAccountTarget({
        ...input, accounts: order, target: { kind: 'account', account: account.ref },
      }).primaryLabel);
      expect(names).toEqual(['Primary', 'Claude account', 'Claude account 2']);
    }
  });
  it('uses the Account-assigned pool label and returns to the definition label after reset', () => {
    const target = { kind: 'group' as const, service, groupId: group.ref.groupId };
    const input = { target, accounts: [account], groups: [group], serviceTitle: 'External Gateway' };
    expect(presentQualifiedConnectedAccountTarget({ ...input,
      labelsByKey: { [connectedEntitySubjectKeyV1(target)]: 'Personal pool name' } }).primaryLabel).toBe('Personal pool name');
    expect(presentQualifiedConnectedAccountTarget({ ...input, labelsByKey: {} }).primaryLabel).toBe('Team pool');
    expect(group.displayName).toBe('Team pool');
  });
  it('preserves an assigned name while giving an unnamed account service copy', () => {
    const idOnlyAccount = { ref: account.ref, providerIdentity: { accountId: 'provider-account-42' } };
    const present = (accountLabel?: string) => {
      const target = presentQualifiedConnectedAccountTarget({
        target: { kind: 'account', account: account.ref },
        accounts: [idOnlyAccount], groups: [], labelsByKey: {},
        accountLabelsByAccountId: { [account.ref.accountId]: accountLabel },
        serviceTitle: 'External Gateway',
      });
      return presentConnectedAccountIdentity({
        hidden: true, label: target.primaryLabel, labelKind: target.primaryLabelKind,
        email: null, accountId: idOnlyAccount.providerIdentity.accountId,
      }).label;
    };
    expect(present()).toBe('External Gateway account');
    // A user-assigned name is a name even if its text matches the provider id.
    expect(present('provider-account-42')).toBe('provider-account-42');
  });
  it('uses an author-provided service title and stable identities without exposing credentials', () => {
    const presentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'account', account: account.ref },
      accounts: [account],
      groups: [group],
      labelsByKey: {
        [connectedServiceProfileKey({
          serviceId: qualifiedConnectedAccountPreferenceServiceKey(service),
          profileId: account.ref.accountId,
        })]: 'Work account',
      },
      serviceTitle: 'External Gateway',
    });

    expect(presentation).toEqual({
      primaryLabel: 'Work account',
      identityLabel: 'work@example.com',
      secondaryLabel: 'External Gateway · work@example.com',
      accessibilityLabel: 'External Gateway · Work account · work@example.com',
    });
    expect(presentation.accessibilityLabel).not.toContain('secret-never-presented');
  });

  it('never routes a canonical account or pool id into visible or assistive output', () => {
    // The canonical ids stay structured: they key routing, list rows and
    // mutation payloads, and a user cannot recognise an account by one.
    const accountPresentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'account', account: account.ref },
      accounts: [account],
      groups: [group],
      labelsByKey: {},
      serviceTitle: 'External Gateway',
    });
    const groupPresentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'group', service, groupId: group.ref.groupId },
      accounts: [account],
      groups: [group],
      labelsByKey: {},
      serviceTitle: 'External Gateway',
    });

    for (const presentation of [accountPresentation, groupPresentation]) {
      for (const text of [
        presentation.primaryLabel,
        presentation.secondaryLabel ?? '',
        presentation.accessibilityLabel,
      ]) {
        expect(text).not.toContain(account.ref.accountId);
        expect(text).not.toContain(group.ref.groupId);
      }
    }
    // The provider-side identity is still offered, so two unnamed accounts of
    // one service stay distinguishable without an internal id.
    expect(accountPresentation.accessibilityLabel).toContain('work@example.com');
  });

  it('does not promote opaque account or pool ids to the primary label', () => {
    const unnamedAccount = {
      ref: { service, accountId: 'account_opaque_123' },
      providerIdentity: undefined,
      displayName: undefined,
    };
    const unnamedGroup = {
      ref: { service, groupId: 'pool_opaque_456' },
      displayName: null,
    };

    const accountPresentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'account', account: unnamedAccount.ref },
      accounts: [unnamedAccount],
      groups: [unnamedGroup],
      labelsByKey: {},
      serviceTitle: 'External Gateway',
    });
    const groupPresentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'group', service, groupId: unnamedGroup.ref.groupId },
      accounts: [unnamedAccount],
      groups: [unnamedGroup],
      labelsByKey: {},
      serviceTitle: 'External Gateway',
    });

    expect(accountPresentation).toEqual({
      primaryLabel: 'External Gateway account',
      accessibilityLabel: 'External Gateway · External Gateway account',
    });
    expect(groupPresentation).toEqual({
      primaryLabel: 'External Gateway',
      accessibilityLabel: 'External Gateway',
    });
  });

  it('reads stored UUID display names tolerantly and keeps a short secondary hint when no human identity exists', () => {
    const providerId = '00ae5eea-6286-48bc-b82a-30a5f8492864';
    const presentation = presentQualifiedConnectedAccountTarget({
      target: { kind: 'account', account: account.ref },
      accounts: [{ ref: account.ref, displayName: providerId, providerIdentity: { accountId: providerId } }],
      groups: [], labelsByKey: {}, serviceTitle: 'ChatGPT',
    });
    expect(presentation.primaryLabel).toBe('ChatGPT account');
    expect(presentation.secondaryLabel).toContain('00ae5•••64');
    expect(presentation.accessibilityLabel).not.toContain(providerId);
  });
  it('does not treat a service-title placeholder as an available human name', () => {
    const input = {
      target: { kind: 'account' as const, account: account.ref },
      accounts: [{ ref: account.ref, displayName: 'ChatGPT', providerIdentity: { accountId: 'provider-account-42' } }],
      groups: [], labelsByKey: {}, serviceTitle: 'ChatGPT',
    };
    const presentation = presentQualifiedConnectedAccountTarget(input);
    expect(presentation.primaryLabel).toBe('ChatGPT account');
    expect(presentation.identityLabel).toBe('provi•••42');
    // Rename writes the Account preference, not provider-owned displayName.
    expect(presentQualifiedConnectedAccountTarget({ ...input, labelsByKey: {
      [connectedServiceProfileKey({ serviceId: qualifiedConnectedAccountPreferenceServiceKey(service), profileId: account.ref.accountId })]: 'ChatGPT',
    } }).primaryLabel).toBe('ChatGPT');
  });
});

describe('presentConnectedAccountNames', () => {
  it('distinguishes matching display names with their presented emails without repeating the identity', async () => {
    const { presentConnectedAccountNames } = await import('./qualifiedConnectedAccountTargetPresentation');
    const entries = ['personal', 'work'].map(key => ({
      key, serviceTitle: 'ChatGPT', displayName: 'Leeroy Brun', email: `${key}@example.com`,
    }));
    const names = presentConnectedAccountNames(entries);
    expect(names.get('personal')).toMatchObject({ primaryLabel: 'Leeroy Brun · personal@example.com', identityLabel: null });
    expect(names.get('work')).toMatchObject({ primaryLabel: 'Leeroy Brun · work@example.com', identityLabel: null });
    expect(presentConnectedAccountNames(entries.slice(0, 1)).get('personal')?.primaryLabel).toBe('Leeroy Brun');
  });

  it('numbers indistinguishable names in stable key order after applying identity privacy', async () => {
    const { presentConnectedAccountNames } = await import('./qualifiedConnectedAccountTargetPresentation');
    const entries = ['b', 'a'].map(key => ({ key, serviceTitle: 'ChatGPT', displayName: 'Leeroy Brun',
      email: `leeroy+${key}@example.com`,
      presentIdentity: (identity: ConnectedAccountIdentityInput) => presentConnectedAccountIdentity({
        ...identity, label: identity.label ?? null, email: identity.email ?? null, accountId: identity.accountId ?? null, hidden: true,
      }),
    }));
    for (const order of [entries, [...entries].reverse()]) {
      const names = presentConnectedAccountNames(order);
      expect(names.get('a')?.primaryLabel).toBe('Leeroy Brun 1');
      expect(names.get('b')?.primaryLabel).toBe('Leeroy Brun 2');
      expect([...names.values()].map(name => name.primaryLabel).join(' ')).not.toContain('@example.com');
    }
  });

  it('tells apart accounts that read as their service account by a stable order, never an id', async () => {
    const { presentConnectedAccountNames } = await import('./qualifiedConnectedAccountTargetPresentation');
    const entry = (key: string, extra: Readonly<{ serviceTitle?: string; email?: string }> = {}) => ({
      key, serviceTitle: extra.serviceTitle ?? 'Claude', accountId: key.split('/')[1], email: extra.email ?? null,
    });
    const claudeA = entry('claude/97bd5614-8970');
    const claudeB = entry('claude/7e9ced1f-60ac');
    const named = entry('claude/c', { email: 'kevin@gmail.com' });
    const codex = entry('codex/z', { serviceTitle: 'Codex' });
    // The order an account is shown in (by usage left) changes; its number does not.
    for (const order of [[claudeA, claudeB, named, codex], [codex, named, claudeB, claudeA]]) {
      const names = presentConnectedAccountNames(order);
      expect(names.get(claudeB.key)?.primaryLabel).toBe('Claude account');
      expect(names.get(claudeA.key)?.primaryLabel).toBe('Claude account 2');
      expect(names.get(named.key)?.primaryLabel).toBe('kevin@gmail.com');
      expect(names.get(codex.key)?.primaryLabel).toBe('Codex account');
      expect([...names.values()].map((name) => name.primaryLabel).join(' ')).not.toMatch(/97bd|7e9c/);
    }
  });
});
