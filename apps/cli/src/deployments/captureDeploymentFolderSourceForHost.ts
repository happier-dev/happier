import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHappierTempDir, removeHappierTempDirAsync } from '@happier-dev/cli-common/tempDirs';
import { captureWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncConflicts';
import { observeWorkspaceSyncEntryAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentSourceIntentV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { MachineWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceManifestEntry } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { Ignore } from 'ignore';
import createGitIgnore from 'ignore';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { resolveWorkspaceReplicationSourceInputsWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import {
    buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries,
    type ScmWorkspaceIntegrationWorkspaceExportTransferEntry,
} from '@/scm/workspace/workspaceExportArtifacts';

type FolderSource = Extract<DeploymentSourceIntentV1, { kind: 'folder' }>;
type FolderSelection = Pick<FolderSource, 'kind' | 'workspaceId' | 'includeEnvFiles' | 'compose'>;

const refuseSource = (): never => {
    throw createActionExecuteFailureError({ ok: false, errorCode: 'deployment_source_unavailable', error: 'deployment_source_unavailable' });
};

function isWithin(root: string, path: string): boolean {
    const suffix = relative(root, path);
    return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}

/** The Deployment boundary is the one owner of the files covered by a folder review. */
export async function captureDeploymentFolderSourceForHost(input: Readonly<{
    workspace: MachineWorkspaceRefV1;
    selection: FolderSelection;
    signal?: AbortSignal;
}>) {
    const source = currentWorkspaceSource();
    const root = await source.realpath(input.workspace.rootPath);
    const { entries, excludedPaths, selectionSource } = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({
        sourcePath: root,
        workspaceTransfer: { contentOnly: true, includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] },
    });
    const excluded = new Set(excludedPaths);
    const captureDirectory = createHappierTempDir({ purpose: 'deployment-folder-source' });
    const dispose = () => removeHappierTempDirAsync(captureDirectory);
    let nextEntry = 0;
    const assertCurrentAuthority = async () => { input.signal?.throwIfAborted(); };
    const acquire = async (relativePath: string, include: (entry: Awaited<ReturnType<typeof observeWorkspaceSyncEntryAtRoot>>) => boolean) => {
        input.signal?.throwIfAborted();
        const expected = await observeWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath, assertCurrentAuthority });
        if (!include(expected)) return { expectation: expected, materialPath: null };
        return await captureWorkspaceSyncEntryAtRoot({ rootPath: root, relativePath, expected, assertCurrentAuthority,
            captureDirectory, operationId: String(nextEntry++) });
    };
    const readRules = async (absolutePath: string) => {
        const relativePath = relative(root, absolutePath).split(sep).join('/');
        const acquired = await acquire(relativePath, entry => entry.kind === 'file');
        if (acquired.expectation.kind === 'missing') return undefined;
        if (!acquired.materialPath) return refuseSource();
        return await readFile(acquired.materialPath, 'utf8');
    };
    try {
        const gitRules = new Map<string, Ignore | null>();
        const ignoredDirectories = new Map<string, boolean>();
        const gitIgnored = async (segments: readonly string[], directory: boolean): Promise<boolean> => {
            const name = segments.join('/');
            const parents = segments.slice(0, -1);
            const known = directory ? ignoredDirectories.get(name) : undefined;
            if (known !== undefined) return known;
            if (parents.length && await gitIgnored(parents, true)) return true;
            let ignored = false;
            for (let index = 0; index < segments.length; index++) {
                const folder = segments.slice(0, index).join('/');
                let rules = gitRules.get(folder);
                if (rules === undefined) {
                    const contents = await readRules(join(root, folder, '.gitignore'));
                    rules = contents === undefined ? null : createGitIgnore({ ignorecase: false }).add(contents);
                    gitRules.set(folder, rules);
                }
                const outcome = rules?.test(segments.slice(index).join('/') + (directory ? '/' : ''));
                if (outcome?.ignored) ignored = true;
                else if (outcome?.unignored) ignored = false;
            }
            if (directory) ignoredDirectories.set(name, ignored);
            return ignored;
        };
        const retained: ScmWorkspaceIntegrationWorkspaceExportTransferEntry[] = [];
        for (const entry of entries) {
            input.signal?.throwIfAborted();
            const segments = entry.relativePath.split('/');
            if (segments.some(name => name.toLowerCase() === '.git')) {
                excluded.add(entry.relativePath);
                continue;
            }
            const envFile = input.selection.includeEnvFiles !== true && segments.some(name => name.toLowerCase().startsWith('.env'));
            const ignored = envFile || (selectionSource === 'filesystem' && await gitIgnored(segments, false));
            if (ignored) {
                excluded.add(entry.relativePath);
                continue;
            }
            const physicalParent = dirname(join(root, ...segments));
            const acquired = await acquire(entry.relativePath, expected => {
                if (expected.kind === 'file') return true;
                if (expected.kind !== 'symlink') return false;
                const target = expected.target;
                const parts = target.split('/');
                const firstChild = parts.findIndex(part => part !== '..' && part !== '.');
                // Only leading parent steps are portable: a later ".." can traverse an
                // admitted symlink first and reach a different parent on the build host.
                if (target.trim() !== target || isAbsolute(target) || win32.parse(target).root
                    || target.includes('\\') || (firstChild >= 0 && parts.slice(firstChild).includes('..'))
                    || !isWithin(root, resolve(physicalParent, target))) {
                    excluded.add(entry.relativePath);
                    return false;
                }
                return true;
            });
            // Git selects index paths too. A tracked file deleted from the working tree has no bytes to stage.
            if (acquired.materialPath) retained.push({ relativePath: entry.relativePath, sourcePath: acquired.materialPath });
        }
        input.signal?.throwIfAborted();
        const captured = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({ entries: retained });
        const manifest = captured.workspaceExportArtifacts.manifest;
        const manifestFingerprint = manifest.fingerprint!;
        let fileCount = 0;
        let totalBytes = 0;
        for (const entry of manifest.entries) {
            if (entry.kind === 'directory') continue;
            fileCount++;
            totalBytes += entry.kind === 'file' ? entry.sizeBytes : Buffer.byteLength(entry.target);
        }
        return { captured: { ...captured, dispose }, sourceIntent: { ...input.selection, manifestFingerprint, fileCount, totalBytes,
            excludedPaths: [...excluded].sort() } satisfies FolderSource };
    } catch (error) {
        await dispose();
        throw error;
    }
}

