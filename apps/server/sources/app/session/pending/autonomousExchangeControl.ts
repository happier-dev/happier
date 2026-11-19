import { AutonomousExchangeStateV1Schema, applyAutonomousExchangeControlV1,
    readAutonomousExchangeAdmissionV1, type AutonomousExchangeControlRequestV1,
    type AutonomousExchangeStateV1 } from '@happier-dev/protocol/sessions/messages/autonomousExchangeV1';
import { isAutonomousExchangeRootReceiptForAccount } from '@/app/session/messages/readAutonomousExchangeSourceRoot';
import { pendingDeliveryStatusToPersistence } from './pendingDeliveryPersistence';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import { applyPendingSessionStateChange } from '@/app/session/pending/applyPendingSessionStateChange';
import { emitPendingChanged } from '@/app/session/pending/publishPendingMutation';
import { resolveSessionAccountChangePublications } from '@/app/session/changeTracking/markAccountChangesForSessionAccounts';
import { acquireSessionAccountCursorLocksInTx } from '@/app/session/changeTracking/acquireSessionAccountCursorLocksInTx';
import { db } from '@/storage/db';
import { inTx, transactionResult, TransactionReplayRequiredError } from '@/storage/inTx';

type ExchangeResult =
    | Readonly<{ ok: true; state: AutonomousExchangeStateV1; observedRevision: string }>
    | Readonly<{ ok: false; error: 'not-found' | 'forbidden' | 'conflict' }>;
type PendingPublication = Readonly<{
    sessionId: string;
    pendingCount: number;
    pendingBlockedCount: number;
    pendingVersion: number;
    recipientCursors: Awaited<ReturnType<typeof applyPendingSessionStateChange>>['recipientCursors'];
    recipient?: Readonly<{ kind: 'execution_run'; runId: string }>;
}>;

function revision(value: bigint): string {
    return `session-message-row-revision:v1:${value.toString(10)}`;
}

/** Read the Account-local root; inherited dependent rows are never control owners. */
export async function readAutonomousExchangeControl(params: Readonly<{
    actorUserId: string; sessionId: string; originInputLocalId: string;
}>): Promise<ExchangeResult> {
    const row = await db.sessionMessage.findUnique({
        where: { sessionId_localId: { sessionId: params.sessionId, localId: params.originInputLocalId } },
        select: { rowRevision: true, autonomousExchangeState: true, inputAdmissionReceipt: true,
            autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true,
            session: { select: { accountId: true, archivedAt: true } } },
    });
    if (!row) return { ok: false, error: 'not-found' };
    if (row.session.accountId !== params.actorUserId || row.session.archivedAt !== null) return { ok: false, error: 'forbidden' };
    const state = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(row.autonomousExchangeState);
    if (!isAutonomousExchangeRootReceiptForAccount(row.inputAdmissionReceipt, params.actorUserId, params.sessionId)
        || !state.success || row.autonomousExchangeRootSessionId !== null
            && (row.autonomousExchangeRootSessionId !== params.sessionId || row.autonomousExchangeRootLocalId !== params.originInputLocalId))
        return { ok: false, error: 'conflict' };
    return { ok: true, state: state.data, observedRevision: revision(row.rowRevision) };
}

