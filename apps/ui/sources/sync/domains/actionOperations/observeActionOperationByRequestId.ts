import type { ActionOperationListV2Request, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpc/errors';
import { getActionOperation, listActionOperations } from '@/sync/ops/actionOperations';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import { isMachineStoppedAnsweringError } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcTimeoutError';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { subscribeActionOperationByRequestId } from './subscribeActionOperationByRequestId';
import { isActionOperationTerminal } from './actionOperationStore';

/** Follow an issued request through publication/reconnect, then join its existing finite runner. */
export function observeActionOperationByRequestId(input: Readonly<{
    serverId: string;
    accountId: string;
    machineId: string;
    requestIdentity: NonNullable<ActionOperationListV2Request['requestIdentity']>;
    signal?: AbortSignal;
    /** Present owner progress while this same observer joins the terminal result. */
    onUpdate?: (operation: ActionOperationSnapshotV1) => void;
}>): Promise<ActionOperationSnapshotV1 | null> {
    return new Promise(resolve => {
        let finished = false;
        let reading = false;
        let changedWhileReading = false;
        let retained: ActionOperationSnapshotV1 | null = null;
        let retainedComplete = false;
        const readController = new AbortController();
        const releases: Array<() => void> = [];
        const matches = (operation: ActionOperationSnapshotV1) => operation.actionId === input.requestIdentity.actionId
            && operation.requestId === input.requestIdentity.requestId && operation.scope.accountId === input.accountId
            && operation.scope.machineId === input.machineId;
        const finish = (operation: ActionOperationSnapshotV1 | null) => {
            if (finished) return;
            finished = true;
            releases.splice(0).forEach(release => release());
            readController.abort();
            resolve(operation);
        };
        const read = async () => {
            if (finished) return;
            // Full reconciled records settle even failures without a result.
            // List summaries still need the owner read, including at the same revision.
            if (retained && retainedComplete && isActionOperationTerminal(retained.state)) {
                finish(retained);
                return;
            }
            if (reading) { changedWhileReading = true; return; }
            reading = true;
            try {
                if (!retained) {
                    const page = await listActionOperations({ ...input, signal: readController.signal,
                        request: { requestIdentity: input.requestIdentity } });
                    if (finished) return;
                    // A push may have located this request while the list was in flight.
                    retained ??= page.items.find(matches) ?? null;
                    if (retained) input.onUpdate?.(retained);
                    // A request-filtered response naming other work cannot establish this request's outcome.
                    if (!retained && page.items.length > 0) { finish(null); return; }
                }
                const selected = retained;
                if (!selected) return; // Publication or reconnect wakes this same observer; absence is not failure.
                const read = await getActionOperation({ ...input, signal: readController.signal,
                    operationId: selected.operationId, waitForTerminal: true });
                if (finished) return;
                if (read.kind === 'not_found') {
                    if (retained?.revision === selected.revision) { retained = null; retainedComplete = false; }
                    return;
                }
                if (!matches(read.operation) || read.operation.operationId !== selected.operationId) { finish(null); return; }
                if (read.operation.revision < (retained?.revision ?? selected.revision)) return;
                input.onUpdate?.(read.operation);
                finish(read.operation);
            } catch (error) {
                const code = readRpcErrorCode(error);
                // The existing connection owner supplies the wake; never replay the effect or start a timer.
                if (!isMachineRequestReachabilityFailure(error) && !isMachineStoppedAnsweringError(error)
                    && code !== 'MACHINE_RPC_UNREACHABLE' && code !== RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE
                    && code !== RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE) finish(null);
            } finally {
                reading = false;
                if (changedWhileReading) { changedWhileReading = false; void read(); }
            }
        };
        const abort = () => finish(null);
        input.signal?.addEventListener('abort', abort, { once: true });
        releases.push(() => input.signal?.removeEventListener('abort', abort));
        if (input.signal?.aborted) { finish(null); return; }
        const releaseObservation = subscribeActionOperationByRequestId({ ...input, requestId: input.requestIdentity.requestId,
            onUpdate: (operation, complete) => {
                if (!matches(operation)) return;
                retained = operation;
                retainedComplete = complete;
                input.onUpdate?.(operation);
                void read();
            } });
        // Subscription immediately publishes a retained result when one exists.
        if (finished) { releaseObservation(); return; }
        releases.push(releaseObservation);
        releases.push(subscribeMachineRpcRecovery({ ...input, expectedAccountId: input.accountId }, () => { void read(); }));
        void read();
    });
}
