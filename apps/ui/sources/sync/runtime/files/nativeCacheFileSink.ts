import { Platform } from 'react-native';

import { log } from '@/log';
import { t } from '@/text';
import { randomUUID } from '@/platform/randomUUID';

type ExpoFileHandleLike = {
    offset?: number | null;
    writeBytes: (bytes: Uint8Array) => void;
    close: () => void;
};

type ExpoFileLike = {
    uri: string;
    create: () => void;
    open: () => ExpoFileHandleLike;
    delete: () => void;
};

type ExpoDirectoryLike = {
    uri: string;
    create: (options: { idempotent: boolean; intermediates: boolean }) => void | Promise<void>;
};

type ExpoPathLike = string | ExpoDirectoryLike;

type ExpoFileSystemLike = {
    Paths?: { cache?: ExpoPathLike | null } | null;
    Directory: new (...paths: ExpoPathLike[]) => ExpoDirectoryLike;
    File: new (...paths: ExpoPathLike[]) => ExpoFileLike;
};

export type NativeCacheFileSink = Readonly<{
    fileUri: string;
    close: () => Promise<void>;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    cleanup: () => Promise<void>;
}>;

export type NativeCacheFileSinkResult =
    | Readonly<{ ok: true; sink: NativeCacheFileSink }>
    | Readonly<{ ok: false; error: string }>;

// Android/Linux cache filesystems limit each filename component to 255 UTF-8 bytes.
const MAX_CACHE_NAME_BYTES = 255;
const filenameEncoder = new TextEncoder();

function truncateUtf8(value: string, maxBytes: number): string {
    let bytes = 0;
    let result = '';
    for (const character of value) {
        bytes += filenameEncoder.encode(character).byteLength;
        if (bytes > maxBytes) break;
        result += character;
    }
    return result;
}

function sanitizeCacheFileName(name: string, maxBytes = MAX_CACHE_NAME_BYTES): string {
    const safe = String(name ?? '').trim()
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
        .replace(/^\.+/g, '_') || 'preview';
    const extensionIndex = safe.lastIndexOf('.');
    const extension = extensionIndex > 0 ? safe.slice(extensionIndex) : '';
    const extensionBytes = filenameEncoder.encode(extension).byteLength;
    if (extension && extensionBytes < maxBytes) {
        return `${truncateUtf8(safe.slice(0, extensionIndex), maxBytes - extensionBytes)}${extension}`;
    }
    return truncateUtf8(safe, maxBytes);
}

export async function createNativeCacheFileSink(input: Readonly<{
    directoryName: string;
    name: string;
}>): Promise<NativeCacheFileSinkResult> {
    try {
        const imported = await import('expo-file-system');
        // Boundary typing: Expo's JS module shape differs across SDK versions.
        const FileSystem = imported as unknown as ExpoFileSystemLike;
        const cacheRoot = FileSystem.Paths?.cache ?? null;
        const cacheRootUri = typeof cacheRoot === 'string' ? cacheRoot.trim() : String(cacheRoot?.uri ?? '').trim();
        if (!cacheRoot || !cacheRootUri) {
            return { ok: false, error: t('errors.operationFailed') };
        }

        const cacheSubdir = new FileSystem.Directory(
            typeof cacheRoot === 'string' ? cacheRootUri : cacheRoot,
            sanitizeCacheFileName(input.directoryName),
        );
        await cacheSubdir.create({ idempotent: true, intermediates: true });

        const prefix = `${randomUUID()}-`;
        const name = sanitizeCacheFileName(input.name, MAX_CACHE_NAME_BYTES - filenameEncoder.encode(prefix).byteLength);
        const file = new FileSystem.File(cacheSubdir, `${prefix}${name}`);
        file.create();
        let handle: ExpoFileHandleLike;
        try {
            handle = file.open();
        } catch (error) {
            try {
                file.delete();
            } catch (cleanupError) {
                throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; ${t('files.fileCleanupFailed')}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`), {
                    errors: [error, cleanupError],
                });
            }
            throw error;
        }
        if (typeof handle.offset === 'number' || handle.offset === null) {
            handle.offset = 0;
        }

        let closed = false;
        let removed = false;
        const close = async () => {
            if (closed) return;
            handle.close();
            closed = true;
        };

        const cleanup = async () => {
            const errors: unknown[] = [];
            try {
                await close();
            } catch (error) {
                errors.push(error);
            }
            try {
                if (!removed) {
                    file.delete();
                    removed = true;
                }
            } catch (error) {
                errors.push(error);
            }
            if (errors.length > 0) {
                log.log(`Failed to clean up cache file: ${errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')}`);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw Object.assign(new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join('; ')), { errors });
            }
        };

        return {
            ok: true,
            sink: {
                fileUri: file.uri,
                close,
                cleanup,
                writeBytes: async (bytes) => {
                    handle.writeBytes(bytes);
                },
            },
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : t('errors.operationFailed') };
    }
}

export type NativeCacheFileShareResult =
    | Readonly<{ status: 'shared'; retainCacheFile: boolean }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'canceled' }>;

export async function shareNativeCacheFile(input: Readonly<{
    fileUri: string;
    name: string;
    mimeType?: string;
    UTI?: string;
    dialogTitle?: string;
    isCurrent?: () => boolean;
    onHandoff?: () => void;
}>): Promise<NativeCacheFileShareResult> {
    try {
        if (input.isCurrent?.() === false) return { status: 'canceled' };
        if (Platform.OS === 'android') {
            const { performAndroidFileAction } = await import('./nativeFileActions');
            if (input.isCurrent?.() === false) return { status: 'canceled' };
            input.onHandoff?.();
            await performAndroidFileAction({ fileUri: input.fileUri, name: input.name, action: 'share', dialogTitle: input.dialogTitle });
            // The chooser resolves at handoff; recipients still own permission to read these bytes.
            return { status: 'shared', retainCacheFile: true };
        }
        const Sharing = await import('expo-sharing');
        const available = await Sharing.isAvailableAsync();
        if (input.isCurrent?.() === false) return { status: 'canceled' };
        if (!available) return { status: 'unavailable' };
        input.onHandoff?.();
        await Sharing.shareAsync(input.fileUri, {
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
            ...(input.UTI ? { UTI: input.UTI } : {}),
            ...(input.dialogTitle ? { dialogTitle: input.dialogTitle } : {}),
        });
        // Expo iOS resolves when the activity controller completes or is dismissed.
        return { status: 'shared', retainCacheFile: false };
    } catch (error) {
        log.log(`Failed to share cache file: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}
