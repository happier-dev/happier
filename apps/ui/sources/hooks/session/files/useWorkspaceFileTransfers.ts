import * as React from 'react';
import { Platform } from 'react-native';

import { resolveLocalUploadSourceSizeBytes } from '@/sync/domains/files/transfers/localUploadSourceReader';
import {
    downloadSessionPathViaTransfer,
} from '@/sync/domains/files/transfers/sessionPathTransferRpc';
import { uploadLocalSourceToSessionPath } from '@/sync/domains/files/transfers/uploadLocalSourceToSessionPath';
import { resolveKeepBothTargetPath } from '@/sync/domains/files/resolveKeepBothTargetPath';
import { sessionStatFile } from '@/sync/ops';
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

type NativeDownloadSink = Extract<Awaited<ReturnType<typeof createNativeDownloadSink>>, { ok: true }>;

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
                    const result = await uploadLocalSourceToSessionPath({
                        sessionId: params.sessionId,
                        source: task.entry,
                        targetPath: task.targetPath,
                        sizeBytes: task.sizeBytes,
                        overwrite: task.overwrite,
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

        const nativeSinkRef: { current: NativeDownloadSink | null } = { current: null };
        const updateProgress = (progress: Readonly<{ downloadedBytes: number; totalBytes: number }>) => {
            setDownloadState((prev) => prev.status === 'downloading'
                ? { ...prev, downloadedBytes: progress.downloadedBytes, totalBytes: progress.totalBytes }
                : prev);
        };

        try {
            if (Platform.OS === 'web') {
                const chunks: Array<Uint8Array<ArrayBuffer>> = [];
                const res = await downloadSessionPathViaTransfer({
                    sessionId: params.sessionId,
                    path: input.path,
                    asZip: input.asZip,
                    onInit: async ({ name, sizeBytes }) => {
                        setDownloadState({
                            status: 'downloading',
                            name,
                            downloadedBytes: 0,
                            totalBytes: sizeBytes,
                        });
                    },
                    signal: controller.signal,
                    onProgress: updateProgress,
                    writeBytes: async (bytes) => {
                        chunks.push(new Uint8Array(bytes));
                    },
                });

                if (!res.success) {
                    setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: res.error });
                    return { ok: false, error: res.error };
                }

                const blob = new Blob(chunks, { type: 'application/octet-stream' });
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
            } else {
                const res = await downloadSessionPathViaTransfer({
                    sessionId: params.sessionId,
                    path: input.path,
                    asZip: input.asZip,
                    onInit: async ({ name, sizeBytes }) => {
                        const nextSink = await createNativeDownloadSink({ name: name || 'download' });
                        if (!nextSink.ok) {
                            throw new Error(nextSink.error);
                        }
                        nativeSinkRef.current = nextSink;
                        setDownloadState({
                            status: 'downloading',
                            name,
                            downloadedBytes: 0,
                            totalBytes: sizeBytes,
                        });
                    },
                    signal: controller.signal,
                    onProgress: updateProgress,
                    writeBytes: async (bytes) => {
                        if (!nativeSinkRef.current) {
                            throw new Error('Download sink unavailable');
                        }
                        await nativeSinkRef.current.writeBytes(bytes);
                    },
                });

                if (!res.success) {
                    if (nativeSinkRef.current) {
                        await nativeSinkRef.current.cleanup();
                    }
                    setDownloadState(controller.signal.aborted ? { status: 'canceled' } : { status: 'error', error: res.error });
                    return { ok: false, error: res.error };
                }

                if (!nativeSinkRef.current) {
                    setDownloadState({ status: 'error', error: 'Download sink unavailable' });
                    return { ok: false, error: 'Download sink unavailable' };
                }

                await nativeSinkRef.current.close();

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
            }

            if (controller.signal.aborted) {
                if (nativeSinkRef.current) {
                    await nativeSinkRef.current.cleanup();
                }
                setDownloadState({ status: 'canceled' });
                return { ok: false, error: 'Download canceled' };
            }

            setDownloadState((prev) => prev.status === 'downloading'
                ? { status: 'done', name: prev.name, totalBytes: prev.totalBytes }
                : prev);
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
