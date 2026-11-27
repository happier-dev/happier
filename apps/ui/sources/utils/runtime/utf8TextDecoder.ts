/**
 * WHATWG UTF-8 TextDecoder for runtimes without a native one (Hermes).
 *
 * Expo's winter polyfill builds the result one code point at a time, which made
 * decoding HTTP JSON the largest native cold-start cost. This keeps the same
 * decoder state machine (maximal-subpart replacement, BOM, fatal, streaming)
 * and only changes how code units become a string: in bulk, per chunk.
 */
const UTF8_LABELS = new Set(['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8']);
const CHUNK_CODE_UNITS = 4096;
const REPLACEMENT = 0xfffd;

type DecoderInput = ArrayBuffer | ArrayBufferView | SharedArrayBuffer;

function toBytes(input: DecoderInput | undefined): Uint8Array {
    if (input === undefined) return new Uint8Array(0);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return new Uint8Array(input);
}

export class Utf8TextDecoder {
    readonly encoding = 'utf-8';
    readonly fatal: boolean;
    readonly ignoreBOM: boolean;
    private codePoint = 0;
    private bytesNeeded = 0;
    private bytesSeen = 0;
    private lowerBoundary = 0x80;
    private upperBoundary = 0xbf;
    private bomResolved = false;
    private streaming = false;

    constructor(label = 'utf-8', options: TextDecoderOptions = {}) {
        if (!UTF8_LABELS.has(String(label).trim().toLowerCase())) throw new RangeError(`Unknown encoding: ${label}`);
        this.fatal = options.fatal === true;
        this.ignoreBOM = options.ignoreBOM === true;
    }

    decode(input?: DecoderInput, options: TextDecodeOptions = {}): string {
        if (!this.streaming) this.reset();
        this.streaming = options.stream === true;
        const bytes = toBytes(input);
        const units = new Uint16Array(Math.min(CHUNK_CODE_UNITS + 1, bytes.length + 2));
        let parts = '';
        let count = 0;
        const flush = () => {
            parts += String.fromCharCode.apply(null, units.subarray(0, count) as unknown as number[]);
            count = 0;
        };
        const emit = (codePoint: number) => {
            if (!this.bomResolved) {
                this.bomResolved = true;
                if (codePoint === 0xfeff && !this.ignoreBOM) return;
            }
            if (count >= CHUNK_CODE_UNITS) flush();
            if (codePoint > 0xffff) {
                codePoint -= 0x10000;
                units[count++] = 0xd800 + (codePoint >> 10);
                units[count++] = 0xdc00 + (codePoint & 0x3ff);
            } else units[count++] = codePoint;
        };
        const error = () => {
            if (this.fatal) {
                this.reset();
                throw new TypeError('The encoded data was not valid utf-8');
            }
            emit(REPLACEMENT);
        };
        for (let index = 0; index < bytes.length; index += 1) {
            const byte = bytes[index]!;
            if (this.bytesNeeded === 0) {
                if (byte <= 0x7f) {
                    // ASCII fast path: no BOM and no surrogate work can apply.
                    if (this.bomResolved && count < CHUNK_CODE_UNITS) units[count++] = byte;
                    else emit(byte);
                } else if (byte >= 0xc2 && byte <= 0xdf) {
                    this.bytesNeeded = 1;
                    this.codePoint = byte & 0x1f;
                } else if (byte >= 0xe0 && byte <= 0xef) {
                    if (byte === 0xe0) this.lowerBoundary = 0xa0;
                    if (byte === 0xed) this.upperBoundary = 0x9f;
                    this.bytesNeeded = 2;
                    this.codePoint = byte & 0xf;
                } else if (byte >= 0xf0 && byte <= 0xf4) {
                    if (byte === 0xf0) this.lowerBoundary = 0x90;
                    if (byte === 0xf4) this.upperBoundary = 0x8f;
                    this.bytesNeeded = 3;
                    this.codePoint = byte & 0x7;
                } else error();
                continue;
            }
            if (byte < this.lowerBoundary || byte > this.upperBoundary) {
                this.resetSequence();
                error();
                // The byte that ended the sequence starts the next one.
                index -= 1;
                continue;
            }
            this.lowerBoundary = 0x80;
            this.upperBoundary = 0xbf;
            this.codePoint = (this.codePoint << 6) | (byte & 0x3f);
            this.bytesSeen += 1;
            if (this.bytesSeen !== this.bytesNeeded) continue;
            const codePoint = this.codePoint;
            this.resetSequence();
            emit(codePoint);
        }
        if (!this.streaming && this.bytesNeeded !== 0) {
            this.resetSequence();
            error();
        }
        if (count > 0) flush();
        return parts;
    }

    private resetSequence(): void {
        this.codePoint = 0;
        this.bytesNeeded = 0;
        this.bytesSeen = 0;
        this.lowerBoundary = 0x80;
        this.upperBoundary = 0xbf;
    }

    private reset(): void {
        this.resetSequence();
        this.bomResolved = false;
        this.streaming = false;
    }
}
