import { lstat, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { startDirectoryTopologyWatchers } from '@/integrations/watcher/startDirectoryTopologyWatcher';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { NATIVE_PROJECT_DEFINITION_FILES } from '@/workspaces/projectSetup/nativeDefinitionInspection';
import { isNativePackageDeclarationFile, isNativePackageDiscoveryDirectory } from '@/workspaces/projectSetup/nativePackageScripts';
import { PROJECT_MANIFEST_RELATIVE_PATH } from '@/workspaces/projectSetup/projectManifestFile';

import type { LocalServiceWorkspaceFactsSnapshot } from '../inventory/workspaces';
import type { LocalServiceInventoryDiagnostic } from '../inventory/scanner';
import { isWorkspacePathWithin } from '../inventory/provenance';

function declarationPath(root: string, path: string): boolean {
    const file = relative(root, path).replaceAll('\\', '/');
    if (file.split('/').slice(0, -1).some(part => !isNativePackageDiscoveryDirectory(part))) return false;
    return file === PROJECT_MANIFEST_RELATIVE_PATH
        || NATIVE_PROJECT_DEFINITION_FILES.some(candidate => candidate === file)
        || isNativePackageDeclarationFile(basename(path))
        || /^\.devcontainer\/[^/]+\/devcontainer\.json$/.test(file);
}

/** Existing Machine inventory watches are unscoped: their mounted lifetime owns
 * declaration observation for known roots. Plain launcher reads own no watches. */
export function createLocalServiceDeclarationWatch(input: Readonly<{
    readWorkspaceFacts(): Promise<LocalServiceWorkspaceFactsSnapshot>;
    onChanged(workspaceRoots: readonly string[] | undefined, signal: AbortSignal): Promise<void>;
    onError(error: unknown, diagnostic: LocalServiceInventoryDiagnostic): void;
}>) {
    const reportError = (error: unknown, role: 'project_root' | 'declaration_file' | 'workspace_facts' | 'declaration_discovery') => {
        // Publish the known Workspace root so its owner can fix permissions,
        // without disclosing native messages, stacks or unrelated error paths.
        const label = (value: unknown) => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_]*$/.test(value) ? value : undefined;
        const cause = error !== null && typeof error === 'object' ? error : null;
        const path = cause && 'path' in cause && typeof cause.path === 'string' ? cause.path : undefined;
        const root = path === undefined ? undefined : roots.find(root => isWorkspacePathWithin(root, path));
        input.onError(error, {
            code: 'local_services_declaration_observation_unavailable', severity: 'warning',
            message: JSON.stringify({ role, root,
                class: cause && 'name' in cause ? label(cause.name) : undefined,
                code: cause && 'code' in cause ? label(cause.code) : undefined,
                errno: cause && 'errno' in cause && typeof cause.errno === 'number' && Number.isFinite(cause.errno) ? cause.errno : undefined,
                syscall: cause && 'syscall' in cause ? label(cause.syscall) : undefined,
            }),
        });
    };
    let demand: AbortController | undefined;
    let roots: readonly string[] = [];
    let workspaceIdentities: readonly (readonly string[])[] = [];
    let dispose: (() => void) | undefined;
    let observation: AbortController | undefined;
    const entryWatches = new Map<string, ReturnType<typeof startFileWatcher>>();
    const stopEntryWatches = () => {
        for (const stop of entryWatches.values()) stop();
        entryWatches.clear();
    };

    const observeRoots = (next: readonly string[], lifetime: AbortController): void => {
        observation?.abort();
        dispose?.();
        stopEntryWatches();
        roots = next;
        const attachment = new AbortController();
        observation = attachment;
        const changed = async (changedRoots?: readonly string[]) => {
            if (lifetime.signal.aborted || attachment.signal.aborted) return;
            try { await input.onChanged(changedRoots, attachment.signal); }
            catch (error) { if (!lifetime.signal.aborted && !attachment.signal.aborted) reportError(error, 'declaration_discovery'); }
        };
        if (next.length === 0) {
            void changed();
            return;
        }
        void Promise.all(next.map(async root => {
            // The filesystem owner accepts canonical watch targets. Discovery keeps
            // the accepted logical root, including supported symlink aliases.
            const directory = await realpath(root).catch(async error => {
                if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
                    if (attachment.signal.aborted) return null;
                    // Missing retained roots are empty, not a failed Machine-wide
                    // observation. The file watcher already follows ancestor creation
                    // with native events, without traversing or polling those ancestors.
                    const appeared = async () => {
                        const directory = await realpath(root).catch(error => {
                            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
                            throw error;
                        });
                        if (directory && !lifetime.signal.aborted && !attachment.signal.aborted) observeRoots(roots, lifetime);
                    };
                    const stop = startFileWatcher(root, appeared, {
                        emitInitial: false, recovery: 'events', onWatcherAttached: appeared,
                        onWatcherUnavailable: error => { if (!attachment.signal.aborted) reportError(error, 'project_root'); },
                    });
                    entryWatches.set(root, stop);
                    return null;
                }
                throw error;
            });
            return directory === null ? null : { root, directory };
        })).then(results => {
            if (lifetime.signal.aborted || attachment.signal.aborted) return;
            const mappings = results.filter(mapping => mapping !== null);
            const directories: string[] = [];
            for (const { directory } of [...mappings].sort((a, b) => a.directory.length - b.directory.length)) {
                if (!directories.some(parent => isWorkspacePathWithin(parent, directory))) directories.push(directory);
            }
            const changedPaths = async (directory: string, path?: string, structural = false) => {
                if (path && relative(directory, path).split(/[\\/]/).some(part => !isNativePackageDiscoveryDirectory(part))) return;
                const affected: string[] = [];
                for (const mapping of mappings) {
                    if (!isWorkspacePathWithin(directory, mapping.directory)) continue;
                    if (path && !(isWorkspacePathWithin(mapping.directory, path) && (structural || declarationPath(mapping.directory, path)))
                        && !(structural && isWorkspacePathWithin(path, mapping.directory))) continue;
                    if (!affected.some(parent => isWorkspacePathWithin(parent, mapping.root))) affected.push(mapping.root);
                }
                if (affected.length > 0) await changed(affected);
            };
            const observeAlias = async (directory: string, path: string) => {
                const alias = await lstat(path).catch(() => undefined);
                if (!alias?.isSymbolicLink()) return;
                const actual = await realpath(path).catch(() => undefined);
                if (!actual || !isWorkspacePathWithin(directory, actual) || attachment.signal.aborted) return;
                const file = relative(directory, path).replaceAll('\\', '/');
                const candidates = declarationPath(directory, path) ? [path]
                    : NATIVE_PROJECT_DEFINITION_FILES.filter(name => name.startsWith(`${file}/`)).map(name => join(directory, name));
                for (const candidate of candidates) {
                    if (attachment.signal.aborted || entryWatches.has(candidate)) continue;
                    const stop = startFileWatcher(candidate, () => changedPaths(directory, candidate), {
                        emitInitial: false, recovery: 'events',
                        onWatcherAttached: () => changedPaths(directory, candidate),
                        onWatcherUnavailable: error => { if (!attachment.signal.aborted) reportError(error, 'declaration_file'); },
                    });
                    entryWatches.set(candidate, stop);
                }
            };
            dispose = startDirectoryTopologyWatchers(directories.map(directory => ({
                directory,
                shouldWatchDirectory: (child: string) => isNativePackageDiscoveryDirectory(basename(child)),
                onFileChange: (path?: string) => changedPaths(directory, path),
                onSymbolicLink: (path: string) => observeAlias(directory, path),
                // The watcher owns removed-directory membership. A missing ordinary
                // file is not an unknown topology change.
                onStructuralChange: (path?: string, kind?: 'directory' | 'file' | 'unknown') => changedPaths(directory, path, kind !== 'file'),
            })), {
                onReady: () => { void changed(); },
                onUnavailable: error => { if (!attachment.signal.aborted) reportError(error, 'project_root'); },
            });
        }).catch(error => { if (!attachment.signal.aborted) reportError(error, 'project_root'); });
    };

    const updateWorkspaceFacts = (source: LocalServiceWorkspaceFactsSnapshot) => {
        const lifetime = demand;
        if (!lifetime || lifetime.signal.aborted) return;
        const next = [...new Set([...source.facts.map(fact => fact.path), ...source.acceptedWorkspaceRefs.map(ref => ref.rootPath)])]
            .filter(Boolean).sort((a, b) => a.length - b.length || a.localeCompare(b));
        const identities = source.acceptedWorkspaceRefs.map(ref => [ref.serverId, ref.machineId, ref.id, ref.rootPath] as const)
            .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]) || a[3].localeCompare(b[3]));
        if (next.length === roots.length && next.every((root, index) => root === roots[index])) {
            if (!isDeepStrictEqual(workspaceIdentities, identities)) {
                workspaceIdentities = identities;
                const attachment = observation;
                if (attachment) void input.onChanged(undefined, attachment.signal).catch(error => {
                    if (!attachment.signal.aborted) reportError(error, 'declaration_discovery');
                });
            }
            return;
        }
        workspaceIdentities = identities;
        observeRoots(next, lifetime);
    };

    return {
        updateWorkspaceFacts,
        setDemand(active: boolean) {
            if (!active) {
                demand?.abort();
                observation?.abort();
                observation = undefined;
                demand = undefined;
                dispose?.();
                stopEntryWatches();
                dispose = undefined;
                roots = [];
                workspaceIdentities = [];
                return;
            }
            if (demand) return;
            const lifetime = new AbortController();
            demand = lifetime;
            void input.readWorkspaceFacts().then(source => {
                if (!lifetime.signal.aborted) updateWorkspaceFacts(source);
            }).catch(error => { if (!lifetime.signal.aborted) reportError(error, 'workspace_facts'); });
        },
    };
}
