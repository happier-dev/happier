import { WEB_FILE_BUFFER_MAX_BYTES } from '@/sync/runtime/files/webFileBufferBudget';
export { WEB_FILE_BUFFER_MAX_BYTES as WEB_DOWNLOAD_MEMORY_FALLBACK_MAX_BYTES } from '@/sync/runtime/files/webFileBufferBudget';

const WEB_DOWNLOAD_SIZE_LIMIT_ERROR = 'File exceeds the web download size limit';

type OpfsWritable = Readonly<{
    write: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    abort?: () => Promise<void>;
}>;

type OpfsFileHandle = Readonly<{
    createWritable: () => Promise<OpfsWritable>;
    getFile: () => Promise<File>;
}>;

type OpfsRoot = Readonly<{
    getFileHandle: (name: string, options?: Readonly<{ create?: boolean }>) => Promise<OpfsFileHandle>;
    removeEntry: (name: string) => Promise<void>;
}>;

export type WebDownloadFileCustody = Readonly<{
    kind: 'web_opfs';
    entryName: string;
}>;

function isOpfsRoot(value: unknown): value is OpfsRoot {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<OpfsRoot>;
    return typeof candidate.getFileHandle === 'function'
        && typeof candidate.removeEntry === 'function';
}

export type WebDownloadFileSink = Readonly<{
    writeBytes: (bytes: Uint8Array) => Promise<void>;
    close: () => Promise<void>;
    getFile: () => Promise<File | Blob>;
    cleanup: () => Promise<void>;
    /** Present only when the bytes can be reopened after the creating component remounts. */
    fileCustody: WebDownloadFileCustody | null;
}>;

function normalizeByteLimit(value: number): number {
    if (!Number.isFinite(value) || value < 0) {
        return 0;
    }
    return Math.floor(value);
}

function assertWithinLimit(sizeBytes: number, maxBytes: number): void {
    if (sizeBytes > maxBytes) {
        throw new Error(WEB_DOWNLOAD_SIZE_LIMIT_ERROR);
    }
}

async function tryGetOpfsRoot(): Promise<OpfsRoot | null> {
    const storage = (globalThis.navigator as unknown as {
        storage?: Readonly<{ getDirectory?: () => Promise<unknown> }>;
    } | undefined)?.storage;
    if (typeof storage?.getDirectory !== 'function') {
        return null;
    }

    try {
        const root: unknown = await storage.getDirectory();
        return isOpfsRoot(root) ? root : null;
    } catch {
        return null;
    }
}

function createTempFileName(): string {
    const suffix = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `.happier-download-${suffix}.partial`;
}

function assertWebDownloadFileCustody(value: WebDownloadFileCustody): void {
    if (value.kind !== 'web_opfs' || !value.entryName.startsWith('.happier-download-') || !value.entryName.endsWith('.partial')) {
        throw new Error('Invalid web file custody');
    }
}

export async function openWebDownloadFileCustody(custody: WebDownloadFileCustody): Promise<File> {
    assertWebDownloadFileCustody(custody);
    const root = await tryGetOpfsRoot();
    if (!root) throw new Error('File-backed web download is unavailable');
    const handle = await root.getFileHandle(custody.entryName);
    return await handle.getFile();
}

export async function removeWebDownloadFileCustody(custody: WebDownloadFileCustody): Promise<void> {
    assertWebDownloadFileCustody(custody);
    const root = await tryGetOpfsRoot();
    if (!root) throw new Error('File-backed web download is unavailable');
    try {
        await root.removeEntry(custody.entryName);
    } catch (error) {
        // OPFS uses the DOM NotFoundError contract for idempotent removal.
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
        throw error;
    }
}

export async function createWebDownloadFileSink(input: Readonly<{
    expectedSizeBytes: number;
    maxBytes: number;
    /** Sensitive executable packages must not fall back to whole-file memory custody. */
    requireFileBacked?: boolean;
}>): Promise<WebDownloadFileSink> {
    const expectedSizeBytes = normalizeByteLimit(input.expectedSizeBytes);
    const maxBytes = normalizeByteLimit(input.maxBytes);
    assertWithinLimit(expectedSizeBytes, maxBytes);

    const opfsRoot = await tryGetOpfsRoot();
    if (opfsRoot) {
        const tempFileName = createTempFileName();
        const fileHandle = await opfsRoot.getFileHandle(tempFileName, { create: true });
        const writable = await fileHandle.createWritable();
        let writtenBytes = 0;
        let closed = false;
        let cleaned = false;

        const cleanup = async (): Promise<void> => {
            if (cleaned) return;
            cleaned = true;
            if (!closed) {
                if (typeof writable.abort === 'function') {
                    await writable.abort().catch(() => undefined);
                } else {
                    await writable.close().catch(() => undefined);
                }
            }
            await opfsRoot.removeEntry(tempFileName).catch(() => undefined);
        };

        return {
            writeBytes: async (bytes) => {
                if (closed || cleaned) {
                    throw new Error('Web download sink is closed');
                }
                const nextWrittenBytes = writtenBytes + bytes.byteLength;
                if (nextWrittenBytes > maxBytes) {
                    await cleanup();
                    throw new Error(WEB_DOWNLOAD_SIZE_LIMIT_ERROR);
                }
                await writable.write(bytes);
                writtenBytes = nextWrittenBytes;
            },
            close: async () => {
                if (closed || cleaned) return;
                await writable.close();
                closed = true;
            },
            getFile: async () => {
                if (!closed || cleaned) {
                    throw new Error('Web download sink is not ready');
                }
                return await fileHandle.getFile();
            },
            cleanup,
            fileCustody: { kind: 'web_opfs', entryName: tempFileName },
        };
    }

    if (input.requireFileBacked) {
        throw new Error('File-backed web download is unavailable');
    }
    const fallbackMaxBytes = Math.min(maxBytes, WEB_FILE_BUFFER_MAX_BYTES);
    assertWithinLimit(expectedSizeBytes, fallbackMaxBytes);
    const chunks: Uint8Array[] = [];
    let writtenBytes = 0;
    let closed = false;
    let cleaned = false;

    return {
        writeBytes: async (bytes) => {
            if (closed || cleaned) {
                throw new Error('Web download sink is closed');
            }
            const nextWrittenBytes = writtenBytes + bytes.byteLength;
            if (nextWrittenBytes > fallbackMaxBytes) {
                chunks.length = 0;
                writtenBytes = 0;
                cleaned = true;
                throw new Error(WEB_DOWNLOAD_SIZE_LIMIT_ERROR);
            }
            chunks.push(new Uint8Array(bytes));
            writtenBytes = nextWrittenBytes;
        },
        close: async () => {
            if (cleaned) return;
            closed = true;
        },
        getFile: async () => {
            if (!closed || cleaned) {
                throw new Error('Web download sink is not ready');
            }
            return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' });
        },
        cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            chunks.length = 0;
            writtenBytes = 0;
        },
        fileCustody: null,
    };
}
