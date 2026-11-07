import * as React from 'react';
import { DaemonTerminalListResponseV1Schema } from '@happier-dev/protocol/daemon/terminal';
import type { SessionTerminalWorkspaceV1 } from '@happier-dev/protocol/terminal/workspace';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { EMPTY_TERMINAL_WORKSPACE, reduceSessionTerminalWorkspace } from '@/components/sessions/terminal/sessionTerminalWorkspace';
import { resolveRunningProjectTerminalMember, type ProjectTerminalScope } from './projectTerminalScope';

export type ProjectRunningTerminalsState = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'unavailable';
    workspace: SessionTerminalWorkspaceV1;
}>;

/** An empty pane discovers existing processes; only an explicit selection restores a local record. */
export function useProjectRunningTerminals(scopeId: string, authority: ProjectTerminalScope | null, enabled: boolean): ProjectRunningTerminalsState {
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ authority: ProjectTerminalScope; state: ProjectRunningTerminalsState }> | null>(null);
    React.useEffect(() => {
        if (!enabled || !authority) { setSnapshot(null); return; }
        const controller = new AbortController();
        const retirement = authority.lifetime.onRetire(() => controller.abort());
        setSnapshot(null);
        void (async () => {
            let state: ProjectRunningTerminalsState = { status: 'unavailable', workspace: EMPTY_TERMINAL_WORKSPACE };
            try {
                // The Machine census includes every accepted checkout. The Project owner below
                // selects this Project's members, including sibling checkouts on this Machine.
                const result = await execute('machines.terminal.list', { serverId: authority.workspace.serverId,
                    machineId: authority.workspace.machineId }, {
                    surface: 'ui', authority: 'present_user', serverId: authority.workspace.serverId,
                    expectedAccountId: authority.scope.accountId, signal: controller.signal,
                });
                const listed = result.ok ? DaemonTerminalListResponseV1Schema.safeParse(result.result) : null;
                if (listed?.success && listed.data.ok) {
                    let workspace = EMPTY_TERMINAL_WORKSPACE;
                    for (const entry of listed.data.terminals) {
                        const terminal = resolveRunningProjectTerminalMember(scopeId, authority, entry);
                        if (terminal) workspace = reduceSessionTerminalWorkspace(workspace, { type: 'open', terminal });
                    }
                    state = { status: 'ready', workspace };
                }
            } catch {
                // Refused, unsupported and unreadable discovery all remain visibly unavailable.
            }
            if (!controller.signal.aborted && authority.lifetime.isCurrent()) setSnapshot({ authority, state });
        })();
        return () => { controller.abort(); retirement.dispose(); };
    }, [authority, enabled, execute, scopeId]);
    return enabled && snapshot?.authority === authority ? snapshot.state
        : { status: enabled && authority ? 'loading' : 'idle', workspace: EMPTY_TERMINAL_WORKSPACE };
}
