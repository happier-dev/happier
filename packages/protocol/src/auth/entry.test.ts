import { describe, expect, it } from 'vitest';

import {
  AuthEntryProjectionV1Schema,
  AuthEntryRequestV1Schema,
  TeamAuthenticationPolicyV1Schema,
  normalizeTeamAuthenticationPolicyV1,
} from './entry.js';
import { FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '../features/payload/featuresResponseSchema.js';

const INVITATION_TOKEN = 'a'.repeat(43);
const VERIFICATION_TOKEN = 'v'.repeat(43);

describe('auth entry protocol v1', () => {
  it('parses and normalizes the strict Team accepted-authentication OR policy', () => {
    const restricted = {
      v: 1 as const,
      mode: 'restricted' as const,
      accepted: [
        { kind: 'team_connection' as const, connectionId: 'connection-z' },
        { kind: 'home_method' as const, methodId: 'email_password' },
      ],
    };
    expect(TeamAuthenticationPolicyV1Schema.parse(restricted)).toEqual(restricted);
    expect(normalizeTeamAuthenticationPolicyV1(restricted)).toEqual({
      ...restricted,
      accepted: [restricted.accepted[1], restricted.accepted[0]],
    });
    expect(normalizeTeamAuthenticationPolicyV1({ v: 1, mode: 'inherit' })).toBeNull();
    expect(TeamAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      mode: 'restricted',
      accepted: [],
    }).success).toBe(false);
    expect(TeamAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      mode: 'restricted',
      accepted: [
        { kind: 'home_method', methodId: 'email_password' },
        { kind: 'home_method', methodId: 'email_password' },
      ],
    }).success).toBe(false);
    // Provider method IDs are a case-insensitive namespace: a case variant is
    // the same accepted entry, not a second distinct choice.
    expect(TeamAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      mode: 'restricted',
      accepted: [
        { kind: 'home_method', methodId: 'GitHub' },
        { kind: 'home_method', methodId: 'github' },
      ],
    }).success).toBe(false);
    expect(TeamAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      mode: 'restricted',
      accepted: [{ kind: 'team_connection', connectionId: 'connection-1', providerKind: 'oidc' }],
    }).success).toBe(false);
    expect(TeamAuthenticationPolicyV1Schema.safeParse({
      v: 1,
      mode: 'restricted',
      accepted: [{ kind: 'home_method', methodId: 'x'.repeat(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 + 1) }],
    }).success).toBe(false);
  });

  it('accepts the exact Home request and rejects unconsumed scopes', () => {
    expect(AuthEntryRequestV1Schema.parse({ v: 1, scope: { kind: 'home' } })).toEqual({
      v: 1,
      scope: { kind: 'home' },
    });
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'home' },
      purpose: 'account_service',
    }).success).toBe(true);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'team', teamId: 'team_1' },
      purpose: 'account_service',
    }).success).toBe(false);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'team', teamId: 'team_1' },
      extra: true,
    }).success).toBe(false);
  });

  it('accepts a syntax-normalized email routing hint only for Home entry', () => {
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1, scope: { kind: 'home' }, email: 'Person@Acme.Example',
    }).success).toBe(true);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1, scope: { kind: 'home' }, email: 'not-a-mailbox',
    }).success).toBe(false);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1, scope: { kind: 'team', teamId: 'team_1' }, email: 'person@acme.example',
    }).success).toBe(false);
  });

  it('accepts a strict immutable-Team request and keeps unavailable targets non-enumerating', () => {
    expect(AuthEntryRequestV1Schema.parse({
      v: 1,
      scope: { kind: 'team', teamId: 'team_1' },
    })).toEqual({
      v: 1,
      scope: { kind: 'team', teamId: 'team_1' },
    });
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'team', teamId: '' },
    }).success).toBe(false);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'team', teamId: 'team_1' },
      purpose: 'account_service',
    }).success).toBe(false);

    const projection = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'admission_required',
      scope: { kind: 'team' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      team: { teamId: 'team_1', name: 'Acme', logo: null },
      actions: [{
        kind: 'authenticate',
        methodId: 'connection_1',
        action: 'login',
        mode: 'keyless',
        origin: 'team',
        presentation: { displayName: 'Acme SSO', iconHint: 'oidc' },
      }],
      autoRedirect: null,
    });
    expect(projection).toMatchObject({ state: 'admission_required', scope: { kind: 'team' } });
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...projection,
      scope: { kind: 'team', teamId: 'team_1' },
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'team' },
      reason: 'entry_not_available',
      autoRedirect: null,
    }).success).toBe(true);
    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'team' },
      reason: 'entry_not_available',
      team: { teamId: 'team_1', name: 'Acme', logo: null },
      autoRedirect: null,
    }).success).toBe(false);
  });

  it('carries the safe provider descriptor fields and a per-provider unavailable reason (L03/01 §10.2)', () => {
    const base = {
      v: 1,
      state: 'admission_required',
      scope: { kind: 'team' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      team: { teamId: 'team_1', name: 'Acme', logo: null },
      autoRedirect: null,
    } as const;
    const presentation = {
      displayName: 'Acme SSO',
      iconHint: 'oidc',
      providerKind: 'workos_sso',
      connectButtonColor: '#0f62fe',
      supportsProfileBadge: true,
    } as const;
    const parsed = AuthEntryProjectionV1Schema.parse({
      ...base,
      actions: [
        {
          kind: 'authenticate',
          methodId: 'provider_sso',
          action: 'connect',
          mode: 'either',
          origin: 'team',
          presentation,
        },
        {
          kind: 'provider_unavailable',
          methodId: 'provider_backup',
          origin: 'team',
          presentation: { displayName: 'Backup SSO', providerKind: 'oidc' },
          reason: 'provider_setup_incomplete',
        },
      ],
    });
    expect(parsed).toMatchObject({
      actions: [
        { kind: 'authenticate', presentation },
        { kind: 'provider_unavailable', methodId: 'provider_backup', reason: 'provider_setup_incomplete' },
      ],
    });
    // Unsafe internal facts never ride the public descriptor.
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...base,
      actions: [{
        kind: 'provider_unavailable',
        methodId: 'provider_backup',
        origin: 'team',
        presentation: { displayName: 'Backup SSO', revision: 4 },
        reason: 'provider_disabled',
      }],
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...base,
      actions: [{
        kind: 'provider_unavailable',
        methodId: 'provider_backup',
        origin: 'team',
        presentation: { displayName: 'Backup SSO' },
        reason: 'client_secret_expired',
      }],
    }).success).toBe(false);
  });

  it('accepts an opaque invitation scope only for Home purpose without echoing the bearer', () => {
    expect(AuthEntryRequestV1Schema.parse({
      v: 1,
      scope: { kind: 'invitation', token: INVITATION_TOKEN },
    })).toEqual({
      v: 1,
      scope: { kind: 'invitation', token: INVITATION_TOKEN },
    });
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'invitation', token: 'short' },
    }).success).toBe(false);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'invitation', token: INVITATION_TOKEN },
      purpose: 'home',
    }).success).toBe(true);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'invitation', token: INVITATION_TOKEN },
      purpose: 'account_service',
    }).success).toBe(false);

    const projection = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'admission_required',
      scope: { kind: 'invitation' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      team: { teamId: 'team-1', name: 'Acme', logo: null },
      invitationEmailVerificationRequired: false,
      actions: [{
        kind: 'authenticate',
        methodId: 'email_password',
        action: 'login',
        mode: 'keyed',
        origin: 'home',
        presentation: { displayName: 'Email' },
      }],
      signInService: { v: 1, mode: 'self' },
      autoRedirect: null,
    });
    expect(JSON.stringify(projection)).not.toContain(INVITATION_TOKEN);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...projection,
      scope: { kind: 'invitation', token: INVITATION_TOKEN },
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...projection,
      role: 'member',
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...projection,
      actions: [{ kind: 'continue' }],
    }).success).toBe(false);
  });

  it('accepts a strict native-verification scope without permitting public projection echo', () => {
    expect(AuthEntryRequestV1Schema.parse({
      v: 1,
      scope: { kind: 'native_email_verification', token: VERIFICATION_TOKEN },
    })).toEqual({
      v: 1,
      scope: { kind: 'native_email_verification', token: VERIFICATION_TOKEN },
    });
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'native_email_verification', token: 'short' },
    }).success).toBe(false);
    expect(AuthEntryRequestV1Schema.safeParse({
      v: 1,
      scope: { kind: 'native_email_verification', token: VERIFICATION_TOKEN },
      purpose: 'account_service',
    }).success).toBe(false);

    const invitationProjection = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'admission_required',
      scope: { kind: 'invitation' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      team: { teamId: 'team-1', name: 'Acme', logo: null },
      invitationEmailVerificationRequired: true,
      actions: [],
      autoRedirect: null,
    });
    expect(JSON.stringify(invitationProjection)).not.toContain(VERIFICATION_TOKEN);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...invitationProjection,
      verificationToken: VERIFICATION_TOKEN,
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...invitationProjection,
      invitationId: 'invitation-1',
    }).success).toBe(false);
  });

  it('expresses why Team and invitation entry is unavailable without widening the state union', () => {
    for (const reason of [
      'entry_not_available',
      'sso_required',
      'wrong_account',
      'directory_delayed',
      'invitation_unavailable',
    ]) {
      expect(AuthEntryProjectionV1Schema.safeParse({
        v: 1,
        state: 'unavailable',
        scope: { kind: 'team' },
        reason,
        autoRedirect: null,
      }).success).toBe(true);
      expect(AuthEntryProjectionV1Schema.safeParse({
        v: 1,
        state: 'unavailable',
        scope: { kind: 'invitation' },
        reason,
        autoRedirect: null,
      }).success).toBe(true);
    }
    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'team' },
      reason: 'not_account_service',
      autoRedirect: null,
    }).success).toBe(false);
  });

  it('keeps unavailable invitation entry non-enumerating and non-executable', () => {
    expect(AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'invitation' },
      reason: 'entry_not_available',
      autoRedirect: null,
    })).toEqual({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'invitation' },
      reason: 'entry_not_available',
      autoRedirect: null,
    });
    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'invitation' },
      reason: 'entry_not_available',
      team: { teamId: 'team-1', name: 'Acme', logo: null },
      autoRedirect: null,
    }).success).toBe(false);
  });

  it('carries only the authenticated Account recipient relationship on invitation entry', () => {
    const base = {
      v: 1,
      state: 'admission_required',
      scope: { kind: 'invitation' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      team: { teamId: 'team-1', name: 'Acme', logo: null },
      invitationEmailVerificationRequired: true,
      actions: [],
      autoRedirect: null,
    } as const;

    expect(AuthEntryProjectionV1Schema.parse({
      ...base,
      actions: [{ kind: 'switch_account' }],
      currentAccountRecipientStatus: 'verification_required',
    })).toMatchObject({
      actions: [{ kind: 'switch_account' }],
      currentAccountRecipientStatus: 'verification_required',
    });
    expect(AuthEntryProjectionV1Schema.parse({
      ...base,
      currentAccountRecipientStatus: 'already_verified',
    })).toMatchObject({ currentAccountRecipientStatus: 'already_verified' });
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...base,
      currentAccountRecipientStatus: 'unknown',
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...base,
      invitationEmailVerificationRequired: undefined,
    }).success).toBe(false);
  });

  it('preserves exact action and mode pairs and rejects impossible result actions', () => {
    const ready = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'ready',
      scope: { kind: 'home' },
      actions: [{
        kind: 'authenticate',
        methodId: 'email_password',
        action: 'login',
        mode: 'either',
        origin: 'home',
        presentation: { displayName: 'Email' },
      }],
      signInService: { v: 1, mode: 'self' },
      autoRedirect: null,
    });
    expect(ready.actions[0]).toMatchObject({ action: 'login', mode: 'either' });

    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'denied',
      scope: { kind: 'home' },
      reason: 'entry_not_available',
      actions: [{ kind: 'continue' }],
      autoRedirect: null,
    }).success).toBe(false);

    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'unavailable',
      scope: { kind: 'home' },
      reason: 'not_account_service',
      autoRedirect: null,
    }).success).toBe(true);
  });

  it('gives an already-admitted Team member only the methodless continue control', () => {
    const alreadyMember = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'already_member',
      scope: { kind: 'team' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      account: { firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null },
      team: { teamId: 'team_1', name: 'Acme', logo: null },
      actions: [{ kind: 'continue' }],
      autoRedirect: null,
    });
    expect(alreadyMember).toMatchObject({ state: 'already_member', scope: { kind: 'team' } });

    const invitationAlreadyMember = AuthEntryProjectionV1Schema.parse({
      v: 1,
      state: 'already_member',
      scope: { kind: 'invitation' },
      home: { serverId: 'home_1', displayName: 'Acme Home', storageMode: 'plain' },
      account: { firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null },
      team: { teamId: 'team_1', name: 'Acme', logo: null },
      actions: [{ kind: 'continue' }],
      autoRedirect: null,
    });
    expect(invitationAlreadyMember).toMatchObject({
      state: 'already_member',
      scope: { kind: 'invitation' },
    });

    // Continuation is not an executable provider choice, and it never carries
    // membership detail an unauthenticated caller could read back.
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...alreadyMember,
      actions: [{
        kind: 'authenticate',
        methodId: 'email_password',
        action: 'login',
        mode: 'keyed',
        origin: 'home',
        presentation: { displayName: 'Email' },
      }],
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...alreadyMember,
      actions: [{ kind: 'continue' }, { kind: 'continue' }],
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({ ...alreadyMember, actions: [] }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({ ...alreadyMember, role: 'member' }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({ ...alreadyMember, account: undefined }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...alreadyMember,
      account: { ...alreadyMember.account, email: 'alice@example.test' },
    }).success).toBe(false);
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...alreadyMember,
      membership: { status: 'active' },
    }).success).toBe(false);

    // Invitation-scoped continuation is valid only when the authenticated
    // server producer has already proved this exact Account's effective
    // membership. It remains bounded to the same methodless projection.
    expect(AuthEntryProjectionV1Schema.safeParse({
      ...invitationAlreadyMember,
      role: 'member',
    }).success).toBe(false);
  });

  it('bounds projection strings by the shared pre-auth metadata resource budget without rejecting long legacy ids', () => {
    const longLegacyId = `legacy-${'x'.repeat(1_024)}`;
    const longLegacyName = `Legacy ${'N'.repeat(1_024)}`;
    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'ready',
      scope: { kind: 'home' },
      actions: [{
        kind: 'authenticate',
        methodId: longLegacyId,
        action: 'login',
        mode: 'keyless',
        origin: 'home',
        presentation: { displayName: longLegacyName, iconHint: longLegacyId },
      }],
      autoRedirect: null,
    }).success).toBe(true);

    expect(AuthEntryProjectionV1Schema.safeParse({
      v: 1,
      state: 'ready',
      scope: { kind: 'home' },
      actions: [{
        kind: 'authenticate',
        methodId: `legacy-${'x'.repeat(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1)}`,
        action: 'login',
        mode: 'keyless',
        origin: 'home',
        presentation: { displayName: 'Legacy' },
      }],
      autoRedirect: null,
    }).success).toBe(false);
  });
});
