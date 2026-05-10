import type { ScmBackendRegistry } from '../registry';
import { defaultScmBackendRegistry } from '../scmBackendCatalog';
import {
    createScmWorkspaceIntegrationPortableWorkspacePathRequest,
    resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath,
    type ScmWorkspaceIntegrationPortableWorkspacePathClassification,
} from './portableWorkspacePath';

import { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export async function assertPortableWorkspaceEntriesWithScmWorkspace(input: Readonly<{
    entries: readonly Readonly<{
        relativePath: string;
    }>[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    const registry = input.registry ?? defaultScmBackendRegistry;
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
}

export function isAdministrativeWorkspacePathWithScmWorkspace(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): boolean {
    for (const backend of (input.registry ?? defaultScmBackendRegistry).listBackends()) {
        if (backend.workspaceIntegration?.isAdministrativeWorkspacePath?.({
            relativePath: input.relativePath,
        }) === true) {
            return true;
        }
    }

    return false;
}

export function classifyPortableWorkspacePathWithScmWorkspace(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): ScmWorkspaceIntegrationPortableWorkspacePathClassification {
    const request = createScmWorkspaceIntegrationPortableWorkspacePathRequest({
        relativePath: input.relativePath,
    });
    for (const backend of (input.registry ?? defaultScmBackendRegistry).listBackends()) {
        const classification = backend.workspaceIntegration?.classifyPortableWorkspacePath?.(request);
        if (classification && classification !== 'unknown') {
            return classification;
        }
    }

    if (resolveScmWorkspaceIntegrationPortableWorkspacePathRelativePath(request).length === 0) {
        return 'unknown';
    }

    return 'unknown';
}
