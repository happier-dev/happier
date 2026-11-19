import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams';

import { isAccountMissingOwnName } from '@/sync/domains/account/accountOwnName';
import { t } from '@/text';

/**
 * How one accept outcome is presented, and what the person can usefully do next.
 *
 * Every terminal outcome stays distinguishable — that is the whole reason the
 * accept result is a discriminated union rather than a boolean — so the join
 * screen offers one real next action instead of a generic error. `joined` and
 * `already_member` both carry the Team, so both can offer Open Team without a
 * second lookup.
 */
export type TeamJoinPresentation = Readonly<{
    title: string;
    body: string | null;
    /** The Team to open, when the outcome produced or confirmed a membership. */
    openTeamId: string | null;
    /** Whether asking the Home again could plausibly change the answer. */
    retryable: boolean;
    /** Whether a fresh invitation from a Team manager is the real remedy. */
    askForNew: boolean;
    /** Whether the person must act on their own identity first. */
    identityAction: 'sign_in_with_invited' | 'use_another_account' | null;
    exitToHappier?: true;
}>;

export function resolveTeamJoinPresentation(
    result: TeamInvitationAcceptResultV1,
    /** Names the Team in the joined title when the caller knows it. */
    teamName?: string,
): TeamJoinPresentation {
    const base = {
        body: null,
        openTeamId: null,
        retryable: false,
        askForNew: false,
        identityAction: null,
    } as const;

    switch (result.outcome) {
        case 'joined':
            // A fresh join is not "already a member": conflating the two would
            // tell somebody their action did nothing when it just succeeded.
            return Object.freeze({
                ...base,
                title: teamName
                    ? t('teams.join.joinedTeamTitle', { team: teamName })
                    : t('teams.join.joinedTitle'),
                openTeamId: result.teamId,
            });
        case 'already_member':
            return Object.freeze({
                ...base,
                title: t('teams.join.alreadyMemberTitle'),
                openTeamId: result.teamId,
            });
        case 'expired':
            return Object.freeze({
                ...base,
                title: t('teams.join.expiredTitle'),
                body: t('teams.join.askForNew'),
                askForNew: true,
            });
        case 'revoked':
            return Object.freeze({
                ...base,
                title: t('teams.join.revokedTitle'),
                body: t('teams.join.askForNew'),
                askForNew: true,
            });
        case 'used':
            return Object.freeze({
                ...base,
                title: t('teams.join.usedTitle'),
                body: t('teams.join.askForNew'),
                askForNew: true,
            });
        case 'team_archived':
            return Object.freeze({
                ...base,
                title: t('teams.join.archivedTitle'),
                body: t('teams.join.askForNew'),
                askForNew: true,
            });
        case 'account_inactive':
            return Object.freeze({
                ...base,
                title: t('teams.join.inactiveTitle'),
                body: t('teams.join.inactiveBody'),
                identityAction: 'use_another_account',
            });
        case 'email_mismatch':
            // The invitation is fine; this device is signed in as somebody else.
            return Object.freeze({
                ...base,
                title: t('teams.join.mismatchTitle'),
                body: t('teams.join.mismatchBody'),
                identityAction: 'sign_in_with_invited',
            });
        case 'feature_unavailable':
            return Object.freeze({
                ...base,
                title: t('teams.join.updateRequiredTitle'),
                body: t('teams.join.updateRequiredBody'),
                exitToHappier: true,
            });
        case 'not_found':
            return Object.freeze({
                ...base,
                title: t('teams.join.invalidTitle'),
                body: t('teams.join.askForNew'),
                askForNew: true,
            });
    }
}

/**
 * Whether the joined-Team card asks for a name: only a fresh `joined`, and only
 * when the Account's synced profile on that Home has no name of its own
 * (`isAccountMissingOwnName`, the rule Home's "Add your name" shares).
 */
export function shouldOfferTeamJoinName(params: Readonly<{
    outcome: TeamInvitationAcceptResultV1['outcome'];
    profile: Readonly<{ name: string | null }> | null;
}>): boolean {
    return params.outcome === 'joined' && isAccountMissingOwnName(params.profile);
}
