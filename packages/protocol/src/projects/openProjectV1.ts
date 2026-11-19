import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { isRpcMethodNotFoundError, RPC_ERROR_CODES } from '../rpc/errors.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ActionFailureCauseV1Schema } from '../actions/actionExecutionResult.js';
import type { ActionExecuteFailure } from '../actions/executor/types.js';
import { ScmRepositoryCloneSourceV1Schema, ScmRepositoryCloneInputSchema, ScmRepositoryContainedSubdirV1Schema } from '../scm/repositoryClone.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { SessionAuthoringCheckoutCreationDraftV1Schema } from '../sessions/authoring/creationFieldsV1.js';
import { HandoffWorkspaceActionV1Schema } from '../sessions/control/handoff/workspaceSyncSchemas.js';
import { WorkspaceAddressV1Schema, WorkspaceAddressV2Schema, ManagedWorkspaceRefV2WriteSchema, WorkspaceRefV1WriteSchema, WorkspaceProjectFactsV1Schema } from '../workspaces/workspaceRefV1.js';
import { ProjectSourceRepositorySelectorV1Schema } from './sources/projectSourceV1.js';
import { ScmRepositoryProvisioningFailureResponseSchema, ScmRepositoryProvisioningRemediationSchema } from '../scm/repositoryProvisioning.js';
import { WorkspaceManifestSchema, WorkspaceManifestRelativePathSchema } from '../workspaces/manifestSchema.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
const PathSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine(value => !value.includes('\0'))));
const OpenManagedTargetSchema = lazyZodSchema(() => z.pick(ManagedWorkspaceRefV2WriteSchema, { managedId: true, controller: true }));

/** Closed choices consumed by the incumbent SCM and Sync realization owners. */
export const WorkspaceActivationRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attach'), targetManaged: z.optional(OpenManagedTargetSchema) }),
  z.strictObject({
    kind: z.literal('worktree'),
    checkout: SessionAuthoringCheckoutCreationDraftV1Schema,
    targetPath: z.optional(PathSchema),
  }),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.pick(ScmRepositoryCloneInputSchema, { destinationParentPath: true, destinationDirectoryName: true, initialCheckout: true, authentication: true }), {
    kind: z.literal('clone'),
    /** An account reference only; host-side selection materializes credentials. */
    gitAccount: z.optional(asProtocolZod(QualifiedConnectedAccountRefSchema)),
  })),
  z.strictObject({
    kind: z.literal('sync'),
    targetPath: PathSchema,
    targetManaged: z.optional(OpenManagedTargetSchema),
    workspaceAction: HandoffWorkspaceActionV1Schema.check(z.refine(action => action.kind !== 'none')),
  }),
]).check(z.refine(value => value.kind !== 'clone'
  || value.gitAccount === undefined
  || value.authentication === 'connected_account')));
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
  /** Opt-in facts from the admitted attached folder, before destination clone effects. */
  cloneSource: z.optional(z.literal(true)),
}).check(z.superRefine((input, context) => {
  if (input.cloneSource && input.materialization.kind !== 'attach') {
    context.addIssue({ code: 'custom', path: ['cloneSource'], message: 'Clone source facts require attachment' });
  }
  if ((input.materialization.kind === 'attach' || input.materialization.kind === 'sync') && input.materialization.targetManaged
    && input.materialization.targetManaged.controller.machineId !== input.machineId) {
    context.addIssue({ code: "custom", path: ['materialization', 'targetManaged'], message: 'Native destination must match its controller Machine' });
  }
  if (input.materialization.kind === 'attach' && input.materialization.targetManaged && (input.source.kind !== 'folder' || input.cloneSource)) {
    context.addIssue({ code: 'custom', path: ['materialization', 'targetManaged'], message: 'Native attachment selects a folder' });
  }
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
  /** Own destination display fact. A later Open receives ordinary admission. */
  destinationReview: z.optional(z.strictObject({
    accountId: IdSchema, serverId: IdSchema, machineId: IdSchema,
    destinationParentPath: ScmRepositoryCloneInputSchema.shape.destinationParentPath,
    destinationDirectoryName: ScmRepositoryCloneInputSchema.shape.destinationDirectoryName,
  })),
  retryNotBeforeMs: ScmRepositoryProvisioningFailureResponseSchema.shape.retryNotBeforeMs,
  remediation: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(ScmRepositoryProvisioningRemediationSchema)),
}));

export const OpenProjectResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('opened'), workspace: WorkspaceAddressV2Schema, directory: PathSchema,
    setup: z.enum(['notRequired', 'approvalRequired', 'prepared', 'failed']),
    facts: z.optional(WorkspaceProjectFactsV1Schema),
    cloneSource: z.optional(ScmRepositoryCloneSourceV1Schema),
    copyOnceBaseline: z.optional(WorkspaceManifestSchema),
    copyOnceExcludedPaths: z.optional(z.readonly(z.array(WorkspaceManifestRelativePathSchema))),
  }),
  z.strictObject({ kind: z.literal('ambiguous'), candidates: z.array(WorkspaceRefV1WriteSchema) }),
  OpenProjectRefusalV1Schema,
  z.strictObject({ kind: z.literal('outcomeUnknown'), operationId: z.optional(IdSchema) }),
]));
export type OpenProjectResultV1 = z.infer<typeof OpenProjectResultV1Schema>;

export function readProjectOpenUnsentRefusalV1(error: unknown): z.infer<typeof OpenProjectRefusalV1Schema> {
  return {
    kind: 'refused',
    code: isRpcMethodNotFoundError(error) ? RPC_ERROR_CODES.UPDATE_REQUIRED : 'machine_unreachable',
  };
}

/** Settlement and operation history consume the same finite Open refusal. */
/** The refusal stays the typed details so Action operation failures can retain it without re-validation. */
export function projectOpenProjectRefusalV1(result: z.infer<typeof OpenProjectRefusalV1Schema>):
  ActionExecuteFailure & Readonly<{ details: z.infer<typeof OpenProjectRefusalV1Schema> }> {
  return { ok: false, errorCode: result.code, error: result.remediation?.label ?? result.code, details: result,
    ...(result.effectAttempted !== undefined ? { effectAttempted: result.effectAttempted } : {}),
    ...(result.failureCause ? { failureCause: result.failureCause } : {}) };
}

/** Private source-host acknowledgement; target Open still validates and accepts its local directory. */
export const ProjectOpenSyncMaterializationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('materialized'), copyOnceBaseline: z.optional(WorkspaceManifestSchema),
    copyOnceExcludedPaths: z.optional(z.readonly(z.array(WorkspaceManifestRelativePathSchema))) }),
  z.strictObject({ kind: z.literal('refused'), code: IdSchema }),
  z.strictObject({ kind: z.literal('outcomeUnknown') }),
]));
export type ProjectOpenSyncMaterializationResultV1 = z.infer<typeof ProjectOpenSyncMaterializationResultV1Schema>;
