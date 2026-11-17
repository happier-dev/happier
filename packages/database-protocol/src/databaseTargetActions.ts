import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DatabaseTargetsConnectScopeV1Schema, DatabaseDescriptorV1Schema } from './databaseOperations.js';
import { DatabaseAccessSummaryV1Schema, DatabaseAgentAccessV1Schema } from './databaseAccess.js';
import { DatabaseManualTargetV1Schema, DatabaseTargetV1Schema } from './databaseTargets.js';

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

/** Who sets this database's access (P3 §12). Machine-local targets carry their stored agent level; deployment
 * targets name the Environment whose `deployments.environments.update` is the one writer. `access` is the
 * requester's decision fold, never recomputed by surfaces. */
export const DatabaseAccessReadInputV1Schema = z.strictObject({ target: DatabaseTargetV1Schema });
export type DatabaseAccessReadInputV1 = z.infer<typeof DatabaseAccessReadInputV1Schema>;
export const DatabaseAccessReadResultV1Schema = z.discriminatedUnion('setBy', [
    z.strictObject({ setBy: z.literal('machine'), agentAccess: DatabaseAgentAccessV1Schema, access: DatabaseAccessSummaryV1Schema }),
    z.strictObject({ setBy: z.literal('environment'), serverId: z.string(), environmentId: z.string(),
        expectedRevision: z.number(), access: DatabaseAccessSummaryV1Schema }),
]);
export type DatabaseAccessReadResultV1 = z.infer<typeof DatabaseAccessReadResultV1Schema>;
/** The one writer of a Machine-local database's agent level. Environment access is written by the Environment. */
export const DatabaseAccessSetInputV1Schema = z.strictObject({ target: DatabaseManualTargetV1Schema, agentAccess: DatabaseAgentAccessV1Schema });
export type DatabaseAccessSetInputV1 = z.infer<typeof DatabaseAccessSetInputV1Schema>;
export const DatabaseAccessSetResultV1Schema = z.strictObject({ ok: z.literal(true), agentAccess: DatabaseAgentAccessV1Schema });
export type DatabaseAccessSetResultV1 = z.infer<typeof DatabaseAccessSetResultV1Schema>;

export const DatabaseTargetsConnectInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectInputV1Schema);
export const DatabaseTargetsConnectResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsConnectResultV1Schema);
export const DatabaseTargetsForgetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetInputV1Schema);
export const DatabaseTargetsForgetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseTargetsForgetResultV1Schema);
export const DatabaseAccessReadInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessReadInputV1Schema);
export const DatabaseAccessReadResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessReadResultV1Schema);
export const DatabaseAccessSetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessSetInputV1Schema);
export const DatabaseAccessSetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseAccessSetResultV1Schema);
