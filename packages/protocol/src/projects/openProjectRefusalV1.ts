import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import { MachineProvisionerNativeCauseV1Schema } from '../machines/managed/providerFactsV1.js';
import { ScmRepositoryCloneInputSchema } from '../scm/repositoryClone.js';
import { ScmRepositoryProvisioningFailureResponseSchema, ScmRepositoryProvisioningRemediationSchema } from '../scm/repositoryProvisioning.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const OpenProjectRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'), code: IdSchema,
  effectAttempted: z.optional(z.boolean()),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  nativeCause: z.optional(MachineProvisionerNativeCauseV1Schema),
  /** Own destination display fact. A later Open receives ordinary admission. */
  destinationReview: z.optional(z.strictObject({
    accountId: IdSchema, serverId: IdSchema, machineId: IdSchema,
    destinationParentPath: ScmRepositoryCloneInputSchema.shape.destinationParentPath,
    destinationDirectoryName: ScmRepositoryCloneInputSchema.shape.destinationDirectoryName,
  })),
  retryNotBeforeMs: ScmRepositoryProvisioningFailureResponseSchema.shape.retryNotBeforeMs,
  remediation: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ScmRepositoryProvisioningRemediationSchema)),
}));
