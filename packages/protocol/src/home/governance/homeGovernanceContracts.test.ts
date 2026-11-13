import { describe, expect, it } from 'vitest';

import {
  HomeCapabilitiesV1Schema,
  NO_HOME_CAPABILITIES_V1,
} from './capabilities.js';
import {
  HOME_TEAM_CREATION_POLICY_DEFAULT_V1,
  HOME_TEAMS_VISIBLE_TO_MEMBERS_DEFAULT_V1,
  HomeAuthenticationPolicyV1Schema,
  HomeGovernancePolicySetInputV1Schema,
  readHomeAuthenticationPolicyV1,
  readTeamCreationPolicyV1,
} from './policy.js';
import { HomeAccountListResultV1Schema, HomeAccountSearchInputV1Schema, HomeAccountRowV1Schema } from './accounts.js';
import { isActiveHomeAccountStatus } from './roles.js';
import { HomeGovernanceEligibilityGetInputV1Schema } from './actionsV1.js';
import { HomeGovernanceEligibilityV1Schema } from './projection.js';
import { HomeGovernanceErrorV1Schema, homeGovernanceErrorHttpStatusV1 } from './errors.js';
import { HomeAdministrationEventV1Schema, parseHomeAdministrationEventDetailV1 } from './audit.js';

describe('public-profile moderation audit contract', () => {
  it.each(['public_profile.restricted', 'public_profile.restored'])('retains the strict %s reason through audit reads', action => {
    const detail = parseHomeAdministrationEventDetailV1(action, { reason: 'Operator review' });
    expect(detail).toEqual({ action, summary: { reason: 'Operator review' } });
    expect(HomeAdministrationEventV1Schema.safeParse({ ...detail, id: 'event-1', at: 1000,
      actor: { kind: 'account', accountId: 'operator', profile: null },
      target: { kind: 'account', id: 'owner', profile: null },
    }).success).toBe(true);
    expect(parseHomeAdministrationEventDetailV1(action, {})).toBeNull();
    expect(parseHomeAdministrationEventDetailV1(action, { reason: 'Operator review', snapshot: 'private' })).toBeNull();
  });
});

describe('Home policy audit contract', () => {
  it('keeps a Session-defaults policy change readable in the audit list', () => {
    const summary = { revision: 2, changes: [{ field: 'sessionDefaults', from: null, to: { permissionMode: 'default' } }] };
    expect(parseHomeAdministrationEventDetailV1('home.policy.set', summary)).toEqual({ action: 'home.policy.set', summary });
  });
});

describe('Home governance error contract', () => {
  it('maps each refusal category to its canonical HTTP status', () => {
    expect(HomeGovernanceErrorV1Schema.safeParse({ error: 'invalid_home_input' }).success).toBe(true);
    expect(homeGovernanceErrorHttpStatusV1('invalid_home_input')).toBe(400);
    expect(homeGovernanceErrorHttpStatusV1('home_policy_invalid')).toBe(400);
    expect(homeGovernanceErrorHttpStatusV1('invalid_home_cursor')).toBe(400);
    expect(homeGovernanceErrorHttpStatusV1('home_governance_forbidden')).toBe(403);
    expect(homeGovernanceErrorHttpStatusV1('home_account_not_found')).toBe(404);
    expect(homeGovernanceErrorHttpStatusV1('home_governance_setup_required')).toBe(409);
    expect(homeGovernanceErrorHttpStatusV1('home_policy_revision_conflict')).toBe(409);
    expect(homeGovernanceErrorHttpStatusV1('home_owner_transfer_required')).toBe(409);
  });
});

describe('Home governance eligibility contract', () => {
  it('accepts only empty input and publishes only effective Team eligibility', () => {
    expect(HomeGovernanceEligibilityGetInputV1Schema.safeParse({}).success).toBe(true);
    expect(HomeGovernanceEligibilityGetInputV1Schema.safeParse({ serverId: 'home-a' }).success).toBe(false);
    expect(HomeGovernanceEligibilityV1Schema.safeParse({ teamsEnabled: true, createTeam: false, createTeamForChosenAccount: false }).success).toBe(true);
    // Whether creation names its first Account is part of the answer, never guessed by a client.
    expect(HomeGovernanceEligibilityV1Schema.safeParse({ teamsEnabled: true, createTeam: true }).success).toBe(false);
    expect(HomeGovernanceEligibilityV1Schema.safeParse({
      teamsEnabled: true,
      createTeam: false,
      activeOwnerCount: 1,
    }).success).toBe(false);
  });

  it('carries the creation policy class, administrator names and Teams visibility for admitted members', () => {
    // The current answer: who to ask, and whether this viewer is shown Teams at all.
    expect(HomeGovernanceEligibilityV1Schema.safeParse({
      teamsEnabled: true,
      createTeam: false,
      createTeamForChosenAccount: false,
      teamCreationPolicy: 'managed_only',
      administratorNames: ['Ada Lovelace', 'grace'],
      showTeams: true,
    }).success).toBe(true);
    // Names only: an administrator's id or email never rides along.
    expect(HomeGovernanceEligibilityV1Schema.safeParse({
      teamsEnabled: true,
      createTeam: false,
      createTeamForChosenAccount: false,
      teamCreationPolicy: 'managed_only',
      administratorNames: [{ accountId: 'acc_1', displayName: 'Ada' }],
    }).success).toBe(false);
    expect(HomeGovernanceEligibilityV1Schema.safeParse({
      teamsEnabled: true,
      createTeam: false,
      createTeamForChosenAccount: false,
      teamCreationPolicy: 'self_service_for_friends',
    }).success).toBe(false);
  });

  it('reads an answer from a Home that predates the policy class, names and visibility', () => {
    // Compatibility (older server -> current client): every added fact is optional.
    const parsed = HomeGovernanceEligibilityV1Schema.safeParse({
      teamsEnabled: true,
      createTeam: false,
      createTeamForChosenAccount: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.teamCreationPolicy).toBeUndefined();
    expect(parsed.data?.administratorNames).toBeUndefined();
    expect(parsed.data?.showTeams).toBeUndefined();
  });
});

describe('Home Teams visibility policy', () => {
  it('shows Teams to members unless a Home turned it off', () => {
    expect(HOME_TEAMS_VISIBLE_TO_MEMBERS_DEFAULT_V1).toBe(true);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 2,
      teamsVisibleToMembers: false,
    }).success).toBe(true);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 2,
      teamsVisibleToMembers: 'no',
    }).success).toBe(false);
  });
});

