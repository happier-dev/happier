import { afterTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { notifySessionHumanPresenceAccessChanged } from "@/app/session/humanPresence/sessionHumanPresenceService";
import { markAccountsChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import { acquireSessionAccountCursorLocksInTx, type SessionAccountCursorLockOptions } from "@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx";
import { tombstoneSessionDraftForLifecycleInTx } from "@/app/account/sessionDrafts/sessionDraftService";
import { removeAccountSessionFollowsOnAccessLossInTx } from "@/app/session/follow/accountFollowService";
import { removeUnsafeSessionFollowEdgesForAccessChangeInTx } from "@/app/session/follow/sessionFollowEdgeService";
import { removeUnsafeSessionManagerEdgesForAccessChangeInTx } from "@/app/session/follow/sessionManagerService";
import { hasSessionFollowSessionSource } from '@/app/session/follow/sessionFollowSourceIdentity';
import { projectSessionEffectiveAccessV1, type EffectiveSessionAccess } from "./sessionAccess";
import { clearSessionResponsibilityIfNoReadAccessInTx } from "./sessionResponsibilityService";
import { SESSION_METADATA_PRIVACY_UPGRADE_SOURCE_WHERE } from "../metadata/sessionMetadataRecipientProjection";

export interface SessionAccessTransitionEffects {
    readonly changedAccountIds: readonly string[];
    readonly grantedAccountIds: readonly string[];
    readonly revokedAccountIds: readonly string[];
    readonly accountCursors: ReadonlyMap<string, AccountChangePublication>;
}

function readTranscript(access: EffectiveSessionAccess | null): boolean {
    return access?.capabilities.readTranscript === true;
}

function accessFingerprint(access: EffectiveSessionAccess | null): string {
    if (!access) return "none";
    const capabilities = Object.entries(access.capabilities)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([capability, allowed]) => `${capability}=${allowed ? 1 : 0}`)
        .join(",");
    return `${access.level}|${capabilities}`;
}

export async function resolveAccessTransitionProjectionSessionIdsInTx(tx: Tx, sessionIds: readonly string[]): Promise<string[]> {
    const ids = [...new Set(sessionIds)];
    if (ids.length === 0) return [];
    const [followEdges, managerEdges] = await Promise.all([
        tx.sessionFollowEdge.findMany({ where: { OR: [{ sourceSessionId: { in: ids } }, { destinationSessionId: { in: ids } }] },
            select: { destinationSessionId: true } }),
        tx.sessionFollowEdge.findMany({ where: { relation: 'manager', OR: [{ sourceSessionId: { in: ids } }, { destinationSessionId: { in: ids } }] },
            select: { sourceSessionId: true, destinationSessionId: true } }),
    ]);
    return [...new Set([...ids, ...followEdges.map(edge => edge.destinationSessionId),
        ...managerEdges.filter(hasSessionFollowSessionSource).flatMap(edge => [edge.sourceSessionId, edge.destinationSessionId])])];
}

/** Fence access cleanup's complete relation audience before native or grant writes. */
export async function acquireSessionAccessTransitionCursorLocksInTx(
    tx: Tx,
    sessionIds: readonly string[],
    additionalAccountIds: readonly string[] = [],
    options?: SessionAccountCursorLockOptions,
): Promise<void> {
    const projectionSessionIds = await resolveAccessTransitionProjectionSessionIdsInTx(tx, sessionIds);
    await acquireSessionAccountCursorLocksInTx(tx, projectionSessionIds, additionalAccountIds, options);
    const captured = new Set(projectionSessionIds);
    const current = await resolveAccessTransitionProjectionSessionIdsInTx(tx, sessionIds);
    if (current.some(sessionId => !captured.has(sessionId))) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
}

/** Shared effective-access lifecycle effects for grant and native membership mutations. */
export async function applySessionAccessTransitionEffectsInTx(
    tx: Tx,
    params: Readonly<{
        sessionId: string;
        before: ReadonlyMap<string, EffectiveSessionAccess | null>;
        after: ReadonlyMap<string, EffectiveSessionAccess | null>;
        /** A changed direct projection needs refresh even when stronger access survives. */
        directGrantChangedAccountId?: string;
        /** Accounts receiving a later roster projection in this same transition. */
        additionalPublicationAccountIds?: readonly string[];
    }>,
): Promise<SessionAccessTransitionEffects> {
    const changedAccountIds: string[] = [];
    const grantedAccountIds: string[] = [];
    const revokedAccountIds: string[] = [];
    const accountCursors = new Map<string, AccountChangePublication>();
    let anyEffectiveAccessChanged = false;
    // Presence qualifies each socket against the source that grants it, so a
    // source change can revoke one credential's view while the structural
    // level/capabilities stay equal (Direct View removed, restricted Team View
    // left). Any real projection change therefore rechecks the room.
    let anyAccessProjectionChanged = false;

    for (const [accountId, beforeAccess] of params.before) {
        const afterAccess = params.after.get(accountId) ?? null;
        const effectiveAccessChanged =
            accessFingerprint(beforeAccess) !== accessFingerprint(afterAccess);
        // A weaker Group grant may disappear while stronger Direct authority
        // survives. Refresh the ordinary projection so its old context cannot
        // outlive that membership.
        const projectionChanged = JSON.stringify(beforeAccess ? projectSessionEffectiveAccessV1(beforeAccess) : null)
            !== JSON.stringify(afterAccess ? projectSessionEffectiveAccessV1(afterAccess) : null);
        if (!projectionChanged && accountId !== params.directGrantChangedAccountId) continue;
        if (effectiveAccessChanged) anyEffectiveAccessChanged = true;
        if (projectionChanged) anyAccessProjectionChanged = true;

        changedAccountIds.push(accountId);
        if (!readTranscript(beforeAccess) && readTranscript(afterAccess)) {
            grantedAccountIds.push(accountId);
        }
        if (readTranscript(beforeAccess) && !readTranscript(afterAccess)) {
            revokedAccountIds.push(accountId);
        }
    }

    await acquireSessionAccessTransitionCursorLocksInTx(tx, [params.sessionId],
        [...changedAccountIds, ...(params.additionalPublicationAccountIds ?? [])]);
    if (grantedAccountIds.length > 0) {
        // Membership and Account-status transitions can grow a Session's audience
        // without changing its owner's own access projection. The owner holds the
        // work this creates: a retained layout-0 upgrade, or recipient keys for an
        // E2EE Session. The wake names no recipient; the audience census decides.
        // The existing Session audience fence already includes that owner.
        const candidate = await tx.session.findFirst({
            where: { id: params.sessionId, OR: [SESSION_METADATA_PRIVACY_UPGRADE_SOURCE_WHERE, { encryptionMode: "e2ee" }] },
            select: { accountId: true },
        });
        if (candidate && grantedAccountIds.some(accountId => accountId !== candidate.accountId)
            && !params.additionalPublicationAccountIds?.includes(candidate.accountId)) {
            for (const publication of await markAccountsChanged(tx, {
                accountIds: [candidate.accountId], kind: "share", entityId: params.sessionId,
            })) accountCursors.set(publication.accountId, publication);
        }
    }
    // Only final read-access loss retires the person's own draft; Edit-to-View
    // keeps it. Draft and Session cursors share the complete transition fence.
    for (const accountId of revokedAccountIds) await tombstoneSessionDraftForLifecycleInTx(tx, { accountId, sessionId: params.sessionId });
    for (const publication of await markAccountsChanged(tx, { accountIds: changedAccountIds, kind: "session", entityId: params.sessionId })) {
        accountCursors.set(publication.accountId, publication);
    }

    if (revokedAccountIds.length > 0) {
        await removeAccountSessionFollowsOnAccessLossInTx(tx, {
            sessionId: params.sessionId,
            accountIds: revokedAccountIds,
        });
    }

    // A changed Session may be either side of a Follow edge. Re-evaluate the
    // complete pair after the mutation: source-access loss by any destination
    // audience member and destination-audience broadening are both unsafe,
    // while an atomic audience contraction that leaves the final pair safe is
    // retained. The Follow service delegates this to Lane 04's one pair owner.
    if (anyEffectiveAccessChanged) {
        await removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx, {
            sessionId: params.sessionId,
        });
        await removeUnsafeSessionManagerEdgesForAccessChangeInTx(tx, { sessionId: params.sessionId });
    }

    // Responsibility is a workflow fact layered on current access, so this one
    // transaction also maintains its invariant. The helper re-evaluates every
    // remaining source itself: losing one overlapping grant keeps the assignment,
    // and only a final loss of read access clears it.
    if (revokedAccountIds.length > 0) {
        await clearSessionResponsibilityIfNoReadAccessInTx({ tx, sessionId: params.sessionId });
    }
    if (anyAccessProjectionChanged) {
        // Presence rechecks the whole room itself, so only the Session identity is
        // meaningful at this seam.
        afterTx(tx, () => notifySessionHumanPresenceAccessChanged({ sessionId: params.sessionId }));
    }

    return { changedAccountIds, grantedAccountIds, revokedAccountIds, accountCursors };
}
