import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSpawnSessionRpcTimeoutMsFromEnv } from './spawnSessionRpcTimeout';
import { readSpawnAttemptCustodyState, type PersistedSpawnAttempt } from './spawnAttemptNonceStore';

export function buildManualSessionCreationKey(userAttemptId: string) {
    const normalized = userAttemptId.trim();
    if (!normalized) throw new Error('Manual Session user-attempt identity is unavailable');
    return SessionCreationKeyV1Schema.parse(`manual:${normalized}`);
}

/** Requester Actions retain the click id; direct spawn RPCs use their creation key. */
export function readManualSessionSpawnOperation(
    scope: ServerAccountScope,
    userAttemptId: string,
): ActionOperationSnapshotV1 | null {
    const state = actionOperationStore.getSnapshot();
    for (const requestId of [userAttemptId, buildManualSessionCreationKey(userAttemptId)]) {
        const operation = actionOperationSelectors.selectSnapshotByRequestId(state, requestId, scope.serverId, scope.accountId);
        if (operation?.actionId === 'session.spawn_new') return operation;
    }
    return null;
}

/** Settled list rows omit result bodies; inspect the same qualified operation before consuming one. */
export async function readManualSessionSpawnOperationDetails(
    scope: ServerAccountScope,
    operation: ActionOperationSnapshotV1,
    shouldContinue: () => boolean = () => true,
    options: Readonly<{ waitForTerminal?: true; signal?: AbortSignal }> = {},
): Promise<ActionOperationSnapshotV1 | null> {
    if (!shouldContinue()) return null;
    if (!options.waitForTerminal && (operation.state !== 'succeeded' && operation.state !== 'failed'
        || operation.result !== undefined)) return operation;
    const { getActionOperation } = await import('@/sync/ops/actionOperations');
    if (!shouldContinue()) return null;
    const response = await getActionOperation({
        serverId: scope.serverId, accountId: scope.accountId,
        machineId: operation.scope.machineId, operationId: operation.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true, timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv() } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.kind !== 'found'
        || response.operation.operationId !== operation.operationId
        || response.operation.actionId !== 'session.spawn_new'
        || response.operation.requestId !== operation.requestId
        || response.operation.scope.accountId !== scope.accountId
        || response.operation.scope.machineId !== operation.scope.machineId
        || response.operation.scope.sessionId !== operation.scope.sessionId
        || response.operation.revision < operation.revision
        || (options.waitForTerminal ? !['succeeded', 'failed', 'cancelled'].includes(response.operation.state)
            : response.operation.state !== 'succeeded' && response.operation.state !== 'failed')
        || response.operation.state === 'succeeded' && response.operation.result === undefined) {
        throw new Error('action_operation_result_unavailable');
    }
    // Requester reads and custodian pushes feed the same settlement authority.
    // Retiring a local observer cannot erase a received, qualified owner fact.
    actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [response.operation] });
    if (!shouldContinue()) return null;
    return response.operation;
}

/** Read the same local preparation result or join its admitted native operation. */
export async function awaitManualSessionSpawnOperation(
    scope: ServerAccountScope,
    userAttemptId: string,
    signal: AbortSignal,
    machineId: string,
): Promise<ActionOperationSnapshotV1 | NonNullable<PersistedSpawnAttempt['terminalResult']> | null> {
    if (signal.aborted) return null;
    const custody = readSpawnAttemptCustodyState(scope);
    const matching = custody.status === 'valid' ? Object.values(custody.attempts).filter(attempt =>
        attempt.userAttemptId === userAttemptId.trim() && attempt.machineId === machineId) : [];
    if (matching.length === 1 && matching[0]?.terminalResult) return matching[0].terminalResult;
    try {
        const { listActionOperations } = await import('@/sync/ops/actionOperations');
        const transport = { serverId: scope.serverId, accountId: scope.accountId, machineId, signal,
            timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv() };
        let operation = readManualSessionSpawnOperation(scope, userAttemptId);
        if (operation?.scope.machineId !== machineId) operation = null;
        for (const requestId of [userAttemptId, buildManualSessionCreationKey(userAttemptId)]) {
            if (operation || signal.aborted) break;
            const page = await listActionOperations({ ...transport,
                request: { requestIdentity: { actionId: 'session.spawn_new', requestId } } });
            operation = page.items.find(candidate => candidate.actionId === 'session.spawn_new'
                && candidate.scope.accountId === scope.accountId && candidate.scope.machineId === machineId
                && candidate.requestId === requestId) ?? null;
            if (operation) actionOperationStore.mergeSnapshots({ serverId: scope.serverId, snapshots: [operation] });
            if (signal.aborted) return null;
        }
        if (signal.aborted) return null;
        if (!operation) throw new Error('action_operation_result_unavailable');
        return await readManualSessionSpawnOperationDetails(scope, operation, () => !signal.aborted, { waitForTerminal: true, signal });
    } catch (error) {
        // Retiring this observation does not reject the daemon-owned operation.
        if (signal.aborted) return null;
        throw error;
    }
}
