import type { ScmBackendRegistry } from '@/scm/registry';
import { isAdministrativeWorkspacePathWithSourceController } from '@/scm/sourceController/workspacePortability';
import { detectWorkspacePathTraits } from '@/scm/sourceController/workspaceExportPackaging/detectWorkspacePathTraits';

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
    return entries.some((entry) => isAdministrativeWorkspacePathWithSourceController({
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
        && isAdministrativeWorkspacePathWithSourceController({
            relativePath,
            registry,
        });
}
