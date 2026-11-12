import { portableQueryChunks } from "@/storage/portableQueryChunks";
import type { Tx } from "@/storage/inTx";
import { resolveStructuralSessionAccessForSessionsInTx, type EffectiveSessionAccess } from "./sessionAccess";
import { acquireSessionAccessTransitionCursorLocksInTx, applySessionAccessTransitionEffectsInTx, resolveAccessTransitionProjectionSessionIdsInTx } from "./sessionAccessTransitionEffects";
import { readSessionAccountCursorAudienceInTx } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";

export type SessionAccessMembershipChange =
    | Readonly<{ kind: "teamMembership" | "teamRole"; teamId: string }>
    | Readonly<{ kind: "teamGroupMembership"; teamId: string; teamGroupIds: readonly string[] }>;


const captured = Symbol("Session access membership impact");
/** Transaction-local before-state; never persisted or accepted from a client. */
export interface SessionAccessMembershipImpact {
    readonly [captured]: {
        tx: Tx;
        readonly accountId: string;
        readonly sessions: ReadonlyMap<string, EffectiveSessionAccess | null>;
    };
}


/** Seek the grant indexes first; correlated OR predicates on Session scan the Home. */
export async function readSessionAccessMembershipChangeSessionIdsInTx(
    tx: Tx, changes: readonly SessionAccessMembershipChange[],
): Promise<string[]> {
    const sessionIds = new Set<string>();
    for (const change of changes) {
        if (change.kind !== "teamGroupMembership") {
            const grants = await tx.sessionTeamGrant.findMany({ where: { teamId: change.teamId }, select: { sessionId: true } });
            for (const grant of grants) sessionIds.add(grant.sessionId);
        }
        if (change.kind === "teamRole") continue;
        const groups = await tx.teamGroup.findMany({ where: { teamId: change.teamId,
            ...(change.kind === "teamGroupMembership" ? { id: { in: [...change.teamGroupIds] } } : {}) }, select: { id: true } });
        if (groups.length === 0) continue;
        for (const ids of portableQueryChunks({ values: groups.map(group => group.id), bindingsPerValue: 1 })) {
            const grants = await tx.sessionGroupGrant.findMany({ where: { teamGroupId: { in: [...ids] } }, select: { sessionId: true } });
            for (const grant of grants) sessionIds.add(grant.sessionId);
        }
    }
    return [...sessionIds];
}

async function readAffectedSessionIdsInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
}>): Promise<string[]> {
    return input.accountIds.length === 0 ? [] : readSessionAccessMembershipChangeSessionIdsInTx(tx, input.changes);
}

/** Pure admission census before a Team writer takes actor or Team resource locks. */
export async function readSessionAccessMembershipChangeAudienceInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
    additionalAdmissionAccountIds?: readonly string[];
}>): Promise<Readonly<{ sessionIds: readonly string[]; accountIds: readonly string[] }>> {
    const affected = await readAffectedSessionIdsInTx(tx, input);
    const projectionSessionIds = await resolveAccessTransitionProjectionSessionIdsInTx(tx, affected);
    const audience = await readSessionAccountCursorAudienceInTx(tx, projectionSessionIds,
        [...input.accountIds, ...(input.additionalAdmissionAccountIds ?? [])]);
    return { sessionIds: audience.projectionSessionIds, accountIds: audience.accountIds };
}

/**
 * Capture before the native membership mutation destroys its old access facts.
 *
 * One Session query and one batched Account×Session access resolution serve the
 * whole affected set: a bulk Team or directory change must not degrade into a
 * per-Account, per-Session authorization loop inside the mutation transaction.
 */
export async function captureSessionAccessMembershipImpactsInTx(tx: Tx, input: Readonly<{
    accountIds: readonly string[];
    changes: readonly SessionAccessMembershipChange[];
}>): Promise<ReadonlyMap<string, SessionAccessMembershipImpact>> {
    const accountIds = [...new Set(input.accountIds)];
    const sessionIds = await readAffectedSessionIdsInTx(tx, { ...input, accountIds });
    // Native Team/Group mutations may publish their Team projection inside
    // mutate, so acquire Session owners and readers before that first write.
    await acquireSessionAccessTransitionCursorLocksInTx(tx, sessionIds, accountIds);
    const access = await resolveStructuralSessionAccessForSessionsInTx(tx, { sessionIds, accountIds });
    return new Map(accountIds.map(accountId => [accountId, {
        [captured]: {
            tx,
            accountId,
            sessions: new Map(sessionIds.map(sessionId => [sessionId, access.get(sessionId)?.get(accountId) ?? null])),
        },
    }]));
}

/**
 * Apply only actual effective changes, without changing the explicit grant roster.
 *
 * Every captured Account is reconciled together so each affected Session runs
 * one batched after-resolution and one transition-effects pass. Relationship
 * default rules evaluate later occurrences without enrolling personal follows.
 */
export async function applySessionAccessMembershipImpactsInTx(tx: Tx, input: Readonly<{
    impacts: Iterable<SessionAccessMembershipImpact>;
}>): Promise<void> {
    const beforeBySession = new Map<string, Map<string, EffectiveSessionAccess | null>>();
    const accountIds = new Set<string>();
    for (const wrapper of input.impacts) {
        const impact = wrapper[captured];
        if (impact.tx !== tx) throw new Error("Membership impact must be applied in its capture transaction");
        accountIds.add(impact.accountId);
        for (const [sessionId, beforeAccess] of impact.sessions) {
            const before = beforeBySession.get(sessionId) ?? new Map<string, EffectiveSessionAccess | null>();
            before.set(impact.accountId, beforeAccess);
            beforeBySession.set(sessionId, before);
        }
    }
    if (beforeBySession.size === 0) return;

    const sessionIds = [...beforeBySession.keys()];
    const afterAccess = await resolveStructuralSessionAccessForSessionsInTx(tx, {
        sessionIds,
        accountIds: [...accountIds],
    });
    for (const sessionId of sessionIds) {
        const before = beforeBySession.get(sessionId)!;
        const resolved = afterAccess.get(sessionId);
        const after = new Map([...before.keys()].map(accountId => [accountId, resolved?.get(accountId) ?? null]));
        await applySessionAccessTransitionEffectsInTx(tx, { sessionId, before, after });
    }
}
