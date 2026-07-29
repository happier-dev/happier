import {
    MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1,
    type MachineLiveStreamAvccChunkTypeV1,
} from '@happier-dev/protocol';

export type AndroidScrcpyRawStreamReasonCode =
    | 'android_scrcpy_raw_stream_buffer_limit_exceeded'
    | 'android_scrcpy_raw_stream_ended'
    | 'android_scrcpy_avcc_description_unavailable';

/**
 * Canonical error for the Android scrcpy raw-stream capture path. Owned here (the stream-leaf
 * module) so both the raw-stream producer (`capture.ts`) and the server-restart producer
 * (`restartProducer.ts`) can throw/identify it without a module cycle.
 */
export class AndroidScrcpyStreamError extends Error {
    readonly reasonCode: AndroidScrcpyRawStreamReasonCode
        | 'android_scrcpy_raw_stream_codec_unsupported'
        | 'android_scrcpy_raw_stream_unavailable'
        | 'android_scrcpy_raw_stream_failed'
        | string;

    constructor(reasonCode: AndroidScrcpyStreamError['reasonCode']) {
        super(reasonCode);
        this.name = 'AndroidScrcpyStreamError';
        this.reasonCode = reasonCode;
    }
}

export type AndroidScrcpyAnnexBNalUnit = Readonly<{
    payload: Uint8Array;
    nalType: number;
    keyframe: boolean;
}>;

export type AndroidScrcpyAnnexBParserResult = Readonly<{
    nalUnits: readonly AndroidScrcpyAnnexBNalUnit[];
    bufferedBytes: number;
    droppedBytes: number;
    reasonCode?: Extract<AndroidScrcpyRawStreamReasonCode, 'android_scrcpy_raw_stream_buffer_limit_exceeded'>;
}>;

export type AndroidScrcpyAvccChunk = Readonly<{
    type: MachineLiveStreamAvccChunkTypeV1;
    payload: Uint8Array;
    keyframe: boolean;
}>;

export type AndroidScrcpyAvccConverterResult = Readonly<{
    chunks: readonly AndroidScrcpyAvccChunk[];
    bufferedBytes: number;
    droppedBytes: number;
    metadata: Readonly<{
        hasSps: boolean;
        hasPps: boolean;
        sawKeyframe: boolean;
    }>;
    reasonCode?: AndroidScrcpyRawStreamReasonCode;
}>;

type StartCode = Readonly<{
    index: number;
    length: 3 | 4;
}>;

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.length === 0) return right.slice();
    if (right.length === 0) return left;
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left);
    merged.set(right, left.length);
    return merged;
}

function findStartCode(bytes: Uint8Array, fromIndex: number): StartCode | null {
    for (let index = Math.max(0, fromIndex); index < bytes.length - 2; index += 1) {
        if (
            index < bytes.length - 3
            && bytes[index] === 0x00
            && bytes[index + 1] === 0x00
            && bytes[index + 2] === 0x00
            && bytes[index + 3] === 0x01
        ) {
            return { index, length: 4 };
        }
        if (bytes[index] === 0x00 && bytes[index + 1] === 0x00 && bytes[index + 2] === 0x01) {
            return { index, length: 3 };
        }
    }
    return null;
}

function trailingPotentialStartCodeBytes(bytes: Uint8Array): number {
    let count = 0;
    for (let index = bytes.length - 1; index >= 0 && bytes[index] === 0x00 && count < 3; index -= 1) {
        count += 1;
    }
    return count;
}

function trimNoiseBeforeStartCode(buffer: Uint8Array): Readonly<{ buffer: Uint8Array; droppedBytes: number }> {
    const start = findStartCode(buffer, 0);
    if (start) {
        return start.index > 0
            ? { buffer: buffer.slice(start.index), droppedBytes: start.index }
            : { buffer, droppedBytes: 0 };
    }

    const keep = trailingPotentialStartCodeBytes(buffer);
    return {
        buffer: keep > 0 ? buffer.slice(buffer.length - keep) : new Uint8Array(0),
        droppedBytes: buffer.length - keep,
    };
}

function nalUnitFromPayload(payload: Uint8Array): AndroidScrcpyAnnexBNalUnit | null {
    const header = payload[0];
    if (header === undefined) return null;
    const nalType = header & 0x1f;
    return {
        payload,
        nalType,
        keyframe: nalType === 5,
    };
}

