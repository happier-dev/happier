import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

const keepCount = lazyZodSchema(() => z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER)));
/** Retained backup policy, shared by configuration and deliberate setup preferences. */
export const DeploymentBackupRetentionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keepEverything') }),
  z.strictObject({ kind: z.literal('keep'), last: z.optional(keepCount), daily: z.optional(keepCount),
    weekly: z.optional(keepCount), monthly: z.optional(keepCount) }).check(z.refine(policy =>
    policy.last !== undefined || policy.daily !== undefined || policy.weekly !== undefined || policy.monthly !== undefined,
  { message: 'A keep policy requires at least one person-selected count.' })),
]));
export type DeploymentBackupRetentionV1 = z.infer<typeof DeploymentBackupRetentionV1Schema>;