/** CAS on the original input makes a retried control occurrence unable to grant a later window. */
export async function controlAutonomousExchange(params: Readonly<{
    actorUserId: string; sessionId: string; originInputLocalId: string;
    request: AutonomousExchangeControlRequestV1;
}>): Promise<ExchangeResult> {
    const outcome = await inTx(async tx => {
        const readRoot = () => tx.sessionMessage.findUnique({
            where: { sessionId_localId: { sessionId: params.sessionId, localId: params.originInputLocalId } },
            select: { id: true, rowRevision: true, autonomousExchangeState: true, inputAdmissionReceipt: true,
                autonomousExchangeRootSessionId: true, autonomousExchangeRootLocalId: true,
                session: { select: { accountId: true, archivedAt: true } } },
        });
        // Refuse an unrelated caller before discovering or locking dependents.
        // This fast rejection does not replace admission under the held locks.
        const discoveredRoot = await readRoot();
        if (!discoveredRoot) return { result: { ok: false, error: 'not-found' } as const, publications: [] };
        if (discoveredRoot.session.accountId !== params.actorUserId || discoveredRoot.session.archivedAt !== null)
            return { result: { ok: false, error: 'forbidden' } as const, publications: [] };
        const readUnstarted = () => tx.sessionPendingMessage.findMany({
            where: { autonomousExchangeRootSessionId: params.sessionId,
                autonomousExchangeRootLocalId: params.originInputLocalId,
                autonomousExchangeCause: 'agent_session',
                status: 'queued', OR: params.request.control === 'stop'
                    ? [{ deliveryState: null }, { deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in' }]
                    : [{ deliveryState: 'blocked', deliveryBlockedReason: 'autonomous_check_in' }] },
            select: { sessionId: true, localId: true, targetExecutionRunId: true,
                deliveryState: true },
        });
        const captured = await readUnstarted();
        const sessionIds = [...new Set([params.sessionId, ...captured.map(pending => pending.sessionId)])];
        // Root and dependent children share one resource-first admission, even
        // when the dependent input has no current Follow edge to its root.
        await acquireSessionAccountCursorLocksInTx(tx, sessionIds, [params.actorUserId]);
        // Discovery confers no control authority. Admit the root's lifecycle,
        // receipt and revision after the complete Session set is held.
        const row = await readRoot();
        if (!row) return { result: { ok: false, error: 'not-found' } as const, publications: [] };
        if (row.session.accountId !== params.actorUserId || row.session.archivedAt !== null)
            return { result: { ok: false, error: 'forbidden' } as const, publications: [] };
        const state = createStoredReadSchema(AutonomousExchangeStateV1Schema).safeParse(row.autonomousExchangeState);
        if (!isAutonomousExchangeRootReceiptForAccount(row.inputAdmissionReceipt, params.actorUserId, params.sessionId)
            || !state.success || row.autonomousExchangeRootSessionId !== null
                && (row.autonomousExchangeRootSessionId !== params.sessionId || row.autonomousExchangeRootLocalId !== params.originInputLocalId)
            || revision(row.rowRevision) !== params.request.observedRevision
            || state.data.stopped || params.request.control !== 'stop'
                && readAutonomousExchangeAdmissionV1(state.data) !== 'check_in') {
            return { result: { ok: false, error: 'conflict' } as const, publications: [] };
        }
        const unstarted = await readUnstarted();
        const admittedSessions = new Set(sessionIds);
        if (unstarted.some(pending => !admittedSessions.has(pending.sessionId))) {
            throw new TransactionReplayRequiredError('session-account-audience-changed');
        }

        const next = applyAutonomousExchangeControlV1(state.data, { kind: params.request.control });
        const updated = await tx.sessionMessage.updateMany({
            where: { id: row.id, rowRevision: row.rowRevision },
            data: { autonomousExchangeState: next, rowRevision: { increment: BigInt(1) } },
        });
        if (updated.count !== 1) return { result: { ok: false, error: 'conflict' } as const, publications: [] };

        const target = params.request.control === 'stop'
            ? pendingDeliveryStatusToPersistence({ status: 'discarded', reason: 'autonomous_exchange_stopped' })
            : pendingDeliveryStatusToPersistence({ status: 'queued' });
        for (const pending of unstarted) {
            await tx.sessionPendingMessage.update({
                where: { sessionId_localId: { sessionId: pending.sessionId, localId: pending.localId } },
                data: { ...target, ...(params.request.control === 'stop'
                    ? { discardedAt: new Date() }
                    : { providerAction: null }) },
            });
        }
        const bySession = new Map<string, { total: number; blocked: number }>();
        const byRun = new Map<string, { sessionId: string; runId: string }>();
        for (const pending of unstarted) {
            if (pending.targetExecutionRunId !== null) {
                byRun.set(JSON.stringify([pending.sessionId, pending.targetExecutionRunId]), {
                    sessionId: pending.sessionId, runId: pending.targetExecutionRunId });
                continue;
            }
            const counts = bySession.get(pending.sessionId) ?? { total: 0, blocked: 0 };
            bySession.set(pending.sessionId, { total: counts.total + 1,
                blocked: counts.blocked + (pending.deliveryState === 'blocked' ? 1 : 0) });
        }
        const publications: PendingPublication[] = [];
        for (const [sessionId, counts] of [...bySession].sort(([left], [right]) => left.localeCompare(right))) {
            const pendingState = await applyPendingSessionStateChange({ tx, sessionId,
                pendingBlockedCountDelta: -counts.blocked,
                ...(params.request.control === 'stop' ? { pendingCountDelta: -counts.total } : {}) });
            publications.push({ sessionId, ...pendingState });
        }
        for (const { sessionId, runId } of [...byRun.values()].sort((left, right) =>
            left.sessionId.localeCompare(right.sessionId) || left.runId.localeCompare(right.runId))) {
            const pendingState = await applyPendingSessionStateChange({ tx, sessionId });
            publications.push({ sessionId, ...pendingState,
                recipient: { kind: 'execution_run' as const, runId } });
        }
        return transactionResult(() => ({
            result: { ok: true, state: next,
                observedRevision: revision(row.rowRevision + BigInt(1)) } as const,
            publications: publications.map(publication => ({
                ...publication,
                recipientCursors: resolveSessionAccountChangePublications(publication.recipientCursors),
            })),
        }));
    }, { isolationLevel: 'ReadCommitted' });
    for (const publication of outcome.publications) {
        await emitPendingChanged({ sessionId: publication.sessionId, changedByAccountId: params.actorUserId,
            pendingCount: publication.pendingCount, pendingBlockedCount: publication.pendingBlockedCount,
            pendingVersion: publication.pendingVersion, recipientCursors: publication.recipientCursors,
            ...(publication.recipient ? { recipient: publication.recipient } : {}) });
    }
    return outcome.result;
}
