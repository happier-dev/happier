import { resolveSessionWorkspaceRootForMachine, type SessionRepositoryV1 } from '@happier-dev/protocol';
import { inspectGitRepositoryIdentity } from '@/scm/backends/git/checkoutIdentity';
import { logger } from '@/ui/logger';

/** Refresh only from this runner's local cwd; keep the exact execution path intact. */
export async function enrichSessionMetadataWithRepository(
    metadata: { path?: unknown; machineId?: unknown; sessionRepositoryV1?: unknown },
): Promise<void> {
    delete metadata.sessionRepositoryV1;
    if (typeof metadata.path !== 'string' || !metadata.path.trim()) return;
    if (typeof metadata.machineId !== 'string' || !metadata.machineId.trim()) return;
    if (resolveSessionWorkspaceRootForMachine({
        metadata, machineId: metadata.machineId, candidatePath: metadata.path,
    }).machinePath !== metadata.path) return;
    try {
        const identity = await inspectGitRepositoryIdentity({ cwd: metadata.path });
        if (identity) metadata.sessionRepositoryV1 = { v: 1, machineId: metadata.machineId, ...identity } satisfies SessionRepositoryV1;
    } catch (error) {
        logger.infoFile('[sessionRepository] Local repository inspection unavailable', {
            path: metadata.path,
            error: error instanceof Error ? error.message : String(error),
        });
    }
}
