/**
 * The explicit Tier-3 code-variable reveal contract.
 *
 * The mounted source UI asks for this only after a person confirms the disclosure.
 * The input carries the frozen query geometry that selected the occurrence, never its
 * response bytes. The daemon rereads one row and requires the exact UUID before any
 * captured variable may cross back to the active Stack Trace panel.
 */

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TriageConfiguredSourceInstanceV1Schema,
    TriageSourceEntryLocalRefV1Schema,
    TriageSourceFailureV1Schema,
} from '@happier-dev/triage-protocol/v1';

import { PosthogFrozenIssueEventsRequestV1Schema } from './issueEventsContract.js';

export const PosthogCodeVariablesInputV1Schema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
    selectedUuid: defineProtocolString({
        minLength: 1,
        pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    }),
    selectedOffset: defineProtocolNumber({ integer: true, minimum: 0 }),
    frozenRequest: PosthogFrozenIssueEventsRequestV1Schema,
}, { policy: 'closed' });
export type PosthogCodeVariablesInputV1 = ReturnType<
    typeof PosthogCodeVariablesInputV1Schema.parse
>;

export const PosthogCodeVariablesResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('revealed'),
        /** JSON presentation only. It is never admitted as Composer/model context. */
        variablesText: defineProtocolString(),
        truncated: defineProtocolLiteral(true).optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('unavailable'),
        failure: TriageSourceFailureV1Schema,
    }, { policy: 'closed' }),
]);
export type PosthogCodeVariablesResultV1 = ReturnType<
    typeof PosthogCodeVariablesResultV1Schema.parse
>;
