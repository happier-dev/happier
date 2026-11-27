import type { TeamInvitationAcceptResultV1 } from '@happier-dev/protocol/teams/invitation';
import type { Tx } from "@/storage/inTx";
import { acquireTeamMutationAccountAdmissionInTx } from "../memberships/sessionAccessEffects";
import { AccountStatus } from "@/storage/enums.generated";
import { readTransactionDatabaseTime } from "@/storage/transactionDatabaseTime";
import { normalizeVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import { upsertVerifiedMailboxEvidenceInTx } from "@/app/auth/verifiedMailboxEvidence";
import { admitTeamMemberInTx } from "../memberships/membershipService";
import { publishTeamChangedInTx } from "../teamChanges";
import {
    consumeTeamInvitationForAcceptanceInTx,
    readTeamInvitationByIdInTx,
    readTeamInvitationByTokenHashInTx,
    type TeamInvitationRecord,
} from "./invitationLifecycle";
import { tryDigestTeamInvitationToken } from "./token";

export type AcceptTeamInvitationInput = Readonly<{
    token: unknown;
    accountId: string;
}>;

export type JoinedTeamInvitation = Extract<TeamInvitationAcceptResultV1, { outcome: "joined" }>;

export class TeamInvitationAcceptanceAbort extends Error {
    readonly result: Exclude<TeamInvitationAcceptResultV1, JoinedTeamInvitation>;

    constructor(result: Exclude<TeamInvitationAcceptResultV1, JoinedTeamInvitation>) {
        super(`Team invitation acceptance aborted: ${result.outcome}`);
        this.name = "TeamInvitationAcceptanceAbort";
        this.result = result;
    }
}

/** Fresh-Account finalizers throw this typed result so `inTx` rolls every prior write back. */
export async function requireAcceptedTeamInvitationInTx(
    tx: Tx,
    input: AcceptTeamInvitationInput,
): Promise<JoinedTeamInvitation> {
    const result = await acceptTeamInvitationInTx(tx, input);
    if (result.outcome === "joined") return result;
    throw new TeamInvitationAcceptanceAbort(result);
}

/**
 * Accept one invitation and create the membership in a single transaction.
 *
 * The check order is deliberate and is itself a product contract:
 *
 * 1. an unusable bearer, an inactive Account, and an archived Team are answered
 *    before anything is consumed;
 * 2. an existing member is answered *before* the terminal checks, so a colleague who
 *    already belongs to the Team cannot burn a still-transferable link by opening it;
 * 3. only then does the conditional consume run, and the database decides the single
 *    winner among concurrent acceptances and revocations.
 *
 * The membership write happens after the consume in the same transaction, so a failed
 * admission rolls the acceptance back: there is never a consumed invitation without a
 * membership, nor a membership without a consumed invitation.
 *
 * The inviter's current role is deliberately not rechecked. Revocation and Team archive
 * are the explicit lifecycle controls; failing a valid link because the inviter changed
 * teams would be an undocumented dependency on an unrelated organizational change.
 */
export async function acceptTeamInvitationInTx(
    tx: Tx,
    input: AcceptTeamInvitationInput,
): Promise<TeamInvitationAcceptResultV1> {
    const tokenHash = tryDigestTeamInvitationToken(input.token);
    if (tokenHash === null) return { outcome: "not_found" };

    const invitation = await readTeamInvitationByTokenHashInTx(tx, tokenHash);
    if (invitation === null) return { outcome: "not_found" };

    return await acceptResolvedTeamInvitationInTx(tx, invitation, input);
}

/**
 * OAuth consumes only the server-side invitation id captured by its one-time
 * attempt. This reference is not accepted by any public route and cannot be
 * substituted for the original bearer.
 */
export async function acceptTeamInvitationAdmissionReferenceInTx(
    tx: Tx,
    input: Readonly<{
        invitationId: string;
        tokenHash: string;
        accountId: string;
    }>,
): Promise<TeamInvitationAcceptResultV1> {
    const invitation = await readTeamInvitationByIdInTx(tx, input.invitationId);
    if (invitation === null) return { outcome: "not_found" };
    if (!/^[0-9a-f]{64}$/u.test(input.tokenHash)
        || !Buffer.from(invitation.tokenHash).equals(Buffer.from(input.tokenHash, "hex"))) {
        return { outcome: "not_found" };
    }
    return await acceptResolvedTeamInvitationInTx(tx, invitation, input);
}

async function acceptResolvedTeamInvitationInTx(
    tx: Tx,
    invitation: TeamInvitationRecord,
    input: Readonly<{
        accountId: string;
    }>,
): Promise<TeamInvitationAcceptResultV1> {
    await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: invitation.teamId, accountIds: [input.accountId], affectedAccountIds: [input.accountId], membershipChange: { kind: "teamMembership", teamId: invitation.teamId } });
    const account = await tx.account.findUnique({
        where: { id: input.accountId },
        select: { status: true },
    });
    if (!account || account.status !== AccountStatus.active) return { outcome: "account_inactive" };

    const team = await tx.team.findUnique({
        where: { id: invitation.teamId },
        select: { id: true, archivedAt: true, admissionMode: true },
    });
    if (!team) return { outcome: "not_found" };
    if (team.archivedAt !== null) return { outcome: "team_archived" };

    const existing = await tx.teamMembership.findUnique({
        where: { teamId_accountId: { teamId: invitation.teamId, accountId: input.accountId } },
        select: { id: true },
    });
    if (existing) return { outcome: "already_member", teamId: invitation.teamId };

    const now = await readTransactionDatabaseTime(tx);
    // Terminal invitation state remains truthful even if Team admission policy has
    // since changed. An authenticated caller can recover from a used/revoked/expired
    // link only when that durable fact is not collapsed into the active-policy
    // refusal below. Existing members still return above without burning a fresh
    // transferable link.
    if (invitation.acceptedAt !== null) return { outcome: "used" };
    if (invitation.revokedAt !== null) return { outcome: "revoked" };
    if (invitation.expiresAt.getTime() <= now.getTime()) return { outcome: "expired" };

    // An active invitation is evidence only for the invite-only admission mode.
    // Policy changes are authoritative at acceptance time: an old bearer cannot
    // become a bypass around current provisioned/JIT evidence, and refusal happens
    // before consume so it remains usable if the Team deliberately switches back.
    if (team.admissionMode !== "invite_only") return { outcome: "not_found" };

    const invitationMailbox = invitation.recipientEmailNormalized === null
        ? null
        : normalizeVerifiedEmail(invitation.recipientEmailNormalized);
    if (invitation.recipientEmailNormalized !== null && invitationMailbox === null) {
        return { outcome: "email_mismatch" };
    }

    // The conditional consume is the race winner. Everything above is a courteous
    // early answer; only this decides that *this* request owns the invitation.
    const consumed = await consumeTeamInvitationForAcceptanceInTx(tx, {
        invitationId: invitation.id,
        acceptedByAccountId: input.accountId,
        now,
    });
    if (!consumed) {
        // Another acceptance, a revocation, or expiry won between the reads and here.
        // Re-read once so the caller gets the real terminal reason rather than a guess.
        const current = await readTeamInvitationByIdInTx(tx, invitation.id);
        if (current === null) return { outcome: "not_found" };
        if (current.acceptedAt !== null) return { outcome: "used" };
        if (current.revokedAt !== null) return { outcome: "revoked" };
        return { outcome: "expired" };
    }

    // Possession of an email-bound invitation's one-time bearer is the approved
    // proof for attaching that exact invited mailbox to the Account chosen at
    // acceptance. Attach the evidence only after this transaction wins the
    // conditional consume: a losing concurrent actor must not acquire mailbox
    // evidence, and any later admission failure rolls both facts back together.
    if (invitationMailbox !== null) {
        await upsertVerifiedMailboxEvidenceInTx(tx, {
            accountId: input.accountId,
            email: invitationMailbox,
        });
    }

    const admitted = await admitTeamMemberInTx(tx, {
        teamId: invitation.teamId,
        accountId: input.accountId,
        role: invitation.role,
        historyAccess: invitation.role === "guest" ? "from_membership" : invitation.historyAccess,
    });
    if (!admitted.ok) {
        if (admitted.error === "team_member_limit_reached") {
            throw new TeamInvitationAcceptanceAbort({ outcome: admitted.error });
        }
        if (admitted.error === "team_seats_required") {
            throw new TeamInvitationAcceptanceAbort({ outcome: admitted.error, details: admitted.details });
        }
        if (admitted.error === "teams_unavailable") {
            // Feature withdrawal is intentionally opaque at this bearer boundary.
            // The typed abort rolls the consume/mailbox writes back and lets every
            // enclosing auth finalizer use its existing no-admission response.
            throw new TeamInvitationAcceptanceAbort({ outcome: "not_found" });
        }
        // Throwing rolls the consume back with the admission. Returning a soft failure
        // here would leave a burnt invitation and no membership, which is the one state
        // this transaction exists to make impossible.
        throw new Error(`Team invitation admission failed: ${admitted.error}`);
    }

    // The joiner's Team list and every existing member's roster just changed. The
    // canonical Team publisher owns that audience and defers its wake to after this
    // transaction commits, so a rolled-back acceptance wakes nobody. The new member
    // is already in the audience: their membership row exists in this transaction.
    await publishTeamChangedInTx(tx, { teamId: invitation.teamId });

    return { outcome: "joined", teamId: invitation.teamId };
}
