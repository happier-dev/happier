import * as React from 'react';
import { DaemonTerminalListResponseV1Schema, type DaemonTerminalShellAvailabilityV1 } from '@happier-dev/protocol/daemon/terminal';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useMachineField } from '@/sync/store/hooks';

export type MachineShellAvailabilityState = Readonly<{
    kind: 'loading' | 'available' | 'offline' | 'unsupported' | 'unavailable';
    cwd?: string;
}>;

export type MachineShellAvailability = Readonly<{
    availability: DaemonTerminalShellAvailabilityV1 | null;
    state: MachineShellAvailabilityState;
}>;

export function resolveMachineShellAvailabilityState(input: Readonly<{
    enabled: boolean;
    machineId: string | null | undefined;
    executionReady: boolean;
    reachability: 'reachable' | 'unreachable' | 'unknown';
    settled: boolean;
    unsupported: boolean;
    availability: DaemonTerminalShellAvailabilityV1 | null;
}>): MachineShellAvailabilityState {
    if (!input.enabled || !input.machineId) return { kind: 'loading' };
    if (input.reachability === 'unreachable') return { kind: 'offline' };
    if (!input.executionReady) return { kind: 'loading' };
    if (!input.settled) return { kind: 'loading' };
    if (input.availability?.ok === true) return { kind: 'available', cwd: input.availability.cwd };
    if (input.unsupported) return { kind: 'unsupported' };
    return { kind: 'unavailable' };
}

/** The terminal owner decides Shell availability once per presented target and Account/policy. */
export function useMachineShellAvailability(input: Readonly<{
    serverId: string;
    machineId: string | null | undefined;
    enabled: boolean;
}>) {
    const execution = useMountedActionExecution(input.serverId);
    const presence = useMachinePresenceSummary(input.serverId, input.machineId);
    const policy = useMachineField(input.machineId ?? '', 'metadata', 'agentIsolation', {
        serverId: input.serverId, enabled: input.enabled,
    });
    const key = JSON.stringify([execution.binding?.scope, execution.binding?.revision, input.machineId, policy]);
    const [state, setState] = React.useState<Readonly<{
        key: string;
        settled: boolean;
        unsupported: boolean;
        availability: DaemonTerminalShellAvailabilityV1 | null;
    }>>({ key, settled: false, unsupported: false, availability: null });
    React.useEffect(() => {
        if (!input.enabled || !input.machineId || !execution.ready) {
            setState({ key, settled: false, unsupported: false, availability: null });
            return;
        }
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && execution.isCurrent();
        void execution.execute('machines.terminal.list', { serverId: input.serverId, machineId: input.machineId, machineShell: true }, { signal: controller.signal })
            .then(result => {
                if (!current()) return;
                const parsed = result.ok ? DaemonTerminalListResponseV1Schema.safeParse(result.result) : null;
                if (!parsed?.success) {
                    setState({ key, settled: true, unsupported: false, availability: null });
                } else if (parsed.data.ok) {
                    setState({ key, settled: true, unsupported: parsed.data.machineShell == null, availability: parsed.data.machineShell ?? null });
                } else {
                    setState({ key, settled: true, unsupported: false, availability: parsed.data });
                }
            }, () => { if (current()) setState({ key, settled: true, unsupported: false, availability: null }); });
        return () => controller.abort();
    }, [input.enabled, input.machineId, input.serverId, execution.execute, execution.isCurrent, execution.ready, key]);
    const availability = input.enabled && execution.ready && state.key === key ? state.availability : null;
    return {
        availability,
        state: resolveMachineShellAvailabilityState({ enabled: input.enabled, machineId: input.machineId,
            executionReady: execution.ready, reachability: presence.reachability, settled: input.enabled && execution.ready && state.key === key && state.settled,
            unsupported: state.unsupported, availability }),
    } satisfies MachineShellAvailability;
}
