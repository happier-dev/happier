import { describe, expect, it } from 'vitest';

import { redactPublicShareCapabilityUrl } from '../crypto/publicShareCapabilityUrl.js';
import {
  buildTeamJoinUrl,
  buildTeamMemberSignInUrl,
  createTeamInvitationTargetBindingV1,
  deriveTeamInvitationStateV1,
  maskTeamInvitationRecipientEmail,
  TEAM_INVITATION_TOKEN_LENGTH,
  TEAM_INVITATION_TTL_MS,
  TeamInvitationAcceptInputV1Schema,
  TeamInvitationAcceptResultV1Schema,
  TeamInvitationPostAuthContinuationV1Schema,
  TeamInvitationAdmissibleRoleV1Schema,
  TeamInvitationCreateInputV1Schema,
  TeamInvitationCreateResultV1Schema,
  TeamInvitationPreviewV1Schema,
  TeamInvitationReissueInputV1Schema,
  TeamInvitationRowV1Schema,
  TeamInvitationsPageV1Schema,
  TeamInvitationTokenV1Schema,
  verifyTeamInvitationTargetBindingV1,
} from './invitation.js';

const TOKEN = 'a'.repeat(43);

describe('team invitation token contract', () => {
  it('admits exactly the 43-character alphanumeric bearer and nothing else', () => {
    expect(TEAM_INVITATION_TOKEN_LENGTH).toBe(43);
    expect(TeamInvitationTokenV1Schema.safeParse(TOKEN).success).toBe(true);
    expect(TeamInvitationTokenV1Schema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(TeamInvitationTokenV1Schema.safeParse('a'.repeat(44)).success).toBe(false);
    expect(TeamInvitationTokenV1Schema.safeParse(`${'a'.repeat(42)}-`).success).toBe(false);
    expect(TeamInvitationTokenV1Schema.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
    expect(TeamInvitationTokenV1Schema.safeParse('')).toMatchObject({ success: false });
  });

  it('fixes the ratified seven-day lifetime as one code-owned constant', () => {
    expect(TEAM_INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('team invitation creation input', () => {
  it('rejects an owner invitation because owner promotion is a governance operation', () => {
    expect(TeamInvitationAdmissibleRoleV1Schema.safeParse('owner').success).toBe(false);
    for (const role of ['admin', 'member', 'guest']) {
      expect(TeamInvitationAdmissibleRoleV1Schema.safeParse(role).success).toBe(true);
    }
    const owner = TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'owner',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'req-1',
    });
    expect(owner.success).toBe(false);
  });

  it('is a closed schema so unknown routing or authority fields cannot ride along', () => {
    const parsed = TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'req-1',
      serverId: 'other-home',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts the transferable and email-bound forms of the same intent', () => {
    expect(TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'all_existing',
      recipientEmail: null,
      requestKey: 'req-1',
    }).success).toBe(true);
    expect(TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'guest',
      historyAccess: 'from_membership',
      recipientEmail: 'Person@Example.test',
      requestKey: 'req-2',
    }).success).toBe(true);
  });

  it('rejects all-existing history for a Guest invitation', () => {
    expect(TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'guest',
      historyAccess: 'all_existing',
      recipientEmail: null,
      requestKey: 'req-guest-history',
    }).success).toBe(false);
  });

  it('rejects an invalid history choice and an unbounded recipient address', () => {
    expect(TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'everything',
      recipientEmail: null,
      requestKey: 'req-1',
    }).success).toBe(false);
    expect(TeamInvitationCreateInputV1Schema.safeParse({
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: `${'a'.repeat(9_000)}@example.test`,
      requestKey: 'req-1',
    }).success).toBe(false);
  });

  it('requires the reissue intent to address one exact existing invitation', () => {
    const input = TeamInvitationReissueInputV1Schema.parse({
      v: 1,
      teamId: 'team-1',
      invitationId: 'inv-1',
      recipientEmail: null,
      requestKey: 'req-3',
    });
    expect(input.invitationId).toBe('inv-1');
    const { invitationId: _invitationId, ...withoutInvitationId } = input;
    expect(TeamInvitationReissueInputV1Schema.safeParse(withoutInvitationId)).toMatchObject({
      success: false,
      error: { issues: [{ code: 'invalid_type', path: ['invitationId'] }] },
    });
  });
});

