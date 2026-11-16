import { z } from 'zod/mini';

/** Read or write class of a database operation, decided once by its Action declaration (PROGRAM R12). */
export const DatabaseOperationClassV1Schema = z.enum(['read', 'write']);
export type DatabaseOperationClassV1 = z.infer<typeof DatabaseOperationClassV1Schema>;

export { DatabaseAgentLevelV1Schema, DatabaseAgentAccessV1Schema, type DatabaseAgentLevelV1, type DatabaseAgentAccessV1 }
    from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';

/** Who is asking: the person themself, or an agent/automation acting for them (invocation authority). */
export const DatabaseRequesterKindV1Schema = z.enum(['person', 'agent']);
export type DatabaseRequesterKindV1 = z.infer<typeof DatabaseRequesterKindV1Schema>;

export const DatabaseAccessRefusalV1Schema = z.enum([
    'database_editing_off', 'database_not_an_editor', 'database_agent_access_none', 'database_agent_access_read_only',
]);
export type DatabaseAccessRefusalV1 = z.infer<typeof DatabaseAccessRefusalV1Schema>;

export const DatabaseAccessDecisionV1Schema = z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), access: DatabaseOperationClassV1Schema }),
    z.strictObject({ ok: z.literal(false), refusal: DatabaseAccessRefusalV1Schema }),
]);
export type DatabaseAccessDecisionV1 = z.infer<typeof DatabaseAccessDecisionV1Schema>;

/** The display fold of the decision for one requester, carried by `database.describe`; surfaces never compute it. */
export const DatabaseAccessSummaryV1Schema = z.strictObject({
    canRead: z.boolean(), canWrite: z.boolean(), reason: z.optional(DatabaseAccessRefusalV1Schema),
});
export type DatabaseAccessSummaryV1 = z.infer<typeof DatabaseAccessSummaryV1Schema>;
