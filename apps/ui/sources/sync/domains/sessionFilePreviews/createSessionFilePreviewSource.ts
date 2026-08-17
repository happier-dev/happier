import { Platform } from 'react-native';
import type { ComposerContentHandleV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';

import {
    downloadDaemonWorkspaceFileToDestination,
    inspectComposerContent,
} from '@/sync/domains/transfers/runtime/transferRuntime';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { createNativeCacheFileSink, type NativeCacheFileSink } from '@/sync/runtime/files/nativeCacheFileSink';

const PREVIEW_CACHE_DIRECTORY_NAME = 'happier-session-file-previews';
const PREVIEW_TOO_LARGE_ERROR = 'File exceeds the preview size limit';

export type SessionFilePreviewSource =
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
    }>;

export type CreateSessionFilePreviewSourceResult =
    | Readonly<{ ok: true; source: SessionFilePreviewSource }>
    | Readonly<{ ok: false; error: string }>;

type PreviewDestination = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup: () => Promise<void>;
}>;

type PreviewByteLoader = (input: Readonly<{
    destination: PreviewDestination;
    signal: AbortSignal | null;
}>) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>>;

function isSupportedPreviewMimeType(mimeType: string): boolean {
    const normalized = mimeType.trim().toLowerCase();
    return normalized === 'image/png'
        || normalized === 'image/jpeg'
        || normalized === 'image/webp'
        || normalized === 'image/gif'
        || normalized === 'video/webm';
}

function toPreviewCacheFileName(input: Readonly<{ filePath: string; cacheIdentity?: string | null }>): string {
    const rawIdentity = String(input.cacheIdentity ?? '').trim();
    const basename = input.filePath.split('/').filter(Boolean).at(-1) ?? 'preview';
    if (!rawIdentity) return basename;
    return `${rawIdentity}-${basename}`.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function createPreviewSource(input: Readonly<{
    filePath: string;
    mimeType: string;
    maxBytes: number;
    expectedSizeBytes?: number | null;
    cacheIdentity?: string | null;
    signal?: AbortSignal | null;
    load: PreviewByteLoader;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const mimeType = input.mimeType.trim();
    if (!isSupportedPreviewMimeType(mimeType)) {
        return { ok: false, error: 'Unsupported preview type' };
    }

    const maxBytes = Number.isFinite(input.maxBytes) ? Math.max(0, Math.floor(input.maxBytes)) : 0;
    if (maxBytes <= 0) {
        return { ok: false, error: PREVIEW_TOO_LARGE_ERROR };
    }

    const expectedSizeBytes =
        typeof input.expectedSizeBytes === 'number' && Number.isFinite(input.expectedSizeBytes)
            ? Math.max(0, Math.floor(input.expectedSizeBytes))
            : null;
    if (expectedSizeBytes != null && expectedSizeBytes > maxBytes) {
        return { ok: false, error: PREVIEW_TOO_LARGE_ERROR };
    }

    let byteLength = 0;
    const chunks: Uint8Array[] = [];
    let nativeSink: NativeCacheFileSink | null = null;
    const shouldCollectChunks = Platform.OS === 'web';

    const cleanupNativeSink = async () => {
        if (!nativeSink) return;
        const sink = nativeSink;
        nativeSink = null;
        await sink.cleanup();
    };

    const destination = {
        writeBytes: async (bytes: Uint8Array) => {
            byteLength += bytes.byteLength;
            if (byteLength > maxBytes) {
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
        const sink = await createNativeCacheFileSink({
            directoryName: PREVIEW_CACHE_DIRECTORY_NAME,
            fileName: toPreviewCacheFileName({
                filePath: input.filePath,
                cacheIdentity: input.cacheIdentity ?? null,
            }),
        });
        if (!sink.ok) {
            return { ok: false, error: sink.error };
        }
        nativeSink = sink;
    }

    try {
        const load = await input.load({
            destination,
            signal: input.signal ?? null,
        });
        if (!load.ok) {
            await destination.cleanup();
            return { ok: false, error: load.error };
        }
        if (input.signal?.aborted) {
            await destination.cleanup();
            return { ok: false, error: 'Preview request cancelled' };
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
                delete: async () => {
                    await completedSink.cleanup();
                },
            },
        };
    } catch (error) {
        await destination.cleanup();
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to create image preview' };
    }
}

export async function createSessionFilePreviewSource(input: Readonly<{
    scope: WorkspaceScopeBase;
    filePath: string;
    mimeType: string;
    maxBytes: number;
    expectedSizeBytes?: number | null;
    cacheIdentity?: string | null;
    signal?: AbortSignal | null;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const maxBytes = Number.isFinite(input.maxBytes)
        ? Math.max(0, Math.floor(input.maxBytes))
        : 0;
    return await createPreviewSource({
        ...input,
        maxBytes,
        load: async ({ destination, signal }) => {
            const download = await downloadDaemonWorkspaceFileToDestination({
                machineId: input.scope.machineId,
                serverId: input.scope.serverId,
                rootPath: input.scope.rootPath,
                request: { path: input.filePath, asZip: false },
                destination,
                onInit: async (init) => {
                    if (init.sizeBytes > maxBytes) {
                        return { success: false, error: PREVIEW_TOO_LARGE_ERROR };
                    }
                },
                signal,
            });
            return download.ok ? { ok: true } : { ok: false, error: download.error };
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
    maxBytes: number;
    signal?: AbortSignal | null;
}>): Promise<CreateSessionFilePreviewSourceResult> {
    const requestedMaxBytes = Number.isFinite(input.maxBytes)
        ? Math.max(0, Math.floor(input.maxBytes))
        : 0;
    // `inspectComposerContent` is the canonical protocol-owned upper bound;
    // this preview owner adds only the caller's user-visible image limit.
    const maxBytes = requestedMaxBytes;
    return await createPreviewSource({
        filePath: input.handle.name,
        mimeType: input.handle.mimeType,
        maxBytes,
        expectedSizeBytes: input.handle.sizeBytes,
        cacheIdentity: input.handle.sha256,
        signal: input.signal ?? null,
        load: async ({ destination, signal }) => {
            const inspection = await inspectComposerContent(
                input.handle,
                {
                    offset: 0,
                    maxBytes: Math.min(maxBytes, input.handle.sizeBytes),
                },
                { signal },
            );
            if (!inspection.success) return { ok: false, error: inspection.error };
            if (inspection.result.offset !== 0 || !inspection.result.eof) {
                return { ok: false, error: 'Composer media inspection returned an incomplete preview' };
            }

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
