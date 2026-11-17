import type { NormalizedVerifiedEmail } from '@happier-dev/protocol/auth/verifiedEmail';
import type { TeamInvitationAdmissibleRoleV1, TeamInvitationEmailDeliveryV1 } from '@happier-dev/protocol/teams/invitation';
import type { AuthEmailDelivery } from "@/app/auth/email/authEmailDelivery";
import type { SessionHistoryAccess } from "@/storage/enums.generated";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { log } from "@/utils/logging/log";
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import { recordTeamInvitationEmailDeliveryResultInTx } from "./invitationLifecycle";

/**
 * The one internal hand-off of an email-bound invitation bearer.
 *
 * Lane 01 owns the invitation and its token; the mail boundary owns transport,
 * rendering, and abuse controls. This composes them and does nothing else: the
 * bearer travels from the create transaction straight to that boundary and is
 * never returned to the manager, logged, or retained.
 *
 * Delivery runs after the invitation has committed and outside any transaction,
 * so a slow or failing SMTP conversation can never hold a database transaction
 * open or roll a real invitation back.
 */

export type TeamInvitationEmailDeps = Readonly<{ delivery: AuthEmailDelivery }>;

export type DeliverTeamInvitationEmailInput = Readonly<{
    invitationId: string;
    /** The manager whose request minted this bearer; the mail names them. */
    inviterAccountId: string;
    recipient: NormalizedVerifiedEmail;
    /** Rendered once by the invitation transport; the renderer derives its QR from these exact bytes. */
    joinUrl: string;
    homeName: string;
    teamName: string;
    role: TeamInvitationAdmissibleRoleV1;
    historyAccess: SessionHistoryAccess;
    expiresAt: Date;
}>;

/**
 * Attempts delivery once and records the coarse result on the exact invitation.
 *
 * There is deliberately no retry, queue, or attempt ledger: retry is explicit
 * reissue, which mints a new bearer and invalidates the old one. Because the
 * result is addressed by invitation id, a slow delivery for a bearer that has
 * since been reissued updates only its own terminal row and can never mark the
 * replacement sent.
 *
 * A crash between submission and the result write leaves no recorded result,
 * which honestly means "unknown" rather than a false sent or unsent claim.
 */
export async function deliverTeamInvitationEmail(
    deps: TeamInvitationEmailDeps,
    input: DeliverTeamInvitationEmailInput,
): Promise<TeamInvitationEmailDeliveryV1 | null> {
    try {
        // The mail is delivered only to the invited mailbox, so naming the manager
        // who invited them discloses nothing to a stranger and is the message's
        // strongest phishing-resistance signal. The join preview states the same
        // label from the same owner, so the two never name the person differently.
        const inviter = await db.account.findUnique({
            where: { id: input.inviterAccountId },
            select: { name: true, username: true },
        });

        const result = await deps.delivery.deliver({
            kind: "invitation",
            to: input.recipient,
            joinUrl: input.joinUrl,
            homeName: input.homeName,
            teamName: input.teamName,
            inviterLabel: inviter ? resolveAccountDisplayLabelV1(inviter) : null,
            requestedRole: input.role,
            sharesSessionHistory: input.historyAccess === "all_existing",
            emailBound: true,
            expiresAt: input.expiresAt,
        });

        const attemptedAt = new Date();
        const status = result.status === "sent" ? "sent" : "failed";
        await inTx((tx) => recordTeamInvitationEmailDeliveryResultInTx(tx, {
            invitationId: input.invitationId,
            status,
            attemptedAt,
        }));
        return { status, attemptedAt: attemptedAt.getTime() };
    } catch {
        // The invitation already committed. Submission may have happened, so no
        // recorded result honestly means unknown; explicit reissue is recovery.
        log({ module: "teams", level: "warn" }, "Invitation committed without a recorded email delivery result");
        return null;
    }
}
