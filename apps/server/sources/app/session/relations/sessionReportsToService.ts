import { inTx, type Tx } from '@/storage/inTx';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import type { SessionReportsToSetResultV1, SessionReportsToOptionsV1 } from '@happier-dev/protocol';
import { resolveEffectiveSessionAccess } from '@/app/session/access/sessionAccess';
import { evaluateCurrentSessionContextPairInTx, mayInjectSessionContextInTx } from '@/app/session/access/sessionContextInjection';
import { acquireSessionReportsToHomeFenceInTx } from './sessionReportsToFence';
import { invalidateSessionRelationProjectionsInTx } from './sessionRelationChanges';
import { readCurrentSourceSessionFollowFrontier, writeSessionFollowFrontierColumns } from './sessionEdgeFrontier';

export interface SessionReportsToSetInput {
    accountId: string;
    sessionId: string;
    leadSessionId: string | null;
    expectedLeadSessionId: string | null;
    authentication: SessionAccessAuthentication;
}
export type SessionReportsToSetResult = SessionReportsToSetResultV1;

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

const forbidden = (reason: 'read' | 'input' | 'pairwise'): SessionReportsToSetResult =>
    ({ ok: false, error: 'reports_to_forbidden', reason });

type ReportsToAdmission = Readonly<{ ok: true }> | Extract<SessionReportsToSetResult, { ok: false }>;

/** The same endpoint and pairwise owner serves read-only options and final mutation. */
async function readReportsToAdmissionInTx(tx: Tx, input: Omit<SessionReportsToSetInput, 'expectedLeadSessionId'>,
    existingLeadSessionId: string | null): Promise<ReportsToAdmission> {
    const account = await tx.account.findUnique({ where: { id: input.accountId }, select: { status: true } });
    if (account?.status !== 'active') return forbidden('read');
    const endpointIds = [...new Set([input.sessionId, ...(input.leadSessionId ? [input.leadSessionId]
        : existingLeadSessionId ? [existingLeadSessionId] : [])])];
    const access = await Promise.all(endpointIds.map((sessionId) => resolveEffectiveSessionAccess(tx, {
        accountId: input.accountId, sessionId, authentication: input.authentication,
    })));
    if (access.some((value) => value?.capabilities.readTranscript !== true)) return forbidden('read');
    if (access.some((value) => value?.capabilities.submitAgentInput !== true)) return forbidden('input');
    if (input.leadSessionId === input.sessionId) return { ok: false, error: 'reports_to_cycle' };
    if (input.leadSessionId !== null) {
        const pair = await mayInjectSessionContextInTx(tx, {
            configuringAccountId: input.accountId, sourceSessionId: input.sessionId,
            destinationSessionId: input.leadSessionId, authentication: input.authentication,
        });
        if (!pair.ok) return forbidden('pairwise');
    }
    return { ok: true };
}

async function reportsToWouldCycleInTx(tx: Tx, sessionId: string, leadSessionId: string): Promise<boolean> {
    const visited = new Set([sessionId]);
    let ancestor: string | null = leadSessionId;
    while (ancestor !== null) {
        if (visited.has(ancestor)) return true;
        visited.add(ancestor);
        const parent: { leadSessionId: string } | null = await tx.sessionReportsTo.findUnique({
            where: { sessionId: ancestor }, select: { leadSessionId: true },
        });
        ancestor = parent?.leadSessionId ?? null;
    }
    return false;
}

/** Reads only requested candidates; no grants, keys, runtime state or relation edges are written. */
export async function readSessionReportsToOptions(input: Readonly<{
    accountId: string; sessionId: string; candidateSessionIds: readonly string[]; authentication: SessionAccessAuthentication;
}>): Promise<SessionReportsToOptionsV1> {
    return inTx(async (tx) => {
        const sourceAccess = await resolveEffectiveSessionAccess(tx, input);
        const existing = sourceAccess?.capabilities.readTranscript === true
            ? await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId }, select: { leadSessionId: true } }) : null;
        const currentLeadSessionId = existing?.leadSessionId ?? null;
        const candidates: SessionReportsToOptionsV1['candidates'] = [];
        for (const sessionId of [...new Set(input.candidateSessionIds)]) {
            const admission = await readReportsToAdmissionInTx(tx, {
                accountId: input.accountId, sessionId: input.sessionId, leadSessionId: sessionId, authentication: input.authentication,
            }, currentLeadSessionId);
            if (!admission.ok) {
                candidates.push({ sessionId, allowed: false,
                    reason: admission.error === 'reports_to_forbidden' ? admission.reason : 'cycle' });
            } else if (await reportsToWouldCycleInTx(tx, input.sessionId, sessionId)) {
                candidates.push({ sessionId, allowed: false, reason: 'cycle' });
            } else {
                candidates.push({ sessionId, allowed: true });
            }
        }
        return { sessionId: input.sessionId, currentLeadSessionId, candidates };
    }, { readOnly: true });
}

