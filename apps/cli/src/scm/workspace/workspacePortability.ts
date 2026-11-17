import type { ScmBackendRegistry } from '../registry';
import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import {
    createScmWorkspaceIntegrationPortableWorkspacePathRequest,
    type ScmWorkspaceIntegrationPortableWorkspacePathClassification,
} from './portableWorkspacePath';

import { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';
import { normalizeWorkspacePath } from './workspaceExportPackaging/normalizeWorkspacePath';

export async function assertPortableWorkspaceEntriesWithScmWorkspace(input: Readonly<{
    entries: readonly Readonly<{
        relativePath: string;
    }>[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    await runWithScmBackendRegistryLease(input.registry, async (registry) => {
        for (const backend of registry.listBackends()) {
            await backend.workspaceIntegration?.assertPortableWorkspaceEntries?.({
                entries: input.entries,
            });
        }

        for (const entry of input.entries) {
            if (classifyPortableWorkspacePathWithScmWorkspace({
                relativePath: entry.relativePath,
                registry,
            }) === 'non_portable') {
                throw buildNonPortableWorkspacePathError(entry.relativePath);
            }
        }
    });
}

export function isAdministrativeWorkspacePathWithScmWorkspace(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): boolean {
    if (!input.registry) return false;
    const segments = normalizeWorkspacePath(input.relativePath).split('/');
    const backends = input.registry.listBackends();
    for (let index = 0; index < segments.length; index++) {
        for (const backend of backends) {
            if (backend.workspaceIntegration?.isAdministrativeWorkspacePath?.({
                relativePath: segments.slice(index).join('/'),
            }) === true) {
                return true;
            }
        }
    }

    return false;
}

export async function resolveIsAdministrativeWorkspacePathWithScmWorkspace(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): Promise<boolean> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) =>
        isAdministrativeWorkspacePathWithScmWorkspace({
            relativePath: input.relativePath,
            registry,
        }));
}

export function classifyPortableWorkspacePathWithScmWorkspace(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): ScmWorkspaceIntegrationPortableWorkspacePathClassification {
    const request = createScmWorkspaceIntegrationPortableWorkspacePathRequest({
        relativePath: input.relativePath,
    });
    if (!input.registry) return 'unknown';
    for (const backend of input.registry.listBackends()) {
        const classification = backend.workspaceIntegration?.classifyPortableWorkspacePath?.(request);
        if (classification && classification !== 'unknown') {
            return classification;
        }
    }

    return 'unknown';
}