describe('Home Team-creation policy codec', () => {
  it('never reads an absent or malformed policy as self-service', () => {
    expect(HOME_TEAM_CREATION_POLICY_DEFAULT_V1).toBe('managed_only');
    expect(readTeamCreationPolicyV1(undefined)).toBe('managed_only');
    expect(readTeamCreationPolicyV1(null)).toBe('managed_only');
    expect(readTeamCreationPolicyV1('')).toBe('managed_only');
    expect(readTeamCreationPolicyV1('selfService')).toBe('managed_only');
    expect(readTeamCreationPolicyV1({ teamCreationPolicy: 'self_service' })).toBe('managed_only');
    expect(readTeamCreationPolicyV1('self_service')).toBe('self_service');
    expect(readTeamCreationPolicyV1('disabled')).toBe('disabled');
  });
});

describe('Home authentication policy codec', () => {
  it('separates inherited absence from unreadable stored narrowing', () => {
    expect(readHomeAuthenticationPolicyV1(null)).toEqual({ status: 'inherited' });
    expect(readHomeAuthenticationPolicyV1(undefined)).toEqual({ status: 'inherited' });
    // A stored document the current deployment can no longer parse must not
    // silently broaden back to the deployment ceiling.
    expect(readHomeAuthenticationPolicyV1({ v: 2 })).toEqual({ status: 'unreadable' });
    expect(readHomeAuthenticationPolicyV1({ v: 1, enabledMethodIds: [] })).toEqual({ status: 'unreadable' });
    expect(readHomeAuthenticationPolicyV1({ v: 1, admission: 'self_service' })).toEqual({
      status: 'narrowed',
      policy: { v: 1, admission: 'self_service' },
    });
  });

  it('rejects empty sets, duplicate methods, and a recommendation outside the permitted modes', () => {
    expect(HomeAuthenticationPolicyV1Schema.safeParse({ v: 1, enabledMethodIds: [] }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({ v: 1, permittedAccountModes: [] }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      enabledMethodIds: ['key-challenge', 'key-challenge'],
    }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      enabledMethodIds: [' KEY_CHALLENGE '],
    }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      permittedAccountModes: ['plain'],
      recommendedProvisioningMode: 'e2ee',
    }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      permittedAccountModes: ['plain', 'e2ee'],
      recommendedProvisioningMode: 'e2ee',
    }).success).toBe(true);
  });

  it('allows only disabling or inheriting the Home sign-in service', () => {
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      signInService: { mode: 'disabled' },
    }).success).toBe(true);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({ v: 1, signInService: null }).success).toBe(true);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      signInService: { mode: 'enabled' },
    }).success).toBe(false);
    expect(HomeAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      signInService: { mode: 'disabled', issuer: 'https://other.example' },
    }).success).toBe(false);
  });
});

