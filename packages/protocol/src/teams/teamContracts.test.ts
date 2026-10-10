import { describe, expect, it } from 'vitest';

import { NO_TEAM_CAPABILITIES_V1, TeamCapabilitiesV1Schema } from './capabilities.js';
import { teamErrorHttpStatusV1, TeamErrorCodeV1Schema, TeamErrorV1Schema } from './errors.js';
import {
  TEAM_LOGO_MAX_SOURCE_BYTES_V1,
  TEAM_LOGO_MAX_SOURCE_PIXELS_V1,
  TEAM_LOGO_PUBLISHED_EDGE_V1,
  TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1,
  TeamLogoSetInputV1Schema,
  decodeTeamLogoSourceV1,
} from './logo.js';
import {
  decodeTeamDirectoryCursorV1,
  encodeTeamDirectoryCursorV1,
  resolveTeamAdmissionProjectionV1,
  teamDirectoryQueryKeyV1,
  TeamsListInputV1Schema,
  TeamSummaryV1Schema,
} from './projections.js';
import {
  decodeTeamInvitationsCursorV1,
  encodeTeamInvitationsCursorV1,
  teamInvitationsQueryKeyV1,
} from './invitation.js';
import {
  TEAM_DESCRIPTION_MAX_LENGTH_V1,
  TEAM_NAME_MAX_LENGTH_V1,
  TeamPolicyV1Schema,
  TeamPolicySetInputV1Schema,
  TeamRoleV1Schema,
  normalizeTeamNameV1,
  validateTeamDescriptionV1,
  validateTeamNameV1,
} from './team.js';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '../server/http/requestBodyBoundsV1.js';

describe('Team display-name owner', () => {
  it('normalizes presentation without inventing an identity key', () => {
    // Outer whitespace, collapsed internal Unicode whitespace, NFC.
    expect(normalizeTeamNameV1('  Acme   Rockets  ')).toBe('Acme Rockets');
    expect(normalizeTeamNameV1('Acme  Rockets')).toBe('Acme Rockets');
    expect(normalizeTeamNameV1('Café')).toBe('Café');
    // Two Teams may legitimately carry the same display name; normalization
    // must not fold case or strip characters to manufacture uniqueness.
    expect(normalizeTeamNameV1('ACME')).toBe('ACME');
    expect(normalizeTeamNameV1('ACME')).not.toBe(normalizeTeamNameV1('acme'));
  });

  it('rejects empty, oversized, and control-character names', () => {
    expect(validateTeamNameV1('Acme')).toEqual({ status: 'ok', name: 'Acme' });
    expect(validateTeamNameV1('   ')).toEqual({ status: 'invalid', reason: 'empty' });
    expect(validateTeamNameV1('')).toEqual({ status: 'invalid', reason: 'empty' });
    expect(validateTeamNameV1('a'.repeat(TEAM_NAME_MAX_LENGTH_V1))).toEqual({
      status: 'ok',
      name: 'a'.repeat(TEAM_NAME_MAX_LENGTH_V1),
    });
    expect(validateTeamNameV1('a'.repeat(TEAM_NAME_MAX_LENGTH_V1 + 1))).toEqual({
      status: 'invalid',
      reason: 'too_long',
    });
    expect(validateTeamNameV1('Acme\u0000Rockets')).toEqual({
      status: 'invalid',
      reason: 'control_characters',
    });
    expect(validateTeamNameV1('Acme\u0085Rockets')).toEqual({
      status: 'invalid',
      reason: 'control_characters',
    });
    // A tab is whitespace, not a rejected control: it collapses like a space.
    expect(validateTeamNameV1('Acme\tRockets')).toEqual({ status: 'ok', name: 'Acme Rockets' });
  });

  it('bounds the optional description and keeps it plain text', () => {
    expect(validateTeamDescriptionV1(null)).toEqual({ status: 'ok', description: null });
    expect(validateTeamDescriptionV1('   ')).toEqual({ status: 'ok', description: null });
    expect(validateTeamDescriptionV1(' Ships rockets. ')).toEqual({
      status: 'ok',
      description: 'Ships rockets.',
    });
    expect(validateTeamDescriptionV1('a'.repeat(TEAM_DESCRIPTION_MAX_LENGTH_V1 + 1))).toEqual({
      status: 'invalid',
      reason: 'too_long',
    });
    expect(validateTeamDescriptionV1('bad\u0000')).toEqual({
      status: 'invalid',
      reason: 'control_characters',
    });
  });
});

