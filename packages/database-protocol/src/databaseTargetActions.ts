import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseTargetsConnectScopeV1Schema, DatabaseDescriptorV1Schema } from './databaseOperations.js';
import { DatabaseAgentAccessV1Schema } from './databaseAccess.js';
import { DatabaseManualTargetV1Schema, DatabaseTargetV1Schema, DatabaseWorktreeTargetV1Schema } from './databaseTargets.js';

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

/** Read the requester’s fold and the owner of the target’s access. */
export const DatabaseAccessReadInputV1Schema = z.strictObject({ target: DatabaseTargetV1Schema });
export type DatabaseAccessReadInputV1 = z.infer<typeof DatabaseAccessReadInputV1Schema>;
export { DatabaseAccessReadResultV1Schema, type DatabaseAccessReadResultV1 } from '@happier-dev/plugin-sdk/database';
/** The one writer of a Machine-local (worktree or manual) database's agent level. Environment access is written by the Environment. */
export const DatabaseAccessSetInputV1Schema = z.strictObject({
    target: z.discriminatedUnion('kind', [DatabaseWorktreeTargetV1Schema, DatabaseManualTargetV1Schema]), agentAccess: DatabaseAgentAccessV1Schema,
});
export type DatabaseAccessSetInputV1 = z.infer<typeof DatabaseAccessSetInputV1Schema>;
export const DatabaseAccessSetResultV1Schema = z.strictObject({ ok: z.literal(true), agentAccess: DatabaseAgentAccessV1Schema });
export type DatabaseAccessSetResultV1 = z.infer<typeof DatabaseAccessSetResultV1Schema>;

export const DatabaseTargetsConnectInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectInputV1Schema);
export const DatabaseTargetsConnectResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectResultV1Schema);
export const DatabaseTargetsForgetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetInputV1Schema);
export const DatabaseTargetsForgetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetResultV1Schema);
export const DatabaseAccessReadInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessReadInputV1Schema);
export { DatabaseAccessReadResultV1Schema as DatabaseAccessReadResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/database';
export const DatabaseAccessSetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessSetInputV1Schema);
export const DatabaseAccessSetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessSetResultV1Schema);
