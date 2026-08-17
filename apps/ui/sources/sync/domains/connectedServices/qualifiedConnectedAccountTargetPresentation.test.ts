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
      secondaryLabel: 'External Gateway · work@example.com · provider-account-42 · account_opaque_123',
      accessibilityLabel: 'External Gateway · Work account · work@example.com · provider-account-42 · account_opaque_123',
    });
    expect(presentation.accessibilityLabel).not.toContain('secret-never-presented');
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
      secondaryLabel: 'account_opaque_123',
      accessibilityLabel: 'External Gateway · account_opaque_123',
    });
    expect(groupPresentation).toEqual({
      primaryLabel: 'External Gateway',
      secondaryLabel: 'pool_opaque_456',
      accessibilityLabel: 'External Gateway · pool_opaque_456',
    });
  });
});
