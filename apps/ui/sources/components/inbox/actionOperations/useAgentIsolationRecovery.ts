import * as React from 'react';
import { MachineAgentIsolationPreviewResultV1Schema, readMachineAgentIsolationPolicyV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';
import { actionOperationStore, isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';

/** An isolation change whose own effect restarted the daemon before it could confirm the result. */
export function isAgentIsolationOutcomeUnknown(operation: QualifiedActionOperation | null | undefined): boolean {
    return operation?.snapshot.actionId === 'machines.agentIsolation.set'
        && !isActionOperationTerminal(operation.snapshot.state)
        && operation.snapshot.observation?.kind === 'outcome_uncertain';
}

/** What the surface can say before the CHECK's result arrives through the operation store. */
export type AgentIsolationRecoveryCheckState = 'checking' | 'unavailable';

export type AgentIsolationRecoveryCheck = Readonly<{
    state: AgentIsolationRecoveryCheckState;
    /** Runs the same CHECK now (a changed review asks for it); true when it published the current effects. */
    recheck: () => Promise<boolean>;
}>;

/** Only a visible unknown isolation surface owns this finite read. Reconnect
 * supersedes its pending CHECK; history, clocks and heartbeats are not demand.
 * The answer itself lands on the operation; `state` only says whether the read is in flight or could not run. */
export function useAgentIsolationRecovery(operation: QualifiedActionOperation | null): AgentIsolationRecoveryCheck {
    const serverId = operation?.serverId;
    const operationId = operation?.snapshot.operationId;
    const machineId = operation?.snapshot.scope.machineId;
    const accountId = operation?.snapshot.scope.accountId;
    const unknown = isAgentIsolationOutcomeUnknown(operation);
    const [state, setState] = React.useState<AgentIsolationRecoveryCheckState>('checking');
    const checkNowRef = React.useRef<() => Promise<boolean>>(async () => false);
    const recheck = React.useCallback(() => checkNowRef.current(), []);
    React.useEffect(() => {
        setState('checking');
        if (!unknown || !serverId || !operationId || !machineId || !accountId) return;
        const execute = createFrontDoorActionExecute();
        let disposed = false, recoveryQueued = false;
        let controller: AbortController | undefined;
        const check = async (): Promise<boolean> => {
            if (disposed) return false;
            controller?.abort();
            const current = new AbortController();
            controller = current;
            const machine = resolveServerScopedMachine(storage.getState(), serverId, machineId);
            const policy = readMachineAgentIsolationPolicyV1(machine?.metadata);
            if (!machine || machine.revokedAt || machine.availability?.kind === 'locked' || policy.status !== 'ready') {
                setState('unavailable');
                return false;
            }
            setState('checking');
            try {
                const result = await execute('machines.agentIsolation.preview', { serverId, machineId, enabled: policy.policy.enabled }, {
                    surface: 'ui', serverId, expectedAccountId: accountId, signal: current.signal,
                });
                if (disposed || current.signal.aborted) return false;
                const preview = result.ok ? MachineAgentIsolationPreviewResultV1Schema.safeParse(result.result) : null;
                if (preview?.success) {
                    actionOperationStore.reobserveMachineAgentIsolation({ serverId, accountId, machineId, operationId,
                        recovery: { enabled: policy.policy.enabled, preview: preview.data } });
                    return true;
                }
                setState('unavailable');
            } catch {
                // No timer or automatic replay: the next reconnect/person intent can recover.
                if (!disposed && !current.signal.aborted) setState('unavailable');
            }
            return false;
        };
        const release = subscribeMachineRpcRecovery({ serverId, machineId, expectedAccountId: accountId }, () => {
            if (disposed || recoveryQueued) return;
            recoveryQueued = true;
            controller?.abort();
            void Promise.resolve().then(() => { recoveryQueued = false; return check(); });
        });
        checkNowRef.current = check;
        void check();
        return () => { disposed = true; controller?.abort(); release(); };
    }, [unknown, serverId, operationId, machineId, accountId]);
    return { state, recheck };
}
