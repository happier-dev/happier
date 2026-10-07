import {
    resolveMachineLiveStreamAvccChunkTypeV1,
    type MachineLiveStreamAvccChunkTypeV1,
} from '@happier-dev/protocol';

export type MachineLiveStreamAvccChunk = Readonly<{
    type: MachineLiveStreamAvccChunkTypeV1;
    payload: Uint8Array;
}>;

export type MachineLiveStreamAvccDemuxerResult = Readonly<{
    chunks: readonly MachineLiveStreamAvccChunk[];
    bufferedBytes: number;
    droppedBytes: number;
    reasonCode?: 'avcc_incomplete_payload' | 'avcc_invalid_payload';
}>;

/**
 * Each input is one complete, size-admitted carrier payload, not a byte-stream fragment.
 * Android's encoder emits whole envelopes and relay ingestion preserves each frame's bytes.
 * Carrier admission owns the byte budget; retaining an incomplete envelope into another
 * frame would combine unrelated payloads, so incomplete retention is exactly zero.
 */
export function demuxMachineLiveStreamAvccPayload(bytes: Uint8Array): MachineLiveStreamAvccDemuxerResult {
    const chunks: MachineLiveStreamAvccChunk[] = [];
    let offset = 0;
    let droppedBytes = 0;
    let reasonCode: MachineLiveStreamAvccDemuxerResult['reasonCode'];
    while (bytes.length - offset >= 4) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
        if (length < 1) {
            offset += 4;
            droppedBytes += 4;
            reasonCode = 'avcc_invalid_payload';
            continue;
        }
        if (bytes.length - offset - 4 < length) break;
        const envelopeLength = 4 + length;
        const type = resolveMachineLiveStreamAvccChunkTypeV1(bytes[offset + 4]!);
        if (type) chunks.push({ type, payload: bytes.subarray(offset + 5, offset + envelopeLength) });
        else {
            droppedBytes += envelopeLength;
            reasonCode = 'avcc_invalid_payload';
        }
        offset += envelopeLength;
    }
    if (offset < bytes.length) {
        droppedBytes += bytes.length - offset;
        reasonCode = 'avcc_incomplete_payload';
    }
    return { chunks, bufferedBytes: 0, droppedBytes, ...(reasonCode ? { reasonCode } : {}) };
}
