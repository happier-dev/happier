import { describe, expect, it } from 'vitest';

import {
  connectedServiceProfileKey,
  qualifiedConnectedAccountPreferenceServiceKey,
} from './connectedServiceProfilePreferences';
import {
  presentQualifiedConnectedAccountTarget,
} from './qualifiedConnectedAccountTargetPresentation';

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
      secondaryLabel: 'External Gateway · work@example.com · provider-account-42',
      accessibilityLabel: 'External Gateway · Work account · work@example.com · provider-account-42',
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
    expect(accountPresentation.accessibilityLabel).toContain('provider-account-42');
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
      primaryLabel: 'External Gateway',
      accessibilityLabel: 'External Gateway',
    });
    expect(groupPresentation).toEqual({
      primaryLabel: 'External Gateway',
      accessibilityLabel: 'External Gateway',
    });
  });
});
