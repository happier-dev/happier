import type { DaemonTerminalEnsureRequest, DaemonTerminalLaunchIntent } from '@happier-dev/protocol/daemon/terminal';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

export function buildMachineTerminalSessionRequest(input: Readonly<{
    terminalKey: string;
    cwd: string | null;
    cols?: number;
    rows?: number;
    launch?: DaemonTerminalLaunchIntent | null;
    workspace?: WorkspaceAddressV1;
}>): DaemonTerminalEnsureRequest {
    // This object also enters the signed Action envelope before JSON encoding.
    // Absent options must be omitted at their producer, not serialized as undefined.
    return {
        terminalKey: input.terminalKey,
        ...(input.cols === undefined ? {} : { cols: input.cols }),
        ...(input.rows === undefined ? {} : { rows: input.rows }),
        ...(input.cwd !== null && (!input.launch || input.launch.kind === 'package_script') ? { cwd: input.cwd } : {}),
        ...(input.launch ? { launch: input.launch } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
    };
}
