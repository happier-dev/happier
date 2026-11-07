import * as React from 'react';
import { DaemonTerminalListResponseV1Schema, type DaemonTerminalShellAvailabilityV1 } from '@happier-dev/protocol/daemon/terminal';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachineField } from '@/sync/store/hooks';

/** The terminal owner decides Shell availability once per presented target and Account/policy. */
export function useMachineShellAvailability(input: Readonly<{
    serverId: string;
    machineId: string | null | undefined;
    enabled: boolean;
}>) {
    const execution = useMountedActionExecution(input.serverId);
    const policy = useMachineField(input.machineId ?? '', 'metadata', 'agentIsolation', {
        serverId: input.serverId, enabled: input.enabled,
    });
    const key = JSON.stringify([execution.binding?.scope, execution.binding?.revision, input.machineId, policy]);
    const [state, setState] = React.useState<Readonly<{ key: string; availability: DaemonTerminalShellAvailabilityV1 | null }>>({ key, availability: null });
    React.useEffect(() => {
        if (!input.enabled || !input.machineId || !execution.ready) return;
        const controller = new AbortController();
        const current = () => !controller.signal.aborted && execution.isCurrent();
        void execution.execute('machines.terminal.list', { serverId: input.serverId, machineId: input.machineId, machineShell: true }, { signal: controller.signal })
            .then(result => {
                if (!current()) return;
                const parsed = result.ok ? DaemonTerminalListResponseV1Schema.safeParse(result.result) : null;
                setState({ key, availability: parsed?.success && parsed.data.ok ? parsed.data.machineShell ?? null : null });
            }, () => { if (current()) setState({ key, availability: null }); });
        return () => controller.abort();
    }, [input.enabled, input.machineId, input.serverId, execution.execute, execution.isCurrent, execution.ready, key]);
    return input.enabled && execution.ready && state.key === key ? state.availability : null;
}