export function createAndroidScrcpyAnnexBParser(input: Readonly<{
    maxBufferedBytes: number;
}>): Readonly<{
    push: (chunk: Uint8Array) => AndroidScrcpyAnnexBParserResult;
    reset: () => void;
}> {
    const maxBufferedBytes = Math.max(8, Math.floor(input.maxBufferedBytes));
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    return {
        push: (chunk) => {
            buffer = appendBytes(buffer, chunk);
            let droppedBytes = 0;
            let reasonCode: AndroidScrcpyAnnexBParserResult['reasonCode'];
            const nalUnits: AndroidScrcpyAnnexBNalUnit[] = [];

            const trimmed = trimNoiseBeforeStartCode(buffer);
            buffer = trimmed.buffer;
            droppedBytes += trimmed.droppedBytes;

            while (true) {
                const currentStart = findStartCode(buffer, 0);
                if (!currentStart || currentStart.index !== 0) {
                    const nextTrimmed = trimNoiseBeforeStartCode(buffer);
                    buffer = nextTrimmed.buffer;
                    droppedBytes += nextTrimmed.droppedBytes;
                    break;
                }

                const payloadStart = currentStart.length;
                const nextStart = findStartCode(buffer, payloadStart);
                if (!nextStart) break;

                const payload = buffer.slice(payloadStart, nextStart.index);
                const nalUnit = nalUnitFromPayload(payload);
                if (nalUnit) nalUnits.push(nalUnit);
                buffer = buffer.slice(nextStart.index);
            }

            if (buffer.length > maxBufferedBytes) {
                droppedBytes += buffer.length - maxBufferedBytes;
                buffer = buffer.slice(buffer.length - maxBufferedBytes);
                reasonCode = 'android_scrcpy_raw_stream_buffer_limit_exceeded';
            }

            return {
                nalUnits,
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

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = (value >>> 8) & 0xff;
    bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
}

function buildAvccDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
    const description = new Uint8Array(11 + sps.length + pps.length);
    description[0] = 0x01;
    description[1] = sps[1] ?? 0x42;
    description[2] = sps[2] ?? 0x00;
    description[3] = sps[3] ?? 0x1e;
    description[4] = 0xff;
    description[5] = 0xe1;
    writeUint16(description, 6, sps.length);
    description.set(sps, 8);
    const ppsCountOffset = 8 + sps.length;
    description[ppsCountOffset] = 0x01;
    writeUint16(description, ppsCountOffset + 1, pps.length);
    description.set(pps, ppsCountOffset + 3);
    return description;
}

function buildLengthPrefixedNalUnit(nalUnit: Uint8Array): Uint8Array {
    const payload = new Uint8Array(4 + nalUnit.length);
    writeUint32(payload, 0, nalUnit.length);
    payload.set(nalUnit, 4);
    return payload;
}

function buildLengthPrefixedNalUnits(nalUnits: readonly AndroidScrcpyAnnexBNalUnit[]): Uint8Array {
    const totalBytes = nalUnits.reduce((total, nalUnit) => total + 4 + nalUnit.payload.length, 0);
    const payload = new Uint8Array(totalBytes);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        const framed = buildLengthPrefixedNalUnit(nalUnit.payload);
        payload.set(framed, offset);
        offset += framed.length;
    }
    return payload;
}

function buildEnvelope(type: MachineLiveStreamAvccChunkTypeV1, payload: Uint8Array): Uint8Array {
    const envelope = new Uint8Array(5 + payload.length);
    writeUint32(envelope, 0, payload.length + 1);
    envelope[4] = MACHINE_LIVE_STREAM_AVCC_ENVELOPE_TAGS_V1[type];
    envelope.set(payload, 5);
    return envelope;
}

function isVideoSlice(nalType: number): boolean {
    return nalType >= 1 && nalType <= 5;
}

function rbspPayloadBytes(nalUnit: Uint8Array): Uint8Array {
    const rbsp: number[] = [];
    let zeroRun = 0;
    for (let index = 1; index < nalUnit.length; index += 1) {
        const byte = nalUnit[index]!;
        if (zeroRun >= 2 && byte === 0x03) {
            zeroRun = 0;
            continue;
        }
        rbsp.push(byte);
        zeroRun = byte === 0x00 ? zeroRun + 1 : 0;
    }
    return new Uint8Array(rbsp);
}

function readBit(bytes: Uint8Array, bitIndex: number): 0 | 1 | null {
    const byte = bytes[Math.floor(bitIndex / 8)];
    if (byte === undefined) return null;
    return ((byte >> (7 - (bitIndex % 8))) & 0x01) as 0 | 1;
}

function readUnsignedExpGolomb(bytes: Uint8Array): number | null {
    let bitIndex = 0;
    let leadingZeroBits = 0;
    while (true) {
        const bit = readBit(bytes, bitIndex);
        if (bit === null) return null;
        bitIndex += 1;
        if (bit === 1) break;
        leadingZeroBits += 1;
        if (leadingZeroBits > 30) return null;
    }

    let suffix = 0;
    for (let index = 0; index < leadingZeroBits; index += 1) {
        const bit = readBit(bytes, bitIndex);
        if (bit === null) return null;
        bitIndex += 1;
        suffix = (suffix << 1) | bit;
    }
    return (2 ** leadingZeroBits) - 1 + suffix;
}

function readFirstMacroblockInSlice(nalUnit: AndroidScrcpyAnnexBNalUnit): number | null {
    if (!isVideoSlice(nalUnit.nalType)) return null;
    return readUnsignedExpGolomb(rbspPayloadBytes(nalUnit.payload));
}

export function createAndroidScrcpyAvccConverter(input: Readonly<{
    maxBufferedBytes: number;
}>): Readonly<{
    push: (chunk: Uint8Array) => AndroidScrcpyAvccConverterResult;
    reset: () => void;
}> {
    const maxBufferedBytes = Math.max(8, Math.floor(input.maxBufferedBytes));
    const parser = createAndroidScrcpyAnnexBParser({
        maxBufferedBytes,
    });
    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;
    let descriptionDirty = false;
    let pendingNalUnits: AndroidScrcpyAnnexBNalUnit[] = [];
    let pendingBytes = 0;
    let pendingHasVideoSlice = false;
    let pendingKeyframe = false;

    const resetPendingAccessUnit = (): void => {
        pendingNalUnits = [];
        pendingBytes = 0;
        pendingHasVideoSlice = false;
        pendingKeyframe = false;
    };

    const pendingStartsNewAccessUnit = (nalUnit: AndroidScrcpyAnnexBNalUnit): boolean => {
        if (!pendingHasVideoSlice) return false;
        if (nalUnit.nalType === 7 || nalUnit.nalType === 8 || nalUnit.nalType === 9) return true;
        if (!isVideoSlice(nalUnit.nalType)) return false;
        const firstMacroblock = readFirstMacroblockInSlice(nalUnit);
        return firstMacroblock !== null ? firstMacroblock === 0 : true;
    };

    const emitPendingAccessUnit = (chunks: AndroidScrcpyAvccChunk[]): Readonly<{
        reasonCode?: AndroidScrcpyRawStreamReasonCode;
        sawKeyframe: boolean;
    }> => {
        if (!pendingHasVideoSlice) {
            resetPendingAccessUnit();
            return { sawKeyframe: false };
        }

        const videoNalUnits = pendingNalUnits.filter((nalUnit) => isVideoSlice(nalUnit.nalType));
        const accessUnitKeyframe = pendingKeyframe;
        resetPendingAccessUnit();

        if (!sps || !pps) {
            return {
                reasonCode: 'android_scrcpy_avcc_description_unavailable',
                sawKeyframe: accessUnitKeyframe,
            };
        }
        if (descriptionDirty) {
            chunks.push({
                type: 'description',
                payload: buildEnvelope('description', buildAvccDescription(sps, pps)),
                keyframe: true,
            });
            descriptionDirty = false;
        }

        const type = accessUnitKeyframe ? 'keyframe' : 'delta';
        chunks.push({
            type,
            payload: buildEnvelope(type, buildLengthPrefixedNalUnits(videoNalUnits)),
            keyframe: accessUnitKeyframe,
        });
        return { sawKeyframe: accessUnitKeyframe };
    };

    const appendPendingNalUnit = (nalUnit: AndroidScrcpyAnnexBNalUnit): boolean => {
        pendingNalUnits.push(nalUnit);
        pendingBytes += nalUnit.payload.length;
        if (isVideoSlice(nalUnit.nalType)) {
            pendingHasVideoSlice = true;
            pendingKeyframe = pendingKeyframe || nalUnit.keyframe;
        }
        return pendingBytes <= maxBufferedBytes;
    };

    return {
        push: (chunk) => {
            const parsed = parser.push(chunk);
            const chunks: AndroidScrcpyAvccChunk[] = [];
            let reasonCode: AndroidScrcpyAvccConverterResult['reasonCode'] = parsed.reasonCode;
            let sawKeyframe = false;
            let droppedBytes = parsed.droppedBytes;

            for (const nalUnit of parsed.nalUnits) {
                if (nalUnit.keyframe) sawKeyframe = true;
                if (pendingStartsNewAccessUnit(nalUnit)) {
                    const emitted = emitPendingAccessUnit(chunks);
                    reasonCode = emitted.reasonCode ?? reasonCode;
                    sawKeyframe = sawKeyframe || emitted.sawKeyframe;
                }

                if (nalUnit.nalType === 7) {
                    sps = nalUnit.payload;
                    descriptionDirty = true;
                }
                if (nalUnit.nalType === 8) {
                    pps = nalUnit.payload;
                    descriptionDirty = true;
                }
                if (isVideoSlice(nalUnit.nalType) && (!sps || !pps)) {
                    reasonCode = 'android_scrcpy_avcc_description_unavailable';
                }

                if (!appendPendingNalUnit(nalUnit)) {
                    droppedBytes += pendingBytes;
                    resetPendingAccessUnit();
                    reasonCode = 'android_scrcpy_raw_stream_buffer_limit_exceeded';
                    chunks.length = 0;
                    break;
                }
            }

            return {
                chunks,
                bufferedBytes: parsed.bufferedBytes + pendingBytes,
                droppedBytes,
                metadata: {
                    hasSps: sps !== null,
                    hasPps: pps !== null,
                    sawKeyframe,
                },
                ...(reasonCode ? { reasonCode } : {}),
            };
        },
        reset: () => {
            parser.reset();
            sps = null;
            pps = null;
            descriptionDirty = false;
            resetPendingAccessUnit();
        },
    };
}
