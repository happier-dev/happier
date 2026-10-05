import type { RepositoryUploadPickInputV1, RepositoryUploadPickResultV1 } from '@happier-dev/protocol';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { normalizeWorkspaceScopeBase, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type RepositoryUploadTarget = Readonly<{
    scope: ServerAccountScope;
    workspaceScope: WorkspaceScopeBase;
    isCurrent: () => boolean;
    pick: (input: Readonly<{ kind: 'files' | 'folder'; destinationDir: string; signal?: AbortSignal }>) => Promise<RepositoryUploadPickResultV1>;
}>;

const targets: RepositoryUploadTarget[] = [];

export function registerRepositoryUploadTarget(target: RepositoryUploadTarget): () => void {
    targets.push(target);
    return () => {
        const index = targets.indexOf(target);
        if (index >= 0) targets.splice(index, 1);
    };
}

export async function invokeRepositoryUploadPick(input: RepositoryUploadPickInputV1, signal?: AbortSignal): Promise<RepositoryUploadPickResultV1> {
    if (signal?.aborted) return { status: 'cancelled' };
    const workspace = normalizeWorkspaceScopeBase(input.workspace);
    if (!workspace) return { status: 'unavailable' };
    for (let index = targets.length - 1; index >= 0; index -= 1) {
        const target = targets[index]!;
        if (!areServerAccountScopesEqual(target.scope, input.scope) || !target.isCurrent()) continue;
        const candidate = normalizeWorkspaceScopeBase(target.workspaceScope);
        if (!candidate || candidate.serverId !== workspace.serverId || candidate.machineId !== workspace.machineId
            || candidate.rootPath !== workspace.rootPath) continue;
        return target.pick({ kind: input.kind, destinationDir: input.destinationDir, ...(signal ? { signal } : {}) });
    }
    return { status: 'unavailable' };
}
