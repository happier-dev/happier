import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseTargetsConnectScopeV1Schema, DatabaseDescriptorV1Schema } from './databaseOperations.js';
import { DatabaseManualTargetV1Schema } from './databaseTargets.js';

/** Association operands only; Saved Secret bytes stay with the existing secret/admission owner. */
export const DatabaseTargetsConnectInputV1Schema = z.strictObject({
    scope: DatabaseTargetsConnectScopeV1Schema,
    savedSecretRef: z.string().check(z.minLength(1)),
    label: z.string(),
});
export type DatabaseTargetsConnectInputV1 = z.infer<typeof DatabaseTargetsConnectInputV1Schema>;
export const DatabaseTargetsConnectResultV1Schema = DatabaseDescriptorV1Schema;
export type DatabaseTargetsConnectResultV1 = z.infer<typeof DatabaseTargetsConnectResultV1Schema>;

/** Forget removes the manual association only; no Saved Secret mutation is represented. */
export const DatabaseTargetsForgetInputV1Schema = z.strictObject({ target: DatabaseManualTargetV1Schema });
export type DatabaseTargetsForgetInputV1 = z.infer<typeof DatabaseTargetsForgetInputV1Schema>;
export const DatabaseTargetsForgetResultV1Schema = z.strictObject({ ok: z.literal(true) });
export type DatabaseTargetsForgetResultV1 = z.infer<typeof DatabaseTargetsForgetResultV1Schema>;

export const DatabaseTargetsConnectInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectInputV1Schema);
export const DatabaseTargetsConnectResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectResultV1Schema);
export const DatabaseTargetsForgetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetInputV1Schema);
export const DatabaseTargetsForgetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetResultV1Schema);
