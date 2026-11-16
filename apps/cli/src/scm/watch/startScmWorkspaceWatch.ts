import { basename, relative, sep } from 'node:path';
import { currentWorkspaceSource, runWithWorkspaceSource, type WorkspaceSource } from '@/workspaces/source/workspaceSource';
import { readRepositoryIgnoredPaths } from '@/scm/readRepositoryIgnoredPaths';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveScmSelectionOutcome } from '@/scm/resolveScmSelection';
import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';

import type { ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';
export type { ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';

export type StartScmWorkspaceWatchOptions = Readonly<{
    /** The admitted request's source; the watch outlives that request's async context. */
    source?: WorkspaceSource;
    directory: string;
    registry?: ScmBackendRegistry;
    onChange: () => void;
    onUnavailable: (reason: ScmWorkspaceWatchUnavailable) => void;
    onReady?: () => void;
}>;

function failure(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

/** One observation lifetime. Demand and sharing belong to the daemon's subscription owner. */
export function startScmWorkspaceWatch(options: StartScmWorkspaceWatchOptions): () => void {
    const source = options.source ?? currentWorkspaceSource();
    let active = true;
    let disposeTree: () => void = () => undefined;
    const metadata = new Map<string, () => void>();
    let finish: () => void = () => undefined;
    const lifetime = new Promise<void>(resolve => { finish = resolve; });
    const dispose = () => {
        if (!active) return;
        active = false;
        disposeTree();
        for (const stop of metadata.values()) stop();
        metadata.clear();
        finish();
    };
    const unavailable = (error: unknown) => {
        if (!active) return;
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
            ? error.code : typeof error === 'object' && error !== null && 'errorCode' in error && typeof error.errorCode === 'string'
                ? error.errorCode : 'WATCH_UNAVAILABLE';
        const message = error instanceof Error ? error.message : 'Native workspace observation is unavailable.';
        dispose();
        options.onUnavailable({ code, message });
    };

    // Later refreshes run from watcher callbacks; keep them on the watch's source.
    void runWithWorkspaceSource(source, () => runWithScmBackendRegistryLease(options.registry, async registry => {
        const requestedDirectory = await source.realpath(options.directory);
        if (!active) return;
        const outcome = await resolveScmSelectionOutcome({ cwd: requestedDirectory, workingDirectory: requestedDirectory, registry });
        if (!active) return;
        if (outcome.kind === 'undetermined') throw outcome.error;
        if (outcome.kind === 'not_a_repository') throw failure('NOT_REPOSITORY', 'Workspace observation requires a source-control repository.');
        const { context, selection } = outcome;
        const integration = selection.backend.workspaceIntegration;
        if (!selection.backend.ignoredPaths || !integration?.watchInputs) {
            throw failure('FEATURE_UNSUPPORTED', 'This source-control backend does not support workspace observation.');
        }
        const directory = requestedDirectory;
        let ignored: ReadonlySet<string> = new Set();
        let watchedIgnored = ignored;
        let workspaceFileNames = new Set<string>();
        const relativePath = (path: string) => relative(directory, path).split(sep).join('/');
        const isIgnored = (path: string) => {
            let candidate = relativePath(path);
            if (integration.isAdministrativeWorkspacePath?.({ relativePath: candidate })) return true;
            while (candidate) {
                if (ignored.has(candidate)) return true;
                const separator = candidate.lastIndexOf('/');
                if (separator < 0) break;
                candidate = candidate.slice(0, separator);
            }
            return false;
        };
        const readIgnored = async () => {
            const paths = await readRepositoryIgnoredPaths({ repositoryRoot: directory, registry });
            if (paths === null) throw failure('COMMAND_FAILED', 'Source-control ignore rules are unavailable.');
            const next = new Set(paths.map(path => path.replaceAll('\\', '/').replace(/\/+$/u, '')));
            const changed = next.size !== ignored.size || [...next].some(path => !ignored.has(path));
            if (changed) ignored = next;
        };
        let refresh = Promise.resolve();
        const sourceChanged = (path?: string) => {
            if (!active) return;
            if (path && workspaceFileNames.has(basename(path))) {
                scheduleRefresh();
            } else if (!path || !isIgnored(path)) options.onChange();
        };
        const replaceTree = async () => {
            if (!active) return;
            disposeTree();
            watchedIgnored = ignored;
            const ready = new Promise<void>(resolveReady => {
                disposeTree = source.watchTree([{
                    directory,
                    ...(process.platform === 'darwin' || process.platform === 'win32' ? {} : {
                        shouldWatchDirectory: path => !isIgnored(path),
                    }),
                    onBeforeDirectoryChange: async () => { await readIgnored(); },
                    onStructuralChange: sourceChanged,
                    onFileChange: sourceChanged,
                }], { onReady: resolveReady, onUnavailable: unavailable });
            });
            await Promise.race([ready, lifetime]);
        };
        const reconcileMetadata = async () => {
            const inputs = await integration.watchInputs!({ context });
            if (!active) return;
            workspaceFileNames = new Set(inputs.workspaceFileNames);
            const paths = new Set(inputs.paths);
            for (const [path, stop] of metadata) {
                if (!paths.has(path)) {
                    metadata.delete(path);
                    stop();
                }
            }
            const attachments: Promise<void>[] = [];
            for (const path of paths) {
                if (!active) return;
                if (metadata.has(path)) continue;
                const attached = new Promise<void>(resolveAttached => {
                    const stop = source.watchFile(path, () => { scheduleRefresh(); }, {
                        emitInitial: false,
                        recovery: 'events',
                        onWatcherAttached: resolveAttached,
                        onWatcherUnavailable: unavailable,
                    });
                    metadata.set(path, stop);
                });
                attachments.push(attached);
            }
            await Promise.race([Promise.all(attachments), lifetime]);
        };
        function scheduleRefresh() {
            refresh = refresh.then(async () => {
                if (!active) return;
                await readIgnored();
                if (!active) return;
                await reconcileMetadata();
                if (ignored !== watchedIgnored) await replaceTree();
                if (active) options.onChange();
            }).catch(unavailable);
        }
        await readIgnored();
        if (!active) return;
        await reconcileMetadata();
        await replaceTree();
        if (active) options.onReady?.();
        await lifetime;
    }, { includeHostingProviders: false })).catch(unavailable);
    return dispose;
}
