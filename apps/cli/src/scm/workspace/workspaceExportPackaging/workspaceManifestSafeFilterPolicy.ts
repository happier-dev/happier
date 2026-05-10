import type { ScmBackendRegistry } from '@/scm/registry';
import { isAdministrativeWorkspacePathWithScmWorkspace } from '@/scm/workspace/workspacePortability';
import { detectWorkspacePathTraits } from '@/scm/workspace/workspaceExportPackaging/detectWorkspacePathTraits';

export type WorkspaceManifestSafeFilterPolicy = Readonly<{
    excludeAdministrativePaths: boolean;
}>;

export const DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY: WorkspaceManifestSafeFilterPolicy = Object.freeze({
    excludeAdministrativePaths: true,
});

export function resolveWorkspaceManifestSafeFilterPolicy(policy?: WorkspaceManifestSafeFilterPolicy): WorkspaceManifestSafeFilterPolicy {
    return policy ?? DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY;
}

export function inferWorkspaceManifestSafeFilterPolicyFromEntries(entries: readonly Readonly<{
    relativePath: string;
}>[], registry?: ScmBackendRegistry): WorkspaceManifestSafeFilterPolicy {
    return entries.some((entry) => isAdministrativeWorkspacePathWithScmWorkspace({
        relativePath: entry.relativePath,
        registry,
    }))
        ? { excludeAdministrativePaths: false }
        : DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY;
}

export async function shouldFilterWorkspaceManifestPath(
    relativePath: string,
    policy: WorkspaceManifestSafeFilterPolicy,
    registry?: ScmBackendRegistry,
): Promise<boolean> {
    return policy.excludeAdministrativePaths
        && !detectWorkspacePathTraits(relativePath).isRoot
        && isAdministrativeWorkspacePathWithScmWorkspace({
            relativePath,
            registry,
        });
}
