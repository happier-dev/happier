import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageUserMarkDisplayV1Schema } from './userMarksProtocol.js';

export const TRIAGE_TASKS_SET_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1 = 'tasks/set-origin-review-v1';
export const TRIAGE_TASKS_READ_ORIGIN_REVIEW_ACTION_LOCAL_ID_V1 = 'tasks/read-origin-review-v1';

/** References only: neither finding bodies nor decisions belong to Triage. */
export const TriageTaskOriginReviewV1Schema = defineProtocolObject({
    reviewId: defineProtocolString({ minLength: 1 }),
    findingIds: defineProtocolArray(defineProtocolString({ minLength: 1 }), { minItems: 1 }),
}, { policy: 'closed' });
export type TriageTaskOriginReviewV1 = ReturnType<typeof TriageTaskOriginReviewV1Schema.parse>;
export const TriageSetTaskOriginReviewInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), entryRef: TriageEntryRefV1Schema,
    displayAtMark: TriageUserMarkDisplayV1Schema,
    originReview: defineProtocolUnion([TriageTaskOriginReviewV1Schema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });
export const TriageSetTaskOriginReviewResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    status: defineProtocolUnion([defineProtocolLiteral('linked'), defineProtocolLiteral('unlinked'), defineProtocolLiteral('conflict')]),
}, { policy: 'closed' });
export const TriageReadTaskOriginReviewInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), entryRef: TriageEntryRefV1Schema,
}, { policy: 'closed' });
export const TriageReadTaskOriginReviewResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), originReview: defineProtocolUnion([TriageTaskOriginReviewV1Schema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });
