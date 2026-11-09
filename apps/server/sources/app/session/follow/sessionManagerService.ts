import { inTx, type Tx } from '@/storage/inTx';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { SessionManagerSetResultV1, SessionManagerOptionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { FollowPolicyV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { resolveEffectiveSessionAccess, resolveEffectiveSessionAccessForSessionsInTx, type EffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { evaluateCurrentSessionContextPairInTx, mayInjectSessionContextInTx, mayInjectSessionContextForDestinationsInTx } from '@/app/session/access/sessionContextInjection';
import { acquireSessionManagerHomeFenceInTx } from './sessionManagerFence';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { invalidateSessionRelationProjectionsInTx } from '../relations/sessionRelationChanges';
import { readCurrentSourceSessionFollowFrontier, writeSessionFollowFrontierColumns } from '../relations/sessionEdgeFrontier';
import { hasSessionFollowSessionSource, sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { readAccountFollowCreationPreferencesInTx } from './accountFollowCreationPreferences';

/** Reads the single current manager relation; membership grants no authority. */
export async function readSessionManagerInTx(tx: Tx, sessionId: string) {
    return tx.sessionFollowEdge.findUnique({ where: { managerSourceSessionId: sessionId, relation: 'manager' } });
}

export interface SessionManagerSetInput {
    accountId: string;
    sessionId: string;
    managerSessionId: string | null;
    expectedManagerSessionId: string | null;
    authentication: SessionAccessAuthentication;
}
export type SessionManagerSetResult = SessionManagerSetResultV1;

const SOURCE_SELECT = {
    id: true, updatedAt: true, archivedAt: true, seq: true, latestReadyEventSeq: true,
    agentStateVersion: true, latestTurnId: true, latestTurnStatus: true,
} as const;

function seedCurrentState(source: Parameters<typeof readCurrentSourceSessionFollowFrontier>[0]) {
    const current = readCurrentSourceSessionFollowFrontier(source);
    // No historical transcript. Leave the current state/terminal fact pending once.
    return writeSessionFollowFrontierColumns({
        ...current, readyEventSeq: Math.max(0, current.readyEventSeq - 1),
        agentStateVersion: Math.max(0, current.agentStateVersion - 1), turn: null,
    });
}

const forbidden = (reason: 'read' | 'input' | 'pairwise'): SessionManagerSetResult =>
    ({ ok: false, error: 'manager_forbidden', reason });

type ManagerAdmission = Readonly<{ ok: true }> | Extract<SessionManagerSetResult, { ok: false }>;

function evaluateManagerEndpointAdmission(accountActive: boolean, access: readonly (EffectiveSessionAccess | null | undefined)[],
    sessionId: string, managerSessionId: string | null): ManagerAdmission {
    if (!accountActive || access.some(value => value?.capabilities.readTranscript !== true)) return forbidden('read');
    if (access.some(value => value?.capabilities.submitAgentInput !== true)) return forbidden('input');
    if (managerSessionId === sessionId) return { ok: false, error: 'manager_cycle' };
    return { ok: true };
}

/** The same endpoint and pairwise owner serves read-only options and final mutation. */
async function readManagerAdmissionInTx(tx: Tx, input: Omit<SessionManagerSetInput, 'expectedManagerSessionId'>,
    existingManagerSessionId: string | null): Promise<ManagerAdmission> {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    if (account?.status !== 'active') return forbidden('read');
    const endpointIds = [...new Set([input.sessionId, ...(input.managerSessionId ? [input.managerSessionId]
        : existingManagerSessionId ? [existingManagerSessionId] : [])])];
    const access = await Promise.all(endpointIds.map((sessionId) => resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId, sessionId, authentication: input.authentication,
    })));
    const endpoints = evaluateManagerEndpointAdmission(true, access, input.sessionId, input.managerSessionId);
    if (!endpoints.ok) return endpoints;
    if (input.managerSessionId !== null) {
        const pair = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionId: input.sessionId,
            destinationSessionId: input.managerSessionId, authentication: input.authentication,
        });
        if (!pair.ok) return forbidden('pairwise');
    }
    return { ok: true };
}

