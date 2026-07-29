import {
    realpathSync,
    statSync,
    watch,
    type FSWatcher,
    type WatchListener,
    type WatchOptions,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

type DirectoryTopologyWatch = (
    path: string,
    options: WatchOptions,
    listener: WatchListener<string>,
) => FSWatcher;

export type StartDirectoryTopologyWatcherOptions = Readonly<{
    watchImpl?: DirectoryTopologyWatch;
    onReady?: () => void;
    onUnavailable?: (error: unknown) => void;
}>;

export type DirectoryTopologyWatchTarget = Readonly<{
    directory: string;
    onStructuralChange: (changedPath?: string) => void | Promise<void>;
}>;

function isCanonicalDirectory(path: string): boolean {
    try {
        return realpathSync(path) === path && statSync(path).isDirectory();
    } catch {
        return false;
    }
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
    const watchImpl = options?.watchImpl ?? watch;
    let active = true;
    type TargetRecord = {
        directory: string;
        targetName: string;
        onStructuralChange: DirectoryTopologyWatchTarget['onStructuralChange'];
        watcher: ReturnType<typeof watch> | null;
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
            watcher: null,
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
    ): void => {
        if (!active) return;
        void Promise.resolve(target.onStructuralChange(changedPath))
            .catch(() => undefined);
    };

    const closeTargetWatcher = (target: TargetRecord): void => {
        const current = target.watcher;
        target.watcher = null;
        current?.close();
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
        target.attachment = target.attachment.then(() => {
            if (!active) return;
            closeTargetWatcher(target);
            const attachable = isCanonicalDirectory(target.directory);
            if (!attachable) {
                if (emitAfterAttachment) {
                    emitStructuralChange(target);
                }
                return;
            }

            let nextWatcher: ReturnType<typeof watch>;
            try {
                nextWatcher = watchImpl(
                    target.directory,
                    { persistent: true, recursive: true },
                    (eventType, filename) => {
                        if (!active || target.watcher !== nextWatcher) return;
                        if (eventType !== 'rename') return;
                        const changedPath = filename === null
                            ? undefined
                            : resolve(target.directory, String(filename));
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