describe('derived invitation state', () => {
  const base = { acceptedAt: null, revokedAt: null, expiresAt: 2_000 } as const;

  it('derives state from timestamps in the ratified precedence order', () => {
    expect(deriveTeamInvitationStateV1(base, 1_000)).toBe('active');
    expect(deriveTeamInvitationStateV1({ ...base, acceptedAt: 500 }, 1_000)).toBe('accepted');
    expect(deriveTeamInvitationStateV1({ ...base, revokedAt: 500 }, 1_000)).toBe('revoked');
    expect(deriveTeamInvitationStateV1({ ...base, expiresAt: 900 }, 1_000)).toBe('expired');
  });

  it('keeps acceptance authoritative over a later revocation and over expiry', () => {
    expect(deriveTeamInvitationStateV1({ acceptedAt: 500, revokedAt: 600, expiresAt: 700 }, 1_000)).toBe('accepted');
    expect(deriveTeamInvitationStateV1({ acceptedAt: null, revokedAt: 600, expiresAt: 700 }, 1_000)).toBe('revoked');
  });

  it('treats the exact expiry instant as expired rather than active', () => {
    expect(deriveTeamInvitationStateV1({ ...base, expiresAt: 1_000 }, 1_000)).toBe('expired');
    expect(deriveTeamInvitationStateV1({ ...base, expiresAt: 1_001 }, 1_000)).toBe('active');
  });
});

