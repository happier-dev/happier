import {
    TEAM_INVITATION_TTL_MS,
    type TeamInvitationAdmissibleRoleV1,
} from "@happier-dev/protocol/teams";
import type { Tx } from "@/storage/inTx";
import type {
    SessionHistoryAccess,
    TeamInvitationEmailDeliveryStatus,
    TeamRole,
} from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { publishTeamChangedInTx } from "../teamChanges";

/**
 * The only writer of `TeamInvitation` rows.
 *
 * Every transition here is a conditional write whose affected-row count is the race
 * winner, so acceptance, revocation, reissue, and Team archive can run concurrently
 * without a lock, an advisory counter, or a second status machine. Invitation state is
 * always derived from these timestamps; nothing stores a status enum.
 *
 * The caller supplies `now`. Consequential callers must pass the transaction database
 * clock (`readTransactionDatabaseTime`) rather than a process-clock sample, so the
 * expiry decision and the minted history horizon share one time source.
 */

export type TeamInvitationRecord = Readonly<{
    id: string;
    teamId: string;
    tokenHash: Uint8Array;
    recipientEmailNormalized: string | null;
    role: TeamRole;
    historyAccess: SessionHistoryAccess;
    createdByAccountId: string | null;
    acceptedAt: Date | null;
    acceptedByAccountId: string | null;
    revokedAt: Date | null;
    expiresAt: Date;
    lastEmailDeliveryStatus: TeamInvitationEmailDeliveryStatus | null;
    lastEmailDeliveryAttemptAt: Date | null;
    createdAt: Date;
}>;

export type CreateTeamInvitationInput = Readonly<{
    teamId: string;
    role: TeamInvitationAdmissibleRoleV1;
    historyAccess: SessionHistoryAccess;
    recipientEmailNormalized: string | null;
    createdByAccountId: string | null;
    tokenHash: Uint8Array;
    now: Date;
}>;

/**
 * Creates one invitation intent. Expiry is always `now + TEAM_INVITATION_TTL_MS`;
 * there is deliberately no per-invitation TTL input, because the seven-day lifetime is
 * a bounded credential-security policy rather than an operator control.
 */
export async function createTeamInvitationInTx(
    tx: Tx,
    input: CreateTeamInvitationInput,
): Promise<TeamInvitationRecord> {
    return tx.teamInvitation.create({
        data: {
            teamId: input.teamId,
            tokenHash: Buffer.from(input.tokenHash),
            recipientEmailNormalized: input.recipientEmailNormalized,
            role: input.role,
            historyAccess: input.role === "guest" ? "from_membership" : input.historyAccess,
            createdByAccountId: input.createdByAccountId,
            expiresAt: new Date(input.now.getTime() + TEAM_INVITATION_TTL_MS),
        },
    });
}

/**
 * The digest is the only lookup key. A caller that cannot produce a well-formed bearer
 * never reaches here, so an arbitrary probe cannot be turned into a row read.
 */
export async function readTeamInvitationByTokenHashInTx(
    tx: Tx,
    tokenHash: Uint8Array,
): Promise<TeamInvitationRecord | null> {
    return tx.teamInvitation.findUnique({ where: { tokenHash: Buffer.from(tokenHash) } });
}

/** Exact server-side admission reference reader. The id is never a bearer by itself. */
export async function readTeamInvitationByIdInTx(
    tx: Tx,
    invitationId: string,
): Promise<TeamInvitationRecord | null> {
    return tx.teamInvitation.findUnique({ where: { id: invitationId } });
}

/**
 * Re-reads the exact server-held OAuth admission reference without consuming it.
 *
 * Existing Accounts still confirm Join through the public bearer owner, but OAuth
 * finalization must not authenticate a now-revoked, used, expired, or replaced
 * invitation continuation. The database clock keeps that decision aligned with
 * the eventual one-time acceptance transaction.
 */
export async function readActiveTeamInvitationAdmissionReferenceInTx(
    tx: Tx,
    input: Readonly<{
        invitationId: string;
        teamId: string;
        tokenHash: string;
    }>,
): Promise<TeamInvitationRecord | null> {
    if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)) return null;
    const [invitation, now] = await Promise.all([
        readTeamInvitationByIdInTx(tx, input.invitationId),
        readTransactionDatabaseTime(tx),
    ]);
    if (!invitation
        || invitation.teamId !== input.teamId
        || invitation.acceptedAt !== null
        || invitation.revokedAt !== null
        || invitation.expiresAt.getTime() <= now.getTime()
        || !Buffer.from(invitation.tokenHash).equals(Buffer.from(input.tokenHash, "hex"))) {
        return null;
    }
    return invitation;
}

export type RevokeTeamInvitationInput = Readonly<{
    teamId: string;
    invitationId: string;
    now: Date;
}>;

/**
 * The one "still waiting" predicate: neither accepted nor revoked, and strictly
 * before expiry, so the exact expiry instant already reads as expired. Every
 * reader that asks whether an invitation is active — the state filter, archive
 * revocation and the Team summary count — composes it rather than restating it.
 */
export function activeTeamInvitationWhere(now: Date) {
    return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } as const;
}

/**
 * Revokes one still-active invitation.
 *
 * The Team is part of the condition so a manager of one Team can never revoke another
 * Team's invitation by id, and an already accepted invitation stays accepted: the
 * membership it produced is real and must not be redescribed as revoked.
 */
