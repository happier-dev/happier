import { log } from '@/log';
import { Platform, Share } from 'react-native';
import { randomUUID } from '@/platform/randomUUID';
import { MAX_CACHE_FILE_NAME_BYTES, sanitizeFileUriSegment } from './fileUriPath';

type ExpoFileSystemModule = Readonly<{
    Directory: new (parent: ExpoFileSystemDirectory | string, name?: string) => ExpoFileSystemDirectory;
    File: new (parent: ExpoFileSystemDirectory | string, name?: string) => ExpoFileSystemFile;
    Paths?: Readonly<{
        cache?: ExpoFileSystemDirectory | string | null;
    }>;
}>;

type ExpoFileSystemDirectory = Readonly<{
    uri: string;
    create: (options?: { intermediates?: boolean; idempotent?: boolean }) => void;
}>;

type ExpoFileSystemFile = Readonly<{
    uri: string;
    exists?: boolean;
    delete: () => void;
    create: () => void;
    open: () => ExpoFileSystemFileHandle;
}>;

type ExpoFileSystemFileHandle = {
    offset?: number | null;
    close: () => void;
    writeBytes: (bytes: Uint8Array) => void;
};

export type NativeCacheFileSink = Readonly<{
    fileUri: string;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup: () => Promise<void>;
}>;

export type NativeCacheFileShareResult =
    | Readonly<{ status: 'shared'; retainCacheFile: boolean; completion: 'confirmed' | 'unobservable' }>
    | Readonly<{ status: 'unavailable' }>
    | Readonly<{ status: 'canceled' }>;

/** Shares through the platform owner and reports whether the recipient still owns reads. */
export async function shareNativeCacheFile(input: Readonly<{
    fileUri: string;
    name: string;
    mimeType?: string;
    UTI?: string;
    dialogTitle?: string;
    isCurrent?: () => boolean;
    onHandoff?: () => void;
    action?: 'save' | 'open' | 'share';
}>): Promise<NativeCacheFileShareResult> {
    try {
        const isCurrent = input.isCurrent ?? (() => true);
        if (Platform.OS === 'android') {
            const { performAndroidFileAction } = await import('./nativeFileActions');
            if (!isCurrent()) return { status: 'canceled' };
            input.onHandoff?.();
            const action = input.action ?? 'share';
            const result = await performAndroidFileAction({ fileUri: input.fileUri, name: input.name, action, mimeType: input.mimeType, dialogTitle: input.dialogTitle });
            if (result.canceled) return { status: 'canceled' };
            // Android chooser completion does not prove the recipient finished reading.
            return { status: 'shared', retainCacheFile: action !== 'save', completion: action === 'save' ? 'confirmed' : 'unobservable' };
        }
        if (Platform.OS === 'ios' && input.action === 'open') {
            // Quick Look renders HTML, PDF and Office files; its share button reaches other apps.
            const { previewIosFile } = await import('./nativeFileActions');
            if (!isCurrent()) return { status: 'canceled' };
            input.onHandoff?.();
            if (await previewIosFile(input.fileUri) === 'dismissed') {
                return { status: 'shared', retainCacheFile: false, completion: 'confirmed' };
            }
        }
        const sharing = await import('expo-sharing');
        if (!isCurrent()) return { status: 'canceled' };
        const available = await sharing.isAvailableAsync();
        if (!isCurrent()) return { status: 'canceled' };
        if (!available) return { status: 'unavailable' };
        input.onHandoff?.();
        if (Platform.OS === 'ios') {
            // RN exposes UIActivityViewController's completed/dismissed result;
            // Expo's Promise<void> discards it. The same cache-file custody stays here.
            const result = await Share.share({ url: input.fileUri });
            if (result.action === Share.dismissedAction) return { status: 'canceled' };
            return result.action === Share.sharedAction
                ? { status: 'shared', retainCacheFile: false, completion: 'confirmed' }
                : { status: 'shared', retainCacheFile: false, completion: 'unobservable' };
        }
        const options = input.mimeType || input.UTI || input.dialogTitle ? {
            ...(input.mimeType ? { mimeType: input.mimeType } : {}),
            ...(input.UTI ? { UTI: input.UTI } : {}),
            ...(input.dialogTitle ? { dialogTitle: input.dialogTitle } : {}),
        } : undefined;
        await sharing.shareAsync(input.fileUri, options);
        return { status: 'shared', retainCacheFile: false, completion: 'unobservable' };
    } catch (error) {
        log.log(`Failed to share cache file: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    }
}

/** Removes one exact cache file after its creating component/process-local closure is gone. */
export async function removeNativeCacheFileCustody(fileUri: string): Promise<void> {
    const FileSystem = await import('expo-file-system') as ExpoFileSystemModule;
    const file = new FileSystem.File(fileUri);
    try {
        file.delete();
    } catch (error) {
        // Expo's modern File API reports absence through `exists`. Absence is
        // the idempotent success case; every other failure must remain visible
        // so the caller retains the only persisted custody locator for retry.
        if (file.exists === false) return;
        throw error;
    }
}

export async function createNativeCacheFileSink(input: Readonly<{
    directoryName: string;
    fileName: string;
}>): Promise<
    | Readonly<{ ok: true } & NativeCacheFileSink>
    | Readonly<{ ok: false; error: string }>
> {
    try {
        const FileSystem = await import('expo-file-system') as ExpoFileSystemModule;
        const cachePath = FileSystem.Paths?.cache ?? null;
        if (!cachePath) {
            return { ok: false, error: 'No cache directory available' };
        }

        const directoryName = sanitizeFileUriSegment(input.directoryName, 'happier-cache');
        const prefix = `${randomUUID()}-`;
        const fileName = `${prefix}${sanitizeFileUriSegment(input.fileName, 'preview', MAX_CACHE_FILE_NAME_BYTES - new TextEncoder().encode(prefix).byteLength)}`;
        const cacheDirectory = typeof cachePath === 'string'
            ? new FileSystem.Directory(cachePath)
            : cachePath;
        const directory = new FileSystem.Directory(cacheDirectory, directoryName);
        directory.create({ intermediates: true, idempotent: true });

        const file = new FileSystem.File(directory, fileName);
        file.create();
        let handle: ExpoFileSystemFileHandle;
        try {
            handle = file.open();
        } catch (error) {
            try {
                file.delete();
            } catch (cleanupError) {
                throw Object.assign(new Error(`${error instanceof Error ? error.message : String(error)}; Failed to clean up cache file: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`), {
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
                // A native copy can remove its destination before failing.
                if (file.exists === false) removed = true;
                else errors.push(error);
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
            fileUri: file.uri,
            writeBytes: async (bytes) => {
                handle.writeBytes(bytes);
            },
            close,
            cleanup,
        };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to create cache file sink' };
    }
}
