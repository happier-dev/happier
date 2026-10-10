import {
    deriveTeamInvitationStateV1,
    type TeamInvitationRowV1,
    type TeamInvitationStateV1,
} from '@happier-dev/protocol/teams';

import { t } from '@/text';

import { teamRoleLabel } from '../teamLabels';

/**
 * How one invitation row is presented, and what may still be done to it.
 *
 * The Home's terminal answers are authoritative and are never recomputed here:
 * the row publishes `state`, not the instants that produced it, so inventing
 * those instants would make this a second — and wrong — decision-maker.
 *
 * Expiry is the one transition that can happen while this list is on screen, and
 * `expiresAt` is a real published fact, so it is the only state derived here.
 * It goes through the protocol's shared deriver so the rule is literally the
 * same code the Home applies.
 */
function resolveState(row: TeamInvitationRowV1, now: number): TeamInvitationStateV1 {
    if (row.state !== 'active') return row.state;
    return deriveTeamInvitationStateV1(
        { acceptedAt: null, revokedAt: null, expiresAt: row.expiresAt },
        now,
    );
}
export type TeamInvitationPresentation = Readonly<{
    state: TeamInvitationStateV1;
    stateLabel: string;
    /** Only a live invitation can be revoked. */
    canRevoke: boolean;
    /**
     * A replacement is useful for anything that is no longer usable, and also
     * for a live one whose link was lost — the bearer is never recoverable.
     */
    canReissue: boolean;
    /**
     * Which replacement intents this row actually has.
     *
     * The reissue input owns the rule: `recipientEmail: null` is **Retry** — the
     * same offer to the same person, preserving whatever recipient constraint
     * the invitation already carries — and a value is **Change email**. Retry
     * cannot widen an email-bound invitation into a transferable link, so this
     * never has to reproduce the address behind the mask to stay safe.
     *
     * `link` therefore offers Retry alone; `email` offers Retry and Change
     * email; `none` is a spent invitation with no replacement at all.
     */
    reissueMode: 'none' | 'link' | 'email';
    /** The masked recipient, or null for a link invitation. */
    recipientLabel: string | null;
    deliveryLabel: string | null;
    /**
     * A waiting invitation whose last email was refused by the mail boundary. The one state that
     * asks for attention on its own row; a finished invitation has nothing left to deliver.
     */
    emailUndelivered: boolean;
    /**
     * What this invitation actually offers, in the manager's words.
     *
     * A reviewer deciding whether to revoke an outstanding invitation needs the
     * role and history horizon it would grant; without them one live link is
     * indistinguishable from another that admits an admin to every past Session.
     */
    offerLabel: string;
}>;

export function resolveTeamInvitationPresentation(
    row: TeamInvitationRowV1,
    now: number,
): TeamInvitationPresentation {
    const state = resolveState(row, now);

    const stateLabel = state === 'active'
        ? t('teams.invitations.stateActive')
        : state === 'accepted'
            ? t('teams.invitations.stateAccepted')
            : state === 'revoked'
                ? t('teams.invitations.stateRevoked')
                : t('teams.invitations.stateExpired');

    const deliveryLabel = row.lastEmailDelivery === null
        ? null
        : row.lastEmailDelivery.status === 'sent'
            ? t('teams.invitations.deliverySent')
            : t('teams.invitations.deliveryFailed');

    // Expiry is passive: offering a fresh replacement is the useful recovery.
    // Revocation is an explicit manager decision and acceptance is already
    // fulfilled, so both retained rows remain provenance-only. This mirrors the
    // canonical reissue writer, which refuses both terminal transitions instead
    // of silently minting access again from either one.
    const canReissue = state === 'active' || state === 'expired';

    return Object.freeze({
        state,
        stateLabel,
        canRevoke: state === 'active',
        canReissue,
        reissueMode: !canReissue
            ? 'none' as const
            : row.recipientEmailMask === null
                ? 'link' as const
                : 'email' as const,
        recipientLabel: row.recipientEmailMask === null
            ? null
            : t('teams.invitations.maskedRecipient', { email: row.recipientEmailMask }),
        deliveryLabel,
        emailUndelivered: state === 'active' && row.lastEmailDelivery?.status === 'failed',
        offerLabel: `${teamRoleLabel(row.role)} · ${row.historyAccess === 'all_existing'
            ? t('teams.history.allExisting')
            : t('teams.history.fromMembership')}`,
    });
}

/**
 * The list's two groups (lab `tsInvites-A`): invitations still waiting to be accepted, and the ones
 * that are finished — accepted, revoked or expired. The state is the presenter's, so a row whose
 * expiry passed on screen moves to finished with the rest of what it shows.
 */
export function partitionTeamInvitations(
    rows: readonly TeamInvitationRowV1[],
    now: number,
): Readonly<{ waiting: readonly TeamInvitationRowV1[]; finished: readonly TeamInvitationRowV1[] }> {
    const waiting: TeamInvitationRowV1[] = [];
    const finished: TeamInvitationRowV1[] = [];
    for (const row of rows) {
        (resolveState(row, now) === 'active' ? waiting : finished).push(row);
    }
    return { waiting, finished };
}
