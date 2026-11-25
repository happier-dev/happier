import { describe, expect, it } from 'vitest';
import {
    TeamInvitationAcceptResultV1Schema,
    type TeamInvitationAcceptResultV1,
} from '@happier-dev/protocol/teams';

import { resolveTeamJoinPresentation } from './teamJoinOutcome';

/** Every outcome the accept contract can actually return. */
const ALL_OUTCOMES: readonly TeamInvitationAcceptResultV1[] = [
    { outcome: 'joined', teamId: 'team-1' },
    { outcome: 'already_member', teamId: 'team-1' },
    { outcome: 'not_found' },
    { outcome: 'expired' },
    { outcome: 'revoked' },
    { outcome: 'used' },
    { outcome: 'team_archived' },
    { outcome: 'account_inactive' },
    { outcome: 'email_mismatch' },
    { outcome: 'feature_unavailable' },
];

describe('resolveTeamJoinPresentation', () => {
    it('covers every outcome the contract can return with a distinct title', () => {
        // Exhaustiveness over the union is enforced by the owner's switch return type;
        // this proves each listed outcome is a real contract shape with its own title.
        for (const outcome of ALL_OUTCOMES) {
            expect(TeamInvitationAcceptResultV1Schema.safeParse(outcome).success).toBe(true);
        }
        const titles = ALL_OUTCOMES.map((outcome) => resolveTeamJoinPresentation(outcome).title);
        expect(titles.every((title) => title.length > 0)).toBe(true);
        expect(new Set(titles).size).toBe(titles.length);
    });

    it('distinguishes a fresh join from an existing membership', () => {
        const joined = resolveTeamJoinPresentation({ outcome: 'joined', teamId: 'team-1' });
        const already = resolveTeamJoinPresentation({ outcome: 'already_member', teamId: 'team-1' });

        // Telling somebody who just joined that they were "already a member"
        // would report their action as a no-op.
        expect(joined.title).not.toBe(already.title);
        // Both produced a membership, so both can open the Team without a lookup.
        expect(joined.openTeamId).toBe('team-1');
        expect(already.openTeamId).toBe('team-1');
    });

    it('offers a new invitation only where one would actually help', () => {
        const askForNew = ALL_OUTCOMES
            .filter((outcome) => resolveTeamJoinPresentation(outcome).askForNew)
            .map((outcome) => outcome.outcome);

        expect(askForNew.sort()).toEqual(['expired', 'not_found', 'revoked', 'used']);
    });

    it('routes an address mismatch to the person’s own identity, not to a manager', () => {
        const mismatch = resolveTeamJoinPresentation({ outcome: 'email_mismatch' });
        expect(mismatch.identityAction).toBe('sign_in_with_invited');
        // The invitation itself is fine, so asking for a replacement is wrong.
        expect(mismatch.askForNew).toBe(false);
    });

    it('never offers a Team to open for an outcome that produced no membership', () => {
        const withoutMembership = ALL_OUTCOMES
            .filter((outcome) => outcome.outcome !== 'joined' && outcome.outcome !== 'already_member');
        for (const outcome of withoutMembership) {
            expect(resolveTeamJoinPresentation(outcome).openTeamId).toBeNull();
        }
    });
});
