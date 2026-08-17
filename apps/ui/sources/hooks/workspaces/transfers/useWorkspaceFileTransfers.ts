import * as React from 'react';
import { Platform } from 'react-native';

import { openLocalUploadSourceReader } from '@/sync/runtime/files/localUploadSourceReader';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import {
    callDaemonWorkspaceStatFileRpc,
    downloadDaemonWorkspaceFileToDestination,
    uploadDaemonWorkspaceFileFromReader,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { resolveLocalUploadSourceSizeBytes } from '@/sync/runtime/files/localUploadSourceReader';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { createNativeCacheFileSink, type NativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import { createWebDownloadFileSink, type WebDownloadFileSink } from './webDownloadFileSink';
import { runTransferFinalizeRecovery } from '@/components/transfers/recovery/runTransferFinalizeRecovery';
import { t } from '@/text';
import { isTransferFinalizeRecoveryFailure } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import type { WorkspaceFileUploadFinalizeResponse } from '@/sync/domains/transfers/runtime/transferRuntime/families/workspaceFileTransfers';

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
    | Readonly<{ status: 'error'; error: string }>;

export type WorkspaceDownloadState =
    | Readonly<{ status: 'idle' }>
    | Readonly<{
        status: 'downloading';
        name: string;
        downloadedBytes: number;
        totalBytes: number;
    }>
    | Readonly<{ status: 'done'; name: string; totalBytes: number }>
    | Readonly<{ status: 'canceled' }>
    | Readonly<{ status: 'error'; error: string }>;

export type WorkspaceTransferResult = { ok: true } | { ok: false; error: string; canceled?: true };

function parseOptionalPositiveInt(value: unknown): number | undefined {
    const raw = String(value ?? '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return undefined;
    const normalized = Math.floor(parsed);
    return normalized > 0 ? normalized : undefined;
}

function resolveWebDownloadMaxBytes(): number {
    return (
        parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_DOWNLOAD_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPIER_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_HAPPY_FILES_PREVIEW_MAX_BYTES)
        ?? parseOptionalPositiveInt(process.env.EXPO_PUBLIC_FILES_PREVIEW_MAX_BYTES)
        // Conservative default to prevent unbounded buffering on web.
        ?? 50_000_000
    );
}

function joinRepoPath(parentDir: string, relativePath: string): string {
    const cleanParent = String(parentDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const cleanRel = String(relativePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/g, '');
    if (!cleanParent) return cleanRel.replace(/\/+/g, '/');
    if (!cleanRel) return cleanParent;
    return `${cleanParent}/${cleanRel}`.replace(/\/+/g, '/');
}

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

function uploadCanceledPlan(): { ok: false; error: string } {
    return { ok: false, error: 'Upload canceled' };
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
    workspaceScope: WorkspaceScopeBase | null;
    entries: readonly WorkspaceUploadEntry[];
    destinationDir: string;
    onResolveConflicts?: ((params: UploadConflictResolutionRequest) => Promise<UploadConflictStrategy>) | null;
    signal?: AbortSignal | null;
}>): Promise<{ ok: true; tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> } | { ok: false; error: string }> {
    const destinationDir = String(input.destinationDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const tasks: Array<{ entry: WorkspaceUploadEntry; targetPath: string; overwrite: boolean; sizeBytes: number }> = [];

    const invalidPaths: string[] = [];
    for (const entry of input.entries) {
        if (input.signal?.aborted) return uploadCanceledPlan();
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
                const stat = await callDaemonWorkspaceStatFileRpc({
                    machineId: scope.machineId,
                    serverId: scope.serverId,
                    rootPath: scope.rootPath,
                    request: { path: candidatePath },
                    ...(input.signal ? { signal: input.signal } : {}),
                });
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
        const statResult = await awaitUploadPreflight(callDaemonWorkspaceStatFileRpc({
            machineId: scope.machineId,
            serverId: scope.serverId,
            rootPath: scope.rootPath,
            request: { path: tasks[i]!.targetPath },
            ...(input.signal ? { signal: input.signal } : {}),
        }), input.signal);
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
                const stat = await callDaemonWorkspaceStatFileRpc({
                    machineId: scope.machineId,
                    serverId: scope.serverId,
                    rootPath: scope.rootPath,
                    request: { path: candidatePath },
                    ...(input.signal ? { signal: input.signal } : {}),
                });
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
    startDownload: (input: Readonly<{ path: string; asZip: boolean }>) => Promise<WorkspaceTransferResult>;
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
    const downloadAbortRef = React.useRef<AbortController | null>(null);
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
            downloadAbortRef.current?.abort();
        };
    }, []);

    const cancelUploads = React.useCallback(() => {
        uploadAbortReasonRef.current = 'user';
        uploadAbortRef.current?.abort();
    }, []);

    const cancelDownload = React.useCallback(() => {
        downloadAbortRef.current?.abort();
    }, []);

    const startUploads = React.useCallback(async (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>): Promise<WorkspaceTransferResult> => {
        if (uploadAbortRef.current) {
            return { ok: false, error: 'Uploads already in progress' };
        }

        const controller = new AbortController();
        uploadAbortRef.current = controller;
        uploadAbortReasonRef.current = null;
        let uploadFailureError: string | null = null;
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
                setCurrentUploadState(plan.error === 'Upload canceled' ? { status: 'canceled' } : { status: 'error', error: plan.error });
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
                setCurrentUploadState({ status: 'error', error: 'Workspace scope not available' });
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
                            setCurrentUploadState({ status: 'error', error: result.error });
                            const recoveryResult = await runTransferFinalizeRecovery({
                                recovery: result.recovery,
                                title: t('transferRecovery.title'),
                                message: t('transferRecovery.message'),
                            });
                            if (recoveryResult?.status === 'finalized') {
                                result = recoveryResult.response;
                            } else {
                                result = {
                                    success: false,
                                    error: recoveryResult?.status === 'unavailable'
                                        ? t('transferRecovery.unavailable')
                                        : recoveryResult?.status === 'discarded'
                                            ? t('transferRecovery.discarded')
                                            : result.error,
                                };
                            }
                        }

                        if (result.success !== true) {
                            uploadFailureError = result.error;
                            if (uploadAbortReasonRef.current !== 'user') {
                                uploadAbortReasonRef.current = 'error';
                            }
                            cancelOnce();
                            setCurrentUploadState({ status: 'error', error: result.error });
                            return;
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Upload failed';
                        uploadFailureError = errorMessage;
                        if (uploadAbortReasonRef.current !== 'user') {
                            uploadAbortReasonRef.current = 'error';
                        }
                        cancelOnce();
                        setCurrentUploadState({ status: 'error', error: errorMessage });
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
                return { ok: false, error: 'Upload canceled' };
            }

            if (uploadAbortReasonRef.current === 'error') {
                const error = uploadFailureError ?? 'Upload failed';
                setCurrentUploadState({ status: 'error', error });
                return { ok: false, error };
            }

            if (controller.signal.aborted) {
                setCurrentUploadState({ status: 'canceled' });
                return { ok: false, error: 'Upload canceled' };
            }

            setCurrentUploadState({ status: 'done', totalFiles: tasks.length, totalBytes });
            if (isCurrentUpload() && !controller.signal.aborted) onAfterUploadSuccess?.();
            return { ok: true };
        } finally {
            if (uploadAbortRef.current === controller) {
                uploadAbortRef.current = null;
                uploadAbortReasonRef.current = null;
            }
        }
    }, [maxConcurrentUploads, onAfterUploadSuccess, onResolveUploadConflicts, stableWorkspaceScope]);

    const startDownload = React.useCallback(async (input: Readonly<{ path: string; asZip: boolean }>): Promise<WorkspaceTransferResult> => {
        if (downloadAbortRef.current) {
            return { ok: false, error: 'Download already in progress' };
        }

        const controller = new AbortController();
        downloadAbortRef.current = controller;
        const isCurrentDownload = (): boolean => (
            mountedRef.current && downloadAbortRef.current === controller
        );
        const setCurrentDownloadState: typeof setDownloadState = (next) => {
            if (isCurrentDownload()) setDownloadState(next);
        };

        const nativeSinkRef: { current: NativeDownloadSink | null } = { current: null };
        const cleanupNativeSinkOnce = async () => {
            if (Platform.OS === 'web' || !nativeSinkRef.current) {
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
            if (Platform.OS !== 'web' || !webSinkRef.current) {
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

        try {
            const scope = stableWorkspaceScope;
            if (!scope) {
                setCurrentDownloadState({ status: 'error', error: 'Workspace scope not available' });
                return { ok: false, error: 'Workspace scope not available' };
            }

            let res: Awaited<ReturnType<typeof downloadDaemonWorkspaceFileToDestination>> | null = null;
            try {
                res = await downloadDaemonWorkspaceFileToDestination({
                    machineId: scope.machineId,
                    serverId: scope.serverId,
                    rootPath: scope.rootPath,
                    request: input,
                    destination: {
                        writeBytes: async (bytes) => {
                            if (!isCurrentDownload() || controller.signal.aborted) {
                                throw new Error('Download canceled');
                            }
                            if (Platform.OS === 'web') {
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
                            if (Platform.OS === 'web' && webSinkRef.current) {
                                await webSinkRef.current.close();
                            } else if (nativeSinkRef.current) {
                                await nativeSinkRef.current.close();
                            }
                        },
                        cleanup: async () => {
                            if (Platform.OS === 'web') {
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

                        if (Platform.OS === 'web') {
                            try {
                                webSinkRef.current = await createWebDownloadFileSink({
                                    expectedSizeBytes: init.sizeBytes,
                                    maxBytes: webDownloadMaxBytes,
                                });
                            } catch (error) {
                                return {
                                    success: false,
                                    error: error instanceof Error ? error.message : 'Download sink unavailable',
                                };
                            }
                            return;
                        }

                        const sink = await createNativeCacheFileSink({
                            directoryName: 'happier-downloads',
                            fileName: init.name || 'download',
                        });
                        if (!sink.ok) {
                            return {
                                success: false,
                                error: sink.error,
                            };
                        }
                        nativeSinkRef.current = sink;
                    },
                    signal: controller.signal,
                    onProgress: updateProgress,
                });
            } catch (error) {
                await cleanupNativeSinkOnce();
                await cleanupWebSinkOnce();
                const webSinkFailure = webSinkFailureRef.current;
                const message = webSinkFailure?.message ?? (error instanceof Error ? error.message : 'Download failed');
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

            if (Platform.OS === 'web') {
                if (!webSinkRef.current) {
                    setCurrentDownloadState({ status: 'error', error: 'Download sink unavailable' });
                    return { ok: false, error: 'Download sink unavailable' };
                }
                const file = await webSinkRef.current.getFile();
                if (!isCurrentDownload() || controller.signal.aborted) {
                    await cleanupWebSinkOnce();
                    return { ok: false, error: 'Download canceled', canceled: true };
                }
                const url = URL.createObjectURL(file);
                try {
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = res.name || 'download';
                    anchor.rel = 'noopener noreferrer';
                    try { anchor.style.display = 'none'; } catch {}
                    try { document.body?.appendChild(anchor); } catch {}
                    anchor.click();

                    // Defer DOM cleanup to the next task so browser download observers still see
                    // the synthetic anchor click as a real download navigation.
                    setTimeout(() => {
                        try { anchor.remove(); } catch { }
                    }, 0);
                } finally {
                    webSinkCleanupScheduled = true;
                    setTimeout(() => {
                        try { URL.revokeObjectURL(url); } catch { }
                        void cleanupWebSinkOnce();
                    }, 1_000);
                }
            } else if (nativeSinkRef.current) {
                try {
                    const Sharing: any = await import('expo-sharing');
                    if (isCurrentDownload() && !controller.signal.aborted && Sharing && typeof Sharing.isAvailableAsync === 'function') {
                        const available = await Sharing.isAvailableAsync();
                        if (isCurrentDownload() && !controller.signal.aborted && available && typeof Sharing.shareAsync === 'function') {
                            await Sharing.shareAsync(nativeSinkRef.current.fileUri);
                        }
                    }
                } catch {
                    // Best-effort share only.
                }
                await cleanupNativeSinkOnce();
            } else {
                setCurrentDownloadState({ status: 'error', error: 'Download sink unavailable' });
                return { ok: false, error: 'Download sink unavailable' };
            }

            if (controller.signal.aborted) {
                await cleanupNativeSinkOnce();
                setCurrentDownloadState({ status: 'canceled' });
                return { ok: false, error: 'Download canceled', canceled: true };
            }

            setCurrentDownloadState((prev) => prev.status === 'downloading'
                ? { status: 'done', name: prev.name, totalBytes: prev.totalBytes }
                : prev);
            return { ok: true };
        } finally {
            if (Platform.OS === 'web' && !webSinkCleanupScheduled) {
                await cleanupWebSinkOnce();
            }
            if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
        }
    }, [stableWorkspaceScope]);

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
