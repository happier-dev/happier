import { describe, expect, it } from 'vitest';
import {
  QualifiedConnectedAccountGroupV4Schema,
  QualifiedConnectedAccountProfileV4Schema,
} from '@happier-dev/protocol';

import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { t } from '@/text';
import { presentConnectedAccountIdentity } from './maskAccountEmail';

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
    members: [{
      v: 1,
      connectedAccountId: 'work',
      priority: 1,
      enabled: true,
      state: {},
      createdAt: 1,
      updatedAt: 1,
    }],
  }),
);

const resolveAuthentication = () => ({
  defaultModeId: 'oauth',
  modes: [{
    id: 'oauth',
    kind: 'oauthAuthorizationCode' as const,
    pkce: 'required' as const,
    outcomeReconciliation: 'none' as const,
  }],
});

describe('buildConnectedAccountPurposeTargetChoices', () => {
  it('applies privacy to visible and assistive identities in purpose choices through the target presenter', () => {
    const choices = buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'request-auth', service, required: true }, selectedTarget: null,
      accounts: [{ ...connectedAccount, displayName: undefined, providerIdentity: { email: 'work@example.com', accountId: 'provider-account-42' } }],
      groups: [], labelsByKey: {}, serviceTitle: 'Acme Gateway', resolveAuthentication,
      presentIdentity: (input) => presentConnectedAccountIdentity({
        ...input, hidden: true, label: input.label ?? null, email: input.email ?? null, accountId: input.accountId ?? null,
      }),
    });
    expect(choices[0]?.presentation).toMatchObject({
      primaryLabel: 'wo•••@e•••.com',
      secondaryLabel: 'Acme Gateway',
      accessibilityLabel: 'Acme Gateway · wo•••@e•••.com',
    });
    expect(JSON.stringify(choices.map((choice) => choice.presentation))).not.toContain('provider-account-42');
  });

  it('offers explicit optional unbound, account and group choices while keeping an incompatible account non-selectable', () => {
    const choices = buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'request-auth', service, required: false },
      selectedTarget: null,
      accounts: [connectedAccount, unavailableAccount],
      groups: [group],
      labelsByKey: {},
      serviceTitle: 'Acme Gateway',
      resolveAuthentication,
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
      resolveAuthentication,
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

  it('uses the active enabled current account as the sole passive group-resolvability authority', () => {
    const groupWithoutRuntimeStatus = Object.freeze({
      ...group,
      state: Object.freeze({}),
    });
    const input = {
      declaration: { purpose: 'request-auth', service, required: true },
      selectedTarget: null,
      accounts: [connectedAccount],
      groups: [groupWithoutRuntimeStatus],
      labelsByKey: {},
      serviceTitle: 'Acme Gateway',
      resolveAuthentication,
    };

    expect(buildConnectedAccountPurposeTargetChoices(input))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'group', selectable: true }),
      ]));

    expect(buildConnectedAccountPurposeTargetChoices({
      ...input,
      groups: [{
        ...groupWithoutRuntimeStatus,
        members: groupWithoutRuntimeStatus.members.map((member) => ({ ...member, enabled: false })),
      }],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'group', selectable: false }),
    ]));

    expect(buildConnectedAccountPurposeTargetChoices({
      ...input,
      accounts: [unavailableAccount],
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'group', selectable: false }),
    ]));
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
      activeConnectedAccountId: opaqueAccount.ref.accountId,
      members: group.members.map((member) => Object.freeze({
        ...member,
        connectedAccountId: opaqueAccount.ref.accountId,
      })),
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
      resolveAuthentication,
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

  describe('Team resource targets from the entitled catalog', () => {
    const disclosedMember = { service, accountId: 'source-member' };
    const catalogEntry = (overrides: Readonly<Record<string, unknown>> = {}) => (
      TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'resource-pool',
        teamId: 'team-acme',
        displayName: 'Acme shared pool',
        resourceRevision: 3,
        readiness: { kind: 'available' },
        recoveryAction: null,
        mayBroker: true,
        mayReceiveDirect: true,
        directMaterialState: 'current',
        sessionUsePolicy: 'personal_allowed',
        providerModels: [],
        connectedServiceSelections: [
          { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'brokered' },
          { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'direct', disclosedMember },
        ],
        sourcePresentation: { kind: 'connected_service', service },
        ...overrides,
      })
    );
    const otherServiceEntry = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource-other',
      teamId: 'team-acme',
      displayName: 'Other service',
      resourceRevision: 1,
      readiness: { kind: 'available' },
      recoveryAction: null,
      mayBroker: true,
      mayReceiveDirect: false,
      directMaterialState: 'never_delivered',
      sessionUsePolicy: 'personal_allowed',
      providerModels: [],
      connectedServiceSelections: [
        { source: 'team_resource', resourceId: 'resource-other', deliveryMode: 'brokered' },
      ],
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'acme.other', localId: 'other' },
      },
    });
    const build = (input: Readonly<{
      teamResources: readonly ReturnType<typeof catalogEntry>[];
      selectedTeamResource?: Parameters<typeof buildConnectedAccountPurposeTargetChoices>[0]['selectedTeamResource'];
    }>) => buildConnectedAccountPurposeTargetChoices({
      declaration: { purpose: 'request-auth', service, required: true },
      selectedTarget: null,
      selectedTeamResource: input.selectedTeamResource ?? null,
      accounts: [connectedAccount],
      groups: [],
      labelsByKey: {},
      serviceTitle: 'Acme Gateway',
      resolveAuthentication,
      teamResources: input.teamResources,
      teamNameById: { 'team-acme': 'Acme' },
    });

    it('offers each exact Team selection for the declared service without copying source accounts', () => {
      const choices = build({ teamResources: [catalogEntry(), otherServiceEntry] });
      const teamChoices = choices.filter((choice) => choice.kind === 'team_resource');

      // A Team choice is the canonical Team selection of its Team, never a
      // purpose target (lane 10 child 02 :271, child 06 :506).
      expect(teamChoices.map((choice) => choice.target)).toEqual([null, null]);
      expect(teamChoices.map((choice) => choice.teamResource)).toEqual([
        {
          teamId: 'team-acme',
          selection: { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'brokered' },
        },
        {
          teamId: 'team-acme',
          selection: { source: 'team_resource', resourceId: 'resource-pool', deliveryMode: 'direct', disclosedMember },
        },
      ]);
      expect(teamChoices.every((choice) => choice.selectable)).toBe(true);
      expect(teamChoices[0]?.presentation).toEqual(expect.objectContaining({
        primaryLabel: 'Acme shared pool',
        secondaryLabel: expect.stringContaining('Acme'),
      }));
      // The recipient's own inventory is unchanged: no source member became an account choice.
      expect(choices.filter((choice) => choice.kind === 'account').map((choice) => choice.target))
        .toEqual([{ kind: 'account', account: connectedAccount.ref }]);
    });

    it('retains stale Team selections as visible but non-selectable choices', () => {
      const choices = buildConnectedAccountPurposeTargetChoices({
        declaration: { purpose: 'request-auth', service, required: true },
        selectedTarget: null,
        accounts: [connectedAccount],
        groups: [],
        labelsByKey: {},
        serviceTitle: 'Acme Gateway',
        resolveAuthentication,
        teamResources: [catalogEntry()],
        teamResourceCurrentKeys: new Set(),
        teamNameById: { 'team-acme': 'Acme' },
      });
      expect(choices.filter((choice) => choice.kind === 'unavailable')).toHaveLength(2);
      expect(choices.filter((choice) => choice.kind === 'unavailable').every((choice) => !choice.selectable)).toBe(true);
    });

    it('keeps an unready Team resource visible but not selectable', () => {
      const choices = build({ teamResources: [catalogEntry({ readiness: { kind: 'source_unavailable' } })] });
      const teamChoices = choices.filter((choice) => choice.kind === 'team_resource');

      expect(teamChoices).toHaveLength(2);
      expect(teamChoices.every((choice) => !choice.selectable)).toBe(true);
    });

    it('retains a withdrawn selected Team resource as an unavailable selection with no personal fallback', () => {
      const selectedTeamResource = {
        teamId: 'team-acme',
        selection: { source: 'team_resource' as const, resourceId: 'resource-pool', deliveryMode: 'direct' as const, disclosedMember },
      };
      const choices = build({ teamResources: [], selectedTeamResource });
      const current = choices.filter((choice) => choice.current);

      expect(current).toEqual([expect.objectContaining({
        target: null,
        teamResource: selectedTeamResource,
        kind: 'unavailable',
        selectable: false,
      })]);
    });
  });
});
