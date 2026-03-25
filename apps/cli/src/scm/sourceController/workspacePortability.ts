import type { ScmBackendRegistry } from '../registry';
import { defaultScmBackendRegistry } from '../defaultRegistry';
import {
    createScmSourceControllerPortableWorkspacePathRequest,
    resolveScmSourceControllerPortableWorkspacePathRelativePath,
    type ScmSourceControllerPortableWorkspacePathClassification,
} from './portableWorkspacePath';

import { buildNonPortableWorkspacePathError } from './workspaceTransferErrors';

export async function assertPortableWorkspaceEntriesWithSourceController(input: Readonly<{
    entries: readonly Readonly<{
        relativePath: string;
    }>[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    const registry = input.registry ?? defaultScmBackendRegistry;
    for (const backend of registry.listBackends()) {
        await backend.sourceController?.assertPortableWorkspaceEntries?.({
            entries: input.entries,
        });
    }

    for (const entry of input.entries) {
        if (classifyPortableWorkspacePathWithSourceController({
            relativePath: entry.relativePath,
            registry,
        }) === 'non_portable') {
            throw buildNonPortableWorkspacePathError(entry.relativePath);
        }
    }
}

export function isAdministrativeWorkspacePathWithSourceController(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): boolean {
    for (const backend of (input.registry ?? defaultScmBackendRegistry).listBackends()) {
        if (backend.sourceController?.isAdministrativeWorkspacePath?.({
            relativePath: input.relativePath,
        }) === true) {
            return true;
        }
    }

    return false;
}

export function classifyPortableWorkspacePathWithSourceController(input: Readonly<{
    relativePath: string;
    registry?: ScmBackendRegistry;
}>): ScmSourceControllerPortableWorkspacePathClassification {
    const request = createScmSourceControllerPortableWorkspacePathRequest({
        relativePath: input.relativePath,
    });
    for (const backend of (input.registry ?? defaultScmBackendRegistry).listBackends()) {
        const classification = backend.sourceController?.classifyPortableWorkspacePath?.(request);
        if (classification && classification !== 'unknown') {
            return classification;
        }
    }

    if (resolveScmSourceControllerPortableWorkspacePathRelativePath(request).length === 0) {
        return 'unknown';
    }

    return 'unknown';
}
