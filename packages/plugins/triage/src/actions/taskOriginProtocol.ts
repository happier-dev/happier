import { defineProtocolLiteral, defineProtocolObject, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageUserMarkDisplayV1Schema } from './userMarksProtocol.js';
import { TriageTaskOriginReviewV1Schema } from './taskReviewProtocol.js';

export const TRIAGE_TASKS_SET_ORIGIN_ERROR_ACTION_LOCAL_ID_V1 = 'tasks/set-origin-error-v1';
export const TRIAGE_TASKS_READ_ORIGIN_ERROR_ACTION_LOCAL_ID_V1 = 'tasks/read-origin-error-v1';
export const TRIAGE_TASK_ORIGIN_RESOURCE_LOCAL_ID_V1 = 'tasks/origin-v1';

/** User-selected relationship, not a copy of the source error. */
export const TriageTaskOriginErrorV1Schema = defineProtocolObject({
    entryRef: TriageEntryRefV1Schema,
    display: TriageUserMarkDisplayV1Schema,
}, { policy: 'closed' });

export const TriageSetTaskOriginErrorInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    entryRef: TriageEntryRefV1Schema,
    displayAtMark: TriageUserMarkDisplayV1Schema,
    originError: defineProtocolUnion([TriageTaskOriginErrorV1Schema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });
export const TriageSetTaskOriginErrorResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    status: defineProtocolUnion([defineProtocolLiteral('linked'), defineProtocolLiteral('unlinked'), defineProtocolLiteral('conflict')]),
}, { policy: 'closed' });
export const TriageReadTaskOriginErrorInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1), entryRef: TriageEntryRefV1Schema,
}, { policy: 'closed' });
export const TriageReadTaskOriginErrorResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    originError: defineProtocolUnion([TriageTaskOriginErrorV1Schema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });

/** The saved task's private relationships; Review bodies remain with Reviews. */
export const TriageTaskOriginResourceResultV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    originError: defineProtocolUnion([TriageTaskOriginErrorV1Schema, defineProtocolLiteral(null)]),
    originReview: defineProtocolUnion([TriageTaskOriginReviewV1Schema, defineProtocolLiteral(null)]),
}, { policy: 'closed' });
