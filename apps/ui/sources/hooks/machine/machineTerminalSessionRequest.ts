import type { DaemonTerminalEnsureRequest, DaemonTerminalLaunchIntent } from '@happier-dev/protocol';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export function buildMachineTerminalSessionRequest(input: Readonly<{
    terminalKey: string;
    cwd: string | null;
    cols?: number;
    rows?: number;
    launch?: DaemonTerminalLaunchIntent | null;
    initialCommand?: string;
    workspace?: WorkspaceAddressV1;
}>): DaemonTerminalEnsureRequest {
    const request = input.launch
        ? { terminalKey: input.terminalKey, cols: input.cols, rows: input.rows, launch: input.launch,
            ...(input.launch.kind === 'package_script' ? { cwd: input.cwd ?? undefined } : {}) }
        : { terminalKey: input.terminalKey, cwd: input.cwd ?? undefined, cols: input.cols, rows: input.rows, initialCommand: input.initialCommand };
    return { ...request, ...(input.workspace ? { workspace: input.workspace } : {}) };
}
