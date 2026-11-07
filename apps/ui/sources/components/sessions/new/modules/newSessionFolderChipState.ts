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
    /** Presentation only while the current folder resolves; never launch intent. */
    lastKnownPath?: string | null;
    machineHomeDir?: string | null;
    /** The machine's own reason when it cannot start a session now, else null. */
    machineUnavailableReason: string | null;
    /** The requester-directory owner's settled failure; the composer owns Retry. */
    directoryReadFailure?: string | null;
}>): AgentInputFolderChipState {
    const path = formatSessionPath(params.selectedPath.trim(), params.machineHomeDir ?? undefined);
    const lastKnownPath = formatSessionPath(params.lastKnownPath?.trim() ?? '', params.machineHomeDir ?? undefined);
    if (params.machineUnavailableReason !== null) {
        const displayedPath = path || lastKnownPath;
        return {
            kind: 'machine_unavailable',
            label: params.directoryKind === 'managed' || !displayedPath ? { kind: 'none' } : { kind: 'folder', path: displayedPath },
            reason: params.machineUnavailableReason,
        };
    }
    if (params.directoryKind === 'managed') return { kind: 'none' };
    if (!path && params.directoryReadFailure) return { kind: 'failed', reason: params.directoryReadFailure };
    return path ? { kind: 'folder', path } : { kind: 'resolving',
        lastKnownPath: lastKnownPath || null };
}
