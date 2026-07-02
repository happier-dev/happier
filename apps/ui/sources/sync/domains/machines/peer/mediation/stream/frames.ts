import {
    resolveMachineLiveStreamAvccChunkTypeV1,
    type MachineLiveStreamAvccChunkTypeV1,
} from '@happier-dev/protocol';

export type MachineLiveStreamJpegFrame = Uint8Array;

export type MachineLiveStreamMjpegExtractorResult = Readonly<{
    frames: readonly MachineLiveStreamJpegFrame[];
    bufferedBytes: number;
    droppedBytes: number;
    reasonCode?: 'mjpeg_buffer_limit_exceeded';
}>;

export type MachineLiveStreamAvccChunk = Readonly<{
    type: MachineLiveStreamAvccChunkTypeV1;
    payload: Uint8Array;
}>;

export type MachineLiveStreamAvccDemuxerResult = Readonly<{
    chunks: readonly MachineLiveStreamAvccChunk[];
    bufferedBytes: number;
    droppedBytes: number;
    reasonCode?: 'avcc_buffer_limit_exceeded';
}>;

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.length === 0) return right.slice();
    if (right.length === 0) return left;
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left);
    merged.set(right, left.length);
    return merged;
}

function findBytePair(bytes: Uint8Array, first: number, second: number, fromIndex: number): number {
    for (let index = Math.max(0, fromIndex); index < bytes.length - 1; index += 1) {
        if (bytes[index] === first && bytes[index + 1] === second) return index;
    }
    return -1;
}

export function createMachineLiveStreamMjpegExtractor(input: Readonly<{
    maxBufferedBytes: number;
}>): Readonly<{
    push: (chunk: Uint8Array) => MachineLiveStreamMjpegExtractorResult;
    reset: () => void;
}> {
    const maxBufferedBytes = Math.max(1, Math.floor(input.maxBufferedBytes));
    let buffer: Uint8Array = new Uint8Array(0);

    const trimNoiseBeforeStart = (): number => {
        const start = findBytePair(buffer, 0xff, 0xd8, 0);
        if (start > 0) {
            buffer = buffer.slice(start);
            return start;
        }
        if (start === -1 && buffer.length > 0) {
            const keepTrailingStartByte = buffer[buffer.length - 1] === 0xff;
            const dropped = keepTrailingStartByte ? buffer.length - 1 : buffer.length;
            buffer = keepTrailingStartByte ? buffer.slice(buffer.length - 1) : new Uint8Array(0);
            return dropped;
        }
        return 0;
    };

    return {
        push: (chunk) => {
            buffer = appendBytes(buffer, chunk);
            let droppedBytes = trimNoiseBeforeStart();
            const frames: Uint8Array[] = [];
            let reasonCode: MachineLiveStreamMjpegExtractorResult['reasonCode'];

            while (true) {
                const start = findBytePair(buffer, 0xff, 0xd8, 0);
                if (start === -1) {
                    droppedBytes += trimNoiseBeforeStart();
                    break;
                }
                if (start > 0) {
                    buffer = buffer.slice(start);
                    droppedBytes += start;
                }

                const end = findBytePair(buffer, 0xff, 0xd9, 2);
                if (end === -1) break;
                const frameEnd = end + 2;
                if (frameEnd > maxBufferedBytes) {
                    droppedBytes += frameEnd;
                    buffer = buffer.slice(frameEnd);
                    droppedBytes += trimNoiseBeforeStart();
                    reasonCode = 'mjpeg_buffer_limit_exceeded';
                    continue;
                }
                frames.push(buffer.slice(0, frameEnd));
                buffer = buffer.slice(frameEnd);
                droppedBytes += trimNoiseBeforeStart();
            }

            if (buffer.length > maxBufferedBytes) {
                droppedBytes += buffer.length - maxBufferedBytes;
                buffer = buffer.slice(buffer.length - maxBufferedBytes);
                droppedBytes += trimNoiseBeforeStart();
                reasonCode = 'mjpeg_buffer_limit_exceeded';
            }

            return {
                frames,
                bufferedBytes: buffer.length,
                droppedBytes,
                ...(reasonCode ? { reasonCode } : {}),
            };
        },
        reset: () => {
            buffer = new Uint8Array(0);
        },
    };
}

export function createMachineLiveStreamAvccDemuxer(input: Readonly<{
    maxBufferedBytes: number;
}>): Readonly<{
    push: (chunk: Uint8Array) => MachineLiveStreamAvccDemuxerResult;
    reset: () => void;
}> {
    const maxBufferedBytes = Math.max(5, Math.floor(input.maxBufferedBytes));
    let buffer: Uint8Array = new Uint8Array(0);

    return {
        push: (chunk) => {
            buffer = appendBytes(buffer, chunk);
            const chunks: MachineLiveStreamAvccChunk[] = [];
            let offset = 0;
            let droppedBytes = 0;
            let reasonCode: MachineLiveStreamAvccDemuxerResult['reasonCode'];

            while (buffer.length - offset >= 4) {
                const length = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
                if (length < 1) {
                    offset += 4;
                    droppedBytes += 4;
                    continue;
                }
                const envelopeLength = 4 + length;
                if (envelopeLength > maxBufferedBytes) {
                    const availableOversizedBytes = Math.min(buffer.length - offset, envelopeLength);
                    offset += availableOversizedBytes;
                    droppedBytes += availableOversizedBytes;
                    reasonCode = 'avcc_buffer_limit_exceeded';
                    continue;
                }
                if (buffer.length - offset - 4 < length) break;

                const tag = buffer[offset + 4];
                const type = typeof tag === 'number' ? resolveMachineLiveStreamAvccChunkTypeV1(tag) : null;
                if (type) {
                    chunks.push({
                        type,
                        payload: buffer.slice(offset + 5, offset + 4 + length),
                    });
                }
                offset += envelopeLength;
            }

            if (offset > 0) buffer = buffer.slice(offset);

            if (buffer.length > maxBufferedBytes) {
                droppedBytes += buffer.length - maxBufferedBytes;
                buffer = buffer.slice(buffer.length - maxBufferedBytes);
                reasonCode = 'avcc_buffer_limit_exceeded';
            }

            return {
                chunks,
                bufferedBytes: buffer.length,
                droppedBytes,
                ...(reasonCode ? { reasonCode } : {}),
            };
        },
        reset: () => {
            buffer = new Uint8Array(0);
        },
    };
}
