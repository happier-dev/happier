import type { Tx } from "@/storage/inTx";
import { readCollectiveSessionGrantIdsForAccountInTx } from "./sessionAccessMembershipImpact";
import type { AccountAdmissionIntent } from "@/app/encryption/accountSessionOwnerMetadataFence";
import {
    resolveStructuralSessionAccessForSessionsInTx,
    type EffectiveSessionAccess,
} from "./sessionAccess";
import { acquireSessionAccessTransitionCursorLocksInTx, applySessionAccessTransitionEffectsInTx } from "./sessionAccessTransitionEffects";

const captured = Symbol("Session access Account-status impact");

/**
 * Transaction-local structural access before an Account lifecycle mutation.
 *
 * The opaque capture prevents a caller from manufacturing a before-state or
 * applying it in another transaction. Account lifecycle remains the status
 * writer; this owner alone selects affected Sessions and evaluates access.
 */
export interface SessionAccessAccountStatusImpact {
    readonly [captured]: {
        readonly tx: Tx;
        readonly accountId: string;
        readonly sessions: ReadonlyMap<string, EffectiveSessionAccess | null>;
    };
}

export interface SessionAccessAccountStatusEffects {
    readonly changedSessionIds: readonly string[];
    readonly grantedSessionIds: readonly string[];
    readonly revokedSessionIds: readonly string[];
}

/**
 * Capture every Session whose effective access can depend on one Account's
 * status. Selection intentionally follows retained relationship rows rather
 * than current eligibility: an inactive-to-active transition must discover the
 * same owner, direct, Team, and Group paths that an active-to-inactive
 * transition removes. The canonical structural evaluator decides whether each
 * candidate actually had access.
 */
async function resolveAccountStatusAffectedSessionIdsInTx(tx: Tx, accountId: string): Promise<string[]> {
    const [owned, shares, collective] = await Promise.all([
        tx.session.findMany({ where: { accountId }, select: { id: true } }),
        tx.sessionGrant.findMany({ where: { principalKind: 'account', accountId: accountId }, select: { sessionId: true } }),
        readCollectiveSessionGrantIdsForAccountInTx(tx, accountId),
    ]);
    return [...new Set([...owned.map(session => session.id), ...shares.map(share => share.sessionId), ...collective])].sort();
}

/** Lock the status transition's Session audience before actor/target Account fences. */
export async function acquireSessionAccountStatusCursorLocksInTx(
    tx: Tx,
    input: Readonly<{ accountId: string; additionalAccountIds: readonly string[]; intent?: AccountAdmissionIntent;
        additionalSessionIds?: readonly string[]; includeLifecyclePublications?: boolean }>,
): Promise<void> {
    await acquireSessionAccessTransitionCursorLocksInTx(tx,
        [...await resolveAccountStatusAffectedSessionIdsInTx(tx, input.accountId), ...(input.additionalSessionIds ?? [])],
        [input.accountId, ...input.additionalAccountIds], {
            intent: input.intent, includeLifecyclePublications: input.includeLifecyclePublications,
        });
}

export async function captureSessionAccessAccountStatusImpactInTx(
    tx: Tx,
    input: Readonly<{ accountId: string }>,
): Promise<SessionAccessAccountStatusImpact> {
    const sessionIds = await resolveAccountStatusAffectedSessionIdsInTx(tx, input.accountId);
    const access = await resolveStructuralSessionAccessForSessionsInTx(tx, {
        sessionIds,
        accountIds: [input.accountId],
    });
    return {
        [captured]: {
            tx,
            accountId: input.accountId,
            sessions: new Map(sessionIds.map(sessionId => [
                sessionId,
                access.get(sessionId)?.get(input.accountId) ?? null,
            ])),
        },
    };
}

/**
 * Apply the canonical Session access transition effects after the Account
 * status writer has mutated the row in the same transaction.
 *
 * Reactivation publishes real access gains but does not create a new
 * relationship: drafts, personal Follow, unsafe Session-to-Session Follow
 * edges, and responsibility removed on loss are deliberately not resurrected.
 */
export async function applySessionAccessAccountStatusImpactInTx(
    tx: Tx,
    input: Readonly<{ impact: SessionAccessAccountStatusImpact }>,
): Promise<SessionAccessAccountStatusEffects> {
    const impact = input.impact[captured];
    if (impact.tx !== tx) {
        throw new Error("Account-status Session access impact must be applied in its capture transaction");
    }
    const sessionIds = [...impact.sessions.keys()];
    const afterAccess = await resolveStructuralSessionAccessForSessionsInTx(tx, {
        sessionIds,
        accountIds: [impact.accountId],
    });
    const changedSessionIds: string[] = [];
    const grantedSessionIds: string[] = [];
    const revokedSessionIds: string[] = [];
    for (const sessionId of sessionIds) {
        const before = new Map([[impact.accountId, impact.sessions.get(sessionId) ?? null]]);
        const after = new Map([[
            impact.accountId,
            afterAccess.get(sessionId)?.get(impact.accountId) ?? null,
        ]]);
        const effects = await applySessionAccessTransitionEffectsInTx(tx, {
            sessionId,
            before,
            after,
        });
        if (effects.changedAccountIds.includes(impact.accountId)) changedSessionIds.push(sessionId);
        if (effects.grantedAccountIds.includes(impact.accountId)) grantedSessionIds.push(sessionId);
        if (effects.revokedAccountIds.includes(impact.accountId)) revokedSessionIds.push(sessionId);
    }
    return { changedSessionIds, grantedSessionIds, revokedSessionIds };
}
