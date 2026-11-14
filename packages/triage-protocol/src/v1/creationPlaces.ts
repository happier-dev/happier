import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { TriageConfiguredSourceInstanceV1Schema, TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageConfiguredSourceCredentialInstanceV1Schema } from './instances.js';
import { TriageIdentifierV1ProtocolSchema, TriageTextV1ProtocolSchema, TriageSourceScopeUnitIdV1Schema } from './identity.js';
import { TriageTaskFieldsV1Schema } from './tasks.js';
import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageScanContinuationV1Schema } from './observations.js';

function input<I, O>(instance: ProtocolComposableSchema<I, O>) {
    return defineProtocolObject({ v: defineProtocolLiteral(1), instance,
        /** Source-native parent scope: a Linear team or Jira project. Omit for the root directory. */
        scopeId: TriageSourceScopeUnitIdV1Schema.optional(),
        query: TriageTextV1ProtocolSchema.optional(), cursor: TriageScanContinuationV1Schema.optional(),
    }, { policy: 'closed' });
}
export const TriageTaskCreationPlacesInputV1Schema = input(TriageConfiguredSourceInstanceV1Schema);
export const TriageTaskCreationPlacesConnectedAccountInputV1Schema = input(TriageConfiguredSourceConnectedAccountInstanceV1Schema);
export const TriageTaskCreationPlacesCredentialInputV1Schema = input(TriageConfiguredSourceCredentialInstanceV1Schema);
/** Presentation and create operands only; providers still authorize the actual write. */
export const TriageTaskCreationPlaceV1Schema = defineProtocolObject({
    id: TriageSourceScopeUnitIdV1Schema, label: TriageTextV1ProtocolSchema, kindId: TriageIdentifierV1ProtocolSchema,
    fields: TriageTaskFieldsV1Schema,
    /** Opaque source-owned selection passed unchanged to the existing create operation. */
    placeId: TriageSourceScopeUnitIdV1Schema.optional(),
    /** Optional children refine this place; a refused parent may require a child selection. */
    childScopeId: TriageSourceScopeUnitIdV1Schema.optional(),
    refusal: defineProtocolObject({ reason: defineProtocolString({ minLength: 1 }),
        message: defineProtocolString().optional() }, { policy: 'closed' }).optional(),
}, { policy: 'closed' });
export const TriageTaskCreationPlacesResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('page'),
        status: defineProtocolUnion([defineProtocolLiteral('complete'), defineProtocolLiteral('partial')]),
        places: defineProtocolArray(TriageTaskCreationPlaceV1Schema), nextCursor: TriageScanContinuationV1Schema.optional(),
        failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type TriageTaskCreationPlaceV1 = ReturnType<typeof TriageTaskCreationPlaceV1Schema.parse>;
export type TriageTaskCreationPlacesResultV1 = ReturnType<typeof TriageTaskCreationPlacesResultV1Schema.parse>;