describe('Team policy contract', () => {
  it('is a closed set of fixed enums, not a rules bag', () => {
    const policy = {
      v: 1 as const,
      sessionCreationPolicy: 'private_default' as const,
      externalSharingPolicy: 'allowed' as const,
      defaultSessionHistoryAccess: 'from_membership' as const,
      admissionMode: 'invite_only' as const,
      authenticationPolicy: null,
      authenticationPolicyStatus: 'available' as const,
    };
    expect(TeamPolicyV1Schema.parse(policy)).toEqual(policy);
    expect(TeamPolicyV1Schema.safeParse({ ...policy, conditions: [] }).success).toBe(false);
    expect(TeamPolicyV1Schema.safeParse({ ...policy, sessionCreationPolicy: 'anything' }).success).toBe(false);
    expect(TeamPolicyV1Schema.safeParse({
      ...policy,
      authenticationPolicy: { v: 1, mode: 'inherit' },
    }).success).toBe(false);
  });

  it('treats an omitted policy field as unchanged and rejects an empty patch', () => {
    expect(TeamPolicySetInputV1Schema.parse({ v: 1, teamId: 't1', externalSharingPolicy: 'disabled' })).toEqual({
      v: 1,
      teamId: 't1',
      externalSharingPolicy: 'disabled',
    });
    // A patch that changes nothing is a client bug, not a silent no-op write.
    expect(TeamPolicySetInputV1Schema.safeParse({ v: 1, teamId: 't1' }).success).toBe(false);
  });

  it('accepts the canonical nullable Team authentication policy and rejects invalid narrowing', () => {
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: null,
      authenticationPolicy: {
        v: 1,
        mode: 'restricted',
        accepted: [{ kind: 'team_connection', connectionId: 'connection-1' }],
      },
    }).success).toBe(true);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: null,
      authenticationPolicy: null,
    }).success).toBe(true);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: null,
      authenticationPolicy: { v: 1, mode: 'restricted', accepted: [] },
    }).success).toBe(false);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: { v: 1, status: 'repair_required' },
      authenticationPolicy: { v: 1, mode: 'inherit' },
    }).success).toBe(true);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: { v: 1, status: 'repair_required', raw: {} },
      authenticationPolicy: { v: 1, mode: 'inherit' },
    }).success).toBe(false);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      authenticationPolicy: { v: 1, mode: 'inherit' },
    }).success).toBe(false);
    expect(TeamPolicySetInputV1Schema.safeParse({
      v: 1,
      teamId: 't1',
      previousAuthenticationPolicy: null,
      externalSharingPolicy: 'disabled',
    }).success).toBe(false);
  });
});

describe('Team capability projection', () => {
  it('denies every capability by default and stays closed', () => {
    expect(TeamCapabilitiesV1Schema.parse(NO_TEAM_CAPABILITIES_V1)).toEqual(NO_TEAM_CAPABILITIES_V1);
    for (const granted of Object.values(NO_TEAM_CAPABILITIES_V1)) expect(granted).toBe(false);
    expect(TeamCapabilitiesV1Schema.safeParse({ ...NO_TEAM_CAPABILITIES_V1, manageEverything: true }).success)
      .toBe(false);
  });
});

