import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    type ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';

import { TriageSourceFailureV1Schema } from './diagnostics.js';
import { TriageCollisionScopeV1ProtocolSchema, TriageTextV1ProtocolSchema, TriageSourceScopeUnitIdV1Schema } from './identity.js';
import {
    TriageSourceScopeContextV1Schema,
    TriageSourceConnectedAccountScopeContextV1Schema,
    TriageSourceCredentialScopeContextV1Schema,
} from './instances.js';
import { TriageScanContinuationV1Schema } from './observations.js';
import { TriageListSortFieldsV1Schema } from './sorting.js';

/** Source-native selection ids are opaque to the aggregate; they are not entry identities. */
// Retained source ids can be repository paths, longer than entry identifiers.
// The source configuration carrier is the actual boundary for a selected id.
const scopeUnitId = TriageSourceScopeUnitIdV1Schema;

export const TriageSourceScopeSelectionV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('all') }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('selected'),
        unitIds: defineProtocolUniqueArray(scopeUnitId, { minItems: 1 }),
    }, { policy: 'closed' }),
]);
export type TriageSourceScopeSelectionV1 = ReturnType<typeof TriageSourceScopeSelectionV1Schema.parse>;

export const TriageSourceScopeUnitV1Schema = defineProtocolObject({
    id: scopeUnitId,
    label: TriageTextV1ProtocolSchema,
    secondaryText: TriageTextV1ProtocolSchema.optional(),
    /** Source-authored join to entry scope; never inferred from an id or display label. */
    collisionScope: TriageCollisionScopeV1ProtocolSchema.optional(),
}, { policy: 'closed' });
export type TriageSourceScopeUnitV1 = ReturnType<typeof TriageSourceScopeUnitV1Schema.parse>;

export const TriageSourceScopeUnitDescriptorV1Schema = defineProtocolObject({
    singularLabel: TriageTextV1ProtocolSchema,
    pluralLabel: TriageTextV1ProtocolSchema,
}, { policy: 'closed' });
export type TriageSourceScopeUnitDescriptorV1 = ReturnType<typeof TriageSourceScopeUnitDescriptorV1Schema.parse>;

function listScopeUnitsInput<I, O>(draft: ProtocolComposableSchema<I, O>) {
    return defineProtocolObject({
        v: defineProtocolLiteral(1),
        draft,
        /** `configured` decodes only the token: no provider or credential read. */
        mode: defineProtocolUnion([defineProtocolLiteral('available'), defineProtocolLiteral('configured')]).optional(),
        query: TriageTextV1ProtocolSchema.optional(),
        cursor: TriageScanContinuationV1Schema.optional(),
    }, { policy: 'closed' });
}

export const TriageListScopeUnitsInputV1Schema = listScopeUnitsInput(TriageSourceScopeContextV1Schema);
export const TriageListScopeUnitsConnectedAccountInputV1Schema = listScopeUnitsInput(TriageSourceConnectedAccountScopeContextV1Schema);
export const TriageListScopeUnitsCredentialInputV1Schema = listScopeUnitsInput(TriageSourceCredentialScopeContextV1Schema);
export type TriageListScopeUnitsInputV1 = ReturnType<typeof TriageListScopeUnitsInputV1Schema.parse>;

const pageFields = {
    kind: defineProtocolLiteral('page'),
    selection: TriageSourceScopeSelectionV1Schema,
    units: defineProtocolArray(TriageSourceScopeUnitV1Schema),
    /** Configured-source override; an empty set explicitly offers no field order. */
    sortFields: TriageListSortFieldsV1Schema.optional(),
};
export const TriageListScopeUnitsResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ ...pageFields, status: defineProtocolLiteral('complete') }, { policy: 'closed' }),
    defineProtocolObject({
        ...pageFields,
        status: defineProtocolLiteral('partial'),
        nextCursor: TriageScanContinuationV1Schema.optional(),
        failure: TriageSourceFailureV1Schema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type TriageListScopeUnitsResultV1 = ReturnType<typeof TriageListScopeUnitsResultV1Schema.parse>;
