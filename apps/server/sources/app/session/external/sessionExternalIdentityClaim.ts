import type {
    SessionExternalIdentityClaimConflictV1,
    SessionExternalIdentityClaimResponseV1,
    SessionExternalIdentityTagV1,
} from "@happier-dev/protocol/sessions/control/contract";

import { resolveSessionAccessForOperation } from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { isPrismaUniqueConstraintError } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";

export type SessionExternalIdentityClaimResult =
    | Readonly<{ ok: true; externalIdentity: SessionExternalIdentityClaimResponseV1["externalIdentity"] }>
    | Readonly<{ ok: false; error: "conflict"; reason: SessionExternalIdentityClaimConflictV1["reason"] }>
    | Readonly<{ ok: false; error: "forbidden" | "session_access_authentication_required" | "session_access_authentication_unavailable" }>;

/**
 * Records "which external conversation this Session is".
 *
 * Admission: the Session owner, or the Session's own hosted runtime principal
 * (an ephemeral Session runner records the identity of the conversation it
 * hosts; the route's credential binding already pins it to this Session).
 *
 * Inside one transaction:
 * - the Session already records this identity → `already_claimed` (idempotent retry);
 * - another Session of the same Account holds the value as its recorded identity
 *   or as its immutable creation `tag` → conflict `taken` (never taken over);
 * - otherwise a conditional write from the identity this Session holds now
 *   (NULL → `claimed`; its own previous identity → `replaced`, after which the
 *   old identity no longer resolves to it, e.g. a new native thread or a handoff
 *   to another Machine); a lost race re-reads and classifies, and a unique-index
 *   violation from a concurrent claimant of the same Account is `taken`.
 *
 * No change-feed publication: no client consumes the column; the lookup route
 * reads it directly.
 */
export async function sessionExternalIdentityClaim(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    externalIdentityTag: SessionExternalIdentityTagV1;
    authentication: SessionAccessAuthentication;
}>): Promise<SessionExternalIdentityClaimResult> {
    try {
        return await inTx(async (tx) => {
            const decision = await resolveSessionAccessForOperation(tx, {
                accountId: params.actorUserId,
                sessionId: params.sessionId,
                authentication: params.authentication,
            });
            if (decision.status === "authentication_required") {
                return { ok: false, error: "session_access_authentication_required" } as const;
            }
            if (decision.status === "authentication_unavailable") {
                return { ok: false, error: "session_access_authentication_unavailable" } as const;
            }
            if (
                decision.status !== "allowed"
                || (decision.access.level !== "owner"
                    && params.authentication.sessionRuntimePrincipal?.sessionId !== params.sessionId)
            ) {
                return { ok: false, error: "forbidden" } as const;
            }
            return await claimInTx(tx, params.sessionId, params.externalIdentityTag);
        });
    } catch (error) {
        if (isPrismaUniqueConstraintError(error)) {
            return { ok: false, error: "conflict", reason: "taken" };
        }
        throw error;
    }
}

async function claimInTx(
    tx: Tx,
    sessionId: string,
    externalIdentityTag: string,
): Promise<SessionExternalIdentityClaimResult> {
    const current = await tx.session.findUnique({
        where: { id: sessionId },
        select: { accountId: true, externalIdentityTag: true },
    });
    if (!current) {
        return { ok: false, error: "forbidden" };
    }
    if (current.externalIdentityTag === externalIdentityTag) {
        return { ok: true, externalIdentity: "already_claimed" };
    }
    const holder = await tx.session.findFirst({
        where: {
            accountId: current.accountId,
            id: { not: sessionId },
            OR: [{ tag: externalIdentityTag }, { externalIdentityTag }],
        },
        select: { id: true },
    });
    if (holder) {
        return { ok: false, error: "conflict", reason: "taken" };
    }
    const written = await tx.session.updateMany({
        where: { id: sessionId, externalIdentityTag: current.externalIdentityTag },
        data: { externalIdentityTag },
    });
    if (written.count === 1) {
        return { ok: true, externalIdentity: current.externalIdentityTag === null ? "claimed" : "replaced" };
    }
    // A concurrent write by this Session changed the identity: equal is the same fact.
    const reread = await tx.session.findUnique({
        where: { id: sessionId },
        select: { externalIdentityTag: true },
    });
    return reread?.externalIdentityTag === externalIdentityTag
        ? { ok: true, externalIdentity: "already_claimed" }
        : { ok: false, error: "conflict", reason: "taken" };
}
