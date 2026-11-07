import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
    TriageGetResultV1Schema,
    TriageSourceFailureV1Schema,
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    triageGetInputFieldsV1,
} from '@happier-dev/triage-protocol/v1';
import { PosthogAssigneeV1Schema } from '../writeContracts.js';

export const PosthogNativeOverviewInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    ...triageGetInputFieldsV1,
    includeAssignees: defineProtocolLiteral(true).optional(),
}, { policy: 'closed' });
const current = defineProtocolUnion([PosthogAssigneeV1Schema, defineProtocolLiteral(null)]).optional();
const choice = defineProtocolObject({ assignee: PosthogAssigneeV1Schema, name: defineProtocolString() }, { policy: 'closed' });
export type PosthogAssignmentChoiceV1 = ReturnType<typeof choice.parse>;
export const PosthogAssignmentReadV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('ready'), current, choices: defineProtocolArray(choice) }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), current, failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type PosthogAssignmentReadV1 = ReturnType<typeof PosthogAssignmentReadV1Schema.parse>;

/** Native-only facts from the same CRUD-first read used by aggregate get. */
export const PosthogNativeOverviewResultV1Schema = defineProtocolObject({
    observation: TriageGetResultV1Schema,
    assignment: PosthogAssignmentReadV1Schema.optional(),
    severity: defineProtocolUnion([
        defineProtocolLiteral('low'), defineProtocolLiteral('medium'),
        defineProtocolLiteral('high'), defineProtocolLiteral('critical'),
    ]).optional(),
    enrichmentFailure: TriageSourceFailureV1Schema.optional(),
    /** The query plane's sparkline: each bucket's start and its occurrence count, oldest first. */
    trend: defineProtocolArray(defineProtocolObject({
        atMs: defineProtocolNumber({ integer: true }),
        count: defineProtocolNumber({ minimum: 0 }),
    }, { policy: 'closed' })).optional(),
}, { policy: 'closed' });

export type PosthogNativeOverviewResultV1 = ReturnType<typeof PosthogNativeOverviewResultV1Schema.parse>;
