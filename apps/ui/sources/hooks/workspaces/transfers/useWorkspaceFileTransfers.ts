import * as React from 'react';
import { Platform } from 'react-native';

import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import {
    callDaemonWorkspaceStatFileRpc,
    classifyTransferFailure,
    type TransferFailureReason,
    downloadDaemonWorkspaceFileToDestination,
    uploadDaemonWorkspaceFileFromReader,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { resolveUploadRelativePath } from '@/sync/domains/transfers/uploadRelativePath';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { shareNativeCacheFile, type NativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import { type WebDownloadFileSink } from './webDownloadFileSink';
import { createPlatformDownloadFileSink } from '@/sync/runtime/files/platformDownloadFileSink';
import { resolveWebDownloadMaxBytes } from '@/sync/runtime/files/webFileBufferBudget';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime';
import type { WorkspaceFileUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';
import { desktopHostKind, invokeDesktopHost } from '@/utils/platform/desktopHost';
import { openInDefaultApp } from '@/sync/runtime/files/openInDefaultApp';
import { canOpenFileInDefaultApp, opensInBrowserTab, saveFileBytes } from '@/sync/runtime/files/saveFileBytes';
import { openWebFileInTab } from '@/sync/runtime/files/openWebFileInTab';
import { Modal } from '@/modal';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { resolveWorkspaceFileDownloadSource, type WorkspaceFileCachedContent } from './workspaceFileDownloadSource';
export type { WorkspaceFileCachedContent } from './workspaceFileDownloadSource';

export type WorkspaceUploadEntry =
    | Readonly<{ kind: 'web'; file: File; relativePath: string }>
    | Readonly<{ kind: 'native'; uri: string; name: string; sizeBytes: number | null; mimeType: string | null; relativePath: string }>;

export type UploadConflictStrategy = 'skip' | 'replace' | 'keep_both' | 'cancel';

export type UploadConflictResolutionRequest = Readonly<{
    conflictCount: number;
    totalCount: number;
    signal?: AbortSignal | null;
}>;

export type WorkspaceUploadState =
    | Readonly<{ status: 'idle' }>
    | Readonly<{
        status: 'preflighting' | 'uploading';
        totalFiles: number;
        completedFiles: number;
        uploadedBytes: number;
        totalBytes: number;
    }>
    | Readonly<{ status: 'done'; totalFiles: number; totalBytes: number }>
    | Readonly<{ status: 'canceled' }>
    /** `reason` is why it ended, in the surface's words; `error` is the transport's text and is never shown. */
    | Readonly<{ status: 'error'; error: string; reason: TransferFailureReason }>;

export type WorkspaceDownloadState =
    | Readonly<{ status: 'idle' }>
    | Readonly<{
        status: 'downloading';
        name: string;
        downloadedBytes: number;
        totalBytes: number;
        cancelable?: boolean;
    }>
    | Readonly<{ status: 'done'; name: string; totalBytes: number }>
    | Readonly<{ status: 'canceled' }>
    | Readonly<{ status: 'error'; error: string }>;

export type WorkspaceFileDownloadAction = 'save' | 'open' | 'share';

export type WorkspaceFileDownloadInput = Readonly<{
    path: string;
    asZip: boolean;
    action?: WorkspaceFileDownloadAction;
    cachedContent?: WorkspaceFileCachedContent | null;
}>;

export type WorkspaceTransferResult = { ok: true } | { ok: false; error: string; canceled?: true };

type UploadPreflightAwait<T> = Readonly<{ status: 'ready'; value: T }> | Readonly<{ status: 'aborted' }>;

async function awaitUploadPreflight<T>(
    promise: Promise<T>,
    signal: AbortSignal | null | undefined,
): Promise<UploadPreflightAwait<T>> {
    if (!signal) return { status: 'ready', value: await promise };
    if (signal.aborted) return { status: 'aborted' };
    return await new Promise<UploadPreflightAwait<T>>((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            resolve({ status: 'aborted' });
        };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
            return;
        }
        void promise.then(
            (value) => {
                cleanup();
                resolve(signal.aborted ? { status: 'aborted' } : { status: 'ready', value });
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
}

const UPLOAD_CANCELED_ERROR = 'Upload canceled';

function uploadCanceledPlan(): { ok: false; error: string } {
    return { ok: false, error: UPLOAD_CANCELED_ERROR };
}

/** A cancellation a caller may end quietly: the person's own cancel, a retired surface, or an aborted signal. */
function uploadCanceledResult(): { ok: false; error: string; canceled: true } {
    return { ok: false, error: UPLOAD_CANCELED_ERROR, canceled: true };
}

/** An abort (navigation, a retired Account or surface, a dismissed confirmation) is a cancellation, never a failure to word. */
function isAbortError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function openWorkspaceUploadSourceReader(entry: WorkspaceUploadEntry): Promise<{
    sizeBytes: number;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}> {
    if (entry.kind === 'web') {
        const reader = await openLocalUploadSourceReader({ kind: 'web', file: entry.file });
        return {
            sizeBytes: reader.sizeBytes ?? entry.file.size,
            readBytes: reader.readBytes,
            close: reader.close,
        };
    }

    const reader = await openLocalUploadSourceReader({
        kind: 'native',
        uri: entry.uri,
        sizeBytes: entry.sizeBytes,
    });
    return {
        sizeBytes: reader.sizeBytes ?? (typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? Math.floor(entry.sizeBytes) : 0),
        readBytes: reader.readBytes,
        close: reader.close,
    };
}

type UploadEntryPlanInput = Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    entries: readonly WorkspaceUploadEntry[];
    destinationDir: string;
    onResolveConflicts?: ((params: UploadConflictResolutionRequest) => Promise<UploadConflictStrategy>) | null;
    signal?: AbortSignal | null;
}>;
type UploadEntryPlan =
    | { ok: true; tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> }
    | { ok: false; error: string; reason?: TransferFailureReason };

/** The preflight read of a destination got no answer from the Machine: the batch has nothing to go on, and says so. */
class UploadPreflightUnreachableError extends Error {}

/**
 * Whether a destination is taken. A read that fails for a reason that says nothing about the Machine (an older
 * daemon without the read) leaves the answer to the upload itself; a Machine that does not answer ends the batch
 * here, once, rather than starting a second long attempt against the same silence.
 */
async function statUploadDestination(scope: WorkspaceScopeBase, path: string, signal: AbortSignal | null | undefined) {
    const stat = await callDaemonWorkspaceStatFileRpc({
        machineId: scope.machineId,
        serverId: scope.serverId,
        rootPath: scope.rootPath,
        request: { path },
        ...(signal ? { signal } : {}),
    });
    if (stat.success !== true && !signal?.aborted && classifyTransferFailure({ errorCode: stat.errorCode }) === 'unreachable') {
        throw new UploadPreflightUnreachableError(stat.error);
    }
    return stat;
}

export async function buildUploadEntryPlan(input: UploadEntryPlanInput): Promise<UploadEntryPlan> {
    try {
        return await planUploadEntries(input);
    } catch (error) {
        if (error instanceof UploadPreflightUnreachableError) return { ok: false, error: error.message, reason: 'unreachable' };
        throw error;
    }
}

async function planUploadEntries(input: UploadEntryPlanInput): Promise<UploadEntryPlan> {
    const destinationDir = String(input.destinationDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> = [];

    const invalidPaths: string[] = [];
    for (const entry of input.entries) {
        if (input.signal?.aborted) return uploadCanceledPlan();
        const relativePath = String(entry.relativePath ?? '').trim();
        const targetPath = resolveUploadRelativePath(destinationDir, relativePath);
        if (!targetPath) {
            invalidPaths.push(relativePath || '(empty)');
            continue;
        }

        let sizeBytes: number | null = null;
        if (entry.kind === 'web') {
            sizeBytes = entry.file.size;
        } else {
            sizeBytes = typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null;
            if (sizeBytes == null) {
                const resolvedSize = await awaitUploadPreflight(resolveLocalUploadSourceSizeBytes(entry), input.signal);
                if (resolvedSize.status === 'aborted') return uploadCanceledPlan();
                sizeBytes = resolvedSize.value;
            }
        }

        if (sizeBytes == null || sizeBytes < 0 || !Number.isFinite(sizeBytes)) {
            return { ok: false, error: 'Unable to resolve upload file size' };
        }

        tasks.push({ entry, targetPath, overwrite: false, sizeBytes: Math.floor(sizeBytes) });
    }

    if (invalidPaths.length > 0) {
        // Skip invalid paths, but keep the remaining valid uploads.
    }
    if (tasks.length === 0) {
        return { ok: false, error: 'No valid files to upload' };
    }

    const usedPaths = new Set<string>();
    const scope = input.workspaceScope;
    if (!scope) {
        return { ok: false, error: 'Workspace scope not available' };
    }

    // Detect collisions within the current upload batch (common on native when multiple picked files share a basename).
    // Resolve them eagerly via keep-both logic so the upload plan never contains duplicate target paths.
    for (let i = 0; i < tasks.length; i += 1) {
        if (input.signal?.aborted) return uploadCanceledPlan();
        const existing = tasks[i]!;
        if (!usedPaths.has(existing.targetPath)) {
            usedPaths.add(existing.targetPath);
            continue;
        }

        const resolvedResult = await awaitUploadPreflight(resolveKeepBothTargetPath({
            desiredPath: existing.targetPath,
            usedPaths,
            maxAttempts: 50,
            pathExists: async (candidatePath) => {
                const stat = await statUploadDestination(scope, candidatePath, input.signal);
                return stat.success !== true || stat.exists === true;
            },
        }), input.signal);
        if (resolvedResult.status === 'aborted') return uploadCanceledPlan();
        tasks[i] = { ...existing, targetPath: resolvedResult.value, overwrite: false };
        usedPaths.add(resolvedResult.value);
    }

    const conflicts: Array<{ index: number; targetPath: string }> = [];

    for (let i = 0; i < tasks.length; i += 1) {
        if (input.signal?.aborted) return uploadCanceledPlan();
        const statResult = await awaitUploadPreflight(statUploadDestination(scope, tasks[i]!.targetPath, input.signal), input.signal);
        if (statResult.status === 'aborted') return uploadCanceledPlan();
        const stat = statResult.value;
        if (stat.success === true && stat.exists === true) {
            conflicts.push({ index: i, targetPath: tasks[i]!.targetPath });
        }
    }

    if (conflicts.length === 0) {
        return { ok: true, tasks };
    }

    const strategyResult = input.onResolveConflicts
        ? await awaitUploadPreflight(
            input.onResolveConflicts({
                conflictCount: conflicts.length,
                totalCount: tasks.length,
                signal: input.signal ?? null,
            }),
            input.signal,
        )
        : { status: 'ready' as const, value: 'keep_both' as const };
    if (strategyResult.status === 'aborted') return uploadCanceledPlan();
    const strategy = strategyResult.value;

    if (strategy === 'cancel') {
        return { ok: false, error: 'Upload canceled' };
    }

    if (strategy === 'skip') {
        const conflictIndices = new Set(conflicts.map((c) => c.index));
        return { ok: true, tasks: tasks.filter((_t, idx) => !conflictIndices.has(idx)) };
    }

    if (strategy === 'replace') {
        for (const conflict of conflicts) {
            tasks[conflict.index] = { ...tasks[conflict.index]!, overwrite: true };
        }
        return { ok: true, tasks };
    }

    // keep_both
    for (const conflict of conflicts) {
        if (input.signal?.aborted) return uploadCanceledPlan();
        const original = tasks[conflict.index]!;
        const resolvedResult = await awaitUploadPreflight(resolveKeepBothTargetPath({
            desiredPath: original.targetPath,
            usedPaths,
            maxAttempts: 50,
            pathExists: async (candidatePath) => {
                const stat = await statUploadDestination(scope, candidatePath, input.signal);
                return stat.success !== true || stat.exists === true;
            },
        }), input.signal);
        if (resolvedResult.status === 'aborted') return uploadCanceledPlan();
        tasks[conflict.index] = { ...original, targetPath: resolvedResult.value, overwrite: false };
        usedPaths.add(resolvedResult.value);
    }

    return { ok: true, tasks };
}

type NativeDownloadSink = NativeCacheFileSink;

function offerBlockedWebFileTab(open: () => boolean): void {
    Modal.alert(t('files.viewer.openInNewTabReady'), undefined, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('files.viewer.openInNewTab'), onPress: () => {
            if (!open()) Modal.alert(t('common.error'), t('files.viewer.openInNewTabBlocked'));
        } },
    ]);
}

export function useWorkspaceFileTransfers(params: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    maxConcurrentUploads?: number;
    onResolveUploadConflicts?: ((params: UploadConflictResolutionRequest) => Promise<UploadConflictStrategy>) | null;
    onAfterUploadSuccess?: (() => void) | null;
}>): Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    startUploads: (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>) => Promise<WorkspaceTransferResult>;
    cancelUploads: () => void;
    /** Clears a settled upload failure from the surface that shows it. */
    dismissUploadFailure: () => void;
    startDownload: (input: WorkspaceFileDownloadInput) => Promise<WorkspaceTransferResult>;
    cancelDownload: () => void;
}> {
    const {
        maxConcurrentUploads,
        onAfterUploadSuccess,
        onResolveUploadConflicts,
        workspaceScope,
    } = params;
    const stableWorkspaceScope = React.useMemo(
        () => workspaceScope,
        [workspaceScope?.machineId, workspaceScope?.rootPath, workspaceScope?.serverId],
    );
    const [uploadState, setUploadState] = React.useState<WorkspaceUploadState>({ status: 'idle' });
    const [downloadState, setDownloadState] = React.useState<WorkspaceDownloadState>({ status: 'idle' });

    const uploadAbortRef = React.useRef<AbortController | null>(null);
    const downloadOperationRef = React.useRef<{ controller: AbortController; cancelable: boolean } | null>(null);
    const uploadAbortReasonRef = React.useRef<'user' | 'error' | null>(null);
    const mountedRef = React.useRef(false);

    // Controllers already own transfer cancellation. A real hook unmount must
    // retire those same in-flight operations instead of allowing a stale
    // upload/download callback to publish into a vanished file surface.
    React.useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            uploadAbortReasonRef.current = 'user';
            uploadAbortRef.current?.abort();
            downloadOperationRef.current?.controller.abort();
        };
    }, [stableWorkspaceScope]);

    const cancelUploads = React.useCallback(() => {
        uploadAbortReasonRef.current = 'user';
        uploadAbortRef.current?.abort();
    }, []);
    const dismissUploadFailure = React.useCallback(() => {
        setUploadState((prev) => prev.status === 'error' ? { status: 'idle' } : prev);
    }, []);

    const cancelDownload = React.useCallback(() => {
        const operation = downloadOperationRef.current;
        if (operation?.cancelable) operation.controller.abort();
    }, []);

    const startUploads = React.useCallback(async (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>): Promise<WorkspaceTransferResult> => {
        if (uploadAbortRef.current) {
            return { ok: false, error: 'Uploads already in progress' };
        }

        const controller = new AbortController();
        uploadAbortRef.current = controller;
        uploadAbortReasonRef.current = null;
        let uploadFailure: Readonly<{ error: string; reason: TransferFailureReason }> | null = null;
        const isCurrentUpload = (): boolean => (
            mountedRef.current && uploadAbortRef.current === controller
        );
        const setCurrentUploadState: typeof setUploadState = (next) => {
            if (isCurrentUpload()) setUploadState(next);
        };

        try {
            setCurrentUploadState({
                status: 'preflighting',
                totalFiles: input.entries.length,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes: 0,
            });

            const plan = await buildUploadEntryPlan({
                workspaceScope: stableWorkspaceScope,
                entries: input.entries,
                destinationDir: input.destinationDir,
                onResolveConflicts: onResolveUploadConflicts ?? null,
                signal: controller.signal,
            });
            if (!plan.ok) {
                if (plan.error === UPLOAD_CANCELED_ERROR) {
                    setCurrentUploadState({ status: 'canceled' });
                    return uploadCanceledResult();
                }
                setCurrentUploadState({ status: 'error', error: plan.error, reason: plan.reason ?? 'other' });
                return { ok: false, error: plan.error };
            }

            const tasks = plan.tasks;
            const totalBytes = tasks.reduce((sum, t) => sum + t.sizeBytes, 0);
            setCurrentUploadState({
                status: 'uploading',
                totalFiles: tasks.length,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes,
            });

            const scope = stableWorkspaceScope;
            if (!scope) {
                setCurrentUploadState({ status: 'error', error: 'Workspace scope not available', reason: 'other' });
                return { ok: false, error: 'Workspace scope not available' };
            }

            const resolvedMaxConcurrentUploads = typeof maxConcurrentUploads === 'number' && Number.isFinite(maxConcurrentUploads)
                ? Math.max(1, Math.floor(maxConcurrentUploads))
                : 3;

            let nextIndex = 0;
            let cancelled = false;
            const cancelOnce = () => {
                if (cancelled) return;
                cancelled = true;
                controller.abort();
            };
            // The first failure is the batch's. Aborting the controller makes every sibling upload raise an abort of
            // its own (or the person cancelled): those are consequences of the first outcome, never another failure.
            const recordFailure = (error: string, reason: TransferFailureReason) => {
                if (controller.signal.aborted) return;
                uploadFailure = { error, reason };
                uploadAbortReasonRef.current = 'error';
                cancelOnce();
                setCurrentUploadState({ status: 'error', error, reason });
            };

            const workers = Array.from({ length: Math.min(resolvedMaxConcurrentUploads, tasks.length) }, () => (async () => {
                while (true) {
                    if (controller.signal.aborted) return;
                    const index = nextIndex;
                    nextIndex += 1;
                    const task = tasks[index];
                    if (!task) return;

                    let source: Awaited<ReturnType<typeof openWorkspaceUploadSourceReader>> | null = null;
                    let sourceClosed = false;
                    const closeSourceOnce = async () => {
                        if (!source || sourceClosed) {
                            return;
                        }
                        sourceClosed = true;
                        await source.close();
                    };
                    try {
                        source = await openWorkspaceUploadSourceReader(task.entry);
                        const fileReader = {
                            ...source,
                            close: async () => await closeSourceOnce(),
                        };
                        let lastUploaded = 0;
                        let result = await uploadDaemonWorkspaceFileFromReader({
                            machineId: scope.machineId,
                            serverId: scope.serverId,
                            rootPath: scope.rootPath,
                            fileReader,
                            request: {
                                path: task.targetPath,
                                sizeBytes: task.sizeBytes,
                                overwrite: task.overwrite,
                            },
                            onProgress: (progress) => {
                                const delta = progress.uploadedBytes - lastUploaded;
                                lastUploaded = progress.uploadedBytes;
                                if (delta <= 0) return;
                                setCurrentUploadState((prev) => {
                                    if (prev.status !== 'uploading') return prev;
                                    return {
                                        ...prev,
                                        uploadedBytes: prev.uploadedBytes + delta,
                                    };
                                });
                            },
                            signal: controller.signal,
                        });

                        if (isTransferFinalizeRecoveryFailure<WorkspaceFileUploadFinalizeResponse>(result)) {
                            setCurrentUploadState({ status: 'error', error: result.error, reason: 'unconfirmed' });
                            const recoveryResult = await runTransferFinalizeRecovery({
                                recovery: result.recovery,
                                signal: controller.signal,
                                title: t('transferRecovery.title'),
                                message: t('transferRecovery.message'),
                            });
                            if (recoveryResult?.status === 'finalized') {
                                result = recoveryResult.response;
                            } else {
                                result = {
                                    success: false,
                                    errorCode: result.errorCode,
                                    error: recoveryResult?.status === 'unavailable'
                                        ? t('transferRecovery.unavailable')
                                        : recoveryResult?.status === 'discarded'
                                            ? t('transferRecovery.discarded')
                                            : result.error,
                                };
                            }
                        }

                        if (result.success !== true) {
                            recordFailure(result.error, classifyTransferFailure({ errorCode: result.errorCode }));
                            return;
                        }
                    } catch (error) {
                        recordFailure(error instanceof Error ? error.message : 'Upload failed', classifyTransferFailure({ thrown: error }));
                        return;
                    } finally {
                        try {
                            await closeSourceOnce();
                        } catch {
                            // ignore close failures so the batch can continue reporting the original error.
                        }
                    }

                    setCurrentUploadState((prev) => {
                        if (prev.status !== 'uploading') return prev;
                        return {
                            ...prev,
                            completedFiles: prev.completedFiles + 1,
                        };
                    });
                }
            })());

            await Promise.all(workers);

            if (uploadAbortReasonRef.current === 'user') {
                setCurrentUploadState({ status: 'canceled' });
                return uploadCanceledResult();
            }

            if (uploadAbortReasonRef.current === 'error') {
                const failure = uploadFailure ?? { error: 'Upload failed', reason: 'other' as const };
                setCurrentUploadState({ status: 'error', error: failure.error, reason: failure.reason });
                return { ok: false, error: failure.error };
            }

            if (controller.signal.aborted) {
                setCurrentUploadState({ status: 'canceled' });
                return uploadCanceledResult();
            }

            setCurrentUploadState({ status: 'done', totalFiles: tasks.length, totalBytes });
            if (isCurrentUpload() && !controller.signal.aborted) onAfterUploadSuccess?.();
            return { ok: true };
        } catch (error) {
            // The batch settles as a result, never a rejection the caller would surface as the raw error.
            if (isAbortError(error) || controller.signal.aborted) {
                setCurrentUploadState({ status: 'canceled' });
                return uploadCanceledResult();
            }
            const message = error instanceof Error ? error.message : 'Upload failed';
            setCurrentUploadState({ status: 'error', error: message, reason: classifyTransferFailure({ thrown: error }) });
            return { ok: false, error: message };
        } finally {
            if (uploadAbortRef.current === controller) {
                uploadAbortRef.current = null;
                uploadAbortReasonRef.current = null;
            }
        }
    }, [maxConcurrentUploads, onAfterUploadSuccess, onResolveUploadConflicts, stableWorkspaceScope]);

    const startDownload = React.useCallback(async (input: WorkspaceFileDownloadInput): Promise<WorkspaceTransferResult> => {
        if (downloadOperationRef.current) {
            return { ok: false, error: 'Download already in progress' };
        }

        const controller = new AbortController();
        const desktopOpening = Platform.OS === 'web' && desktopHostKind() === 'tauri' && input.action === 'open';
        const useWebSink = Platform.OS === 'web' && !desktopOpening;
        // A browser tab shows the bytes with Happier's origin, so the open owner admits the kind first.
        const tabMimeType = resolveFileViewerKind({ path: input.path }).mimeType;
        const opensTab = useWebSink && input.action === 'open' && opensInBrowserTab() && canOpenFileInDefaultApp(tabMimeType);
        const operation = { controller, cancelable: true };
        downloadOperationRef.current = operation;
        const isCurrentDownload = (): boolean => (
            mountedRef.current && downloadOperationRef.current === operation
        );
        const setCurrentDownloadState: typeof setDownloadState = (next) => {
            if (isCurrentDownload()) setDownloadState(next);
        };
        const beginNativeHandoff = () => {
            // The OS owns the action after handoff; app cancellation cannot
            // stop its copy, dismiss its share sheet, or retract a granted URI.
            operation.cancelable = false;
            setCurrentDownloadState(prev => prev.status === 'downloading' ? { ...prev, cancelable: false } : prev);
        };

        let failureMessage: string | null = null;
        let keepNativeSink = false;
        const nativeSinkRef: { current: NativeDownloadSink | null } = { current: null };
        const cleanupNativeSinkOnce = async () => {
            if (useWebSink || !nativeSinkRef.current) {
                return;
            }
            const sink = nativeSinkRef.current;
            nativeSinkRef.current = null;
            await sink.cleanup();
        };
        const webSinkRef: { current: WebDownloadFileSink | null } = { current: null };
        let webSinkCleanupScheduled = false;
        const webSinkFailureRef: { current: Error | null } = { current: null };
        const cleanupWebSinkOnce = async () => {
            if (!useWebSink || !webSinkRef.current) {
                return;
            }
            const sink = webSinkRef.current;
            webSinkRef.current = null;
            await sink.cleanup();
        };
        const webDownloadMaxBytes = resolveWebDownloadMaxBytes();
        const updateProgress = (progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => {
            setCurrentDownloadState((prev) => prev.status === 'downloading'
                ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                : prev);
        };

        let cleanupOverride: WorkspaceTransferResult | null = null;
        const download = (async (): Promise<WorkspaceTransferResult> => {
            try {
                const source = resolveWorkspaceFileDownloadSource({ workspaceScope: stableWorkspaceScope,
                    asZip: input.asZip, cachedContent: input.cachedContent });
                if (source.kind === 'held') {
                    const content = source.content;
                    setCurrentDownloadState({ status: 'downloading', name: content.fileName,
                        downloadedBytes: content.bytes.byteLength, totalBytes: content.bytes.byteLength });
                    const result = await saveFileBytes({ ...content, action: input.action ?? 'save',
                        isCurrent: () => isCurrentDownload() && !controller.signal.aborted,
                        onHandoff: beginNativeHandoff });
                    if (result === 'canceled') {
                        setCurrentDownloadState({ status: 'canceled' });
                        return { ok: false, error: 'Download canceled', canceled: true };
                    }
                    setCurrentDownloadState({ status: 'done', name: content.fileName, totalBytes: content.bytes.byteLength });
                    return { ok: true };
                }
                if (source.kind === 'unavailable') {
                    setCurrentDownloadState({ status: 'error', error: 'Workspace scope not available' });
                    return { ok: false, error: 'Workspace scope not available' };
                }
                const scope = source.scope;

                setCurrentDownloadState({ status: 'downloading', name: input.path, downloadedBytes: 0, totalBytes: 0 });
                let res: Awaited<ReturnType<typeof downloadDaemonWorkspaceFileToDestination>> | null = null;
                try {
                    res = await downloadDaemonWorkspaceFileToDestination({
                        machineId: scope.machineId,
                        serverId: scope.serverId,
                        rootPath: scope.rootPath,
                        request: { path: input.path, asZip: input.asZip },
                        destination: {
                            writeBytes: async (bytes) => {
                                if (!isCurrentDownload() || controller.signal.aborted) {
                                    throw new Error('Download canceled');
                                }
                                if (useWebSink) {
                                    if (!webSinkRef.current) {
                                        throw new Error('Download sink unavailable');
                                    }
                                    try {
                                        await webSinkRef.current.writeBytes(bytes);
                                    } catch (error) {
                                        webSinkFailureRef.current = error instanceof Error ? error : new Error('Download sink unavailable');
                                        try {
                                            controller.abort();
                                        } catch {}
                                        throw error;
                                    }
                                    return;
                                }

                                if (!nativeSinkRef.current) {
                                    throw new Error('Download sink unavailable');
                                }
                                await nativeSinkRef.current.writeBytes(bytes);
                            },
                            close: async () => {
                                if (useWebSink && webSinkRef.current) {
                                    await webSinkRef.current.close();
                                } else if (nativeSinkRef.current) {
                                    await nativeSinkRef.current.close();
                                }
                            },
                            cleanup: async () => {
                                if (useWebSink) {
                                    await cleanupWebSinkOnce();
                                    return;
                                }

                                await cleanupNativeSinkOnce();
                            },
                        },
                        onInit: async (init) => {
                            if (!isCurrentDownload() || controller.signal.aborted) {
                                return { success: false, error: 'Download canceled' };
                            }
                            setCurrentDownloadState({
                                status: 'downloading',
                                name: init.name,
                                downloadedBytes: 0,
                                totalBytes: init.sizeBytes,
                            });

                            try {
                                const allocated = await createPlatformDownloadFileSink({ name: init.name, sizeBytes: init.sizeBytes,
                                    desktopOpening, webMaxBytes: webDownloadMaxBytes });
                                if (allocated.kind === 'web') webSinkRef.current = allocated.sink;
                                else nativeSinkRef.current = allocated.sink;
                            } catch (error) {
                                return {
                                    success: false,
                                    error: error instanceof Error ? error.message : 'Download sink unavailable',
                                };
                            }
                        },
                        signal: controller.signal,
                        onProgress: updateProgress,
                    });
                } catch (error) {
                    await cleanupNativeSinkOnce();
                    await cleanupWebSinkOnce();
                    const webSinkFailure = webSinkFailureRef.current;
                    const message = webSinkFailure?.message ?? (error instanceof Error ? error.message : t('errors.operationFailed'));
                    failureMessage = message;
                    if (!webSinkFailure && controller.signal.aborted) {
                        setCurrentDownloadState({ status: 'canceled' });
                        return { ok: false, error: 'Download canceled', canceled: true };
                    }
                    setCurrentDownloadState(webSinkFailure
                        ? { status: 'error', error: message }
                        : controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: message });
                    return { ok: false, error: message };
                }

                if (!res.ok) {
                    await cleanupNativeSinkOnce();
                    await cleanupWebSinkOnce();
                    if (controller.signal.aborted) {
                        setCurrentDownloadState({ status: 'canceled' });
                        return { ok: false, error: 'Download canceled', canceled: true };
                    }
                    setCurrentDownloadState({ status: 'error', error: res.error });
                    return { ok: false, error: res.error };
                }

                if (!isCurrentDownload() || controller.signal.aborted) {
                    await cleanupNativeSinkOnce();
                    await cleanupWebSinkOnce();
                    return { ok: false, error: 'Download canceled', canceled: true };
                }

                if (useWebSink) {
                    if (!webSinkRef.current) {
                        setCurrentDownloadState({ status: 'error', error: 'Download sink unavailable' });
                        return { ok: false, error: 'Download sink unavailable' };
                    }
                    const file = await webSinkRef.current.getFile();
                    if (!isCurrentDownload() || controller.signal.aborted) {
                        await cleanupWebSinkOnce();
                        return { ok: false, error: 'Download canceled', canceled: true };
                    }
                    if (opensTab) {
                        const shown = await openWebFileInTab(file, tabMimeType);
                        // The press expired while the bytes arrived: offer the tab from a new press.
                        if (!shown.opened) offerBlockedWebFileTab(shown.open);
                    } else {
                        webSinkCleanupScheduled = true;
                        downloadWebFile(file, res.name || 'download', cleanupWebSinkOnce);
                    }
                } else if (nativeSinkRef.current) {
                    const action = input.action ?? 'save';
                    if (desktopOpening) {
                        beginNativeHandoff();
                        await openInDefaultApp({ path: nativeSinkRef.current.fileUri, invoke: invokeDesktopHost });
                        keepNativeSink = true;
                    } else {
                        const shared = await shareNativeCacheFile({
                            fileUri: nativeSinkRef.current.fileUri,
                            name: res.name || 'download',
                            action,
                            isCurrent: () => isCurrentDownload() && !controller.signal.aborted,
                            onHandoff: beginNativeHandoff,
                        });
                        if (shared.status === 'canceled') {
                            setCurrentDownloadState({ status: 'canceled' });
                            return { ok: false, error: 'Download canceled', canceled: true };
                        }
                        if (shared.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
                        keepNativeSink = shared.retainCacheFile;
                    }
                    if (!keepNativeSink) await cleanupNativeSinkOnce();
                } else {
                    setCurrentDownloadState({ status: 'error', error: 'Download sink unavailable' });
                    return { ok: false, error: 'Download sink unavailable' };
                }

                if (controller.signal.aborted && operation.cancelable) {
                    if (!keepNativeSink) await cleanupNativeSinkOnce();
                    setCurrentDownloadState({ status: 'canceled' });
                    return { ok: false, error: 'Download canceled', canceled: true };
                }

                setCurrentDownloadState((prev) => prev.status === 'downloading'
                    ? { status: 'done', name: prev.name, totalBytes: prev.totalBytes }
                    : prev);
                return { ok: true };
            } catch (error) {
                let message = error instanceof Error ? error.message : t('errors.operationFailed');
                try {
                    await cleanupNativeSinkOnce();
                } catch (cleanupError) {
                    message += `; ${t('files.fileCleanupFailed')}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
                }
                failureMessage = message;
                setCurrentDownloadState({ status: 'error', error: message });
                return { ok: false, error: message };
            }
        })();
        return download.finally(async () => {
            let cleanupResult: WorkspaceTransferResult | null = null;
            try {
                if (!keepNativeSink) await cleanupNativeSinkOnce();
                if (useWebSink && !webSinkCleanupScheduled) {
                    await cleanupWebSinkOnce();
                }
            } catch (error) {
                const cleanupMessage = error instanceof Error ? error.message : t('files.fileCleanupFailed');
                const message = failureMessage
                    ? `${failureMessage}; ${t('files.fileCleanupFailed')}: ${cleanupMessage}`
                    : cleanupMessage;
                setCurrentDownloadState({ status: 'error', error: message });
                cleanupResult = { ok: false, error: message };
            } finally {
                if (downloadOperationRef.current === operation) downloadOperationRef.current = null;
            }
            cleanupOverride = cleanupResult;
        }).then(
            result => cleanupOverride ?? result,
            (error: unknown) => {
                if (cleanupOverride) return cleanupOverride;
                throw error;
            },
        );
    }, [stableWorkspaceScope]);

    return React.useMemo(() => ({
        uploadState,
        downloadState,
        startUploads,
        cancelUploads,
        dismissUploadFailure,
        startDownload,
        cancelDownload,
    }), [
        cancelDownload,
        cancelUploads,
        dismissUploadFailure,
        downloadState,
        startDownload,
        startUploads,
        uploadState,
    ]);
}