describe('Team summary projection', () => {
  const summary = {
    id: 'team_1',
    name: 'Acme',
    description: null,
    logo: null,
    archivedAt: null,
    recovery: null,
    policy: {
      v: 1 as const,
      sessionCreationPolicy: 'private_default' as const,
      externalSharingPolicy: 'allowed' as const,
      defaultSessionHistoryAccess: 'from_membership' as const,
      admissionMode: 'invite_only' as const,
      authenticationPolicy: null,
      authenticationPolicyStatus: 'available' as const,
    },
    viewerRole: 'owner' as const,
    capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
    admission: { historyChoice: { admin: 'choice' as const, member: 'choice' as const, guest: 'hidden' as const } },
    counts: { members: 3, suspendedMembers: 1, groups: 2, waitingInvitations: null },
  };

  it('round-trips and rejects undeclared fields', () => {
    expect(TeamSummaryV1Schema.parse(summary)).toEqual(summary);
    expect(TeamSummaryV1Schema.safeParse({ ...summary, memberCount: 12 }).success).toBe(false);
  });

  it('carries viewer-qualified Overview counts as a closed object', () => {
    expect(TeamSummaryV1Schema.parse({ ...summary, counts: null }).counts).toBeNull();
    expect(TeamSummaryV1Schema.safeParse({ ...summary, counts: undefined }).success).toBe(false);
    expect(TeamSummaryV1Schema.safeParse({
      ...summary,
      counts: { ...summary.counts, sessions: 4 },
    }).success).toBe(false);
    expect(TeamSummaryV1Schema.safeParse({
      ...summary,
      counts: { ...summary.counts, members: -1 },
    }).success).toBe(false);
  });

  it('carries no Home or server identity, which the client qualifies separately', () => {
    expect(TeamSummaryV1Schema.safeParse({ ...summary, serverId: 's1' }).success).toBe(false);
    expect(TeamSummaryV1Schema.safeParse({ ...summary, homeId: 'h1' }).success).toBe(false);
  });

  it('carries owner recovery authority as a strict viewer-qualified union', () => {
    expect(TeamSummaryV1Schema.parse({
      ...summary,
      recovery: { kind: 'owner_required', canAppointOwner: true },
    }).recovery).toEqual({ kind: 'owner_required', canAppointOwner: true });
    expect(TeamSummaryV1Schema.safeParse({
      ...summary,
      recovery: { kind: 'owner_required', canAppointOwner: true, manageMembers: true },
    }).success).toBe(false);
  });

  it('derives the admission history choice from the one guest rule', () => {
    // The guest exclusion has exactly one owner. Offering a guest a Team history
    // horizon would promise Team-principal access the role never carries, and a
    // second hand-written table here is precisely the drift that would reintroduce it.
    expect(resolveTeamAdmissionProjectionV1()).toEqual({
      historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' },
    });
    expect(TeamSummaryV1Schema.shape.admission.parse(resolveTeamAdmissionProjectionV1()))
      .toEqual(resolveTeamAdmissionProjectionV1());
  });

  it('accepts a guest whose history choice is hidden', () => {
    const guest = {
      ...summary,
      viewerRole: 'guest' as const,
      admission: { historyChoice: { admin: 'hidden' as const, member: 'hidden' as const, guest: 'hidden' as const } },
    };
    expect(TeamSummaryV1Schema.parse(guest).viewerRole).toBe('guest');
    expect(TeamRoleV1Schema.parse('guest')).toBe('guest');
  });
});

describe('Team logo admission contract', () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngBase64 = Buffer.from(pngBytes).toString('base64');

  it('names the resource each bound protects rather than a nearby number', () => {
    // The decoded-byte bound protects decoder working memory, so it must stay far
    // below the shared transport ceiling instead of inheriting it.
    expect(TEAM_LOGO_MAX_SOURCE_BYTES_V1).toBeLessThan(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
    // The pixel bound is the raw RGBA decode budget: 4 bytes per pixel.
    expect(TEAM_LOGO_MAX_SOURCE_PIXELS_V1 * 4).toBe(64 * 1024 * 1024);
    // The route body limit must admit the base64 inflation of a maximal source.
    expect(TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1)
      .toBeGreaterThan(Math.ceil(TEAM_LOGO_MAX_SOURCE_BYTES_V1 / 3) * 4);
    expect(TEAM_LOGO_REQUEST_MAX_BODY_BYTES_V1).toBeLessThan(SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1);
    expect(TEAM_LOGO_PUBLISHED_EDGE_V1).toBe(512);
  });

  it('accepts only the two established image formats and rejects unknown fields', () => {
    const input = { v: 1 as const, teamId: 't1', image: { mimeType: 'image/png' as const, dataBase64: pngBase64 } };
    expect(TeamLogoSetInputV1Schema.parse(input)).toEqual(input);
    expect(TeamLogoSetInputV1Schema.safeParse({
      ...input,
      image: { mimeType: 'image/webp', dataBase64: pngBase64 },
    }).success).toBe(false);
    // A caller-supplied path would make blob custody client-controlled.
    expect(TeamLogoSetInputV1Schema.safeParse({ ...input, path: 'public/teams/t1/logo/x.png' }).success).toBe(false);
    expect(TeamLogoSetInputV1Schema.safeParse({
      ...input,
      image: { mimeType: 'image/png', dataBase64: pngBase64, width: 10 },
    }).success).toBe(false);
  });

  it('rejects an oversized payload before anything decodes it', () => {
    const oversized = 'A'.repeat(Math.ceil(TEAM_LOGO_MAX_SOURCE_BYTES_V1 / 3) * 4 + 8);
    expect(TeamLogoSetInputV1Schema.safeParse({
      v: 1, teamId: 't1', image: { mimeType: 'image/png', dataBase64: oversized },
    }).success).toBe(false);
  });

  it('decodes a well-formed payload and rejects malformed base64 or an oversized decode', () => {
    const input = TeamLogoSetInputV1Schema.parse({
      v: 1, teamId: 't1', image: { mimeType: 'image/png', dataBase64: pngBase64 },
    });
    const decoded = decodeTeamLogoSourceV1(input.image);
    expect(decoded).toEqual({ status: 'ok', bytes: pngBytes, mimeType: 'image/png' });

    expect(decodeTeamLogoSourceV1({ mimeType: 'image/png', dataBase64: '!!!not base64!!!' }))
      .toEqual({ status: 'invalid', reason: 'malformed' });
    expect(decodeTeamLogoSourceV1({ mimeType: 'image/png', dataBase64: '' }))
      .toEqual({ status: 'invalid', reason: 'malformed' });
  });
});

