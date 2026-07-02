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
    }>
    | Readonly<{ status: 'done'; name: string; totalBytes: number }>
    | Readonly<{ status: 'canceled' }>
    | Readonly<{ status: 'error'; error: string }>;

type TransferResult = { ok: true } | { ok: false; error: string };

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
    const scope = input.workspaceScope;
    if (!scope) {
        return { ok: false, error: 'Workspace scope not available' };
    }

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
                const stat = await callDaemonWorkspaceStatFileRpc({
                    machineId: scope.machineId,
                    serverId: scope.serverId,
                    rootPath: scope.rootPath,
                    request: { path: candidatePath },
                });
                return stat.success !== true || stat.exists === true;
            },
        });
        tasks[i] = { ...existing, targetPath: resolved, overwrite: false };
        usedPaths.add(resolved);
    }

    const conflicts: Array<{ index: number; targetPath: string }> = [];

    for (let i = 0; i < tasks.length; i += 1) {
        const stat = await callDaemonWorkspaceStatFileRpc({
            machineId: scope.machineId,
            serverId: scope.serverId,
            rootPath: scope.rootPath,
            request: { path: tasks[i]!.targetPath },
        });
        if (stat.success === true && stat.exists === true) {
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
                const stat = await callDaemonWorkspaceStatFileRpc({
                    machineId: scope.machineId,
                    serverId: scope.serverId,
                    rootPath: scope.rootPath,
                    request: { path: candidatePath },
                });
                return stat.success !== true || stat.exists === true;
            },
        });
        tasks[conflict.index] = { ...original, targetPath: resolved, overwrite: false };
        usedPaths.add(resolved);
    }

    return { ok: true, tasks };
}

type NativeDownloadSink = NativeCacheFileSink;

