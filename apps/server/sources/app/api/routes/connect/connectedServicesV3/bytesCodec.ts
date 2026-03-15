const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toPrismaBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    if (bytes.buffer instanceof ArrayBuffer) {
        const sliced = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        return new Uint8Array(sliced);
    }
    const buffer = new ArrayBuffer(bytes.byteLength);
    const copy = new Uint8Array(buffer);
    copy.set(bytes);
    return copy;
}

export function encodeUtf8Bytes(value: string): Uint8Array<ArrayBuffer> {
    return toPrismaBytes(encoder.encode(value));
}

export function decodeUtf8String(bytes: Uint8Array): string {
    return decoder.decode(bytes);
}

