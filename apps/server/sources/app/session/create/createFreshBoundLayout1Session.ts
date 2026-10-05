import type { Tx } from "@/storage/inTx";

import { ensureLayout1SessionCreateInvariantsInTx } from "./layout1SessionCreateInvariants";
import {
    applyRequestedSessionPlacementInTx,
    insertLayout1SessionRowInTx,
    isSessionCreationPlacementError,
    isSessionOwnerEnvelopeError,
    isSessionTeamCredentialBindingError,
    SessionInitialAccessError,
    SessionInitialTriggerAdmissionError,
    SessionCreationOriginError,
    SessionCreationReportsToError,
    type Layout1SessionCreateOutcome,
} from "./layout1SessionRowWrite";
import type {
    FreshBoundLayout1SessionCreateRejection,
    PreparedLayout1SessionCreate,
} from "./prepareLayout1SessionCreate";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";

/**
 * Classifies a throw from Layout-1 Session creation as a domain rejection.
 *
 * The constructors deliberately throw these so the caller's own transaction
 * rolls back with the Session row. Whether a given throw is a domain refusal or
 * an infrastructure failure is one question, so it is answered here rather than
 * re-answered by every wrapper: a wrapper that forgets turns a folder removed
 * between review and submit into an unexpected 500.
 */
export function classifyLayout1SessionCreateThrow(
    error: unknown,
): FreshBoundLayout1SessionCreateRejection | null {
    if (error instanceof SessionCreationOriginError) return { reason: "session-origin-forbidden" };
    if (error instanceof SessionCreationReportsToError) return { reason: "session-reports-to-invalid", result: error.result };
    if (isSessionCreationPlacementError(error)) return { reason: "invalid-organization-placement" };
    if (isSessionOwnerEnvelopeError(error)) return { reason: "invalid-params" };
    if (error instanceof SessionInitialAccessError) {
        return { reason: "session-initial-access-invalid", code: error.code };
    }
    if (error instanceof SessionInitialTriggerAdmissionError) {
        return { reason: "session-initial-trigger-invalid", code: error.code };
    }
    if (isSessionTeamCredentialBindingError(error)) {
        return { reason: "team-credential-binding-invalid", code: error.reason };
    }
    return null;
}

/**
 * Creates one ordinary Layout-1 Session at a reserved final identity.
 *
 * This entry exists for callers that allocated the Session identity before the
 * transaction and must bind that exact row — never a tag match belonging to an
 * unrelated Session. It shares every preparation and durable invariant with
 * `createOrRejoinLayout1SessionByTagInTx`; the difference is refusal instead of
 * rejoin, expressed as a separate entry rather than a mode flag.
 *
 * Like the ordinary entry, it throws `SessionCreationPlacementError` so an
 * invalid requested placement rolls back with the Session row. Callers compose
 * it inside their own transaction.
 */
export async function createFreshBoundLayout1SessionInTx(
    tx: Tx,
    params: Readonly<{
        prepared: PreparedLayout1SessionCreate;
        sessionId: string;
        authentication: SessionAccessAuthentication;
    }>,
): Promise<Exclude<Layout1SessionCreateOutcome<FreshBoundLayout1SessionCreateRejection>, { kind: "rejoined" }>> {
    const { prepared, sessionId } = params;
    const invariants = await ensureLayout1SessionCreateInvariantsInTx(tx, prepared);
    if (!invariants.ok) {
        return { kind: "rejected", rejection: invariants.rejection };
    }

    const reservedIdentityHolder = await tx.session.findUnique({
        where: { id: sessionId },
        select: { id: true },
    });
    if (reservedIdentityHolder) {
        return { kind: "rejected", rejection: { reason: "session-id-taken" } };
    }

    const tagHolder = await tx.session.findUnique({
        where: {
            accountId_tag: {
                accountId: prepared.accountId,
                tag: prepared.tag,
            },
        },
        select: { id: true },
    });
    if (tagHolder) {
        return { kind: "rejected", rejection: { reason: "session-tag-taken" } };
    }

    const created = await insertLayout1SessionRowInTx(tx, {
        prepared,
        effectiveEncryptionMode: invariants.effectiveEncryptionMode,
        ownerAccountMode: invariants.accountEncryptionMode,
        authentication: params.authentication,
        sessionId,
    });
    return {
        kind: "created",
        session: created,
        ownerAccountMode: invariants.accountEncryptionMode,
        organizationPlacement: await applyRequestedSessionPlacementInTx(tx, {
            prepared,
            sessionId: created.id,
        }),
    };
}
