import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveScmBackendRegistry } from '@/scm/scmBackendCatalog';
import {
    isAdministrativeWorkspacePathWithScmWorkspace,
    resolveIsAdministrativeWorkspacePathWithScmWorkspace,
} from '@/scm/workspace/workspacePortability';
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
    if (!registry) return DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY;
    return entries.some((entry) => isAdministrativeWorkspacePathWithScmWorkspace({
        relativePath: entry.relativePath,
        registry,
    }))
        ? { excludeAdministrativePaths: false }
        : DEFAULT_WORKSPACE_MANIFEST_SAFE_FILTER_POLICY;
}

export async function resolveWorkspaceManifestSafeFilterPolicyFromEntries(entries: readonly Readonly<{
    relativePath: string;
}>[], registry?: ScmBackendRegistry): Promise<WorkspaceManifestSafeFilterPolicy> {
    return inferWorkspaceManifestSafeFilterPolicyFromEntries(
        entries,
        await resolveScmBackendRegistry(registry),
    );
}

export async function shouldFilterWorkspaceManifestPath(
    relativePath: string,
    policy: WorkspaceManifestSafeFilterPolicy,
    registry?: ScmBackendRegistry,
): Promise<boolean> {
    return policy.excludeAdministrativePaths
        && !detectWorkspacePathTraits(relativePath).isRoot
        && await resolveIsAdministrativeWorkspacePathWithScmWorkspace({
            relativePath,
            registry,
        });
}
