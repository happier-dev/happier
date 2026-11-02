import { Platform } from 'react-native';
import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import type { ComposerContentHandleV1, SessionAttachmentHandleV1 } from '@happier-dev/protocol';

import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { NativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';
import { resolveWebFileBufferMaxBytes } from '@/sync/runtime/files/webFileBufferBudget';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

const PREVIEW_CACHE_DIRECTORY_NAME = 'happier-session-file-previews';
export const PREVIEW_TOO_LARGE_ERROR = 'File exceeds the preview size limit';

export type SessionFilePreviewSource = (
    | Readonly<{
        kind: 'object-url';
        uri: string;
        revoke: () => void;
        byteLength: number;
        mimeType: string;
    }>
    | Readonly<{
        kind: 'cache-file';
        uri: string;
        delete: () => Promise<void>;
        byteLength: number;
        mimeType: string;
    }>) & Readonly<{ bytes?: Uint8Array }>;

export type CreateSessionFilePreviewSourceResult =
    | Readonly<{ ok: true; source: SessionFilePreviewSource }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

function previewFailure(error: string, errorCode?: string): Extract<CreateSessionFilePreviewSourceResult, { ok: false }> {
    // This owner emits the size-limit sentinel, including from the destination and transfer admission.
    const code = errorCode ?? (error === PREVIEW_TOO_LARGE_ERROR ? 'too_large' : undefined);
    return { ok: false, error, ...(code ? { errorCode: code } : {}) };
}

type PreviewDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup: () => Promise<void>;
}>;

/** Bytes received so far; `totalBytes` is the transfer's announced size. */
export type PreviewLoadProgress = Readonly<{ receivedBytes: number; totalBytes: number }>;
export type PreviewLoadProgressListener = (progress: PreviewLoadProgress) => void;

type PreviewByteLoader = (input: Readonly<{
    maxBytes: number | null;
    destination: PreviewDestination;
    signal: AbortSignal | null;
    onProgress: PreviewLoadProgressListener | null;
}>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: string; errorCode?: string }>>;

