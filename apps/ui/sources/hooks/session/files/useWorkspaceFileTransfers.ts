import * as React from 'react';
import { Platform } from 'react-native';

import { uploadInChunks, downloadInChunks } from '@/sync/domains/files/transfers/chunkTransferClient';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import {
    sessionFilesDownloadAbort,
    sessionFilesDownloadChunk,
    sessionFilesDownloadFinalize,
    sessionFilesDownloadInit,
    sessionFilesUploadAbort,
    sessionFilesUploadChunk,
    sessionFilesUploadFinalize,
    sessionFilesUploadInit,
    sessionStatFile,
} from '@/sync/ops';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';

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

function joinRepoPath(parentDir: string, relativePath: string): string {
    const cleanParent = String(parentDir ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
    const cleanRel = String(relativePath ?? '').trim().replace(/\\/g, '/').replace(/^\/+/g, '');
    if (!cleanParent) return cleanRel.replace(/\/+/g, '/');
    if (!cleanRel) return cleanParent;
    return `${cleanParent}/${cleanRel}`.replace(/\/+/g, '/');
}

function joinFileUri(baseUri: string, childPath: string): string {
    const base = String(baseUri ?? '').trim();
    const child = String(childPath ?? '').trim().replace(/^\/+/g, '');
    if (!base) return child;
    if (!child) return base;
    const withSlash = base.endsWith('/') ? base : `${base}/`;
    return `${withSlash}${child}`;
}

async function readNativeFileSizeBestEffort(uri: string): Promise<number | null> {
    try {
        const FileSystem: any = await import('expo-file-system');
        const file = new FileSystem.File(uri);
        const handle = file.open();
        try {
            const fromHandle = typeof handle?.size === 'number' && Number.isFinite(handle.size) ? handle.size : null;
            const fromFile = typeof file?.size === 'number' && Number.isFinite(file.size) ? file.size : null;
            return fromHandle ?? fromFile;
        } finally {
            try { handle.close(); } catch { }
        }
    } catch {
        return null;
    }
}

async function buildUploadEntryPlan(input: Readonly<{
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
                sizeBytes = await readNativeFileSizeBestEffort(entry.uri);
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

    const usedPaths = new Set<string>(tasks.map((t) => t.targetPath));
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
    }

    return { ok: true, tasks };
}

async function readUploadChunk(entry: WorkspaceUploadEntry, offset: number, length: number): Promise<Uint8Array> {
    if (entry.kind === 'web') {
        const nextEnd = Math.min(entry.file.size, offset + length);
        const chunkBlob = entry.file.slice(offset, nextEnd);
        return new Uint8Array(await chunkBlob.arrayBuffer());
    }

    const FileSystem: any = await import('expo-file-system');
    const file = new FileSystem.File(entry.uri);
    const handle = file.open();
    try {
        if (typeof handle.offset === 'number' || handle.offset === null) {
            handle.offset = offset;
        }
        return handle.readBytes(length);
    } finally {
        try { handle.close(); } catch { }
    }
}

async function writeNativeFileChunk(handle: any, bytes: Uint8Array): Promise<void> {
    handle.writeBytes(bytes);
}

async function createNativeDownloadSink(input: Readonly<{ name: string }>): Promise<
    | { ok: true; fileUri: string; close: () => Promise<void>; writeBytes: (bytes: Uint8Array) => Promise<void>; cleanup: () => Promise<void> }
    | { ok: false; error: string }
> {
    try {
        const FileSystem: any = await import('expo-file-system');
        const cacheDir = String(FileSystem.cacheDirectory ?? FileSystem.Paths?.cache ?? '').trim();
        if (!cacheDir) {
            return { ok: false, error: 'No cache directory available' };
        }

        const downloadsDir = joinFileUri(cacheDir, 'happier-downloads');
        await FileSystem.makeDirectoryAsync(downloadsDir, { intermediates: true });

        const fileUri = joinFileUri(downloadsDir, input.name);
        const file = new FileSystem.File(fileUri);
        file.create();
        const handle = file.open();
        if (typeof handle.offset === 'number' || handle.offset === null) {
            handle.offset = 0;
        }

        const close = async () => {
            try { handle.close(); } catch { }
        };

        const cleanup = async () => {
            try { await close(); } catch { }
            try { file.delete(); } catch { }
        };

        return {
            ok: true,
            fileUri: file.uri,
            close,
            cleanup,
            writeBytes: async (bytes) => await writeNativeFileChunk(handle, bytes),
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to create download sink' };
    }
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
    startDownload: (input: Readonly<{ path: string; asZip: boolean }>) => Promise<TransferResult>;
    cancelDownload: () => void;
}> {
    const [uploadState, setUploadState] = React.useState<WorkspaceUploadState>({ status: 'idle' });
    const [downloadState, setDownloadState] = React.useState<WorkspaceDownloadState>({ status: 'idle' });

    const uploadAbortRef = React.useRef<AbortController | null>(null);
    const downloadAbortRef = React.useRef<AbortController | null>(null);

    const cancelUploads = React.useCallback(() => {
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

        try {
            setUploadState({
                status: 'preflighting',
                totalFiles: input.entries.length,
                completedFiles: 0,
                uploadedBytes: 0,
                totalBytes: 0,
            });

            const plan = await buildUploadEntryPlan({
                sessionId: params.sessionId,
                entries: input.entries,
                destinationDir: input.destinationDir,
                onResolveConflicts: params.onResolveUploadConflicts ?? null,
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

            const maxConcurrentUploads = typeof params.maxConcurrentUploads === 'number' && Number.isFinite(params.maxConcurrentUploads)
                ? Math.max(1, Math.floor(params.maxConcurrentUploads))
                : 3;

            let nextIndex = 0;
            let cancelled = false;
            const cancelOnce = () => {
                if (cancelled) return;
                cancelled = true;
                controller.abort();
            };

            const workers = Array.from({ length: Math.min(maxConcurrentUploads, tasks.length) }, () => (async () => {
                while (true) {
                    if (controller.signal.aborted) return;
                    const index = nextIndex;
                    nextIndex += 1;
                    const task = tasks[index];
                    if (!task) return;

                    let lastUploaded = 0;
                    const result = await uploadInChunks<any, any, any>({
                        totalBytes: task.sizeBytes,
                        readBytes: async (offset, length) => await readUploadChunk(task.entry, offset, length),
                        init: async () => await sessionFilesUploadInit(params.sessionId, {
                            path: task.targetPath,
                            sizeBytes: task.sizeBytes,
                            overwrite: task.overwrite,
                        }),
                        sendChunk: async ({ uploadId, index, contentBase64 }) => await sessionFilesUploadChunk(params.sessionId, { uploadId, index, contentBase64 }),
                        finalize: async ({ uploadId }) => await sessionFilesUploadFinalize(params.sessionId, { uploadId }),
                        abort: async ({ uploadId }) => await sessionFilesUploadAbort(params.sessionId, { uploadId }),
                        signal: controller.signal,
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
                    });

                    if (!result.success) {
                        cancelOnce();
                        setUploadState({ status: controller.signal.aborted ? 'canceled' : 'error', error: result.error });
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
            params.onAfterUploadSuccess?.();
            return { ok: true };
        } finally {
            uploadAbortRef.current = null;
        }
    }, [params]);

    const startDownload = React.useCallback(async (input: Readonly<{ path: string; asZip: boolean }>): Promise<TransferResult> => {
        if (downloadAbortRef.current) {
            return { ok: false, error: 'Download already in progress' };
        }

        const controller = new AbortController();
        downloadAbortRef.current = controller;

        let nativeSink: Awaited<ReturnType<typeof createNativeDownloadSink>> | null = null;

        try {
            const init = await sessionFilesDownloadInit(params.sessionId, { path: input.path, asZip: input.asZip });
            if (!init.success) {
                setDownloadState({ status: 'error', error: init.error });
                return { ok: false, error: init.error };
            }

            setDownloadState({
                status: 'downloading',
                name: init.name,
                downloadedBytes: 0,
                totalBytes: init.sizeBytes,
            });

            if (Platform.OS === 'web') {
                const chunks: Array<Uint8Array<ArrayBuffer>> = [];

                const res = await downloadInChunks<any, any, any>({
                    init: async () => init,
                    readChunk: async ({ downloadId, index }) => await sessionFilesDownloadChunk(params.sessionId, { downloadId, index }),
                    finalize: async ({ downloadId }) => await sessionFilesDownloadFinalize(params.sessionId, { downloadId }),
                    abort: async ({ downloadId }) => await sessionFilesDownloadAbort(params.sessionId, { downloadId }),
                    signal: controller.signal,
                    onProgress: (progress) => {
                        setDownloadState((prev) => prev.status === 'downloading'
                            ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                            : prev);
                    },
                    writeBytes: async (bytes) => {
                        chunks.push(new Uint8Array(bytes));
                    },
                });

                if (!res.ok) {
                    setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: res.error });
                    return { ok: false, error: res.error };
                }

                const blob = new Blob(chunks, { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                try {
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = init.name || 'download';
                    anchor.rel = 'noopener noreferrer';
                    anchor.click();
                } finally {
                    try { URL.revokeObjectURL(url); } catch { }
                }
            } else {
                const sink = await createNativeDownloadSink({ name: init.name || 'download' });
                nativeSink = sink;
                if (!sink.ok) {
                    setDownloadState({ status: 'error', error: sink.error });
                    return { ok: false, error: sink.error };
                }

                const res = await downloadInChunks<any, any, any>({
                    init: async () => init,
                    readChunk: async ({ downloadId, index }) => await sessionFilesDownloadChunk(params.sessionId, { downloadId, index }),
                    finalize: async ({ downloadId }) => await sessionFilesDownloadFinalize(params.sessionId, { downloadId }),
                    abort: async ({ downloadId }) => await sessionFilesDownloadAbort(params.sessionId, { downloadId }),
                    signal: controller.signal,
                    onProgress: (progress) => {
                        setDownloadState((prev) => prev.status === 'downloading'
                            ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                            : prev);
                    },
                    writeBytes: async (bytes) => await sink.writeBytes(bytes),
                });

                if (!res.ok) {
                    await sink.cleanup();
                    setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: res.error });
                    return { ok: false, error: res.error };
                }

                await sink.close();

                try {
                    const Sharing: any = await import('expo-sharing');
                    if (Sharing && typeof Sharing.isAvailableAsync === 'function') {
                        const available = await Sharing.isAvailableAsync();
                        if (available && typeof Sharing.shareAsync === 'function') {
                            await Sharing.shareAsync(sink.fileUri);
                        }
                    }
                } catch {
                    // Best-effort share only.
                }
            }

            if (controller.signal.aborted) {
                if (nativeSink && nativeSink.ok) {
                    await nativeSink.cleanup();
                }
                setDownloadState({ status: 'canceled' });
                return { ok: false, error: 'Download canceled' };
            }

            setDownloadState({ status: 'done', name: init.name, totalBytes: init.sizeBytes });
            return { ok: true };
        } finally {
            downloadAbortRef.current = null;
        }
    }, [params.sessionId]);

    return {
        uploadState,
        downloadState,
        startUploads,
        cancelUploads,
        startDownload,
        cancelDownload,
    };
}
