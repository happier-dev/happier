import * as React from 'react';
import { MachineAgentIsolationOwnStatusV1Schema, type MachineAgentIsolationOwnStatusV1 } from '@happier-dev/protocol/machines/agentIsolationV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachineField } from '@/sync/store/hooks';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { hasUnresolvedRequesterDirectories, isRequesterDirectoryLaunchPreparable } from '@/utils/sessions/machineDefaultDirectory';

/** Demand the existing requester read once per target/policy. No new native probe or polling. */
export function useMachineOwnIsolationStatus(input: Readonly<{
    machineId: string | null | undefined;
    machine: Machine | null | undefined;
    serverId?: string | null;
    enabled: boolean;
}>) {
    const serverId = resolveMachineDaemonReadServerId(input.serverId);
    const execution = useMountedActionExecution(serverId);
    const policy = useMachineField(input.machineId ?? '', 'metadata', 'agentIsolation', {
        serverId, enabled: input.enabled,
    });
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const key = JSON.stringify([execution.binding?.scope, execution.binding?.revision, input.machineId]);
    const [state, setState] = React.useState<Readonly<{
        key: string;
        status: MachineAgentIsolationOwnStatusV1 | null;
        loading: boolean;
        failed: boolean;
    }>>({ key, status: null, loading: false, failed: false });
    // Selection can resolve a prospective target before committing its directory.
    const readStatus = React.useCallback(async (machineId: string, signal?: AbortSignal): Promise<MachineAgentIsolationOwnStatusV1 | null> => {
        const result = await execution.execute('machines.agentIsolation.status', { machineId }, { signal });
        const parsed = result.ok ? MachineAgentIsolationOwnStatusV1Schema.safeParse(result.result) : null;
        return parsed?.success ? parsed.data : null;
    }, [execution.execute]);
    React.useEffect(() => {
        if (!input.enabled || !input.machineId || !execution.ready) return;
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && execution.isCurrent();
        setState({ key, status: null, loading: true, failed: false });
        void readStatus(input.machineId, controller.signal)
            .then(status => {
                if (!current()) return;
                setState({ key, status, loading: false, failed: status === null });
            }, () => {
                if (current()) setState({ key, status: null, loading: false, failed: true });
            });
        return () => controller.abort();
    }, [input.enabled, input.machineId, readStatus, execution.isCurrent, execution.ready, key, policy, attempt]);
    const current = input.enabled && execution.ready && state.key === key;
    return { status: current ? state.status : null, loading: input.enabled && (!current || state.loading),
        launchPreparable: current && isRequesterDirectoryLaunchPreparable(state.status),
        // A successful status read can still leave the requester's folders unavailable.
        failed: current && (state.failed || (state.status !== null
            && hasUnresolvedRequesterDirectories({ machine: input.machine, ownStatus: state.status }))), retry, readStatus };
}
