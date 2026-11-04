import type { Metadata } from '@happier-dev/session-core/state';
import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { normalizeLocalPathForComparison, resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';

export type SessionBranchObservation = Readonly<{
    machineId: string;
    path: string;
    rootPath: string;
    branch: Readonly<{ head: string | null; detached: boolean }>;
}>;

export function applyObservedSessionBranch(metadata: Metadata, observation: SessionBranchObservation): Metadata {
    if (metadata.machineId !== observation.machineId || typeof metadata.path !== 'string') return metadata;
    const workspace = resolveSessionWorkspaceRootForMachine({
        metadata, machineId: observation.machineId, candidatePath: metadata.path,
    });
    const machinePath = resolveAbsolutePath(workspace.machinePath, metadata.homeDir);
    if (normalizeLocalPathForComparison(machinePath) !== normalizeLocalPathForComparison(observation.path)
        || resolvePathRelativeToRoot({ path: observation.path, root: observation.rootPath }) === null) return metadata;
    const branch = observation.branch.detached === true
        ? null
        : typeof observation.branch.head === 'string' && observation.branch.head.trim()
            ? observation.branch.head
            : undefined;
    return branch === undefined || metadata.branch === branch ? metadata : { ...metadata, branch };
}