async function mutateSessionReportsToInTx(tx: Tx, input: SessionReportsToSetInput, createdChild: boolean): Promise<SessionReportsToSetResult> {
    // Every existing-child mutation takes the Home fence before *any* read.
    if (!createdChild) await acquireSessionReportsToHomeFenceInTx(tx);
    const child = await tx.session.findUnique({ where: { id: input.sessionId }, select: SOURCE_SELECT });
    if (!child) return forbidden('read');
    const existing = await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId } });
    const admission = await readReportsToAdmissionInTx(tx, input, existing?.leadSessionId ?? null);
    if (!admission.ok) return admission;
    if ((existing?.leadSessionId ?? null) !== input.expectedLeadSessionId) return { ok: false, error: 'reports_to_cas_conflict' };
    if ((existing?.leadSessionId ?? null) === input.leadSessionId) {
        return { ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: existing?.attachedAt.getTime() ?? null };
    }
    if (!createdChild && input.leadSessionId !== null && await reportsToWouldCycleInTx(tx, input.sessionId, input.leadSessionId)) return { ok: false, error: 'reports_to_cycle' };
    // The Session's existing projection timestamp also separates detach/reattach
    // in one clock tick; no relation incarnation or historical tombstone is added.
    const changedAt = new Date(Math.max(Date.now(), child.updatedAt.getTime() + 1, (existing?.attachedAt.getTime() ?? -1) + 1));
    // Fresh creation publishes the row returned by its constructor. It has no
    // previous attachment to separate and must not make that publication stale.
    if (!createdChild) await tx.session.update({ where: { id: input.sessionId }, data: { updatedAt: changedAt } });
    if (input.leadSessionId === null) {
        await tx.sessionReportsTo.deleteMany({ where: { sessionId: input.sessionId } });
    } else {
        await tx.sessionReportsTo.upsert({
            where: { sessionId: input.sessionId },
            create: { sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: changedAt, ...seedCurrentState(child) },
            update: { leadSessionId: input.leadSessionId, attachedAt: changedAt, ...seedCurrentState(child) },
        });
    }
    await invalidateSessionRelationProjectionsInTx(tx, [input.sessionId,
        ...(existing ? [existing.leadSessionId] : []), ...(input.leadSessionId ? [input.leadSessionId] : [])]);
    return { ok: true, sessionId: input.sessionId, leadSessionId: input.leadSessionId, attachedAt: input.leadSessionId === null ? null : changedAt.getTime() };
}

export async function setSessionReportsToInTx(tx: Tx, input: SessionReportsToSetInput): Promise<SessionReportsToSetResult> {
    return mutateSessionReportsToInTx(tx, input, false);
}
export async function setSessionReportsTo(input: SessionReportsToSetInput): Promise<SessionReportsToSetResult> {
    return inTx((tx) => setSessionReportsToInTx(tx, input));
}
export async function attachCreatedSessionReportsToInTx(tx: Tx, input: Omit<SessionReportsToSetInput, 'expectedLeadSessionId'>): Promise<SessionReportsToSetResult> {
    return mutateSessionReportsToInTx(tx, { ...input, expectedLeadSessionId: null }, true);
}
export async function removeUnsafeSessionReportsToEdgesForAccessChangeInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<number> {
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true } });
    let removed = 0;
    const affected = new Set<string>();
    for (const edge of edges) {
        if ((await evaluateCurrentSessionContextPairInTx(tx, { sourceSessionId: edge.sessionId, destinationSessionId: edge.leadSessionId })).ok) continue;
        const deleted = await tx.sessionReportsTo.deleteMany({ where: edge });
        removed += deleted.count;
        if (deleted.count > 0) { affected.add(edge.sessionId); affected.add(edge.leadSessionId); }
    }
    await invalidateSessionRelationProjectionsInTx(tx, affected);
    return removed;
}

export async function applySessionArchiveTransitionToReportsToInTx(tx: Tx, input: Readonly<{ sessionId: string; wasArchived: boolean; isArchived: boolean }>): Promise<void> {
    if (input.wasArchived === input.isArchived) return;
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true, attachedAt: true } });
    for (const edge of edges) {
        if (input.isArchived) continue;
        const [child, lead] = await Promise.all([
            tx.session.findUnique({ where: { id: edge.sessionId }, select: SOURCE_SELECT }),
            tx.session.findUnique({ where: { id: edge.leadSessionId }, select: { archivedAt: true } }),
        ]);
        if (!child || !lead || child.archivedAt !== null || lead.archivedAt !== null) continue;
        await tx.sessionReportsTo.updateMany({ where: { sessionId: edge.sessionId, leadSessionId: edge.leadSessionId, attachedAt: edge.attachedAt }, data: seedCurrentState(child) });
    }
    await invalidateSessionRelationProjectionsInTx(tx, edges.flatMap((edge) => [edge.sessionId, edge.leadSessionId]));
}

export async function invalidateSessionReportsToForSourceChangeInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<void> {
    const parent = await tx.sessionReportsTo.findUnique({ where: { sessionId: input.sessionId }, select: { leadSessionId: true } });
    if (parent) await invalidateSessionRelationProjectionsInTx(tx, [parent.leadSessionId]);
}

export async function invalidateSessionReportsToForSessionDeleteInTx(tx: Tx, input: Readonly<{ sessionId: string }>): Promise<void> {
    const edges = await tx.sessionReportsTo.findMany({ where: { OR: [{ sessionId: input.sessionId }, { leadSessionId: input.sessionId }] },
        select: { sessionId: true, leadSessionId: true } });
    await invalidateSessionRelationProjectionsInTx(tx, edges.flatMap((edge) => [edge.sessionId, edge.leadSessionId]).filter((id) => id !== input.sessionId));
}
