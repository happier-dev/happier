import { describe, expect, it } from 'vitest';
import type { TeamInvitationRowV1 } from '@happier-dev/protocol/teams';

import { partitionTeamInvitations, resolveTeamInvitationPresentation } from './teamInvitationPresentation';

const NOW = 1_000_000;

function row(overrides?: Partial<TeamInvitationRowV1>): TeamInvitationRowV1 {
    return {
        id: 'inv-1',
        teamId: 'team-1',
        state: 'active',
        role: 'member',
        historyAccess: 'from_membership',
        recipientEmailMask: null,
        expiresAt: NOW + 1000,
        createdAt: NOW - 1000,
        createdByAccountId: 'account-1',
        acceptedByAccountId: null,
        lastEmailDelivery: null,
        ...overrides,
    };
}

describe('resolveTeamInvitationPresentation', () => {
    it('offers revocation only while an invitation is genuinely live', () => {
        expect(resolveTeamInvitationPresentation(row(), NOW).canRevoke).toBe(true);
        expect(resolveTeamInvitationPresentation(row({ state: 'revoked' }), NOW).canRevoke).toBe(false);
        expect(resolveTeamInvitationPresentation(row({ state: 'accepted' }), NOW).canRevoke).toBe(false);
    });

    it('treats a live row whose expiry passed on screen as expired', () => {
        const stale = resolveTeamInvitationPresentation(row({ expiresAt: NOW - 1 }), NOW);
        expect(stale.state).toBe('expired');
        // Offering to revoke something already dead would be a false control.
        expect(stale.canRevoke).toBe(false);
        expect(stale.canReissue).toBe(true);
    });

    it('never recomputes a terminal answer the Home already gave', () => {
        // An accepted invitation past its expiry stays accepted: the membership
        // it produced is real, and calling it expired would misdescribe history.
        const accepted = resolveTeamInvitationPresentation(
            row({ state: 'accepted', expiresAt: NOW - 5000 }),
            NOW,
        );
        expect(accepted.state).toBe('accepted');
        // Reissuing a spent invitation would mint access for somebody who joined.
        expect(accepted.canReissue).toBe(false);

        const revoked = resolveTeamInvitationPresentation(
            row({ state: 'revoked', expiresAt: NOW - 5000 }),
            NOW,
        );
        expect(revoked.state).toBe('revoked');
        // Revocation is an explicit manager decision. The retained row is
        // provenance, not a shortcut for silently minting fresh access again.
        expect(revoked.canReissue).toBe(false);
    });

    it('shows only the masked recipient and the delivery outcome', () => {
        const emailBound = resolveTeamInvitationPresentation(
            row({ recipientEmailMask: 'a•••@example.com', lastEmailDelivery: { status: 'failed', attemptedAt: NOW } }),
            NOW,
        );
        expect(emailBound.recipientLabel).toContain('a•••@example.com');
        expect(emailBound.deliveryLabel).toBe('Email delivery failed');

        const linkOnly = resolveTeamInvitationPresentation(row(), NOW);
        expect(linkOnly.recipientLabel).toBeNull();
        expect(linkOnly.deliveryLabel).toBeNull();
    });

    it('states what an outstanding invitation would actually grant', () => {
        // Two live links are otherwise indistinguishable, so a manager deciding
        // whether to revoke one must see the role and the history horizon it
        // carries rather than only that it is active.
        const wideOpen = resolveTeamInvitationPresentation(
            row({ role: 'admin', historyAccess: 'all_existing' }),
            NOW,
        );
        expect(wideOpen.offerLabel).toContain('Admin');
        expect(wideOpen.offerLabel).toContain('Include sessions already shared with the Team');

        const restrained = resolveTeamInvitationPresentation(row({ role: 'guest' }), NOW);
        expect(restrained.offerLabel).toContain('Guest');
        expect(restrained.offerLabel).toContain('Only sessions shared after they join');
    });
});

describe('reissue safety', () => {
    it('offers Change email only where there is a recipient constraint to replace', () => {
        const emailBound = resolveTeamInvitationPresentation(
            row({ recipientEmailMask: 'a•••@example.com' }),
            NOW,
        );
        // The reissue input owns the rule: `null` is Retry and preserves the
        // existing constraint, so the masked address never has to be
        // reproduced. Change email is the separate intent that replaces it.
        expect(emailBound.reissueMode).toBe('email');

        const linkOnly = resolveTeamInvitationPresentation(row(), NOW);
        // A transferable link has no constraint, so Retry is the only intent.
        expect(linkOnly.reissueMode).toBe('link');
    });

    it('offers no reissue at all for an invitation that was already accepted', () => {
        const accepted = resolveTeamInvitationPresentation(row({ state: 'accepted' }), NOW);
        expect(accepted.canReissue).toBe(false);
        expect(accepted.reissueMode).toBe('none');
    });
});

describe('partitionTeamInvitations', () => {
    it('separates invitations still waiting from the ones that are finished, keeping their order', () => {
        const rows = [
            row({ id: 'waiting-1' }),
            row({ id: 'accepted', state: 'accepted' }),
            row({ id: 'waiting-2' }),
            row({ id: 'revoked', state: 'revoked' }),
            // Its expiry passed while the list was on screen: it is finished, whatever the row still says.
            row({ id: 'lapsed', expiresAt: NOW - 1 }),
        ];
        const { waiting, finished } = partitionTeamInvitations(rows, NOW);
        expect(waiting.map((invitation) => invitation.id)).toEqual(['waiting-1', 'waiting-2']);
        expect(finished.map((invitation) => invitation.id)).toEqual(['accepted', 'revoked', 'lapsed']);
    });
});

describe('an email that did not arrive', () => {
    it('is the only state that asks for the invitation to be sent again from its row', () => {
        const failed = { status: 'failed' as const, attemptedAt: NOW - 10 };
        const sent = { status: 'sent' as const, attemptedAt: NOW - 10 };
        const undelivered = row({ recipientEmailMask: 'j•••@acme.dev', lastEmailDelivery: failed });
        expect(resolveTeamInvitationPresentation(undelivered, NOW).emailUndelivered).toBe(true);
        expect(resolveTeamInvitationPresentation(row({ recipientEmailMask: 'j•••@acme.dev', lastEmailDelivery: sent }), NOW).emailUndelivered).toBe(false);
        // A finished invitation has nothing left to deliver.
        expect(resolveTeamInvitationPresentation({ ...undelivered, state: 'revoked' }, NOW).emailUndelivered).toBe(false);
    });
});
