import * as React from 'react';
import { DaemonTerminalListResponseV1Schema, type DaemonTerminalShellAvailabilityV1 } from '@happier-dev/protocol/daemon/terminal';
import { readUnexpectedActionErrorDiagnosticV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useMachineField } from '@/sync/store/hooks';

export type MachineShellAvailabilityState = Readonly<{
    kind: 'loading' | 'available' | 'offline' | 'unsupported' | 'needsManage' | 'unavailable';
    cwd?: string;
}>;

export type MachineShellAvailability = Readonly<{
    availability: DaemonTerminalShellAvailabilityV1 | null;
    failure: ActionExecuteFailure | null;
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
    failure: ActionExecuteFailure | null;
}>): MachineShellAvailabilityState {
    if (!input.enabled || !input.machineId) return { kind: 'loading' };
    if (input.reachability === 'unreachable') return { kind: 'offline' };
    if (!input.executionReady) return { kind: 'loading' };
    if (!input.settled) return { kind: 'loading' };
    if (input.availability?.ok === true) return { kind: 'available', cwd: input.availability.cwd };
    if (input.unsupported) return { kind: 'unsupported' };
    if (input.failure?.errorCode === 'machine_manage_required') return { kind: 'needsManage' };
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
        failure?: ActionExecuteFailure;
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
                if (!result.ok) {
                    setState({ key, settled: true, unsupported: false, availability: null, failure: result });
                    return;
                }
                const parsed = DaemonTerminalListResponseV1Schema.safeParse(result.result);
                if (!parsed.success) {
                    setState({ key, settled: true, unsupported: false, availability: null,
                        failure: { ok: false, errorCode: 'terminal_invalid_response', error: 'terminal_invalid_response' } });
                } else if (parsed.data.ok) {
                    setState({ key, settled: true, unsupported: parsed.data.machineShell == null, availability: parsed.data.machineShell ?? null });
                } else {
                    setState({ key, settled: true, unsupported: false, availability: parsed.data });
                }
            }, error => {
                if (!current()) return;
                const diagnostic = readUnexpectedActionErrorDiagnosticV1(error);
                const code = diagnostic.errorCode ?? 'action_failed';
                setState({ key, settled: true, unsupported: false, availability: null,
                    failure: { ok: false, errorCode: code, error: code, details: diagnostic } });
            });
        return () => controller.abort();
    }, [input.enabled, input.machineId, input.serverId, execution.execute, execution.isCurrent, execution.ready, key]);
    const availability = input.enabled && execution.ready && state.key === key ? state.availability : null;
    const failure = input.enabled && execution.ready && state.key === key
        ? state.failure ?? (availability?.ok === false ? availability : null) : null;
    return {
        availability,
        failure,
        state: resolveMachineShellAvailabilityState({ enabled: input.enabled, machineId: input.machineId,
            executionReady: execution.ready, reachability: presence.reachability, settled: input.enabled && execution.ready && state.key === key && state.settled,
            unsupported: state.unsupported, availability, failure }),
    } satisfies MachineShellAvailability;
}
