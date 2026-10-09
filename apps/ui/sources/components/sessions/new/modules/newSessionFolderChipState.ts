import type { AgentInputFolderChipState } from '@/components/sessions/agentInput/definitions/AgentInputFolderChip';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';

/**
 * The new-session composer's folder chip, from the directory-intent owner and the machine's
 * availability. A folder intent without a path yet is still resolving (never "no folder"); an
 * unavailable machine keeps showing the current value, with the machine's reason.
 */
export function resolveNewSessionFolderChipState(params: Readonly<{
    directoryKind: 'path' | 'managed';
    /** The effective folder (`''` while none is resolved, or with no folder). */
    selectedPath: string;
    machineHomeDir?: string | null;
    /** The machine's own reason when it cannot start a session now, else null. */
    machineUnavailableReason: string | null;
}>): AgentInputFolderChipState {
    const path = formatSessionPath(params.selectedPath.trim(), params.machineHomeDir ?? undefined);
    if (params.machineUnavailableReason !== null) {
        return {
            kind: 'machine_unavailable',
            label: params.directoryKind === 'managed' || !path ? { kind: 'none' } : { kind: 'folder', path },
            reason: params.machineUnavailableReason,
        };
    }
    if (params.directoryKind === 'managed') return { kind: 'none' };
    return path ? { kind: 'folder', path } : { kind: 'resolving', lastKnownPath: null };
}