describe('Team directory cursor codec', () => {
  const activeMemberScope = TeamsListInputV1Schema.parse({ v: 1, scope: 'member', archived: 'active' });
  const archivedMemberScope = TeamsListInputV1Schema.parse({ v: 1, scope: 'member', archived: 'archived' });

  it('round-trips the exact ordering tuple', () => {
    const cursor = encodeTeamDirectoryCursorV1({
      queryKey: teamDirectoryQueryKeyV1(activeMemberScope),
      name: 'Acme',
      id: 'team_1',
    });
    expect(decodeTeamDirectoryCursorV1(cursor, teamDirectoryQueryKeyV1(activeMemberScope))).toEqual({
      status: 'ok',
      cursor: { name: 'Acme', id: 'team_1' },
    });
  });

  it('is opaque rather than a readable position the client may author', () => {
    const cursor = encodeTeamDirectoryCursorV1({
      queryKey: teamDirectoryQueryKeyV1(activeMemberScope),
      name: 'Acme',
      id: 'team_1',
    });
    expect(cursor).not.toContain('team_1');
    expect(cursor).not.toContain('Acme');
  });

  it('rejects a cursor from a different query rather than silently restarting', () => {
    const cursor = encodeTeamDirectoryCursorV1({
      queryKey: teamDirectoryQueryKeyV1(activeMemberScope),
      name: 'Acme',
      id: 'team_1',
    });
    expect(decodeTeamDirectoryCursorV1(cursor, teamDirectoryQueryKeyV1(archivedMemberScope)))
      .toEqual({ status: 'invalid' });
  });

  it('rejects malformed, truncated, and non-cursor input', () => {
    const key = teamDirectoryQueryKeyV1(activeMemberScope);
    expect(decodeTeamDirectoryCursorV1('', key)).toEqual({ status: 'invalid' });
    expect(decodeTeamDirectoryCursorV1('not-a-cursor', key)).toEqual({ status: 'invalid' });
    expect(decodeTeamDirectoryCursorV1(Buffer.from('{}').toString('base64url'), key)).toEqual({ status: 'invalid' });
  });

  it('distinguishes the administered scope from ordinary membership visibility', () => {
    const administered = TeamsListInputV1Schema.parse({ v: 1, scope: 'administered', archived: 'active' });
    expect(teamDirectoryQueryKeyV1(administered)).not.toBe(teamDirectoryQueryKeyV1(activeMemberScope));
  });

  it('bounds the page size and rejects an unknown filter', () => {
    expect(TeamsListInputV1Schema.safeParse({ v: 1, scope: 'member', archived: 'active', limit: 0 }).success)
      .toBe(false);
    expect(TeamsListInputV1Schema.safeParse({ v: 1, scope: 'member', archived: 'active', limit: 5000 }).success)
      .toBe(false);
    expect(TeamsListInputV1Schema.safeParse({ v: 1, scope: 'everyone', archived: 'active' }).success).toBe(false);
    expect(TeamsListInputV1Schema.safeParse({ v: 1, scope: 'member', archived: 'active', query: 'x' }).success)
      .toBe(false);
  });
});

