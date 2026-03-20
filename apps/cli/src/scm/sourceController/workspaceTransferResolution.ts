import { readdir, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { defaultScmBackendRegistry } from '../defaultRegistry';
import type { ScmBackendRegistry } from '../registry';
import { resolveScmSelection } from '../resolveScmSelection';
import {
    createScmSourceControllerPortableWorkspacePathRequest,
    type ScmSourceControllerPortableWorkspacePathClassification,
} from './portableWorkspacePath';
import {
    buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries,
    createScmSourceControllerWorkspaceExportArtifacts,
    type ScmSourceControllerWorkspaceExportArtifacts,
} from './workspaceExportArtifacts';
import {
    isIgnorableWorkspaceExportAccessError,
    listWorkspaceExportFallbackEntries,
} from './workspaceExportFallbackEntries';
import {
    createScmSourceControllerWorkspaceTransferEntry,
    createScmSourceControllerWorkspaceTransferRequest,
    createScmSourceControllerWorkspaceTransferResult,
    type ScmSourceControllerWorkspaceTransferEntry,
    type ScmSourceControllerWorkspaceTransferRequestInput,
    type ScmSourceControllerWorkspaceTransferRequest,
    type ScmSourceControllerWorkspaceTransferMetadata,
    type ScmSourceControllerWorkspaceTransferResult,
} from './workspaceTransfer';

export function buildNonPortableWorkspacePathError(relativePath: string): Error {
    return new Error(`Workspace transfer contains non-portable workspace path: ${relativePath}`);
}

async function resolveWorkspaceTransferStateWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<Readonly<{
    transfer: ScmSourceControllerWorkspaceTransferResult | null;
    workspaceExportArtifacts: ScmSourceControllerWorkspaceExportArtifacts | null;
    isNestedRepoSourcePath: boolean;
}>> {
    const resolved = await resolveScmSelection({
        workingDirectory: input.sourcePath,
        cwd: input.sourcePath,
        registry: input.registry ?? defaultScmBackendRegistry,
    });
    if (!resolved) {
        return {
            transfer: null,
            workspaceExportArtifacts: null,
            isNestedRepoSourcePath: false,
        };
    }

    const isNestedRepoSourcePath = await (async () => {
        const repoRootPath = resolved.context.detection.rootPath;
        if (!resolved.context.detection.isRepo || !repoRootPath) {
            return false;
        }

        const canonicalize = async (path: string): Promise<string> => {
            try {
                return await realpath(path);
            } catch {
                return resolve(path);
            }
        };

        const [canonicalSourcePath, canonicalRepoRootPath] = await Promise.all([
            canonicalize(input.sourcePath),
            canonicalize(repoRootPath),
        ]);
        return canonicalSourcePath !== canonicalRepoRootPath;
    })();

    const sourceController = resolved.selection.backend.sourceController;
    const workspaceTransfer = createScmSourceControllerWorkspaceTransferRequest(input.workspaceTransfer);
    const sourceControllerInput = {
        context: resolved.context,
        workspaceTransfer,
    };

    const sourceControllerArtifacts = await sourceController?.resolveWorkspaceExportArtifacts?.(sourceControllerInput)
        .catch(() => null);
    if (sourceControllerArtifacts) {
        return {
            transfer: null,
            workspaceExportArtifacts: createScmSourceControllerWorkspaceExportArtifacts(sourceControllerArtifacts),
            isNestedRepoSourcePath,
        };
    }

    if (sourceController?.resolveWorkspaceTransfer) {
        return {
            transfer: await sourceController.resolveWorkspaceTransfer(sourceControllerInput).catch(() => null),
            workspaceExportArtifacts: null,
            isNestedRepoSourcePath,
        };
    }

    const [entries, metadata] = await Promise.all([
        sourceController?.resolveWorkspaceTransferEntries?.(sourceControllerInput) ?? Promise.resolve(null),
        sourceController?.resolveWorkspaceTransferMetadata?.(sourceControllerInput) ?? Promise.resolve(null),
    ]);
    if (!entries) {
        return {
            transfer: null,
            workspaceExportArtifacts: null,
            isNestedRepoSourcePath,
        };
    }

    return {
        transfer: createScmSourceControllerWorkspaceTransferResult({
            entries,
            metadata,
        }),
        workspaceExportArtifacts: null,
        isNestedRepoSourcePath,
    };
}

export function classifyPortableWorkspaceTransferEntryWithSourceController(input: Readonly<{
    entry: ScmSourceControllerWorkspaceTransferEntry;
    registry?: ScmBackendRegistry;
}>): ScmSourceControllerPortableWorkspacePathClassification {
    const registry = input.registry ?? defaultScmBackendRegistry;
    const transferEntry = createScmSourceControllerWorkspaceTransferEntry(input.entry);

    for (const backend of registry.listBackends()) {
        const transferEntryClassification = backend.sourceController?.classifyPortableWorkspaceTransferEntry?.(transferEntry);
        if (transferEntryClassification && transferEntryClassification !== 'unknown') {
            return transferEntryClassification;
        }

        const pathClassification = backend.sourceController?.classifyPortableWorkspacePath?.(
            createScmSourceControllerPortableWorkspacePathRequest({
                relativePath: transferEntry.relativePath,
            }),
        );
        if (pathClassification && pathClassification !== 'unknown') {
            return pathClassification;
        }
    }

    return 'unknown';
}

export async function assertPortableWorkspaceTransferEntriesWithSourceController(input: Readonly<{
    entries: readonly ScmSourceControllerWorkspaceTransferEntry[];
    registry?: ScmBackendRegistry;
}>): Promise<void> {
    for (const entry of input.entries) {
        if (classifyPortableWorkspaceTransferEntryWithSourceController({ entry, registry: input.registry }) === 'non_portable') {
            throw buildNonPortableWorkspacePathError(entry.relativePath);
        }
    }
}

export async function resolveWorkspaceTransferWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceTransferResult | null> {
    return (await resolveWorkspaceTransferStateWithSourceController(input)).transfer;
}

export async function resolveWorkspaceTransferEntriesWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<readonly ScmSourceControllerWorkspaceTransferEntry[] | null> {
    const transfer = await resolveWorkspaceTransferWithSourceController(input);
    return transfer ? transfer.entries.map((entry) => createScmSourceControllerWorkspaceTransferEntry(entry)) : null;
}

export async function resolveWorkspaceTransferMetadataWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceTransferMetadata | null> {
    const transfer = await resolveWorkspaceTransferWithSourceController(input);
    return transfer ? transfer.metadata ?? null : null;
}

export async function buildWorkspaceExportArtifactsWithSourceController(input: Readonly<{
    sourcePath: string;
    workspaceTransfer: ScmSourceControllerWorkspaceTransferRequestInput;
    registry?: ScmBackendRegistry;
}>): Promise<ScmSourceControllerWorkspaceExportArtifacts> {
    const resolved = await resolveWorkspaceTransferStateWithSourceController(input);

    if (resolved.workspaceExportArtifacts) {
        return resolved.workspaceExportArtifacts;
    }

    if (resolved.transfer && !(resolved.isNestedRepoSourcePath && resolved.transfer.entries.length === 0)) {
        const transferEntries = resolved.transfer.entries.map((entry) => createScmSourceControllerWorkspaceTransferEntry(entry));
        const sourceControllerMetadata = resolved.transfer.metadata ?? null;
        await assertPortableWorkspaceTransferEntriesWithSourceController({
            entries: transferEntries,
            registry: input.registry,
        });
        const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
            entries: transferEntries,
            shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
        });
        return createScmSourceControllerWorkspaceExportArtifacts({
            ...workspaceExportArtifacts,
            sourceControllerMetadata,
        });
    }

    const fallbackEntries = await listWorkspaceExportFallbackEntries({
        root: input.sourcePath,
        readDirectory: async (directory) => await readdir(directory, { withFileTypes: true }),
    });
    const workspaceExportArtifacts = await buildScmSourceControllerWorkspaceExportArtifactsFromTransferEntries({
        entries: fallbackEntries,
        shouldIgnoreAccessError: isIgnorableWorkspaceExportAccessError,
    });
    return createScmSourceControllerWorkspaceExportArtifacts({
        ...workspaceExportArtifacts,
    });
}