describe('bearer confinement in projections', () => {
  it('drops any bearer-shaped field from a manager invitation row', () => {
    const parsed = TeamInvitationRowV1Schema.safeParse({
      id: 'inv-1',
      teamId: 'team-1',
      state: 'active',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmailMask: null,
      expiresAt: 2_000,
      createdAt: 1_000,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
      token: TOKEN,
    });
    expect(parsed.success).toBe(false);
  });

  it('never lets a preview carry the token, roster, or internal actor identity', () => {
    const preview = {
      home: { serverId: 'home-1', displayName: 'Acme Home', storageMode: 'plain' as const },
      team: { teamId: 'team-1', name: 'Acme', logo: null, accentSeed: 'team-1' },
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      state: 'active' as const,
      expiresAt: 2_000,
      recipientEmailMask: null,
    };
    expect(TeamInvitationPreviewV1Schema.safeParse(preview).success).toBe(true);
    // A Home without a published storage policy discloses nothing rather than "plain".
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      home: { ...preview.home, storageMode: null },
    }).success).toBe(true);
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      home: { ...preview.home, storageMode: 'unknown' },
    }).success).toBe(false);
    // A Home that publishes no display name says nothing rather than letting the
    // join screen substitute the application origin or the inviter for it.
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      home: { ...preview.home, displayName: null },
    }).success).toBe(true);
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      home: { ...preview.home, displayName: '' },
    }).success).toBe(false);
    expect(TeamInvitationPreviewV1Schema.safeParse({ ...preview, token: TOKEN }).success).toBe(false);
    expect(TeamInvitationPreviewV1Schema.safeParse({ ...preview, createdByAccountId: 'a1' }).success).toBe(false);
    expect(TeamInvitationPreviewV1Schema.safeParse({ ...preview, memberCount: 12 }).success).toBe(false);
  });

  it('discloses the inviter as one display label and never as an actor identity', () => {
    const preview = {
      home: { serverId: 'home-1', displayName: 'Acme Home', storageMode: 'plain' as const },
      team: { teamId: 'team-1', name: 'Acme', logo: null, accentSeed: 'team-1' },
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      state: 'active' as const,
      expiresAt: 2_000,
      recipientEmailMask: null,
      // The same label the invitation email already shows the invited person.
      inviterLabel: 'Ada Lovelace',
    };
    expect(TeamInvitationPreviewV1Schema.safeParse(preview).success).toBe(true);
    // An inviter whose Account no longer resolves reads as "not said", never as a
    // placeholder, and an older Home that omits the field reads the same way.
    expect(TeamInvitationPreviewV1Schema.safeParse({ ...preview, inviterLabel: null }).success).toBe(true);
    const { inviterLabel: _omitted, ...withoutLabel } = preview;
    expect(TeamInvitationPreviewV1Schema.parse(withoutLabel).inviterLabel).toBeNull();
    // An Account with neither a name nor a username has no label; it must not
    // reach the wire as an empty string the join screen would render as a gap.
    expect(TeamInvitationPreviewV1Schema.safeParse({ ...preview, inviterLabel: '' }).success).toBe(false);
    // The label is the whole disclosure: no id, no address, no actor object.
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      inviterAccountId: 'account-1',
    }).success).toBe(false);
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      inviterEmail: 'ada@example.test',
    }).success).toBe(false);
    expect(TeamInvitationPreviewV1Schema.safeParse({
      ...preview,
      inviter: { label: 'Ada Lovelace' },
    }).success).toBe(false);
  });

  it('returns the raw bearer exactly once on create and permits its omission', () => {
    const invitation = {
      id: 'inv-1',
      teamId: 'team-1',
      state: 'active' as const,
      role: 'member' as const,
      historyAccess: 'from_membership' as const,
      recipientEmailMask: null,
      expiresAt: 2_000,
      createdAt: 1_000,
      createdByAccountId: 'account-1',
      acceptedByAccountId: null,
      lastEmailDelivery: null,
    };
    expect(TeamInvitationCreateResultV1Schema.safeParse({
      invitation,
      joinUrl: `https://app.example.test/join/${TOKEN}`,
    }).success).toBe(true);
    expect(TeamInvitationCreateResultV1Schema.safeParse({ invitation, joinUrl: null }).success).toBe(true);
    expect(TeamInvitationCreateResultV1Schema.safeParse({ invitation }).success).toBe(false);
  });

  it('publishes whether this Home can currently deliver an invitation by mail', () => {
    // The manager page is the only authenticated read that already proves
    // invitation authority, so it is where the invite surfaces learn whether
    // offering Email is honest. Absence is not "available": the field is
    // required so a Home that cannot answer cannot be read as one that can.
    const page = {
      items: [],
      nextCursor: null,
      emailDelivery: 'available' as const,
      linkDelivery: 'available' as const,
    };
    expect(TeamInvitationsPageV1Schema.safeParse(page).success).toBe(true);
    expect(TeamInvitationsPageV1Schema.safeParse({
      ...page,
      emailDelivery: 'unavailable',
    }).success).toBe(true);
    // A Home with no published join target can render no link, so it also
    // cannot mail one; the two answers are carried separately because the
    // surface must distinguish "share a link instead" from "there is no link".
    expect(TeamInvitationsPageV1Schema.safeParse({
      ...page,
      emailDelivery: 'unavailable',
      linkDelivery: 'unavailable',
    }).success).toBe(true);
    const { emailDelivery: _emailDelivery, ...withoutEmailDelivery } = page;
    const { linkDelivery: _linkDelivery, ...withoutLinkDelivery } = page;
    expect(TeamInvitationsPageV1Schema.safeParse(withoutEmailDelivery)).toMatchObject({
      success: false,
      error: { issues: [{ path: ['emailDelivery'] }] },
    });
    expect(TeamInvitationsPageV1Schema.safeParse(withoutLinkDelivery)).toMatchObject({
      success: false,
      error: { issues: [{ path: ['linkDelivery'] }] },
    });
    expect(TeamInvitationsPageV1Schema.safeParse({ ...page, emailDelivery: true }).success).toBe(false);
    expect(TeamInvitationsPageV1Schema.safeParse({ ...page, emailDelivery: 'maybe' }).success).toBe(false);
    expect(TeamInvitationsPageV1Schema.safeParse({ ...page, linkDelivery: 'maybe' }).success).toBe(false);
  });

  it('masks a recipient address without disclosing the full local part', () => {
    expect(maskTeamInvitationRecipientEmail('person@example.test')).toBe('p•••@example.test');
    expect(maskTeamInvitationRecipientEmail('a@example.test')).toBe('•••@example.test');
    expect(maskTeamInvitationRecipientEmail(null)).toBeNull();
  });
});

