import { z } from 'zod/mini';
import { V2SessionRecordSchema, V2SessionByIdResponseSchema, SessionLookupByTagsResponseV2Schema, SESSION_LOOKUP_BY_TAGS_MAX_TAGS_V2 } from '@happier-dev/protocol/sessions/control/contract';
import { SessionReadBatchDetailV1Schema, type SessionReadBatchDetailV1 } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import type { SessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { orderAsDeclared } from '@/app/api/utils/enableSchemaValidation';

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

/**
 * The record producer (`mapV2SessionRow` and the detail owner's additions) validates each
 * stored value where it enters and builds every other member by typed construction, so its
 * record is emitted as it is: no whole-record parse, which cost about 47 KiB and 60-117 µs per
 * Session. Members take the order the record admission emitted.
 */
export function assembleProjectedSessionRecord<T extends ProjectedSessionRecord>(record: T): T {
    return orderAsDeclared(recordResponse, record);
}

export function parseProjectedSessionRecord(record: ProjectedSessionRecord) {
    return recordResponse.parse(record);
}

export function parseProjectedSessionByIdResponse(body: Readonly<Record<string, unknown>> & Readonly<{
    session: ProjectedSessionRecord;
}>) {
    return byIdResponse.parse(body);
}

export function parseProjectedSessionLookupResponse(body: Readonly<{
    sessions: readonly ProjectedSessionRecord[];
    externalIdentities?: readonly Readonly<{ sessionId: string; externalIdentityTag: string | null; tagMatched: boolean }>[];
}>) {
    return lookupResponse.parse(body);
}

/** Compatibility projections return `unknown`; this parse is their typed admission. */
export function parseProjectedSessionBatchDetail(detail: unknown): SessionReadBatchDetailV1 {
    return batchDetailResponse.parse(detail);
}
