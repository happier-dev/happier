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