/** Same endpoint and pairwise decisions as final mutation, with page-oriented loading. */
async function readManagerCandidateAdmissionsInTx(tx: Tx, input: Readonly<{
    accountId: string; sessionId: string; candidateSessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<ReadonlyMap<string, ManagerAdmission>> {
    const admissions = new Map<string, ManagerAdmission>();
    const candidateIds = [...new Set(input.candidateSessionIds)];
    if (candidateIds.length === 0) return admissions;
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    if (account?.status !== 'active') return new Map(candidateIds.map(id => [id, forbidden('read')]));
    const access = await resolveEffectiveSessionAccessForSessionsInTx(tx, {
        ...input, sessionIds: [input.sessionId, ...candidateIds],
    });
    const pairCandidates: string[] = [];
    for (const id of candidateIds) {
        const admission = evaluateManagerEndpointAdmission(true, [access.get(input.sessionId), access.get(id)], input.sessionId, id);
        admissions.set(id, admission);
        if (admission.ok) pairCandidates.push(id);
    }
    const pairs = await mayInjectSessionContextForDestinationsInTx(tx, {
        configuringAccountId: input.accountId, sourceSessionId: input.sessionId,
        destinationSessionIds: pairCandidates, authentication: input.authentication,
    });
    for (const id of pairCandidates) if (!pairs.get(id)?.ok) admissions.set(id, forbidden('pairwise'));
    return admissions;
}

async function managerWouldCycleInTx(tx: Tx, sessionId: string, managerSessionId: string): Promise<boolean> {
    return (await readManagerCyclesInTx(tx, sessionId, [managerSessionId])).has(managerSessionId);
}

/** Walk only candidate ancestry, sharing already-read ancestors across the page. */
async function readManagerCyclesInTx(tx: Tx, sessionId: string, managerSessionIds: readonly string[]): Promise<ReadonlySet<string>> {
    const parents = new Map<string, string | null>();
    let frontier = [...new Set(managerSessionIds)].filter(id => id !== sessionId);
    while (frontier.length > 0) {
        const edges = await tx.sessionFollowEdge.findMany({
            where: { relation: 'manager', sourceSessionId: { in: frontier } },
            select: { sourceSessionId: true, destinationSessionId: true },
        });
        for (const id of frontier) parents.set(id, null);
        for (const edge of edges.filter(hasSessionFollowSessionSource)) parents.set(edge.sourceSessionId, edge.destinationSessionId);
        frontier = [...new Set(edges.map(edge => edge.destinationSessionId))].filter(id => id !== sessionId && !parents.has(id));
    }
    const cycles = new Set<string>();
    for (const managerSessionId of managerSessionIds) {
        const visited = new Set([sessionId]);
        let ancestor: string | null = managerSessionId;
        while (ancestor !== null) {
            if (visited.has(ancestor)) { cycles.add(managerSessionId); break; }
            visited.add(ancestor);
            ancestor = parents.get(ancestor) ?? null;
        }
    }
    return cycles;
}

/** Reads only requested candidates; no grants, keys, runtime state or relation edges are written. */
export async function getSessionManagerOptions(input: Readonly<{
    accountId: string; sessionId: string; candidateSessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<SessionManagerOptionsV1> {
    return captureReadSnapshot<SessionManagerOptionsV1>(async (tx) => {
        const sourceAccess = await resolveEffectiveSessionAccess(tx, input);
        const existing = sourceAccess?.capabilities.readTranscript === true
            ? await readSessionManagerInTx(tx, input.sessionId) : null;
        const lead = existing ? await resolveEffectiveSessionAccess(tx, { ...input, sessionId: existing.destinationSessionId }) : null;
        const currentManagerSessionId = existing && lead?.capabilities.readTranscript === true ? existing.destinationSessionId : null;
        const admissions = await readManagerCandidateAdmissionsInTx(tx, input);
        const cycles = await readManagerCyclesInTx(tx, input.sessionId,
            [...admissions].filter(([, admission]) => admission.ok).map(([id]) => id));
        const candidates: SessionManagerOptionsV1['candidates'] = [];
        for (const sessionId of [...new Set(input.candidateSessionIds)]) {
            const admission = admissions.get(sessionId)!;
            if (!admission.ok) {
                candidates.push({ sessionId, allowed: false,
                    reason: admission.error === 'manager_forbidden' ? admission.reason : 'cycle' });
            } else if (cycles.has(sessionId)) {
                candidates.push({ sessionId, allowed: false, reason: 'cycle' });
            } else {
                candidates.push({ sessionId, allowed: true });
            }
        }
        return { sessionId: input.sessionId, currentManagerSessionId, candidates };
    });
}

async function mutateSessionManagerInTx(tx: Tx, input: SessionManagerSetInput, createdChild: boolean): Promise<SessionManagerSetResult> {
    // Every existing-child mutation takes the Home fence before *any* read.
    if (!createdChild) await acquireSessionManagerHomeFenceInTx(tx);
    await acquireSessionAccountCursorLocksInTx(tx, [input.sessionId,
        ...(input.expectedManagerSessionId ? [input.expectedManagerSessionId] : []),
        ...(input.managerSessionId ? [input.managerSessionId] : [])]);
    const child = await tx.session.findUnique({ where: { id: input.sessionId }, select: SOURCE_SELECT });
    if (!child) return forbidden('read');
    const existing = await readSessionManagerInTx(tx, input.sessionId);
    const admission = await readManagerAdmissionInTx(tx, input, existing?.destinationSessionId ?? null);
    if (!admission.ok) return admission;
    if ((existing?.destinationSessionId ?? null) !== input.expectedManagerSessionId) return { ok: false, error: 'manager_cas_conflict' };
    if ((existing?.destinationSessionId ?? null) === input.managerSessionId) {
        return existing
            ? { ok: true, sessionId: input.sessionId, managerSessionId: existing.destinationSessionId, attachedAt: existing.attachedAt.getTime() }
            : { ok: true, sessionId: input.sessionId, managerSessionId: null, attachedAt: null };
    }
    if (!createdChild && input.managerSessionId !== null && await managerWouldCycleInTx(tx, input.sessionId, input.managerSessionId)) return { ok: false, error: 'manager_cycle' };
    // The Session's existing projection timestamp also separates detach/reattach
    // in one clock tick; no relation incarnation or historical tombstone is added.
    const changedAt = new Date(Math.max(Date.now(), child.updatedAt.getTime() + 1, (existing?.attachedAt.getTime() ?? -1) + 1));
    // Fresh creation publishes the row returned by its constructor. It has no
    // previous attachment to separate and must not make that publication stale.
    if (!createdChild) await tx.session.update({ where: { id: input.sessionId }, data: { updatedAt: changedAt } });
    if (input.managerSessionId === null) {
        await tx.sessionFollowEdge.deleteMany({ where: { relation: 'manager', sourceSessionId: input.sessionId } });
    } else {
        const defaults = await readAccountFollowCreationPreferencesInTx(tx, input.accountId);
        const policyJson = JSON.stringify(FollowPolicyV1Schema.parse(defaults.managerPolicy));
        await tx.sessionFollowEdge.upsert({
            where: { managerSourceSessionId: input.sessionId },
            create: { relation: 'manager', sourceSessionId: input.sessionId, managerSourceSessionId: input.sessionId,
                sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: input.sessionId }),
                policyJson,
                destinationSessionId: input.managerSessionId, attachedAt: changedAt, ...seedCurrentState(child) },
            update: { destinationSessionId: input.managerSessionId, attachedAt: changedAt, policyJson, ...seedCurrentState(child) },
        });
    }
    await invalidateSessionRelationProjectionsInTx(tx, [input.sessionId,
        ...(existing ? [existing.destinationSessionId] : []), ...(input.managerSessionId ? [input.managerSessionId] : [])]);
    return input.managerSessionId === null
        ? { ok: true, sessionId: input.sessionId, managerSessionId: null, attachedAt: null }
        : { ok: true, sessionId: input.sessionId, managerSessionId: input.managerSessionId, attachedAt: changedAt.getTime() };
}

export async function setSessionManagerInTx(tx: Tx, input: SessionManagerSetInput): Promise<SessionManagerSetResult> {
    return mutateSessionManagerInTx(tx, input, false);
}
export async function setSessionManager(input: SessionManagerSetInput): Promise<SessionManagerSetResult> {
    // The Home graph fence and ordered Account audience fence precede admission;
    // a queued Account publisher must not invalidate a Serializable snapshot.
    return inTx((tx) => setSessionManagerInTx(tx, input));
}
export async function attachCreatedSessionManagerInTx(tx: Tx, input: Omit<SessionManagerSetInput, 'expectedManagerSessionId'>): Promise<SessionManagerSetResult> {
    return mutateSessionManagerInTx(tx, { ...input, expectedManagerSessionId: null }, true);
}
export async function removeUnsafeSessionManagerEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<number> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { relation: 'manager', OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }] },
        select: { sourceSessionId: true, destinationSessionId: true } });
    let removed = 0;
    const affected = new Set<string>();
    for (const edge of edges.filter(hasSessionFollowSessionSource)) {
        if ((await evaluateCurrentSessionContextPairInTx(tx, edge)).ok) continue;
        const deleted = await tx.sessionFollowEdge.deleteMany({ where: { ...edge, relation: 'manager' } });
        removed += deleted.count;
        if (deleted.count > 0) { affected.add(edge.sourceSessionId); affected.add(edge.destinationSessionId); }
    }
    await invalidateSessionRelationProjectionsInTx(tx, affected);
    return removed;
}

