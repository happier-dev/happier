import { encodeBase64 } from '@/encryption/base64';

function mergeTransferChunks(chunks: readonly Uint8Array[]): Uint8Array {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

export function createBufferedTransferDestination(maxBytes: number): Readonly<{
    destination: {
        writeBytes: (bytes: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
        cleanup: () => Promise<void>;
    };
    toBase64: () => string;
    reset: () => void;
}> {
    let bufferedBytes = 0;
    const chunks: Uint8Array[] = [];

    const reset = () => {
        bufferedBytes = 0;
        chunks.length = 0;
    };

    return {
        destination: {
            writeBytes: async (bytes) => {
                bufferedBytes += bytes.byteLength;
                if (bufferedBytes > maxBytes) {
                    throw new Error('File exceeds the inline file read size limit');
                }
                chunks.push(new Uint8Array(bytes));
            },
            close: async () => {},
            cleanup: async () => {
                reset();
            },
        },
        toBase64: () => encodeBase64(mergeTransferChunks(chunks), 'base64'),
        reset,
    };
}