export function useWorkspaceFileTransfers(params: Readonly<{
    workspaceScope: WorkspaceScopeBase | null;
    maxConcurrentUploads?: number;
    onResolveUploadConflicts?: ((params: Readonly<{ conflictCount: number; totalCount: number }>) => Promise<UploadConflictStrategy>) | null;
    onAfterUploadSuccess?: (() => void) | null;
}>): Readonly<{
    uploadState: WorkspaceUploadState;
    downloadState: WorkspaceDownloadState;
    startUploads: (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>) => Promise<TransferResult>;
    cancelUploads: () => void;
    startDownload: (input: Readonly<{ path: string; asZip: boolean }>) => Promise<TransferResult>;
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

    const cancelUploads = React.useCallback(() => {
        uploadAbortReasonRef.current = 'user';
        uploadAbortRef.current?.abort();
    }, []);

    const cancelDownload = React.useCallback(() => {
        downloadAbortRef.current?.abort();
    }, []);

    const startUploads = React.useCallback(async (input: Readonly<{ entries: readonly WorkspaceUploadEntry[]; destinationDir: string }>): Promise<TransferResult> => {
        if (uploadAbortRef.current) {
            return { ok: false, error: 'Uploads already in progress' };
        }

        const controller = new AbortController();
        uploadAbortRef.current = controller;
        uploadAbortReasonRef.current = null;
        let uploadFailureError: string | null = null;

        try {
            setUploadState({
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

            const scope = stableWorkspaceScope;
            if (!scope) {
                setUploadState({ status: 'error', error: 'Workspace scope not available' });
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
                        const result = await uploadDaemonWorkspaceFileFromReader({
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
                            uploadFailureError = result.error;
                            if (uploadAbortReasonRef.current !== 'user') {
                                uploadAbortReasonRef.current = 'error';
                            }
                            cancelOnce();
                            setUploadState({ status: 'error', error: result.error });
                            return;
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : 'Upload failed';
                        uploadFailureError = errorMessage;
                        if (uploadAbortReasonRef.current !== 'user') {
                            uploadAbortReasonRef.current = 'error';
                        }
                        cancelOnce();
                        setUploadState({ status: 'error', error: errorMessage });
                        return;
                    } finally {
                        try {
                            await closeSourceOnce();
                        } catch {
                            // ignore close failures so the batch can continue reporting the original error.
                        }
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

            if (uploadAbortReasonRef.current === 'user') {
                setUploadState({ status: 'canceled' });
                return { ok: false, error: 'Upload canceled' };
            }

            if (uploadAbortReasonRef.current === 'error') {
                const error = uploadFailureError ?? 'Upload failed';
                setUploadState({ status: 'error', error });
                return { ok: false, error };
            }

            if (controller.signal.aborted) {
                setUploadState({ status: 'error', error: 'Upload canceled' });
                return { ok: false, error: 'Upload canceled' };
            }

            setUploadState({ status: 'done', totalFiles: tasks.length, totalBytes });
            onAfterUploadSuccess?.();
            return { ok: true };
        } finally {
            uploadAbortRef.current = null;
            uploadAbortReasonRef.current = null;
        }
    }, [maxConcurrentUploads, onAfterUploadSuccess, onResolveUploadConflicts, stableWorkspaceScope]);

    const startDownload = React.useCallback(async (input: Readonly<{ path: string; asZip: boolean }>): Promise<TransferResult> => {
        if (downloadAbortRef.current) {
            return { ok: false, error: 'Download already in progress' };
        }

        const controller = new AbortController();
        downloadAbortRef.current = controller;

        const nativeSinkRef: { current: NativeDownloadSink | null } = { current: null };
        let nativeSinkCleaned = false;
        const cleanupNativeSinkOnce = async () => {
            if (Platform.OS === 'web' || !nativeSinkRef.current || nativeSinkCleaned) {
                return;
            }
            nativeSinkCleaned = true;
            await nativeSinkRef.current.cleanup();
        };
        const downloadedChunks: Uint8Array[] = [];
        let webBufferedBytes = 0;
        let webExceededLimit = false;
        const webDownloadMaxBytes = resolveWebDownloadMaxBytes();
        const updateProgress = (progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => {
            setDownloadState((prev) => prev.status === 'downloading'
                ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                : prev);
        };

        try {
            const scope = stableWorkspaceScope;
            if (!scope) {
                setDownloadState({ status: 'error', error: 'Workspace scope not available' });
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

                            await cleanupNativeSinkOnce();
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
                const message = error instanceof Error ? error.message : 'Download failed';
                setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: message });
                return { ok: false, error: message };
            }

            if (Platform.OS === 'web' && webExceededLimit) {
                setDownloadState({ status: 'error', error: 'File exceeds the web download size limit' });
                return { ok: false, error: 'File exceeds the web download size limit' };
            }

            if (!res.ok) {
                await cleanupNativeSinkOnce();
                setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: res.error });
                return { ok: false, error: res.error };
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
                    try { anchor.style.display = 'none'; } catch {}
                    try { document.body?.appendChild(anchor); } catch {}
                    anchor.click();

                    // Defer DOM cleanup to the next task so browser download observers still see
                    // the synthetic anchor click as a real download navigation.
                    setTimeout(() => {
                        try { anchor.remove(); } catch { }
                    }, 0);
                } finally {
                    setTimeout(() => {
                        try { URL.revokeObjectURL(url); } catch { }
                    }, 1_000);
                }
            } else if (nativeSinkRef.current) {
                try {
                    const Sharing: any = await import('expo-sharing');
                    if (Sharing && typeof Sharing.isAvailableAsync === 'function') {
                        const available = await Sharing.isAvailableAsync();
                        if (available && typeof Sharing.shareAsync === 'function') {
                            await Sharing.shareAsync(nativeSinkRef.current.fileUri);
                        }
                    }
                } catch {
                    // Best-effort share only.
                }
                await cleanupNativeSinkOnce();
            } else {
                setDownloadState({ status: 'error', error: 'Download sink unavailable' });
                return { ok: false, error: 'Download sink unavailable' };
            }

            if (controller.signal.aborted) {
                await cleanupNativeSinkOnce();
                setDownloadState({ status: 'canceled' });
                return { ok: false, error: 'Download canceled' };
            }

            setDownloadState((prev) => prev.status === 'downloading'
                ? { status: 'done', name: prev.name, totalBytes: prev.totalBytes }
                : prev);
            return { ok: true };
        } finally {
            if (Platform.OS === 'web') {
                webBufferedBytes = 0;
                downloadedChunks.length = 0;
            }
            downloadAbortRef.current = null;
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
