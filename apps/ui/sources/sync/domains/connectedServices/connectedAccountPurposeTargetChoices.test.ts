import { describe, expect, it } from 'vitest';
import {
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
} from '@happier-dev/protocol';

import { t } from '@/text';

import {
  buildConnectedAccountPurposeTargetChoices,
  resolveConnectedAccountPurposeTargetDisplay,
} from './connectedAccountPurposeTargetChoices';
import {
  connectedServiceProfileKey,
  qualifiedConnectedAccountPreferenceServiceKey,
} from './connectedServiceProfilePreferences';

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
const unavailableAccount = Object.freeze({
  ...connectedAccount,
  ref: Object.freeze({ service, accountId: 'expired' }),
  displayName: 'Expired account',
  status: 'needs_reauth' as const,
});
const group = Object.freeze(
  QualifiedConnectedAccountGroupV4Schema.parse({
    v: 1,
    ref: { service, groupId: 'team' },
    incarnation: 'qualified-group-row-team',
    displayName: 'Team pool',
    policy: {},
    activeConnectedAccountId: 'work',
    generation: 1,
    runtimeStateRevision: 1,
    state: { status: 'ready' },
    createdAt: 1,
    updatedAt: 1,
    members: [],
  }),
);

const resolveAuthenticationMode = () => ({
  id: 'oauth',
  kind: 'oauthAuthorizationCode' as const,
  pkce: 'required' as const,
  outcomeReconciliation: 'none' as const,
});

describe('buildConnectedAccountPurposeTargetChoices', () => {
  it('offers explicit optional unbound, account and group choices while keeping an incompatible account non-selectable', () => {
    const choices = buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'request-auth', service, required: false },
      selectedTarget: null,
      accounts: [connectedAccount, unavailableAccount],
      groups: [group],
      labelsByKey: {},
      serviceTitle: 'Acme Gateway',
      resolveAuthenticationMode,
    });

    expect(choices.map((choice) => ({
      title: choice.presentation.primaryLabel,
      target: choice.target?.kind ?? 'none',
      selectable: choice.selectable,
    }))).toEqual([
      { title: '—', target: 'none', selectable: true },
      { title: 'Expired account', target: 'account', selectable: false },
      { title: 'Work account', target: 'account', selectable: true },
      { title: 'Team pool', target: 'group', selectable: true },
    ]);
  });

  it('does not create an unbound choice for a required purpose and retains a deleted current target as unavailable', () => {
    const deleted = Object.freeze({
      kind: 'account' as const,
      account: Object.freeze({ service, accountId: 'deleted' }),
    });
    const choices = buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'request-auth', service, required: true },
      selectedTarget: deleted,
      accounts: [connectedAccount],
      groups: [],
      labelsByKey: {},
      serviceTitle: 'Acme Gateway',
      resolveAuthenticationMode,
    });

    expect(choices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: deleted,
        presentation: expect.objectContaining({ primaryLabel: 'Unavailable' }),
        selectable: false,
        current: true,
      }),
    ]));
    expect(choices.some((choice) => choice.target === null)).toBe(false);
  });

  it('uses the qualified Connected Accounts label for menu and saved-target presentation without exposing opaque ids', () => {
    const opaqueAccount = Object.freeze({
      ...connectedAccount,
      ref: Object.freeze({
        service,
        accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af',
      }),
      displayName: undefined,
      providerIdentity: undefined,
    });
    const opaqueGroup = Object.freeze({
      ...group,
      ref: Object.freeze({
        service,
        groupId: '633c2d12-7055-4e2a-8a81-35f1d8ecb4da',
      }),
      displayName: null,
    });
    const accountTarget = Object.freeze({
      kind: 'account' as const,
      account: opaqueAccount.ref,
    });
    const groupTarget = Object.freeze({
      kind: 'group' as const,
      service,
      groupId: opaqueGroup.ref.groupId,
    });
    const labelsByKey = {
      [connectedServiceProfileKey({
        serviceId: qualifiedConnectedAccountPreferenceServiceKey(service),
        profileId: opaqueAccount.ref.accountId,
      })]: 'Personal OpenAI',
    };
    // `labelsByKey` is deliberately a runtime input here: the RED test proves
    // that the choice owner, rather than a Provider consumer, must read the
    // existing Connected Accounts preference projection.
    const choiceInput = {
      declaration: { purpose: 'request-auth', service, required: true },
      selectedTarget: null,
      accounts: [opaqueAccount],
      groups: [opaqueGroup],
      resolveAuthenticationMode,
      labelsByKey,
      serviceTitle: 'Acme Gateway',
    };
    const accountDisplayInput = {
      target: accountTarget,
      accounts: [opaqueAccount],
      groups: [opaqueGroup],
      labelsByKey,
      serviceTitle: 'Acme Gateway',
    };
    const groupDisplayInput = {
      target: groupTarget,
      accounts: [opaqueAccount],
      groups: [opaqueGroup],
      labelsByKey,
      serviceTitle: 'Acme Gateway',
    };

    const choices = buildConnectedAccountPurposeTargetChoices(choiceInput);
    const accountChoice = choices.find((choice) => choice.target?.kind === 'account');
    const groupChoice = choices.find((choice) => choice.target?.kind === 'group');

    expect(accountChoice).toEqual(expect.objectContaining({
      presentation: expect.objectContaining({
        primaryLabel: 'Personal OpenAI',
        secondaryLabel: 'Acme Gateway',
      }),
      selectable: true,
    }));
    expect(groupChoice).toEqual(expect.objectContaining({
      presentation: expect.objectContaining({
        primaryLabel: 'Acme Gateway',
      }),
      selectable: true,
    }));
    // The opaque id keys the choice for routing and mutation, and appears in no
    // field a person reads or a screen reader speaks.
    for (const choice of [accountChoice, groupChoice]) {
      for (const text of [
        choice?.presentation.primaryLabel,
        choice?.presentation.secondaryLabel,
        choice?.presentation.accessibilityLabel,
      ]) {
        expect(text ?? '').not.toContain(opaqueAccount.ref.accountId);
        expect(text ?? '').not.toContain(opaqueGroup.ref.groupId);
      }
    }
    expect(accountChoice?.id).toContain(opaqueAccount.ref.accountId);
    expect(groupChoice?.id).toContain(opaqueGroup.ref.groupId);
    expect(resolveConnectedAccountPurposeTargetDisplay(accountDisplayInput)).toBe('Personal OpenAI');
    expect(resolveConnectedAccountPurposeTargetDisplay(groupDisplayInput)).toBe('Acme Gateway');
  });
});
