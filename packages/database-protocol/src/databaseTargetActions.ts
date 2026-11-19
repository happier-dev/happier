import { type ProtocolSchemaOutput, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import {
    DatabaseAgentAccessV1Schema,
    DatabaseManualTargetV1Schema,
    DatabaseTargetV1Schema,
    DatabaseTargetsConnectScopeV1Schema,
    DatabaseWorktreeTargetV1Schema,
} from '@happier-dev/plugin-sdk/database';

/** Association operands only; Saved Secret bytes stay with the existing secret/admission owner. */
export const DatabaseTargetsConnectInputV1Schema = defineProtocolObject({
    scope: DatabaseTargetsConnectScopeV1Schema,
    savedSecretRef: defineProtocolString({ minLength: 1 }),
    label: defineProtocolString(),
}, { policy: 'closed' });
export type DatabaseTargetsConnectInputV1 = ProtocolSchemaOutput<typeof DatabaseTargetsConnectInputV1Schema>;

/** Forget removes the manual association only; no Saved Secret mutation is represented. */
export const DatabaseTargetsForgetInputV1Schema = defineProtocolObject({ target: DatabaseManualTargetV1Schema }, { policy: 'closed' });
export type DatabaseTargetsForgetInputV1 = ProtocolSchemaOutput<typeof DatabaseTargetsForgetInputV1Schema>;
export const DatabaseTargetsForgetResultV1Schema = defineProtocolObject({ ok: defineProtocolLiteral(true) }, { policy: 'closed' });
export type DatabaseTargetsForgetResultV1 = ProtocolSchemaOutput<typeof DatabaseTargetsForgetResultV1Schema>;

/** Who sets this database's access (P3 §12). Machine-local targets carry their stored agent level; deployment
 * targets name the Environment whose `deployments.environments.update` is the one writer. `access` is the
 * requester's decision fold, never recomputed by surfaces. */
export const DatabaseAccessReadInputV1Schema = defineProtocolObject({ target: DatabaseTargetV1Schema }, { policy: 'closed' });
export type DatabaseAccessReadInputV1 = ProtocolSchemaOutput<typeof DatabaseAccessReadInputV1Schema>;
export { DatabaseAccessReadResultV1Schema, type DatabaseAccessReadResultV1 } from '@happier-dev/plugin-sdk/database';
/** The one writer of a Machine-local (worktree or manual) database's agent level. Environment access is written by the Environment. */
export const DatabaseAccessSetInputV1Schema = defineProtocolObject({
    target: defineProtocolUnion([DatabaseWorktreeTargetV1Schema, DatabaseManualTargetV1Schema]), agentAccess: DatabaseAgentAccessV1Schema,
}, { policy: 'closed' });
export type DatabaseAccessSetInputV1 = ProtocolSchemaOutput<typeof DatabaseAccessSetInputV1Schema>;
export const DatabaseAccessSetResultV1Schema = defineProtocolObject({ ok: defineProtocolLiteral(true), agentAccess: DatabaseAgentAccessV1Schema }, { policy: 'closed' });
export type DatabaseAccessSetResultV1 = ProtocolSchemaOutput<typeof DatabaseAccessSetResultV1Schema>;

export const DatabaseTargetsConnectInputV1ProtocolSchema = DatabaseTargetsConnectInputV1Schema;
export const DatabaseTargetsForgetInputV1ProtocolSchema = DatabaseTargetsForgetInputV1Schema;
export const DatabaseTargetsForgetResultV1ProtocolSchema = DatabaseTargetsForgetResultV1Schema;
export const DatabaseAccessReadInputV1ProtocolSchema = DatabaseAccessReadInputV1Schema;
export { DatabaseAccessReadResultV1Schema as DatabaseAccessReadResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/database';
export const DatabaseAccessSetInputV1ProtocolSchema = DatabaseAccessSetInputV1Schema;
export const DatabaseAccessSetResultV1ProtocolSchema = DatabaseAccessSetResultV1Schema;
