import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { scmUiBackendRegistry } from '@/scm/registry/scmUiBackendRegistry';

export type ScmRemoteSelection = {
    remote: string;
    branch: string | null;
};

export function inferRemoteTargetFromSnapshot(
    snapshot: ScmWorkingSnapshot | null | undefined
): ScmRemoteSelection {
    return scmUiBackendRegistry.getPluginForSnapshot(snapshot ?? null).inferRemoteTarget(snapshot ?? null);
}

export function resolvePublishRemoteFromSnapshot(snapshot: ScmWorkingSnapshot | null | undefined): string | null {
    const remotes = snapshot?.repo.remotes ?? [];
    if (remotes.length === 0) return null;
    const inferredRemote = inferRemoteTargetFromSnapshot(snapshot).remote.trim();
    if (inferredRemote && remotes.some((remote) => remote.name === inferredRemote)) {
        return inferredRemote;
    }
    const origin = remotes.find((remote) => remote.name === 'origin');
    return (origin ?? remotes[0])?.name ?? null;
}
