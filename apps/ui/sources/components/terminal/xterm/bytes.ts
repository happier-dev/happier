export type XtermWriteBytesInput = Readonly<{
    terminalId: string;
    seq: number;
    byteOffset: number;
    bytes: Uint8Array;
}>;

export type XtermWriteCompleteEvent = Readonly<{
    terminalId: string;
    seq: number;
    byteOffset: number;
    byteLength: number;
    ackedByteOffset: number;
}>;

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();

export function copyTerminalBytes(bytes: Uint8Array): Uint8Array {
    return bytes.slice();
}

export function decodeTerminalBytesForPreview(bytes: Uint8Array): string {
    if (bytes.byteLength === 0) return '';
    return utf8Decoder.decode(bytes);
}

export function estimateUtf8ByteLength(text: string): number {
    if (text.length === 0) return 0;
    return utf8Encoder.encode(text).byteLength;
}

export function buildXtermWriteCompleteEvent(input: XtermWriteBytesInput): XtermWriteCompleteEvent {
    const byteLength = input.bytes.byteLength;
    return {
        terminalId: input.terminalId,
        seq: input.seq,
        byteOffset: input.byteOffset,
        byteLength,
        ackedByteOffset: input.byteOffset + byteLength,
    };
}