describe('Team invitation cursor codec', () => {
  const active = { teamId: 'team_a', state: 'active' as const };
  const revoked = { teamId: 'team_a', state: 'revoked' as const };

  it('round-trips the ordering tuple and binds the derived state query', () => {
    const queryKey = teamInvitationsQueryKeyV1(active);
    const cursor = encodeTeamInvitationsCursorV1({ queryKey, createdAt: 42, id: 'inv_1' });
    expect(decodeTeamInvitationsCursorV1(cursor, queryKey)).toEqual({
      status: 'ok',
      cursor: { createdAt: 42, id: 'inv_1' },
    });
    expect(decodeTeamInvitationsCursorV1(cursor, teamInvitationsQueryKeyV1(revoked)))
      .toEqual({ status: 'invalid' });
    expect(decodeTeamInvitationsCursorV1(cursor, teamInvitationsQueryKeyV1({ ...active, teamId: 'team_b' })))
      .toEqual({ status: 'invalid' });
  });
});

describe('Team error contract', () => {
  it('maps each typed domain result to its released HTTP status', () => {
    expect(teamErrorHttpStatusV1('invalid_team_input')).toBe(400);
    expect(teamErrorHttpStatusV1('invalid_team_cursor')).toBe(400);
    expect(teamErrorHttpStatusV1('invalid_team_authentication_policy')).toBe(400);
    expect(teamErrorHttpStatusV1('team_forbidden')).toBe(403);
    expect(teamErrorHttpStatusV1('team_authentication_required')).toBe(403);
    expect(teamErrorHttpStatusV1('team_authentication_unavailable')).toBe(503);
    expect(teamErrorHttpStatusV1('team_not_found')).toBe(404);
    expect(teamErrorHttpStatusV1('teams_unavailable')).toBe(404);
    expect(teamErrorHttpStatusV1('team_archived')).toBe(409);
    expect(teamErrorHttpStatusV1('team_authentication_policy_conflict')).toBe(409);
    expect(TeamErrorCodeV1Schema.safeParse('provider_test_required').success).toBe(false);
    expect(teamErrorHttpStatusV1('team_authentication_policy_unavailable')).toBe(409);
  });

  it('never distinguishes an unreadable Team from a missing one', () => {
    // Both must be the same wire result so Team existence cannot be probed.
    expect(teamErrorHttpStatusV1('team_not_found')).toBe(404);
    expect(TeamErrorCodeV1Schema.safeParse('team_hidden').success).toBe(false);
  });

  it('carries the invitation lifecycle results in the one Team error vocabulary', () => {
    // Invitation routes are Team routes: a second code enum would give one
    // domain result two wire contracts and two status mappings.
    expect(teamErrorHttpStatusV1('invitation_not_found')).toBe(404);
    expect(teamErrorHttpStatusV1('invitation_not_active')).toBe(409);
    expect(teamErrorHttpStatusV1('invitation_email_unavailable')).toBe(409);
  });

  it('rejects an unknown code in the shared error body', () => {
    expect(TeamErrorV1Schema.safeParse({ error: 'team_forbidden' }).success).toBe(true);
    expect(TeamErrorV1Schema.safeParse({
      error: 'team_authentication_policy_unavailable',
      details: { reason: 'provider_test_required' },
    }).success).toBe(true);
    expect(TeamErrorV1Schema.safeParse({
      error: 'team_authentication_policy_unavailable',
      details: { reason: 'unknown_reason' },
    }).success).toBe(false);
    expect(TeamErrorV1Schema.safeParse({
      error: 'team_forbidden',
      details: { reason: 'provider_test_required' },
    }).success).toBe(false);
    expect(TeamErrorV1Schema.safeParse({ error: 'nope' }).success).toBe(false);
    expect(TeamErrorV1Schema.safeParse({ error: 'team_forbidden', detail: 'x' }).success).toBe(false);
  });
});
