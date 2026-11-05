import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import type { ActionExecuteFailure } from '../actions/executor/types.js';
import { ScmRepositoryCloneInputSchema, ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../sessions/authoring/creationFieldsV1.js';
import { HandoffWorkspaceActionV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { WorkspaceAddressV1Schema, WorkspaceRefV1WriteSchema, WorkspaceProjectFactsV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSourceRepositorySelectorV1Schema } from './sources/projectSourceV1.js';
import { ScmRepositoryProvisioningFailureResponseSchema, ScmRepositoryProvisioningRemediationSchema } from '../scm/repositoryProvisioning.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const PathSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine(value => !value.includes('\0'))));

/** Closed choices consumed by the incumbent SCM and Sync realization owners. */
export const WorkspaceActivationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attach') }),
  z.strictObject({
    kind: z.literal('worktree'),
    checkout: SessionAuthoringCheckoutCreationDraftV1Schema,
    targetPath: z.optional(PathSchema),
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(ScmRepositoryCloneInputSchema, { destinationParentPath: true, destinationDirectoryName: true, initialCheckout: true }), {
    kind: z.literal('clone'),
  })),
  z.strictObject({
    kind: z.literal('sync'),
    targetPath: PathSchema,
    workspaceAction: HandoffWorkspaceActionV1Schema.check(z.refine(action => action.kind !== 'none')),
  }),
]));
export type WorkspaceActivationRequestV1 = z.infer<typeof WorkspaceActivationRequestV1Schema>;

export const OpenProjectInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: IdSchema,
  machineId: IdSchema,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('workspace'), workspaceId: IdSchema, checkout: z.optional(WorkspaceAddressV1Schema) }),
    z.strictObject({ kind: z.literal('folder'), path: PathSchema }),
    z.strictObject({
      kind: z.literal('source'), id: IdSchema, revision: z.number().check(z.int(), z.positive()),
      selector: ProjectSourceRepositorySelectorV1Schema,
      defaultRef: z.optional(IdSchema), subdir: z.optional(ScmRepositoryContainedSubdirV1Schema),
      checkout: z.optional(WorkspaceAddressV1Schema),
    }),
    z.strictObject({ kind: z.literal('repository'), selector: ProjectSourceRepositorySelectorV1Schema }),
  ]),
  ref: z.optional(IdSchema),
  subdir: z.optional(ScmRepositoryContainedSubdirV1Schema),
  materialization: WorkspaceActivationRequestV1Schema,
}).check(z.superRefine((input, context) => {
  if ((input.source.kind === 'workspace' || input.source.kind === 'source') && input.source.checkout) {
    if (input.source.checkout.serverId !== input.serverId
      || input.source.kind === 'workspace' && input.source.checkout.workspaceId !== input.source.workspaceId) {
      context.addIssue({ code: "custom", path: ['source', 'checkout'], message: 'Checkout must match the selected Home and Workspace' });
    }
  }
})));
export type OpenProjectInputV1 = z.infer<typeof OpenProjectInputV1Schema>;

export const OpenProjectRefusalV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('refused'), code: IdSchema,
  effectAttempted: z.optional(z.boolean()),
  failureCause: z.optional(ActionFailureCauseV1Schema),
  retryNotBeforeMs: ScmRepositoryProvisioningFailureResponseSchema.shape.retryNotBeforeMs,
  remediation: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ScmRepositoryProvisioningRemediationSchema)),
}));

export const OpenProjectResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('opened'), workspace: WorkspaceAddressV1Schema, directory: PathSchema,
    setup: z.enum(['notRequired', 'approvalRequired', 'prepared', 'failed']),
    facts: z.optional(WorkspaceProjectFactsV1Schema),
  }),
  z.strictObject({ kind: z.literal('ambiguous'), candidates: z.array(WorkspaceRefV1WriteSchema) }),
  OpenProjectRefusalV1Schema,
  z.strictObject({ kind: z.literal('outcomeUnknown'), operationId: z.optional(IdSchema) }),
]));
export type OpenProjectResultV1 = z.infer<typeof OpenProjectResultV1Schema>;

/** Settlement and operation history consume the same finite Open refusal. */
export function projectOpenProjectRefusalV1(result: z.infer<typeof OpenProjectRefusalV1Schema>): ActionExecuteFailure {
  return { ok: false, errorCode: result.code, error: result.code, details: result,
    ...(result.effectAttempted !== undefined ? { effectAttempted: result.effectAttempted } : {}),
    ...(result.failureCause ? { failureCause: result.failureCause } : {}) };
}

/** Private source-host acknowledgement; target Open still validates and accepts its local directory. */
export const ProjectOpenSyncMaterializationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('materialized') }),
  z.strictObject({ kind: z.literal('refused'), code: IdSchema }),
  z.strictObject({ kind: z.literal('outcomeUnknown') }),
]));
export type ProjectOpenSyncMaterializationResultV1 = z.infer<typeof ProjectOpenSyncMaterializationResultV1Schema>;