/** Recovery exports only the previous deployment's admitted manifest. */
export async function captureRetainedDeploymentFolderForHost(input: Readonly<{
    rootPath: string;
    manifest: readonly WorkspaceManifestEntry[];
    manifestFingerprint: string;
    assertCurrentAuthority(): Promise<void>;
}>) {
    const captureDirectory = createHappierTempDir({ purpose: 'deployment-folder-source' });
    const dispose = () => removeHappierTempDirAsync(captureDirectory);
    try {
        const entries: ScmWorkspaceIntegrationWorkspaceExportTransferEntry[] = [];
        for (const { kind, relativePath } of input.manifest) {
            if (kind === 'directory') continue;
            const expected = await observeWorkspaceSyncEntryAtRoot({ ...input, relativePath });
            if (expected.kind !== kind) return refuseSource();
            const { materialPath } = await captureWorkspaceSyncEntryAtRoot({ ...input, relativePath, expected,
                captureDirectory, operationId: String(entries.length) });
            if (!materialPath) return refuseSource();
            entries.push({ relativePath, sourcePath: materialPath });
        }
        const captured = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({ entries });
        if (captured.workspaceExportArtifacts.manifest.fingerprint !== input.manifestFingerprint) {
            await captured.blobProvider.dispose?.();
            return refuseSource();
        }
        return { ...captured, dispose };
    } catch (error) {
        await dispose();
        throw error;
    }
}
