import { z } from 'zod/mini';
import {
    DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1,
    DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1,
} from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { DatabaseCaptureSourceV1Schema } from './databaseCaptureSource.js';

const id = z.string().check(z.minLength(1));
const time = z.number().check(z.int(), z.nonnegative());
export const DatabaseCaptureCursorV1Schema = z.strictObject({ at: time, id });
export const DatabaseCapturePageV1Schema = z.strictObject({
    limit: z.number().check(z.int(), z.positive()),
    before: z.optional(DatabaseCaptureCursorV1Schema),
});
export const databaseCaptureSourceInput = { source: DatabaseCaptureSourceV1Schema };
export const databaseCaptureSelectedPage = {
    ...databaseCaptureSourceInput, page: DatabaseCapturePageV1Schema, since: z.optional(time), until: z.optional(time),
};
export const DatabaseCaptureTracesListInputV1Schema = z.strictObject(databaseCaptureSelectedPage);
export const DatabaseCaptureTraceGetInputV1Schema = z.strictObject({
    ...databaseCaptureSourceInput, traceId: id, page: z.strictObject({ limit: DatabaseCapturePageV1Schema.shape.limit }),
});
export const DatabaseCaptureEndpointCursorV1Schema = z.strictObject({ serviceName: z.string(), method: id, route: id });
export const DatabaseCaptureEndpointsListInputV1Schema = z.strictObject({
    ...databaseCaptureSourceInput,
    page: z.strictObject({ limit: DatabaseCapturePageV1Schema.shape.limit, before: z.optional(DatabaseCaptureEndpointCursorV1Schema) }),
    since: z.optional(time), until: z.optional(time),
    endpoint: z.optional(DatabaseCaptureEndpointCursorV1Schema),
});
const captureTraceFindingVerification = z.strictObject({
    observationKey: id,
    httpStatusCode: z.optional(z.number()),
    readBefore: z.strictObject({ action: z.literal(DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1), input: DatabaseCaptureTraceGetInputV1Schema }),
    findAfter: z.strictObject({ action: z.literal(DATABASE_CAPTURE_TRACES_LIST_ACTION_ID_V1), input: DatabaseCaptureTracesListInputV1Schema }),
});
const captureEndpointRead = z.strictObject({
    action: z.literal(DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1), input: DatabaseCaptureEndpointsListInputV1Schema,
});
export const DatabaseCaptureFindingVerificationV1Schema = z.union([
    captureTraceFindingVerification,
    z.strictObject({ observationKey: id, readBefore: captureEndpointRead, findAfter: captureEndpointRead }),
]);