async function createPreviewSource(input: Readonly<{
    filePath: string;
    mimeType: string;
    maxBytes: number | null;
    expectedSizeBytes?: number | null;
    signal?: AbortSignal | null;
    onProgress?: PreviewLoadProgressListener | null;
    load: PreviewByteLoader;
    retainBytes?: boolean;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const viewer = resolveFileViewerKind({ path: input.filePath, mimeType: input.mimeType });
    const mimeType = viewer.mimeType;
    if (!viewer.previewable) {
        return previewFailure('Unsupported preview type', 'unsupported');
    }

    const requestedMaxBytes = input.maxBytes === null ? null : Number.isFinite(input.maxBytes) ? Math.max(0, Math.floor(input.maxBytes)) : 0;
    const maxBytes = Platform.OS === 'web'
        ? Math.min(requestedMaxBytes ?? Infinity, resolveWebFileBufferMaxBytes())
        : requestedMaxBytes;
    if (maxBytes !== null && maxBytes <= 0) {
        return previewFailure(PREVIEW_TOO_LARGE_ERROR);
    }

    const expectedSizeBytes =
        typeof input.expectedSizeBytes === 'number' && Number.isFinite(input.expectedSizeBytes)
            ? Math.max(0, Math.floor(input.expectedSizeBytes))
            : null;
    if (maxBytes !== null && expectedSizeBytes != null && expectedSizeBytes > maxBytes) {
        return previewFailure(PREVIEW_TOO_LARGE_ERROR);
    }

    let byteLength = 0;
    const chunks: Uint8Array[] = [];
    let nativeSink: NativeCacheFileSink | null = null;
    const shouldCollectChunks = Platform.OS === 'web' || input.retainBytes === true;

    const cleanupNativeSink = async () => {
        if (!nativeSink) return;
        const sink = nativeSink;
        nativeSink = null;
        await sink.cleanup();
    };

    const destination = {
        writeBytes: async (bytes: Uint8Array) => {
            byteLength += bytes.byteLength;
            if (maxBytes !== null && byteLength > maxBytes) {
                throw new Error(PREVIEW_TOO_LARGE_ERROR);
            }
            const copy = new Uint8Array(bytes);
            if (shouldCollectChunks) {
                chunks.push(copy);
            }
            if (Platform.OS !== 'web') {
                if (!nativeSink) throw new Error('Preview cache sink unavailable');
                await nativeSink.writeBytes(copy);
            }
        },
        close: async () => {
            if (Platform.OS !== 'web' && nativeSink) {
                await nativeSink.close();
            }
        },
        cleanup: async () => {
            byteLength = 0;
            chunks.length = 0;
            await cleanupNativeSink();
        },
    };

    if (Platform.OS !== 'web') {
        const { createNativeCacheFileSink } = await import('@/sync/runtime/files/nativeCacheFileSink');
        const sink = await createNativeCacheFileSink({
            directoryName: PREVIEW_CACHE_DIRECTORY_NAME,
            fileName: input.filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? 'preview',
        });
        if (!sink.ok) {
            return { ok: false, error: sink.error };
        }
        nativeSink = sink;
    }

    try {
        const load = await input.load({
            maxBytes,
            destination,
            signal: input.signal ?? null,
            onProgress: input.onProgress ?? null,
        });
        if (!load.ok) {
            await destination.cleanup();
            return previewFailure(load.error, load.errorCode);
        }
        if (input.signal?.aborted) {
            await destination.cleanup();
            return { ok: false, error: 'Preview request cancelled' };
        }

        let retainedBytes: Uint8Array | undefined;
        if (input.retainBytes) {
            retainedBytes = new Uint8Array(byteLength);
            let offset = 0;
            for (const chunk of chunks) {
                retainedBytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
        }

        if (Platform.OS === 'web') {
            const blob = new Blob(chunks as BlobPart[], { type: mimeType });
            chunks.length = 0;
            const uri = URL.createObjectURL(blob);
            return {
                ok: true,
                source: {
                    kind: 'object-url',
                    uri,
                    byteLength,
                    mimeType,
                    ...(retainedBytes ? { bytes: retainedBytes } : {}),
                    revoke: () => {
                        URL.revokeObjectURL(uri);
                    },
                },
            };
        }

        if (!nativeSink) {
            await destination.cleanup();
            return { ok: false, error: 'Preview cache sink unavailable' };
        }

        const completedSink = nativeSink;
        nativeSink = null;
        chunks.length = 0;
        return {
            ok: true,
            source: {
                kind: 'cache-file',
                uri: completedSink.fileUri,
                byteLength,
                mimeType,
                ...(retainedBytes ? { bytes: retainedBytes } : {}),
                delete: async () => {
                    await completedSink.cleanup();
                },
            },
        };
    } catch (error) {
        await destination.cleanup();
        const code = error && typeof error === 'object' && 'errorCode' in error && typeof error.errorCode === 'string'
            ? error.errorCode : readRpcErrorCode(error);
        return previewFailure(error instanceof Error ? error.message : 'Failed to create file preview', code);
    }
}

export async function createSessionFilePreviewSource(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    mimeType: string;
    maxBytes: number | null;
    expectedSizeBytes?: number | null;
    signal?: AbortSignal | null;
    onProgress?: PreviewLoadProgressListener | null;
    /** A browser edit retains the original locally without downloading it again at Attach. */
    retainBytes?: boolean;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    // Callers own their preview budget; every source also shares the web buffering budget.
    return await createPreviewSource({
        ...input,
        load: async ({ destination, signal, maxBytes, onProgress }) => {
            const { downloadDaemonWorkspaceFileToDestination } = await import('@/sync/domains/transfers/runtime/transferRuntime');
            const download = await downloadDaemonWorkspaceFileToDestination({
                machineId: input.scope.machineId,
                serverId: input.scope.serverId,
                rootPath: input.scope.rootPath,
                request: { path: input.filePath, asZip: false },
                destination,
                onInit: async (init) => {
                    if (maxBytes !== null && init.sizeBytes > maxBytes) {
                        return { success: false, error: PREVIEW_TOO_LARGE_ERROR };
                    }
                },
                signal,
                onProgress: onProgress
                    ? ({ downloadedBytes, totalBytes }) => onProgress({ receivedBytes: downloadedBytes, totalBytes })
                    : null,
            });
            return download.ok ? { ok: true } : download;
        },
    });
}

/** Attachment preview uses issued custody, never the Message's advisory filesystem path. */
export async function createSessionAttachmentPreviewSource(input: Readonly<{
    handle: SessionAttachmentHandleV1;
    fileName: string;
    mimeType: string;
    maxBytes: number | null;
    expectedSizeBytes?: number | null;
    signal?: AbortSignal | null;
    onProgress?: PreviewLoadProgressListener | null;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    return await createPreviewSource({
        filePath: input.fileName,
        mimeType: input.mimeType,
        maxBytes: input.maxBytes,
        expectedSizeBytes: input.expectedSizeBytes,
        signal: input.signal,
        onProgress: input.onProgress ?? null,
        load: async ({ destination, signal, maxBytes, onProgress }) => {
            const { downloadDaemonSessionAttachmentToDestination } = await import('@/sync/domains/transfers/runtime/transferRuntime');
            const context = (await import('@/sync/sync')).sync.getSessionAttachmentTransferContext(input.handle.sessionId, { purpose: 'attachmentPreview' });
            if (!context) return { ok: false, error: 'Session attachment scope is unavailable' };
            const download = await downloadDaemonSessionAttachmentToDestination({
                transferContext: context,
                attachmentHandle: input.handle,
                destination,
                signal,
                onInit: async ({ sizeBytes }) => maxBytes !== null && sizeBytes > maxBytes
                    ? { success: false, error: PREVIEW_TOO_LARGE_ERROR }
                    : undefined,
                onProgress: onProgress
                    ? ({ downloadedBytes, totalBytes }) => onProgress({ receivedBytes: downloadedBytes, totalBytes })
                    : null,
            });
            return download.ok ? { ok: true } : download;
        },
    });
}

/**
 * Materializes one bounded, opaque Composer stage through the same preview
 * sink and cleanup owner as SessionMedia. The handle remains the only custody
 * input: no workspace path or general file reader is admitted here.
 */
export async function createComposerStagedMediaPreviewSource(input: Readonly<{
    handle: ComposerContentHandleV1;
    maxBytes: number | null;
    signal?: AbortSignal | null;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const requestedMaxBytes = input.maxBytes === null ? null : Number.isFinite(input.maxBytes)
        ? Math.max(0, Math.floor(input.maxBytes))
        : 0;
    // `inspectComposerContent` is the canonical protocol-owned upper bound;
    // the shared preview sink also enforces the caller's image limit and the web buffering budget.
    const maxBytes = requestedMaxBytes;
    return await createPreviewSource({
        filePath: input.handle.name,
        mimeType: input.handle.mimeType,
        maxBytes,
        expectedSizeBytes: input.handle.sizeBytes,
        signal: input.signal ?? null,
        load: async ({ destination, signal, maxBytes }) => {
            const { inspectComposerContent } = await import('@/sync/domains/transfers/runtime/transferRuntime');
            const inspection = await inspectComposerContent(
                input.handle,
                {
                    offset: 0,
                    maxBytes: Math.min(maxBytes ?? input.handle.sizeBytes, input.handle.sizeBytes),
                },
                { signal },
            );
            if (!inspection.success) return previewFailure(inspection.error,
                'errorCode' in inspection && typeof inspection.errorCode === 'string' ? inspection.errorCode : undefined);
            if (inspection.result.offset !== 0 || !inspection.result.eof) {
                return { ok: false, error: 'Composer media inspection returned an incomplete preview' };
            }

            const { decodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
            const bytes = decodeBase64(inspection.result.bytesBase64, 'base64');
            if (bytes.byteLength !== input.handle.sizeBytes) {
                return { ok: false, error: 'Composer media inspection returned an invalid preview size' };
            }
            await destination.writeBytes(bytes);
            await destination.close();
            return { ok: true };
        },
    });
}

/** Already-opened Artifact and revision bytes use the same admission, sink and cleanup owner. */
export async function createBytesPreviewSource(input: Readonly<{
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
    maxBytes: number | null;
    signal?: AbortSignal | null;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    return createPreviewSource({
        filePath: input.fileName,
        mimeType: input.mimeType,
        maxBytes: input.maxBytes,
        expectedSizeBytes: input.bytes.byteLength,
        signal: input.signal,
        load: async ({ destination, signal }) => {
            if (signal?.aborted) return { ok: false, error: 'Preview request cancelled' };
            await destination.writeBytes(input.bytes);
            await destination.close();
            return { ok: true };
        },
    });
}
