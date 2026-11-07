import * as React from 'react';
import { Platform } from 'react-native';
import { t } from '@/text';

import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import { downloadDaemonSessionFileToDestination, resolveDaemonSessionFileDownloadUrl, uploadDaemonSessionFileFromReader } from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { sessionStatFile } from '@/sync/ops';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import { createNativeCacheFileSink, shareNativeCacheFile, type NativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import { resolveWebFileBufferMaxBytes } from '@/sync/runtime/files/webFileBufferBudget';

export type WorkspaceUploadEntry =
    | Readonly<{ kind: 'web'; file: File; relativePath: string }>
    | Readonly<{ kind: 'native'; uri: string; name: string; sizeBytes: number | null; mimeType: string | null; relativePath: string }>;

export type UploadConflictStrategy = 'skip' | 'replace' | 'keep_both' | 'cancel';

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
    | Readonly<{ status: 'error'; error: string }>;

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

type TransferResult = { ok: true } | { ok: false; error: string; canceled?: boolean };
export type WorkspaceFileTransferResult = TransferResult;
export type WorkspaceFileDownloadAction = 'save' | 'open' | 'share';
type WorkspaceFileDownloadInput = Readonly<{ path: string; asZip: boolean; action?: WorkspaceFileDownloadAction }>;

function joinRepoPath(parentDir: string, relativePath: string): string {
    const cleanParent = String(parentDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const cleanRel = String(relativePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/g, '');
    if (!cleanParent) return cleanRel.replace(/\/+/g, '/');
    if (!cleanRel) return cleanParent;
    return `${cleanParent}/${cleanRel}`.replace(/\/+/g, '/');
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

export async function buildUploadEntryPlan(input: Readonly<{
    sessionId: string;
    entries: readonly WorkspaceUploadEntry[];
    destinationDir: string;
    onResolveConflicts?: ((params: Readonly<{ conflictCount: number; totalCount: number }>) => Promise<UploadConflictStrategy>) | null;
}>): Promise<{ ok: true; tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> } | { ok: false; error: string }> {
    const destinationDir = String(input.destinationDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> = [];

    const invalidPaths: string[] = [];
    for (const entry of input.entries) {
        const relativePath = String(entry.relativePath ?? '').trim();
        const targetPath = joinRepoPath(destinationDir, relativePath);
        if (!targetPath || !isSafeWorkspaceRelativePath(targetPath)) {
            invalidPaths.push(relativePath || '(empty)');
            continue;
        }

        let sizeBytes: number | null = null;
        if (entry.kind === 'web') {
            sizeBytes = entry.file.size;
        } else {
            sizeBytes = typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null;
            if (sizeBytes == null) {
                sizeBytes = await resolveLocalUploadSourceSizeBytes(entry);
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

    // Detect collisions within the current upload batch (common on native when multiple picked files share a basename).
    // Resolve them eagerly via keep-both logic so the upload plan never contains duplicate target paths.
    for (let i = 0; i < tasks.length; i += 1) {
        const existing = tasks[i]!;
        if (!usedPaths.has(existing.targetPath)) {
            usedPaths.add(existing.targetPath);
            continue;
        }

        const resolved = await resolveKeepBothTargetPath({
            desiredPath: existing.targetPath,
            usedPaths,
            maxAttempts: 50,
            pathExists: async (candidatePath) => {
                const stat = await sessionStatFile(input.sessionId, candidatePath);
                return !stat.success || stat.exists === true;
            },
        });
        tasks[i] = { ...existing, targetPath: resolved, overwrite: false };
        usedPaths.add(resolved);
    }

    const conflicts: Array<{ index: number; targetPath: string }> = [];

    for (let i = 0; i < tasks.length; i += 1) {
        const stat = await sessionStatFile(input.sessionId, tasks[i]!.targetPath);
        if (stat.success && stat.exists === true) {
            conflicts.push({ index: i, targetPath: tasks[i]!.targetPath });
        }
    }

    if (conflicts.length === 0) {
        return { ok: true, tasks };
    }

    const strategy = input.onResolveConflicts
        ? await input.onResolveConflicts({ conflictCount: conflicts.length, totalCount: tasks.length })
        : 'keep_both';

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
        const original = tasks[conflict.index]!;
        const resolved = await resolveKeepBothTargetPath({
            desiredPath: original.targetPath,
            usedPaths,
            maxAttempts: 50,
            pathExists: async (candidatePath) => {
                const stat = await sessionStatFile(input.sessionId, candidatePath);
                return !stat.success || stat.exists === true;
            },
        });
        tasks[conflict.index] = { ...original, targetPath: resolved, overwrite: false };
        usedPaths.add(resolved);
    }

    return { ok: true, tasks };
}

export function useWorkspaceFileTransfers(params: Readonly<{
    sessionId: string;
    maxConcurrentUploads?: number;
    onResolveUploadConflicts?: ((params: Readonly<{ conflictCount: number; totalCount: number }>) => Promise<UploadConflictStrategy>) | null;
    onAfterUploadSuccess?: (() => void) | null;
}>): Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    startUploads: (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>) => Promise<TransferResult>;
    cancelUploads: () => void;
    startDownload: (input: WorkspaceFileDownloadInput) => Promise<TransferResult>;
    cancelDownload: () => void;
}> {
    const {
        sessionId,
        maxConcurrentUploads,
        onResolveUploadConflicts,
        onAfterUploadSuccess,
    } = params;
    const [uploadState, setUploadState] = React.useState<WorkspaceUploadState>({ status: 'idle' });
    const [downloadState, setDownloadState] = React.useState<WorkspaceDownloadState>({ status: 'idle' });

    const uploadAbortRef = React.useRef<AbortController | null>(null);
    const downloadOperationRef = React.useRef<{ controller: AbortController; cancelable: boolean } | null>(null);

    const cancelUploads = React.useCallback(() => {
        uploadAbortRef.current?.abort();
    }, []);

    const cancelDownload = React.useCallback(() => {
        const operation = downloadOperationRef.current;
        if (operation?.cancelable) operation.controller.abort();
    }, []);

    const startUploads = React.useCallback(async (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>): Promise<TransferResult> => {
        if (uploadAbortRef.current) {
            return { ok: false, error: 'Uploads already in progress' };
        }

        const controller = new AbortController();
        uploadAbortRef.current = controller;

        try {
            setUploadState({
                status: 'preflighting',
                totalFiles: input.entries.length,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes: 0,
            });

            const plan = await buildUploadEntryPlan({
                sessionId,
                entries: input.entries,
                destinationDir: input.destinationDir,
                onResolveConflicts: onResolveUploadConflicts ?? null,
            });
            if (!plan.ok) {
                setUploadState(plan.error === 'Upload canceled' ? { status: 'canceled' } : { status: 'error', error: plan.error });
                return { ok: false, error: plan.error };
            }

            const tasks = plan.tasks;
            const totalBytes = tasks.reduce((sum, t) => sum + t.sizeBytes, 0);
            setUploadState({
                status: 'uploading',
                totalFiles: tasks.length,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes,
            });

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

            const workers = Array.from({ length: Math.min(resolvedMaxConcurrentUploads, tasks.length) }, () => (async () => {
                while (true) {
                    if (controller.signal.aborted) return;
                    const index = nextIndex;
                    nextIndex += 1;
                    const task = tasks[index];
                    if (!task) return;

                    const source = await openWorkspaceUploadSourceReader(task.entry);
                    let lastUploaded = 0;
                    const result = await uploadDaemonSessionFileFromReader({
                        sessionId,
                        fileReader: source,
                        request: {
                            path: task.targetPath,
                            sizeBytes: task.sizeBytes,
                            overwrite: task.overwrite,
                        },
                        onProgress: (progress) => {
                            const delta = progress.uploadedBytes - lastUploaded;
                            lastUploaded = progress.uploadedBytes;
                            if (delta <= 0) return;
                            setUploadState((prev) => {
                                if (prev.status !== 'uploading') return prev;
                                return {
                                    ...prev,
                                    uploadedBytes: prev.uploadedBytes + delta,
                                };
                            });
                        },
                        signal: controller.signal,
                    });

                    if (result.success !== true) {
                        cancelOnce();
                        setUploadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: result.error });
                        return;
                    }

                    setUploadState((prev) => {
                        if (prev.status !== 'uploading') return prev;
                        return {
                            ...prev,
                            completedFiles: prev.completedFiles + 1,
                        };
                    });
                }
            })());

            await Promise.all(workers);

            if (controller.signal.aborted) {
                setUploadState({ status: 'canceled' });
                return { ok: false, error: 'Upload canceled' };
            }

            setUploadState({ status: 'done', totalFiles: tasks.length, totalBytes });
            onAfterUploadSuccess?.();
            return { ok: true };
        } finally {
            uploadAbortRef.current = null;
        }
    }, [maxConcurrentUploads, onAfterUploadSuccess, onResolveUploadConflicts, sessionId]);

    const startDownload = React.useCallback(async (input: WorkspaceFileDownloadInput): Promise<TransferResult> => {
        if (downloadOperationRef.current) {
            return { ok: false, error: 'Download already in progress' };
        }

        const controller = new AbortController();
        const operation = { controller, cancelable: true };
        downloadOperationRef.current = operation;
        const beginNativeHandoff = () => {
            if (controller.signal.aborted) {
                setDownloadState({ status: 'canceled' });
                return false;
            }
            // The OS owns the action after handoff; app cancellation cannot
            // stop its copy, dismiss its share sheet, or retract a granted URI.
            operation.cancelable = false;
            setDownloadState(prev => prev.status === 'downloading' ? { ...prev, cancelable: false } : prev);
            return true;
        };

        const nativeSinkRef: { current: NativeCacheFileSink | null } = { current: null };
        const action = input.action ?? 'save';
        let keepNativeSink = false;
        let failureMessage: string | null = null;
        const downloadedChunks: Uint8Array[] = [];
        let webBufferedBytes = 0;
        let webExceededLimit = false;
        const webDownloadMaxBytes = resolveWebFileBufferMaxBytes();
        const updateProgress = (progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => {
            setDownloadState((prev) => prev.status === 'downloading'
                ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                : prev);
        };

        let cleanupOverride: TransferResult | null = null;
        const download = (async (): Promise<TransferResult> => {
            try {
                if (action === 'save' && !input.asZip) {
                    setDownloadState({ status: 'downloading', name: input.path, downloadedBytes: 0, totalBytes: 0, cancelable: true });
                    const direct = await resolveDaemonSessionFileDownloadUrl({ sessionId, path: input.path });
                    if (!direct.success) throw new Error(direct.error);
                    if (direct.url) {
                        if (!beginNativeHandoff()) return { ok: false, canceled: true, error: 'Download canceled' };
                        // Same-window web downloads avoid popup blocking after the link RPC. Tauri/native
                        // still use the existing OS browser opener. Do not claim the OS download completed.
                        if (!await openExternalUrl(direct.url, { webTarget: '_self' })) throw new Error(t('errors.operationFailed'));
                        setDownloadState({ status: 'idle' });
                        return { ok: true };
                    }
                    if (controller.signal.aborted) return { ok: false, canceled: true, error: 'Download canceled' };
                }
                const res = await downloadDaemonSessionFileToDestination({
                    sessionId,
                    request: { path: input.path, asZip: input.asZip },
                    destination: {
                        writeBytes: async (bytes) => {
                            if (Platform.OS === 'web') {
                                if (webExceededLimit) {
                                    return;
                                }

                                webBufferedBytes += bytes.byteLength;
                                if (webBufferedBytes > webDownloadMaxBytes) {
                                    webExceededLimit = true;
                                    // Stop the transfer as early as possible without throwing through the pipeline.
                                    try {
                                        controller.abort();
                                    } catch {}

                                    webBufferedBytes = 0;
                                    downloadedChunks.length = 0;
                                    return;
                                }

                                downloadedChunks.push(new Uint8Array(bytes));
                                return;
                            }

                            if (!nativeSinkRef.current) {
                                throw new Error('Download sink unavailable');
                            }
                            await nativeSinkRef.current.writeBytes(bytes);
                        },
                        close: async () => {
                            if (Platform.OS !== 'web' && nativeSinkRef.current) {
                                await nativeSinkRef.current.close();
                            }
                        },
                        cleanup: async () => {
                            if (Platform.OS === 'web') {
                                webBufferedBytes = 0;
                                downloadedChunks.length = 0;
                                return;
                            }

                            if (nativeSinkRef.current) {
                                await nativeSinkRef.current.cleanup();
                            }
                        },
                    },
                    onInit: async (init) => {
                        setDownloadState({
                            status: 'downloading',
                            name: init.name,
                            downloadedBytes: 0,
                            totalBytes: init.sizeBytes,
                        });

                        if (Platform.OS === 'web') {
                            if (init.sizeBytes > webDownloadMaxBytes) {
                                return {
                                    success: false,
                                    error: 'File exceeds the web download size limit',
                                };
                            }
                            webBufferedBytes = 0;
                            webExceededLimit = false;
                            return;
                        }

                        const sink = await createNativeCacheFileSink({
                            directoryName: 'happier-downloads',
                            name: init.name || 'download',
                        });
                        if (!sink.ok) {
                            return {
                                success: false,
                                error: sink.error,
                            };
                        }
                        nativeSinkRef.current = sink.sink;
                    },
                    signal: controller.signal,
                    onProgress: updateProgress,
                });

                if (Platform.OS === 'web' && webExceededLimit) {
                    setDownloadState({ status: 'error', error: 'File exceeds the web download size limit' });
                    return { ok: false, error: 'File exceeds the web download size limit' };
                }

                if (!res.ok) {
                    failureMessage = res.error;
                    const canceled = controller.signal.aborted && operation.cancelable;
                    setDownloadState(canceled ? { status: 'canceled' } : { status: 'error', error: res.error });
                    return { ok: false, error: res.error, ...(canceled ? { canceled: true } : {}) };
                }

                if (Platform.OS === 'web') {
                    const blob = new Blob(downloadedChunks as BlobPart[], { type: 'application/octet-stream' });
                    downloadedChunks.length = 0;
                    const url = URL.createObjectURL(blob);
                    try {
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.download = res.name || 'download';
                        anchor.rel = 'noopener noreferrer';
                        anchor.click();
                    } finally {
                        setTimeout(() => {
                            try { URL.revokeObjectURL(url); } catch { }
                        }, 1_000);
                    }
                } else if (nativeSinkRef.current) {
                    if (controller.signal.aborted) {
                        setDownloadState({ status: 'canceled' });
                        return { ok: false, error: 'Download canceled', canceled: true };
                    }
                    const action = input.action ?? 'save';
                    if (Platform.OS === 'android' && action !== 'share') {
                        const { performAndroidFileAction } = await import('@/sync/runtime/files/nativeFileActions');
                        if (!beginNativeHandoff()) return { ok: false, error: 'Download canceled', canceled: true };
                        const result = await performAndroidFileAction({
                            fileUri: nativeSinkRef.current.fileUri,
                            name: res.name || 'download',
                            action,
                        });
                        if (result.canceled) {
                            setDownloadState({ status: 'canceled' });
                            return { ok: false, error: 'Download canceled', canceled: true };
                        }
                        keepNativeSink = action === 'open';
                    } else {
                        const result = await shareNativeCacheFile({
                            fileUri: nativeSinkRef.current.fileUri,
                            name: res.name || 'download',
                            isCurrent: () => !controller.signal.aborted,
                            onHandoff: () => { beginNativeHandoff(); },
                        });
                        if (result.status === 'canceled') {
                            setDownloadState({ status: 'canceled' });
                            return { ok: false, error: 'Download canceled', canceled: true };
                        }
                        if (result.status === 'unavailable') throw new Error(t('files.fileSharingUnavailable'));
                        keepNativeSink = result.retainCacheFile;
                    }
                } else {
                    setDownloadState({ status: 'error', error: 'Download sink unavailable' });
                    return { ok: false, error: 'Download sink unavailable' };
                }

                if (controller.signal.aborted && operation.cancelable) {
                    if (nativeSinkRef.current && !keepNativeSink) {
                        await nativeSinkRef.current.cleanup();
                    }
                    setDownloadState({ status: 'canceled' });
                    return { ok: false, error: 'Download canceled', canceled: true };
                }

                setDownloadState((prev) => prev.status === 'downloading'
                    ? { status: 'done', name: prev.name, totalBytes: prev.totalBytes }
                    : prev);
                return { ok: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : t('errors.operationFailed');
                failureMessage = message;
                const canceled = controller.signal.aborted && operation.cancelable;
                setDownloadState(canceled ? { status: 'canceled' } : { status: 'error', error: message });
                return { ok: false, error: message, ...(canceled ? { canceled: true } : {}) };
            }
        })();
        return download.finally(async () => {
            let cleanupResult: TransferResult | null = null;
            try {
                if (nativeSinkRef.current && !keepNativeSink) await nativeSinkRef.current.cleanup();
            } catch (error) {
                const cleanupMessage = error instanceof Error ? error.message : t('files.fileCleanupFailed');
                const message = failureMessage ? `${failureMessage}; ${t('files.fileCleanupFailed')}: ${cleanupMessage}` : cleanupMessage;
                setDownloadState({ status: 'error', error: message });
                cleanupResult = { ok: false, error: message };
            } finally {
                if (Platform.OS === 'web') {
                    webBufferedBytes = 0;
                    downloadedChunks.length = 0;
                }
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
    }, [sessionId]);

    return React.useMemo(() => ({
        uploadState,
        downloadState,
        startUploads,
        cancelUploads,
        startDownload,
        cancelDownload,
    }), [
        cancelDownload,
        cancelUploads,
        downloadState,
        startDownload,
        startUploads,
        uploadState,
    ]);
}