describe('Home policy mutation input', () => {
  it('requires an expected revision and rejects unknown or lane-03-owned fields', () => {
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 0,
      teamCreationPolicy: 'self_service',
    }).success).toBe(true);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      teamCreationPolicy: 'self_service',
    }).success).toBe(false);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 1,
      teamProviderPolicy: { anything: true },
    }).success).toBe(false);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 1,
      unknownField: true,
    }).success).toBe(false);
  });

  it('rejects a patch that changes nothing', () => {
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({ expectedRevision: 3 }).success).toBe(false);
  });

  it('accepts clearing the authentication narrowing back to inheritance', () => {
    const parsed = HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 2,
      authenticationPolicy: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts strict Lane 03 provider and outbound-network ceilings in the canonical Home patch', () => {
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 3,
      teamProviderPolicy: {
        v: 1,
        allowedTeamProviderKinds: ['oidc', 'github_app_identity'],
        teamJitAllowed: false,
        approvedGitHubEnterpriseOrigins: ['https://github.corp.example:8443'],
      },
      identityNetworkPolicy: {
        v: 1,
        mode: 'private_allowlist',
        hostnames: ['id.internal.example'],
        cidrs: ['10.20.0.0/16'],
        ports: [8443],
      },
    }).success).toBe(true);
    expect(HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 3,
      teamProviderPolicy: {
        v: 1,
        allowedTeamProviderKinds: ['github_app_identity'],
        teamJitAllowed: false,
        approvedGitHubEnterpriseOrigins: ['https://github.corp.example/path'],
      },
    }).success).toBe(false);
  });

  it('requires the private identity-network arm to name every exact boundary', () => {
    const patch = (identityNetworkPolicy: unknown) => HomeGovernancePolicySetInputV1Schema.safeParse({
      expectedRevision: 3,
      identityNetworkPolicy,
    }).success;

    expect(patch({
      v: 1,
      mode: 'private_allowlist',
      hostnames: ['id.internal.example'],
      cidrs: ['10.20.0.0/16'],
    })).toBe(false);
    expect(patch({
      v: 1,
      mode: 'private_allowlist',
      hostnames: ['id.internal.example'],
      cidrs: [],
      ports: [443],
    })).toBe(false);
    expect(patch({ v: 1, mode: 'public_only', ports: [8443] })).toBe(false);
  });
});

describe('Home account projections', () => {
  it('uses the canonical page result shape without retaining an unreleased accounts arm', () => {
    expect(HomeAccountListResultV1Schema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(HomeAccountListResultV1Schema.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(true);
    expect(HomeAccountListResultV1Schema.safeParse({ items: [], nextCursor: null, total: -1 }).success).toBe(false);
    expect(HomeAccountListResultV1Schema.safeParse({ items: [], nextCursor: null, total: 1.5 }).success).toBe(false);
    expect(HomeAccountListResultV1Schema.safeParse({ accounts: [], nextCursor: null }).success).toBe(false);
  });

  it('keeps the administrator row strict so no unowned field can be disclosed', () => {
    const row = {
      accountId: 'acc_1',
      homeRole: 'admin',
      status: 'suspended',
      profile: { firstName: 'A', lastName: null, username: 'a', avatarUrl: null },
      createdAt: 1,
      authentication: {
        signInEmail: 'a@example.com',
        usableMethodIds: ['email_password'],
      },
      mutationCapabilities: {
        setRole: {
          member: { status: 'available' },
          admin: { status: 'unavailable', reason: 'unchanged' },
          owner: { status: 'available' },
        },
        disable: { status: 'unavailable', reason: 'target_not_active' },
        reenable: { status: 'available' },
        delete: { status: 'unavailable', reason: 'team_owner_transfer_required' },
        signOutEverywhere: { status: 'available' },
      },
    };
    expect(HomeAccountRowV1Schema.safeParse(row).success).toBe(true);
    expect(HomeAccountRowV1Schema.safeParse({ ...row, mutationCapabilities: undefined }).success).toBe(false);
    expect(HomeAccountRowV1Schema.safeParse({ ...row, authentication: undefined }).success).toBe(false);
    expect(HomeAccountRowV1Schema.safeParse({ ...row, email: 'a@example.com' }).success).toBe(false);
  });

  it('binds every Account search to an exact scope', () => {
    expect(HomeAccountSearchInputV1Schema.safeParse({
      query: 'ann',
      scope: { kind: 'home' },
    }).success).toBe(true);
    expect(HomeAccountSearchInputV1Schema.safeParse({
      query: 'ann',
      scope: { kind: 'team', teamId: 'team_1' },
    }).success).toBe(true);
    expect(HomeAccountSearchInputV1Schema.safeParse({ query: 'ann' }).success).toBe(false);
    expect(HomeAccountSearchInputV1Schema.safeParse({
      query: 'ann',
      scope: { kind: 'team' },
    }).success).toBe(false);
    expect(HomeAccountSearchInputV1Schema.safeParse({
      query: '',
      scope: { kind: 'home' },
    }).success).toBe(false);
  });
});

describe('Home capabilities', () => {
  it('has an all-denied constant that satisfies the strict schema', () => {
    expect(HomeCapabilitiesV1Schema.safeParse(NO_HOME_CAPABILITIES_V1).success).toBe(true);
    expect(Object.values(NO_HOME_CAPABILITIES_V1).every((value) => value === false)).toBe(true);
    expect(HomeCapabilitiesV1Schema.safeParse({
      ...NO_HOME_CAPABILITIES_V1,
      searchAccounts: true,
    }).success).toBe(false);
  });
});

describe('Account status predicate', () => {
  it('treats only active as able to exercise Home authority', () => {
    expect(isActiveHomeAccountStatus('active')).toBe(true);
    expect(isActiveHomeAccountStatus('suspended')).toBe(false);
    expect(isActiveHomeAccountStatus('disabled')).toBe(false);
  });
});
