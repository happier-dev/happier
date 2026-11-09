import type {
    PluginCollectionHostReferenceAdapter,
    PluginCollectionHostReferenceResolution,
} from "@/app/plugins/data/collections/hostReferences";
import {
    resolveSessionAccessDecisionsForSessionsInTx,
    resolveSessionAccessForOperation,
    resolveStructuralSessionAccess,
    type SessionAccessOperationDecision,
} from "@/app/session/access/sessionAccess";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { Tx } from "@/storage/inTx";

const AVAILABLE = Object.freeze({ status: "available" as const });
const TOMBSTONE = Object.freeze({ status: "tombstone" as const });
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });
const AUTHENTICATION_REQUIRED = Object.freeze({ status: "authentication_required" as const });
const AUTHENTICATION_UNAVAILABLE = Object.freeze({ status: "authentication_unavailable" as const });

export type AuthenticatedSessionHostReferenceResolution =
    | PluginCollectionHostReferenceResolution
    | typeof AUTHENTICATION_REQUIRED
    | typeof AUTHENTICATION_UNAVAILABLE;

/** Exact-credential Session availability for request-bound access witnesses. */
export async function resolveSessionHostReferenceForAuthenticationInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    targetId: string;
    authentication: SessionAccessAuthentication;
}>): Promise<AuthenticatedSessionHostReferenceResolution> {
    const decision = await resolveSessionAccessForOperation(input.tx, {
        accountId: input.accountId,
        sessionId: input.targetId,
        authentication: input.authentication,
        capability: "readTranscript",
    });
    const live = projectLiveSessionHostReference(decision);
    if (live) return live;

    const change = await input.tx.accountChange.findUnique({
        where: {
            accountId_kind_entityId: {
                accountId: input.accountId,
                kind: "session",
                entityId: input.targetId,
            },
        },
        select: { sessionId: true },
    });
    return change?.sessionId === null ? TOMBSTONE : UNAVAILABLE;
}

/**
 * The set-oriented sibling for one credential over many Sessions, such as an
 * Account change page's access witness. Access decisions come from the same
 * operation resolver over one batched projection read, and tombstones from one
 * Account-change read, instead of one of each per Session.
 */
export async function resolveSessionHostReferencesForAuthenticationInTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    targetIds: readonly string[];
    authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, AuthenticatedSessionHostReferenceResolution>> {
    const targetIds = [...new Set(input.targetIds)];
    const result = new Map<string, AuthenticatedSessionHostReferenceResolution>();
    if (targetIds.length === 0) return result;
    const decisions = await resolveSessionAccessDecisionsForSessionsInTx(input.tx, {
        accountId: input.accountId,
        sessionIds: targetIds,
        authentication: input.authentication,
        capability: "readTranscript",
    });
    const unresolved: string[] = [];
    for (const id of targetIds) {
        const decision = decisions.get(id);
        const live = decision ? projectLiveSessionHostReference(decision) : null;
        if (live) result.set(id, live);
        else unresolved.push(id);
    }
    if (unresolved.length === 0) return result;
    const changes = await input.tx.accountChange.findMany({
        where: { accountId: input.accountId, kind: "session", entityId: { in: unresolved } },
        select: { entityId: true, sessionId: true },
    });
    const tombstones = new Set(changes.filter(change => change.sessionId === null).map(change => change.entityId));
    for (const id of unresolved) result.set(id, tombstones.has(id) ? TOMBSTONE : UNAVAILABLE);
    return result;
}

function projectLiveSessionHostReference(
    decision: SessionAccessOperationDecision,
): AuthenticatedSessionHostReferenceResolution | null {
    if (decision.status === "allowed") return AVAILABLE;
    // Authentication failure is not evidence of structural revocation. Keep
    // it distinct for durable access witnesses; relation validation still
    // fails closed because neither result is `available`.
    if (decision.status === "authentication_required") return AUTHENTICATION_REQUIRED;
    if (decision.status === "authentication_unavailable") return AUTHENTICATION_UNAVAILABLE;
    return null;
}

/**
 * Canonical Account-authorized Session identity/availability adapter for Data.
 *
 * Live references use the Session access owner, including current collaborator
 * access and publication policy. A deleted Session resolves only through its
 * Account-scoped change row after the Session foreign key has been cleared.
 * Neither result grants Session mutation authority or exposes private rows.
 */
export const sessionPluginCollectionHostReferenceAdapter = {
    hostKind: "session",
    async resolveInTx({ tx, accountId, targetId }) {
        const access = await resolveStructuralSessionAccess(tx, { accountId, sessionId: targetId });
        if (access?.capabilities.readTranscript) return AVAILABLE;
        const change = await tx.accountChange.findUnique({
            where: { accountId_kind_entityId: { accountId, kind: "session", entityId: targetId } },
            select: { sessionId: true },
        });
        return change?.sessionId === null ? TOMBSTONE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter;

/**
 * Canonical Account-scoped Message identity adapter for Data. The Message
 * domain owns the Session join; a missing or other-Account row stays
 * unavailable so a Collection relation cannot become a Message oracle.
 */
export const messagePluginCollectionHostReferenceAdapter = {
    hostKind: "message",
    async resolveInTx({ tx, accountId, targetId }) {
        const message = await tx.sessionMessage.findFirst({
            where: {
                id: targetId,
                session: { is: { accountId } },
            },
            select: { id: true },
        });
        return message ? AVAILABLE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter;
