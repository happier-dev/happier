import {
    defineProtocolArray, defineProtocolJsonValue, defineProtocolLiteral, defineProtocolNumber,
    defineProtocolObject, defineProtocolString, defineProtocolUnion,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';
import {
    TriageEntryLocatorV1Schema, TriageEntryRefV1Schema, TriageIdentifierV1ProtocolSchema,
    TriageSourceEntryLocalRefV1Schema,
} from './identity.js';
import { TriageConfiguredSourceInstanceV1Schema, TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageConfiguredSourceCredentialInstanceV1Schema } from './instances.js';
import { TriageSourcePresentObservationV1Fields } from './observations.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 } from './bounds.js';

// These are write inputs, not bounded row-display projections. The containing
// Action envelope and each provider's validation own document/field budgets.
const taskFields = {
    title: defineProtocolString({ minLength: 1 }).optional(),
    body: defineProtocolString().optional(),
    assigneeIds: defineProtocolArray(TriageIdentifierV1ProtocolSchema).optional(),
    labelIds: defineProtocolArray(TriageIdentifierV1ProtocolSchema).optional(),
    // A scope may be a provider route (GitHub owner/repository is up to 140
    // bytes), not an entity id. Its provider and the Action envelope own size.
    scopeId: defineProtocolString({ minLength: 1, pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 }).optional(),
    projectId: defineProtocolUnion([TriageIdentifierV1ProtocolSchema, defineProtocolLiteral(null)]).optional(),
    priority: defineProtocolUnion([defineProtocolNumber(), TriageIdentifierV1ProtocolSchema, defineProtocolLiteral(null)]).optional(),
    dueDate: defineProtocolUnion([defineProtocolString({ minLength: 1 }), defineProtocolLiteral(null)]).optional(),
    estimate: defineProtocolUnion([defineProtocolNumber(), defineProtocolLiteral(null)]).optional(),
    parent: defineProtocolUnion([TriageEntryRefV1Schema, defineProtocolLiteral(null)]).optional(),
    blockedBy: defineProtocolArray(TriageEntryRefV1Schema).optional(),
} as const;
export const TriageTaskFieldsV1Schema = defineProtocolObject(taskFields, { policy: 'closed' });
export type TriageTaskFieldsV1 = ReturnType<typeof TriageTaskFieldsV1Schema.parse>;
const taskFieldChoice = defineProtocolObject({
    id: TriageIdentifierV1ProtocolSchema,
    label: defineProtocolString({ minLength: 1, pattern: TRIAGE_SINGLE_LINE_STRING_PATTERN_V1 }),
}, { policy: 'closed' });
/**
 * What a task's name-valued fields can be set to, from the source's own directory, for the exact read that asked.
 * A present list is complete; an omitted field means the source has no directory for it or could not read one, so
 * the field keeps typed names.
 */
export const TriageTaskFieldChoicesV1Schema = defineProtocolObject({
    assigneeIds: defineProtocolArray(taskFieldChoice).optional(),
    labelIds: defineProtocolArray(taskFieldChoice).optional(),
}, { policy: 'closed' });
export type TriageTaskFieldChoicesV1 = ReturnType<typeof TriageTaskFieldChoicesV1Schema.parse>;
export const TriageTaskCreateFieldsV1Schema = defineProtocolObject({
    ...taskFields, title: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export type TriageTaskCreateFieldsV1 = ReturnType<typeof TriageTaskCreateFieldsV1Schema.parse>;

function createInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1), instance, kindId: TriageIdentifierV1ProtocolSchema,
        fields: TriageTaskCreateFieldsV1Schema,
        /** A source-owned initialStatuses id; omission retains the source's default. */
        initialStatusId: TriageIdentifierV1ProtocolSchema.optional(),
    }, { policy: 'closed' });
}
function editInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1), instance, localRef: TriageSourceEntryLocalRefV1Schema,
        lastKnownLocator: TriageEntryLocatorV1Schema.optional(), fields: TriageTaskFieldsV1Schema,
    }, { policy: 'closed' });
}
/** Typed native values are reauthorized against the source's current workflow. */
export const TriageTaskTransitionFieldValuesV1Schema = defineProtocolArray(defineProtocolObject({
    fieldId: TriageIdentifierV1ProtocolSchema,
    value: defineProtocolUnion([defineProtocolString(), defineProtocolNumber(), defineProtocolArray(defineProtocolString())]),
}, { policy: 'closed' }));
export type TriageTaskTransitionFieldValuesV1 = ReturnType<typeof TriageTaskTransitionFieldValuesV1Schema.parse>;
function transitionInput<TInput, TOutput>(instance: ProtocolComposableSchema<TInput, TOutput>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1), instance, localRef: TriageSourceEntryLocalRefV1Schema,
        lastKnownLocator: TriageEntryLocatorV1Schema.optional(), transitionId: TriageIdentifierV1ProtocolSchema,
        fieldValues: TriageTaskTransitionFieldValuesV1Schema.optional(),
    }, { policy: 'closed' });
}
export const TriageTaskCreateInputV1Schema = createInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageTaskEditInputV1Schema = editInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageTaskTransitionInputV1Schema = transitionInput(TriageConfiguredSourceInstanceV1Schema);
export const TriageTaskCreateConnectedAccountInputV1Schema = createInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageTaskEditConnectedAccountInputV1Schema = editInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageTaskTransitionConnectedAccountInputV1Schema = transitionInput(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageTaskCreateCredentialInputV1Schema = createInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export const TriageTaskEditCredentialInputV1Schema = editInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export const TriageTaskTransitionCredentialInputV1Schema = transitionInput(TriageConfiguredSourceCredentialInstanceV1Schema);
export type TriageTaskCreateInputV1 = ReturnType<typeof TriageTaskCreateInputV1Schema.parse>;
export type TriageTaskEditInputV1 = ReturnType<typeof TriageTaskEditInputV1Schema.parse>;
export type TriageTaskTransitionInputV1 = ReturnType<typeof TriageTaskTransitionInputV1Schema.parse>;

const observation = defineProtocolObject(TriageSourcePresentObservationV1Fields, { policy: 'closed' });
export const TriageTaskWriteResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('applied'), observation }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('refused'), reason: TriageIdentifierV1ProtocolSchema,
        message: defineProtocolString().optional(), details: defineProtocolJsonValue().optional(),
        retryable: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
        requestId: defineProtocolString().optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('uncertain'), observation: observation.optional(), failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type TriageTaskWriteResultV1 = ReturnType<typeof TriageTaskWriteResultV1Schema.parse>;
