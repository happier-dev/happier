export type LocalUploadSource =
    | Readonly<{ kind: 'web'; file: File }>
    | Readonly<{ kind: 'memory'; bytes: Uint8Array }>
    | Readonly<{ kind: 'native'; uri: string; sizeBytes?: number | null }>;

export type LocalUploadSourceReader = Readonly<{
    sizeBytes: number | null;
    readBytes: (offset: number, length: number) => Promise<Uint8Array>;
    close: () => Promise<void>;
}>;

function isFiniteSizeBytes(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

async function openNativeLocalUploadSourceReader(source: Readonly<{ uri: string; sizeBytes?: number | null }>): Promise<LocalUploadSourceReader> {
    const FileSystem: any = await import('expo-file-system');
    const file = new FileSystem.File(source.uri);
    const handle = file.open();
    const sizeBytes = isFiniteSizeBytes(handle?.size)
        ? handle.size
        : isFiniteSizeBytes(file?.size)
            ? file.size
            : isFiniteSizeBytes(source.sizeBytes)
                ? source.sizeBytes
                : null;

    return {
        sizeBytes,
        readBytes: async (offset, length) => {
            if (typeof handle.offset === 'number' || handle.offset === null) {
                handle.offset = offset;
            }
            return handle.readBytes(length);
        },
        close: async () => {
            try {
                handle.close();
            } catch {
                // ignore
            }
        },
    };
}

export async function openLocalUploadSourceReader(source: LocalUploadSource): Promise<LocalUploadSourceReader> {
    if (source.kind === 'web') {
        return {
            sizeBytes: source.file.size,
            readBytes: async (offset, length) => {
                const nextEnd = Math.min(source.file.size, offset + length);
                const chunkBlob = source.file.slice(offset, nextEnd);
                return new Uint8Array(await chunkBlob.arrayBuffer());
            },
            close: async () => {
                // no-op
            },
        };
    }

    if (source.kind === 'memory') {
        return {
            sizeBytes: source.bytes.byteLength,
            readBytes: async (offset, length) => source.bytes.slice(offset, Math.min(source.bytes.byteLength, offset + length)),
            close: async () => {
                // no-op
            },
        };
    }

    return await openNativeLocalUploadSourceReader(source);
}

export async function resolveLocalUploadSourceSizeBytes(source: LocalUploadSource): Promise<number | null> {
    if (source.kind === 'web') {
        return source.file.size;
    }

    if (source.kind === 'memory') {
        return source.bytes.byteLength;
    }

    if (isFiniteSizeBytes(source.sizeBytes)) {
        return source.sizeBytes;
    }

    const reader = await openNativeLocalUploadSourceReader(source);
    try {
        return reader.sizeBytes;
    } finally {
        await reader.close();
    }
}