describe('join URL', () => {
  it('binds the exact opaque target bytes while preserving deliberate bearer transferability', () => {
    const homeTarget = '{"kind":"descriptor","descriptor":{"revision":1}}';
    const binding = createTeamInvitationTargetBindingV1({ token: TOKEN, homeTarget });

    expect(binding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(verifyTeamInvitationTargetBindingV1({ token: TOKEN, homeTarget, binding })).toBe(true);
    expect(verifyTeamInvitationTargetBindingV1({
      token: TOKEN,
      homeTarget: homeTarget.replace('1', '2'),
      binding,
    })).toBe(false);
    expect(verifyTeamInvitationTargetBindingV1({
      token: TOKEN,
      homeTarget,
      binding: `${binding}=`,
    })).toBe(false);
    // A holder of the complete transferable bearer can intentionally recompute
    // the binding for another target; this is integrity against target-only
    // rewriting, not signed Home identity.
    const replacementTarget = homeTarget.replace('1', '2');
    const replacementBinding = createTeamInvitationTargetBindingV1({
      token: TOKEN,
      homeTarget: replacementTarget,
    });
    expect(verifyTeamInvitationTargetBindingV1({
      token: TOKEN,
      homeTarget: replacementTarget,
      binding: replacementBinding,
    })).toBe(true);
  });

  it('requires the portable Home target and carries it beside the bearer', () => {
    expect(buildTeamJoinUrl({
      applicationOrigin: 'https://app.example.test/',
      token: TOKEN,
      homeTarget: 'home-descriptor value/+=',
    })).toBe(
      `https://app.example.test/join/${TOKEN}`
      + '?target=home-descriptor%20value%2F%2B%3D'
      + '&targetBinding=TYNlI3RTsveVx2CFSmKe_mYanAIM76dUDeo5Zzb0SSE',
    );
    expect(() => buildTeamJoinUrl({
      applicationOrigin: 'https://app.example.test',
      token: TOKEN,
      homeTarget: null as never,
    })).toThrow('Team join URL requires a portable Home target');
  });

  it('refuses a malformed bearer or an origin that already carries authority', () => {
    expect(() => buildTeamJoinUrl({
      applicationOrigin: 'https://app.example.test',
      token: 'short',
      homeTarget: 'home-descriptor',
    })).toThrow();
    expect(() => buildTeamJoinUrl({
      applicationOrigin: 'https://user:pass@app.example.test',
      token: TOKEN,
      homeTarget: 'home-descriptor',
    })).toThrow();
    expect(() => buildTeamJoinUrl({
      applicationOrigin: 'https://app.example.test/?next=1',
      token: TOKEN,
      homeTarget: 'home-descriptor',
    })).toThrow();
  });

  it('produces a link the shared capability redactor fully templates', () => {
    const url = buildTeamJoinUrl({
      applicationOrigin: 'https://app.example.test',
      token: TOKEN,
      homeTarget: 'home-descriptor',
    });
    const redacted = redactPublicShareCapabilityUrl(url);
    expect(redacted).toBe(
      'https://app.example.test/join/:token?target=home-descriptor'
      + '&targetBinding=z16QmonPp4aOGYLbrxLo3Bxa7xfdMqtnCTRH-s9Z4Aw',
    );
    expect(redacted).not.toContain(TOKEN);
  });
});

describe('member sign-in URL', () => {
  it('addresses the immutable Team on the same explicit Home carrier, with no bearer', () => {
    expect(buildTeamMemberSignInUrl({
      applicationOrigin: 'https://app.example.test/',
      teamId: 'team_exact',
      homeTarget: 'home-descriptor value/+=',
    })).toBe('https://app.example.test/teams/team_exact/sign-in?target=home-descriptor%20value%2F%2B%3D');
  });

  it('escapes the Team id rather than letting it shape the path', () => {
    expect(buildTeamMemberSignInUrl({
      applicationOrigin: 'https://app.example.test',
      teamId: 'team a/b',
      homeTarget: 'home-descriptor',
    })).toBe('https://app.example.test/teams/team%20a%2Fb/sign-in?target=home-descriptor');
  });

  it('refuses an absent Team or an origin that already carries authority', () => {
    expect(() => buildTeamMemberSignInUrl({
      applicationOrigin: 'https://app.example.test',
      teamId: '   ',
      homeTarget: 'home-descriptor',
    })).toThrow('Team member sign-in URL requires a Team');
    expect(() => buildTeamMemberSignInUrl({
      applicationOrigin: 'https://app.example.test',
      teamId: 'team_exact',
      homeTarget: '  ',
    })).toThrow('Team member sign-in URL requires a portable Home target');
    expect(() => buildTeamMemberSignInUrl({
      applicationOrigin: 'https://user:pass@app.example.test',
      teamId: 'team_exact',
      homeTarget: 'home-descriptor',
    })).toThrow();
    expect(() => buildTeamMemberSignInUrl({
      applicationOrigin: 'https://app.example.test/?next=1',
      teamId: 'team_exact',
      homeTarget: 'home-descriptor',
    })).toThrow();
  });
});

describe('accept transport and typed outcomes', () => {
  it('accepts only a strict versioned bearer body', () => {
    expect(TeamInvitationAcceptInputV1Schema.safeParse({ v: 1, token: TOKEN }).success).toBe(true);
    const continuation = { v: 1, kind: 'post_auth_invitation', reference: 'oauth_pending_exact', teamId: 'team-1' } as const;
    expect(TeamInvitationPostAuthContinuationV1Schema.safeParse(continuation).success).toBe(true);
    expect(TeamInvitationAcceptInputV1Schema.safeParse({ v: 1, continuation }).success).toBe(true);
    expect(TeamInvitationAcceptInputV1Schema.safeParse({ v: 1, token: TOKEN, continuation }).success).toBe(false);
    expect(TeamInvitationAcceptInputV1Schema.safeParse({ token: TOKEN }).success).toBe(false);
    expect(TeamInvitationAcceptInputV1Schema.safeParse({ v: 1, token: TOKEN, teamId: 't' }).success).toBe(false);
  });

  it('keeps every user-recoverable terminal state distinguishable', () => {
    for (const outcome of [
      'not_found',
      'expired',
      'revoked',
      'used',
      'team_archived',
      'account_inactive',
      'email_mismatch',
      'feature_unavailable',
    ]) {
      expect(TeamInvitationAcceptResultV1Schema.safeParse({ outcome }).success).toBe(true);
    }
    expect(TeamInvitationAcceptResultV1Schema.safeParse({ outcome: 'joined', teamId: 'team-1' }).success).toBe(true);
    expect(TeamInvitationAcceptResultV1Schema.safeParse({ outcome: 'already_member', teamId: 'team-1' }).success).toBe(true);
    expect(TeamInvitationAcceptResultV1Schema.safeParse({ outcome: 'joined' }).success).toBe(false);
    expect(TeamInvitationAcceptResultV1Schema.safeParse({ outcome: 'internal_error' }).success).toBe(false);
  });
});
