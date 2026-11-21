import { type ProtocolSchemaOutput, defineProtocolArray, defineProtocolLiteral,
    defineProtocolObject, defineProtocolString, defineProtocolUnion } from '../protocol/protocolFacade.js';
import { SharedSavedSecretReferenceSelectionV1Schema } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseManagedDeploymentTargetV1Schema } from './projections.js';

const target = DatabaseManagedDeploymentTargetV1Schema;
const role = defineProtocolString({ minLength: 1 });
const statements = defineProtocolArray(defineProtocolString({ minLength: 1 }), { minItems: 1 });

/** Credentials travel by an existing shared Saved Secret reference. */
export const DatabaseReadAccessAttachInputV1Schema = defineProtocolObject({
    target,
    savedSecretRef: projectZodProtocolSchema(SharedSavedSecretReferenceSelectionV1Schema.shape.ref),
    resourceRevision: projectZodProtocolSchema(SharedSavedSecretReferenceSelectionV1Schema.shape.resourceRevision),
}, { policy: 'closed' });
export type DatabaseReadAccessAttachInputV1 = ProtocolSchemaOutput<typeof DatabaseReadAccessAttachInputV1Schema>;

export const DatabaseReadAccessCreateInputV1Schema = defineProtocolUnion([
    defineProtocolObject({ target, mode: defineProtocolLiteral('preview') }, { policy: 'closed' }),
    defineProtocolObject({ target, mode: defineProtocolLiteral('apply'), role, statements }, { policy: 'closed' }),
]);
export type DatabaseReadAccessCreateInputV1 = ProtocolSchemaOutput<typeof DatabaseReadAccessCreateInputV1Schema>;

export const DatabaseReadAccessSetupResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        ok: defineProtocolLiteral(true), status: defineProtocolLiteral('review'), role, statements,
    }, { policy: 'closed' }),
    defineProtocolObject({
        ok: defineProtocolLiteral(true), status: defineProtocolLiteral('configured'),
    }, { policy: 'closed' }),
]);
export type DatabaseReadAccessSetupResultV1 = ProtocolSchemaOutput<typeof DatabaseReadAccessSetupResultV1Schema>;