export async function applySessionArchiveTransitionToManagerInTx(tx: Tx, input: Readonly<{ sessionId: string; wasArchived: boolean; isArchived: boolean }>): Promise<void> {
    if (input.wasArchived === input.isArchived) return;
    const edges = await tx.sessionFollowEdge.findMany({ where: { relation: 'manager', OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }] },
        select: { sourceSessionId: true, destinationSessionId: true, attachedAt: true } });
    for (const edge of edges.filter(hasSessionFollowSessionSource)) {
        if (input.isArchived) continue;
        const [child, lead] = await Promise.all([
            tx.session.findUnique({ where: { id: edge.sourceSessionId }, select: SOURCE_SELECT }),
            tx.session.findUnique({ where: { id: edge.destinationSessionId }, select: { archivedAt: true } }),
        ]);
        if (!child || !lead || child.archivedAt !== null || lead.archivedAt !== null) continue;
        await tx.sessionFollowEdge.updateMany({ where: { relation: 'manager', sourceSessionId: edge.sourceSessionId,
            destinationSessionId: edge.destinationSessionId, attachedAt: edge.attachedAt }, data: seedCurrentState(child) });
    }
    await invalidateSessionRelationProjectionsInTx(tx, edges.filter(hasSessionFollowSessionSource).flatMap((edge) => [edge.sourceSessionId, edge.destinationSessionId]));
}

export async function invalidateSessionManagerForSessionDeleteInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<void> {
    const edges = await tx.sessionFollowEdge.findMany({ where: { relation: 'manager', OR: [{ sourceSessionId: input.sessionId }, { destinationSessionId: input.sessionId }] },
        select: { sourceSessionId: true, destinationSessionId: true } });
    await invalidateSessionRelationProjectionsInTx(tx, edges.filter(hasSessionFollowSessionSource).flatMap((edge) => [edge.sourceSessionId, edge.destinationSessionId]).filter((id) => id !== input.sessionId));
}
