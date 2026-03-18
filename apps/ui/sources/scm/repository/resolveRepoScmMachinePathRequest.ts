import { storage } from '@/sync/domains/state/storage';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export function resolveRepoScmMachinePathRequest(input: Readonly<{
    machineId: string;
    path: string;
}>): Readonly<{
    machineId: string;
    resolvedPath: string;
    repoIdentityKey: string;
}> | null {
    const machineId = input.machineId.trim();
    const rawPath = input.path.trim();
    if (!machineId || !rawPath) {
        return null;
    }

    const state = storage.getState();
    const homeDir = state.machines?.[machineId]?.metadata?.homeDir;
    const resolvedPath = resolveAbsolutePath(rawPath, homeDir);
    return {
        machineId,
        resolvedPath,
        repoIdentityKey: `${machineId}:${resolvedPath}`,
    };
}
