import {
    realpathSync,
    statSync,
    watch,
    type FSWatcher,
    type WatchListener,
    type WatchOptionsWithStringEncoding,
} from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

type DirectoryTopologyWatch = (
    path: string,
    options: WatchOptionsWithStringEncoding,
    listener: WatchListener<string>,
) => FSWatcher;

export type StartDirectoryTopologyWatcherOptions = Readonly<{
    watchImpl?: DirectoryTopologyWatch;
    onReady?: () => void;
    onUnavailable?: (error: unknown) => void;
}>;

export type DirectoryTopologyWatchTarget = Readonly<{
    directory: string;
    /** Apply the consuming domain's existing traversal policy before enrolling subtrees. */
    shouldWatchDirectory?: (directory: string) => boolean;
    onStructuralChange: (changedPath?: string, kind?: 'directory' | 'file' | 'unknown') => void | Promise<void>;
    /** Source-wide consumers share these directory attachments for content too. */
    onFileChange?: (changedPath?: string) => void | Promise<void>;
    /** Native enrollment fact; consumers decide which logical aliases they read. */
    onSymbolicLink?: (path: string) => void | Promise<void>;
}>;

function isCanonicalDirectory(path: string): boolean {
    try {
        return realpathSync(path) === path && statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Node emulates recursive fs.watch on Linux with a watch for every file.
 * Topology needs directories only; named-file content has its own shared parent
 * attachment. Enrol new subtrees from rename events within this same owner. */
function watchDirectoryTree(
    root: string,
    watchImpl: DirectoryTopologyWatch,
    onStructuralChange: NonNullable<DirectoryTopologyWatchTarget['onStructuralChange']>,
    onUnavailable: (error: unknown) => void,
    onFileChange?: (changedPath?: string) => void,
    shouldWatchDirectory?: (directory: string) => boolean,
    onSymbolicLink?: (path: string) => void,
) {
    const watchers = new Map<string, FSWatcher>();
    let active = true;
    const contains = (directory: string, path: string) => {
        const child = relative(directory, path);
        return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
    };
    const closeSubtree = (directory: string) => {
        for (const [path, watcher] of watchers) {
            if (!contains(directory, path)) continue;
            watchers.delete(path);
            watcher.close();
        }
    };
    const walk = async (directory: string): Promise<void> => {
        if (!active || watchers.has(directory) || (directory !== root && shouldWatchDirectory?.(directory) === false)
            || !isCanonicalDirectory(directory)) return;
        const watcher = watchImpl(directory, { persistent: true, recursive: false }, (eventType, filename) => {
            if (!active || watchers.get(directory) !== watcher) return;
            const changedPath = filename === null ? directory : resolve(directory, String(filename));
            if (eventType !== 'rename') {
                onFileChange?.(filename === null ? undefined : changedPath);
                return;
            }
            // Serialize structural enrollment with the initial walk. A burst
            // cannot leave a newer subtree attached beneath a stale disposer.
            pending = pending.then(async () => {
                if (!active) return;
                onSymbolicLink?.(changedPath);
                const wasDirectory = watchers.has(changedPath);
                closeSubtree(changedPath);
                await walk(changedPath);
                if (active) onStructuralChange(filename === null ? undefined : changedPath,
                    filename === null ? 'unknown' : wasDirectory || watchers.has(changedPath) ? 'directory' : 'file');
            }).catch(error => { if (active) onUnavailable(error); });
        });
        watchers.set(directory, watcher);
        watcher.on('error', error => { if (active && watchers.get(directory) === watcher) onUnavailable(error); });
        try {
            const entries = await opendir(directory);
            for await (const entry of entries) {
                if (!active || watchers.get(directory) !== watcher) return;
                // Dirents avoid statting/retaining each transcript, and never
                // follow symlinks outside the admitted canonical tree.
                if (entry.isDirectory()) await walk(resolve(directory, entry.name));
                else if (entry.isSymbolicLink()) onSymbolicLink?.(resolve(directory, entry.name));
            }
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
            closeSubtree(directory);
        }
    };
    let pending = Promise.resolve().then(() => walk(root));
    return {
        ready: pending,
        dispose() {
            active = false;
            closeSubtree(root);
        },
    };
}

/**
 * Watches structural changes below already-authorized canonical directories.
 *
 * Sibling targets share one parent sentinel while retaining independent recursive
 * target watchers and callbacks. The sentinel allows a missing/deleted target to
 * be attached again without polling. Canonical identity is revalidated on every
 * attachment so a recreated symlink cannot inherit prior directory authorization.
 */
export function startDirectoryTopologyWatchers(
    targets: readonly DirectoryTopologyWatchTarget[],
    options?: StartDirectoryTopologyWatcherOptions,
): () => void {
    const watchImpl: DirectoryTopologyWatch = options?.watchImpl ?? watch;
    let active = true;
    type TargetRecord = {
        directory: string;
        targetName: string;
        onStructuralChange: DirectoryTopologyWatchTarget['onStructuralChange'];
        onFileChange: DirectoryTopologyWatchTarget['onFileChange'];
        shouldWatchDirectory: DirectoryTopologyWatchTarget['shouldWatchDirectory'];
        onSymbolicLink: DirectoryTopologyWatchTarget['onSymbolicLink'];
        watcher: ReturnType<typeof watch> | null;
        disposeTree: (() => void) | null;
        attachment: Promise<void>;
    };
    type ParentRecord = {
        directory: string;
        targetsByName: Map<string, TargetRecord>;
        watcher: ReturnType<typeof watch> | null;
    };
    const parentRecords = new Map<string, ParentRecord>();
    const targetRecords: TargetRecord[] = [];

    for (const target of targets) {
        if (targetRecords.some(({ directory }) => directory === target.directory)) {
            continue;
        }
        const parentDirectory = dirname(target.directory);
        const record: TargetRecord = {
            directory: target.directory,
            targetName: basename(target.directory),
            onStructuralChange: target.onStructuralChange,
            onFileChange: target.onFileChange,
            shouldWatchDirectory: target.shouldWatchDirectory,
            onSymbolicLink: target.onSymbolicLink,
            watcher: null,
            disposeTree: null,
            attachment: Promise.resolve(),
        };
        targetRecords.push(record);
        const parent = parentRecords.get(parentDirectory) ?? {
            directory: parentDirectory,
            targetsByName: new Map(),
            watcher: null,
        };
        parent.targetsByName.set(record.targetName, record);
        parentRecords.set(parentDirectory, parent);
    }

    const emitStructuralChange = (
        target: TargetRecord,
        changedPath?: string,
        kind?: 'directory' | 'file' | 'unknown',
    ): void => {
        if (!active) return;
        void Promise.resolve(target.shouldWatchDirectory
            ? target.onStructuralChange(changedPath, kind)
            : target.onStructuralChange(changedPath))
            .catch(() => undefined);
    };

    const closeTargetWatcher = (target: TargetRecord): void => {
        const current = target.watcher;
        target.watcher = null;
        current?.close();
        target.disposeTree?.();
        target.disposeTree = null;
    };

    const emitFileChange = (target: TargetRecord, path?: string) => {
        if (active) void Promise.resolve(target.onFileChange?.(path)).catch(() => undefined);
    };

    let unavailableNotified = false;
    let readyNotified = false;
    const notifyUnavailable = (error: unknown): void => {
        if (!active || unavailableNotified) return;
        unavailableNotified = true;
        void Promise.resolve().then(() => {
            if (!active) return;
            options?.onUnavailable?.(error);
        }).catch(() => undefined);
    };
    const notifyReady = (): void => {
        if (
            !active
            || unavailableNotified
            || readyNotified
            || [...parentRecords.values()].some((parent) => !parent.watcher)
        ) {
            return;
        }
        readyNotified = true;
        void Promise.resolve().then(() => {
            if (!active || unavailableNotified) return;
            options?.onReady?.();
        }).catch(() => undefined);
    };

    const attachTarget = (
        target: TargetRecord,
        emitAfterAttachment = false,
    ): void => {
        target.attachment = target.attachment.then(async () => {
            if (!active) return;
            closeTargetWatcher(target);
            const attachable = isCanonicalDirectory(target.directory);
            if (!attachable) {
                if (emitAfterAttachment) {
                    emitStructuralChange(target);
                }
                return;
            }

            // Native recursive watching cannot exclude subtrees. Selective consumers
            // use the same directory enrollment owner on every platform.
            if (target.shouldWatchDirectory || (process.platform !== 'darwin' && process.platform !== 'win32')) {
                const tree = watchDirectoryTree(target.directory, watchImpl,
                    (changedPath, kind) => emitStructuralChange(target, changedPath, kind), error => {
                        if (!active || target.disposeTree !== tree.dispose) return;
                        closeTargetWatcher(target);
                        notifyUnavailable(error);
                    }, path => emitFileChange(target, path), target.shouldWatchDirectory, path => {
                        if (active) void Promise.resolve(target.onSymbolicLink?.(path)).catch(notifyUnavailable);
                    });
                target.disposeTree = tree.dispose;
                await tree.ready;
                if (emitAfterAttachment) emitStructuralChange(target);
                return;
            }

            let nextWatcher: ReturnType<typeof watch>;
            try {
                nextWatcher = watchImpl(
                    target.directory,
                    { persistent: true, recursive: true },
                    (eventType, filename) => {
                        if (!active || target.watcher !== nextWatcher) return;
                        const changedPath = filename === null
                            ? undefined
                            : resolve(target.directory, String(filename));
                        if (eventType !== 'rename') {
                            emitFileChange(target, changedPath);
                            return;
                        }
                        emitStructuralChange(target, changedPath);
                    },
                );
            } catch (error) {
                notifyUnavailable(error);
                return;
            }
            target.watcher = nextWatcher;
            if (emitAfterAttachment) {
                emitStructuralChange(target);
            }
            nextWatcher.on('error', (error) => {
                if (!active || target.watcher !== nextWatcher) return;
                closeTargetWatcher(target);
                notifyUnavailable(error);
            });
        }).catch((error) => {
            closeTargetWatcher(target);
            notifyUnavailable(error);
        });
    };

    const attachParentWatcher = (parent: ParentRecord): void => {
        if (!active || parent.watcher) return;
        try {
            const nextWatcher = watchImpl(
                parent.directory,
                { persistent: true },
                (eventType, filename) => {
                    if (!active || parent.watcher !== nextWatcher) return;
                    if (eventType !== 'rename') return;
                    if (filename === null) {
                        for (const target of parent.targetsByName.values()) {
                            attachTarget(target, true);
                        }
                        return;
                    }
                    const target = parent.targetsByName.get(String(filename));
                    if (target) {
                        attachTarget(target, true);
                    }
                },
            );
            parent.watcher = nextWatcher;
            nextWatcher.on('error', (error) => {
                if (!active || parent.watcher !== nextWatcher) return;
                nextWatcher.close();
                parent.watcher = null;
                notifyUnavailable(error);
            });
        } catch (error) {
            notifyUnavailable(error);
        }
    };
    for (const parent of parentRecords.values()) {
        attachParentWatcher(parent);
    }
    for (const target of targetRecords) {
        attachTarget(target);
    }
    void Promise.all(targetRecords.map((target) => target.attachment))
        .then(notifyReady)
        .catch(notifyUnavailable);

    return () => {
        if (!active) return;
        active = false;
        for (const target of targetRecords) {
            closeTargetWatcher(target);
        }
        for (const parent of parentRecords.values()) {
            parent.watcher?.close();
            parent.watcher = null;
        }
    };
}

export function startDirectoryTopologyWatcher(
    directory: string,
    onStructuralChange: (changedPath?: string) => void | Promise<void>,
    options?: StartDirectoryTopologyWatcherOptions,
): () => void {
    return startDirectoryTopologyWatchers([
        { directory, onStructuralChange },
    ], options);
}
