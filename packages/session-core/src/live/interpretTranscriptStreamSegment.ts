import {
    normalizeRawMessage,
    normalizeRawMessageInSequence,
    type NormalizedMessage,
    type RawMessageNormalizationSequenceState,
} from '../raw/normalize.js';
import type { RawRecord } from '../raw/schemas.js';
import type { SessionMessageRole } from '@happier-dev/protocol';
import {
    isTerminalTranscriptStreamSegmentRecord,
    readTranscriptStreamSegmentGeneration,
    readTranscriptStreamSegmentText,
    withTranscriptStreamSegmentText,
    type TranscriptStreamSegmentAssembler,
} from "./transcriptStreamSegmentAssembly.js";

export type TranscriptStreamSegmentInput = Readonly<{
    assembler: TranscriptStreamSegmentAssembler;
    sessionId: string;
    record: RawRecord | null;
    message: Readonly<{
        localId: string;
        createdAt: number;
        messageRole?: SessionMessageRole | null;
        sidechainId?: string | null;
    }>;
    rawMessageNormalizationState?: RawMessageNormalizationSequenceState;
}> & (
    | Readonly<{ type: 'transcript-stream-segment'; tick?: number | null }>
    | Readonly<{ type: 'transcript-stream-segment-delta'; tick: number; baseLength: number }>
);

/** Interpret decrypted live frames through the same normalization owner as durable rows. */
export function interpretTranscriptStreamSegment(params: TranscriptStreamSegmentInput): NormalizedMessage | null {
    const { assembler, sessionId, message } = params;
    let record = params.record;
    if (params.type === 'transcript-stream-segment-delta') {
        const deltaText = readTranscriptStreamSegmentText(record);
        if (deltaText === null) {
            assembler.evictTranscriptStreamSegmentAssembly(sessionId, message.localId);
            return null;
        }
        const text = assembler.applyTranscriptStreamSegmentDelta({
            sessionId,
            localId: message.localId,
            deltaText,
            tick: params.tick,
            baseLength: params.baseLength,
            generation: readTranscriptStreamSegmentGeneration(record),
        });
        // A terminal delta ends the live chain; the durable base stays for the terminal revision.
        if (isTerminalTranscriptStreamSegmentRecord(record)) assembler.endTranscriptStreamSegmentLive(sessionId, message.localId);
        if (text === null) return null;
        record = record ? withTranscriptStreamSegmentText(record, text) : null;
        if (!record) {
            assembler.evictTranscriptStreamSegmentAssembly(sessionId, message.localId);
            return null;
        }
    } else {
        assembler.noteTranscriptStreamSegmentSnapshot({ sessionId, localId: message.localId, record, tick: params.tick ?? null });
    }
    const input = {
        id: message.localId,
        localId: message.localId,
        createdAt: message.createdAt,
        raw: record,
        messageRole: message.messageRole ?? undefined,
        sidechainId: message.sidechainId ?? undefined,
    };
    return params.rawMessageNormalizationState
        ? normalizeRawMessageInSequence(input, params.rawMessageNormalizationState)
        : normalizeRawMessage(input.id, input.localId, input.createdAt, input.raw, {
            messageRole: input.messageRole,
            sidechainId: input.sidechainId,
        });
}