export async function revokeTeamInvitationInTx(
    tx: Tx,
    input: RevokeTeamInvitationInput,
): Promise<"revoked" | "unchanged"> {
    const result = await tx.teamInvitation.updateMany({
        where: {
            id: input.invitationId,
            teamId: input.teamId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now },
        },
        data: { revokedAt: input.now },
    });
    return result.count === 1 ? "revoked" : "unchanged";
}

/**
 * Team archive revokes every outstanding invitation in the archiving transaction.
 *
 * Restore deliberately cannot resurrect them: the rows are terminal afterwards, so a
 * link that circulated while the Team was archived stays dead.
 */
export async function revokeActiveTeamInvitationsForTeamInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; now: Date }>,
): Promise<number> {
    const result = await tx.teamInvitation.updateMany({
        where: { teamId: input.teamId, ...activeTeamInvitationWhere(input.now) },
        data: { revokedAt: input.now },
    });
    return result.count;
}

export type ConsumeTeamInvitationInput = Readonly<{
    invitationId: string;
    acceptedByAccountId: string;
    now: Date;
}>;

/**
 * The one-time consume.
 *
 * The full terminal condition lives in the `where` clause, so the database decides the
 * winner: exactly one of several concurrent acceptances, or one of an acceptance and a
 * revocation, can observe `count === 1`. `expiresAt` is compared strictly greater than
 * `now`, which makes the exact expiry instant expired rather than active.
 *
 * A `false` result must leave no membership behind; the caller performs the membership
 * write inside the same transaction and rolls back together with this row.
 */
export async function consumeTeamInvitationForAcceptanceInTx(
    tx: Tx,
    input: ConsumeTeamInvitationInput,
): Promise<boolean> {
    const result = await tx.teamInvitation.updateMany({
        where: {
            id: input.invitationId,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: input.now },
        },
        data: { acceptedAt: input.now, acceptedByAccountId: input.acceptedByAccountId },
    });
    return result.count === 1;
}

export type ReissueTeamInvitationInput = Readonly<{
    teamId: string;
    invitationId: string;
    /** Replaces the recipient constraint; `null` produces a transferable replacement. */
    recipientEmailNormalized: string | null;
    createdByAccountId: string | null;
    tokenHash: Uint8Array;
    now: Date;
}>;

export type ReissueTeamInvitationResult =
    | Readonly<{ previous: TeamInvitationRecord; replacement: TeamInvitationRecord }>
    | "unchanged";

/**
 * Reissue is one transaction: conditionally revoke the current active invitation, then
 * mint a replacement carrying the same role and history intent with a fresh seven-day
 * lifetime.
 *
 * Copying role and history from the stored row rather than from caller input is what
 * makes "the previous link stops working" safe: a reissue cannot silently escalate the
 * offer. Only the recipient constraint is caller-replaceable, which is exactly the
 * Change-email journey. If the invitation is already terminal, nothing is minted, so a
 * duplicated Retry cannot leave two live bearers.
 */
export async function reissueTeamInvitationInTx(
    tx: Tx,
    input: ReissueTeamInvitationInput,
): Promise<ReissueTeamInvitationResult> {
    const revoked = await revokeTeamInvitationInTx(tx, {
        teamId: input.teamId,
        invitationId: input.invitationId,
        now: input.now,
    });
    if (revoked === "unchanged") return "unchanged";

    const previous = await tx.teamInvitation.findUniqueOrThrow({ where: { id: input.invitationId } });
    const replacement = await createTeamInvitationInTx(tx, {
        teamId: previous.teamId,
        // The stored role is a `TeamRole` column, but the creation parser rejects
        // `owner`, so a persisted invitation can only carry an admissible role.
        role: previous.role as TeamInvitationAdmissibleRoleV1,
        historyAccess: previous.role === "guest" ? "from_membership" : previous.historyAccess,
        recipientEmailNormalized: input.recipientEmailNormalized,
        createdByAccountId: input.createdByAccountId,
        tokenHash: input.tokenHash,
        now: input.now,
    });
    return { previous, replacement };
}

/**
 * The narrow outcome writer for the Lane 02 mail boundary, called after the invitation
 * transaction commits.
 *
 * It addresses the exact invitation id, so a slow delivery for a bearer that has since
 * been reissued updates only its own terminal row and can never mark the replacement
 * sent. A crash between submission and this write leaves `null`, which honestly means
 * "no recorded result" rather than a false sent or unsent claim.
 */
export async function recordTeamInvitationEmailDeliveryResultInTx(
    tx: Tx,
    input: Readonly<{
        invitationId: string;
        status: TeamInvitationEmailDeliveryStatus;
        attemptedAt: Date;
    }>,
): Promise<void> {
    const invitation = await tx.teamInvitation.findUnique({
        where: { id: input.invitationId },
        select: { teamId: true },
    });
    if (!invitation) return;
    const updated = await tx.teamInvitation.updateMany({
        where: { id: input.invitationId },
        data: {
            lastEmailDeliveryStatus: input.status,
            lastEmailDeliveryAttemptAt: input.attemptedAt,
        },
    });
    if (updated.count === 1) await publishTeamChangedInTx(tx, { teamId: invitation.teamId });
}
