import { z } from 'zod/mini';
import { V2SessionRecordSchema, V2SessionByIdResponseSchema, SessionLookupByTagsResponseV2Schema, SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchDetailV1Schema, SessionReadBatchResultV1Schema, SessionReadBatchResponseV1Schema,
    type SessionReadBatchResponseV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import type { SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

type ProjectedSessionRecord = Readonly<Record<string, unknown>> & Readonly<{
    ownerMetadata?: SessionOwnerMetadataEnvelopeV1 | null;
}>;

// Only the recipient projector's already-admitted envelope skips a second payload
// scan. Every other field and record refinement keeps its canonical admission.
const recordResponse = z.safeExtend(V2SessionRecordSchema, {
    ownerMetadata: z.optional(z.nullable(z.custom<SessionOwnerMetadataEnvelopeV1>())),
});
const byIdResponse = z.safeExtend(V2SessionByIdResponseSchema, { session: recordResponse });
const lookupResponse = z.safeExtend(SessionLookupByTagsResponseV2Schema, {
    sessions: z.array(recordResponse).check(z.maxLength(SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2)),
});
const batchDetailResponse = z.union([
    z.safeExtend(SessionReadBatchDetailV1Schema._zod.def.options[0], { body: byIdResponse }),
    SessionReadBatchDetailV1Schema._zod.def.options[1],
]);
const batchResponse = z.safeExtend(SessionReadBatchResponseV1Schema, {
    results: z.array(z.safeExtend(SessionReadBatchResultV1Schema, { detail: z.optional(batchDetailResponse) })),
});

export function parseProjectedSessionRecord(record: ProjectedSessionRecord) {
    return recordResponse.parse(record);
}

export function parseProjectedSessionByIdResponse(body: Readonly<Record<string, unknown>> & Readonly<{
    session: ProjectedSessionRecord;
}>) {
    return byIdResponse.parse(body);
}

export function parseProjectedSessionLookupResponse(body: Readonly<{ sessions: readonly ProjectedSessionRecord[] }>) {
    return lookupResponse.parse(body);
}

/** Compatibility projections return `unknown`; this parse is their typed admission. */
export function parseProjectedSessionBatchDetail(detail: unknown) {
    return batchDetailResponse.parse(detail);
}

export function parseProjectedSessionBatchResponse(body: SessionReadBatchResponseV1) {
    return batchResponse.parse(body);
}
