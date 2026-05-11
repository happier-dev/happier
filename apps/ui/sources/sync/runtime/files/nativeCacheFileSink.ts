import { joinFileUri, sanitizeFileUriSegment } from './fileUriPath';

export type NativeCacheFileSink = Readonly<{
    fileUri: string;
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    cleanup: () => Promise<void>;
}>;

export async function createNativeCacheFileSink(input: Readonly<{
    directoryName: string;
    fileName: string;
}>): Promise<
    | Readonly<{ ok: true } & NativeCacheFileSink>
    | Readonly<{ ok: false; error: string }>
> {
    try {
        const FileSystem: any = await import('expo-file-system');
        const cacheDir = String(FileSystem.cacheDirectory ?? FileSystem.Paths?.cache ?? '').trim();
        if (!cacheDir) {
            return { ok: false, error: 'No cache directory available' };
        }

        const directoryName = sanitizeFileUriSegment(input.directoryName, 'happier-cache');
        const fileName = sanitizeFileUriSegment(input.fileName, 'preview');
        const directoryUri = joinFileUri(cacheDir, directoryName);
        await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });

        const file = new FileSystem.File(joinFileUri(directoryUri, fileName));
        try {
            file.delete();
        } catch {}
        file.create();
        const handle = file.open();
        if (typeof handle.offset === 'number' || handle.offset === null) {
            handle.offset = 0;
        }

        let closed = false;
        const close = async () => {
            if (closed) return;
            closed = true;
            try {
                handle.close();
            } catch {}
        };

        const cleanup = async () => {
            try {
                await close();
            } catch {}
            try {
                file.delete();
            } catch {}
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
