import { WorkflowApprovedOperationV1Schema } from '../actions/approvedOperationV1.js';
export { WorkflowApprovedOperationV1Schema } from '../actions/approvedOperationV1.js';
import { InputPathSchema } from '../inputs/inputPredicates.js';
import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';

import {
  WorkflowDefinitionBaseSchema,
  WorkflowDefinitionV1Schema,
  type WorkflowBlock,
  type WorkflowDefinitionV1,
  WorkflowStepExecutionSelectionSchema,
  WorkflowLiteralEngineSelectionV1Schema,
  WorkflowSelectionBindingV1Schema,
  WorkflowParticipantBindingV1Schema,
  WorkflowLeafExecutionTargetV1Schema as WorkflowRunExecutionTargetV1Schema,
} from './workflowV1.js';
import { WorkflowDefinitionIdV1Schema, WorkflowRunIdV1Schema } from './workflowIdsV1.js';
import { DiscussionAddressV1Schema, DiscussionMessageRefV1Schema } from '../discussions/references.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { AgentPermissionIntentV1Schema, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { resolvePermissionPrivilegeOrdinal } from '../actions/permissionPrivilege.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationIdV1Schema } from '../automations/automationIdV1.js';
import { SessionInputSourceAuthorityV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { WorkflowBlockIdSchema, WorkflowInputNameSchema } from './workflowReferenceV1.js';
import { WorkflowAcceptedWorkspaceTargetV1Schema } from './workflowWorkspaceV1.js';
import { resolveWorkflowStepSelectionV1 } from './workflowStepSelectionV1.js';
import { RoleOverrideV1Schema, ResolvedRoleV1Schema } from '../prompts/roles/rolesV1.js';
import { WorkflowDefinitionRefV1StringSchema } from './workflowDefinitionRefV1.js';
import { ARTIFACT_EXCERPT_MAX_CHARS_V1 } from '../artifacts/artifactExcerptV1.js';
import { ArtifactSavedByV1Schema } from '../artifacts/artifactBinaryV1.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ActionSessionAddressV1Schema } from '../actions/sessionTargetV1.js';
import { ExecutableParticipantSelectionV1Schema } from '../discussions/executableParticipants.js';
import { SessionSpawnNewSelectionV2Schema } from '../sessions/creation/sessionSpawnNewSelectionV2.js';
import { ActionRequestAttributionV1Schema } from '../actions/actionRequestAttributionV1.js';
import { ActionsSettingsV1Schema } from '../actions/actionSettings.js';
import { ActionRequiredAuthoritySchema, ActionSurfaceSchema } from '../actions/metadata.js';
import { WorkflowDiscussionOriginV1Schema, WorkflowResultDeliveryV1Schema } from './workflowDestinationsV1.js';
export { collectWorkflowLeavesV1, deriveWorkflowDestinationsV1, readWorkflowLeafTargetSessionIdsV1,
  resolveWorkflowDestinationsV1, WorkflowDestinationsV1Schema, type WorkflowDestinationsV1 } from './workflowDestinationsV1.js';

/** One deliberate engine edit; replay retains every other accepted leaf fact. */
export const WorkflowReplayAgentOverrideV1Schema = lazyZodSchema(() => z.strictObject({
  sourceKey: z.union([z.literal('$root'), WorkflowDefinitionRefV1StringSchema]),
  blockId: WorkflowBlockIdSchema,
  engine: WorkflowLiteralEngineSelectionV1Schema,
}));
export type WorkflowReplayAgentOverrideV1 = z.infer<typeof WorkflowReplayAgentOverrideV1Schema>;

export const WorkflowRoleOverridesV1Schema = lazyZodSchema(() => z.array(RoleOverrideV1Schema).check(z.superRefine((overrides, context) => {
  const seen = new Set<string>();
  overrides.forEach((override, index) => {
    if (seen.has(override.roleId)) context.addIssue({
      code: 'custom', path: [index, 'roleId'], message: 'Workflow role overrides must be unique by role id',
    });
    seen.add(override.roleId);
  });
})));
export type WorkflowRoleOverridesV1 = z.infer<typeof WorkflowRoleOverridesV1Schema>;

export const WorkflowArtifactRevisionV1Schema = lazyZodSchema(() => z.strictObject({
  headerVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
  bodyVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type WorkflowArtifactRevisionV1 = z.infer<typeof WorkflowArtifactRevisionV1Schema>;

/** Descriptive source lineage, never execution identity, source access or trusted actor authority. */
export const WorkflowDefinitionCaptureProvenanceV1Schema = lazyZodSchema(() => z.strictObject({
  discussion: DiscussionAddressV1Schema,
  messages: z.array(z.strictObject({ source: DiscussionMessageRefV1Schema, authorAccountId: z.nullable(z.string()),
    participantSessionId: z.optional(z.string()) })),
  workflow: z.optional(z.strictObject({ runId: WorkflowRunIdV1Schema, source: z.strictObject({
    kind: z.enum(['inline', 'saved', 'catalog', 'automation']),
    definitionId: z.optional(WorkflowDefinitionIdV1Schema),
    ref: z.optional(z.string()), revision: z.optional(WorkflowArtifactRevisionV1Schema),
    version: z.optional(z.union([z.string(), z.number()])), automationId: z.optional(z.string()),
  }) })),
}));

export const WorkflowDefinitionMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  title: z.string().check(z.trim(), z.minLength(1)),
  description: z.optional(z.string()),
  captureProvenance: z.optional(WorkflowDefinitionCaptureProvenanceV1Schema),
}));
export type WorkflowDefinitionMetadataV1 = z.infer<typeof WorkflowDefinitionMetadataV1Schema>;

export const WorkflowDefinitionSavedByV1Schema = ArtifactSavedByV1Schema;
export type WorkflowDefinitionSavedByV1 = z.infer<typeof WorkflowDefinitionSavedByV1Schema>;

export const WorkflowDefinitionArtifactHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('workflow-definition.v1'),
  definitionId: WorkflowDefinitionIdV1Schema,
  revision: WorkflowArtifactRevisionV1Schema,
  metadata: WorkflowDefinitionMetadataV1Schema,
  /** Static authored step labels, written atomically with the definition for header-only cards. */
  previewSteps: z.optional(z.array(z.string())),
  excerpt: z.optional(z.string().check(z.maxLength(ARTIFACT_EXCERPT_MAX_CHARS_V1))),
}));
export type WorkflowDefinitionArtifactHeaderV1 = z.infer<typeof WorkflowDefinitionArtifactHeaderV1Schema>;
export const WorkflowDefinitionArtifactHeaderV1ReadSchema = createStoredReadSchema(WorkflowDefinitionArtifactHeaderV1Schema);

export const WorkflowDefinitionContentUnavailableReasonV1Schema = lazyZodSchema(() => z.enum([
  'invalid_header', 'revision_mismatch', 'missing_body', 'invalid_body', 'not_found',
]));
export type WorkflowDefinitionContentUnavailableReasonV1 = z.infer<typeof WorkflowDefinitionContentUnavailableReasonV1Schema>;

/** A restored body is a new physical revision, not a rewrite of its historical row. */
export function retargetWorkflowDefinitionArtifactHeaderV1(input: Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  expectedRevision: WorkflowArtifactRevisionV1;
  nextRevision: WorkflowArtifactRevisionV1;
}>): WorkflowDefinitionArtifactHeaderV1 {
  const parsed = WorkflowDefinitionArtifactHeaderV1ReadSchema.safeParse(input.header);
  if (!parsed.success || parsed.data.definitionId !== input.artifactId
    || parsed.data.revision.headerVersion !== input.expectedRevision.headerVersion
    || parsed.data.revision.bodyVersion !== input.expectedRevision.bodyVersion) {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
  return { ...parsed.data, revision: WorkflowArtifactRevisionV1Schema.parse(input.nextRevision) };
}

export const WorkflowDefinitionArtifactBodyV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('workflow-definition.v1'),
  definition: WorkflowDefinitionV1Schema,
}));
export type WorkflowDefinitionArtifactBodyV1 = z.infer<typeof WorkflowDefinitionArtifactBodyV1Schema>;
export const WorkflowDefinitionArtifactBodyV1ReadSchema = createStoredReadSchema(WorkflowDefinitionArtifactBodyV1Schema);

export const WorkflowResolvedInputsV1Schema = lazyZodSchema(() => z.record(z.string(), StrictJsonValueSchema).check(z.superRefine((inputs, context) => {
    for (const inputName of Object.keys(inputs)) {
      if (!WorkflowInputNameSchema.safeParse(inputName).success) {
        context.addIssue({
          code: "custom",
          path: [inputName],
          message: 'Invalid Workflow input name',
        });
      }
    }
  })));
export type WorkflowResolvedInputsV1 = z.infer<typeof WorkflowResolvedInputsV1Schema>;

/**
 * Default execution class frozen for the admitted Run. Workflow-only attached
 * Runs are retired; Session-attached Execution Runs outside Workflows are not.
 */
export { WorkflowRunExecutionTargetV1Schema };
export type WorkflowRunExecutionTargetV1 = z.infer<typeof WorkflowRunExecutionTargetV1Schema>;

export const WorkflowAcceptedParticipantV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), session: ActionSessionAddressV1Schema,
    machineId: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('model'), launch: SessionSpawnNewSelectionV2Schema }),
]));
export type WorkflowAcceptedParticipantV1 = z.infer<typeof WorkflowAcceptedParticipantV1Schema>;

export const WorkflowMaterializedLeafV1Schema = lazyZodSchema(() => z.strictObject({
  sourceKey: z.string().check(z.minLength(1)), blockId: z.string().check(z.minLength(1)),
  kind: z.enum(['step', 'action', 'workflow', 'wait']),
  selection: WorkflowStepExecutionSelectionSchema,
  /** Lexical workspace intent before defaults are flattened into selection. */
  authoredWorkspace: WorkflowStepExecutionSelectionSchema.shape.workspace._zod.def.innerType,
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  participant: z.optional(WorkflowAcceptedParticipantV1Schema),
  role: zMini.optional(ResolvedRoleV1Schema),
  /** Frame-local Session inputs admitted against the starting principal's corpus. */
  sessionAuthorityBindings: z.optional(z.array(z.strictObject({
    inputName: WorkflowInputNameSchema,
    targets: z.array(z.strictObject({ address: ActionSessionAddressV1Schema, machineId: z.string().check(z.minLength(1)) })),
  }))),
  /** Verified Session placement for each immutable input admitted to this leaf. */
  sessionBindings: z.optional(z.strictObject({
    inputName: WorkflowInputNameSchema,
    defaultFrom: z.optional(z.literal('origin_session')),
    targets: z.array(z.strictObject({ address: ActionSessionAddressV1Schema, machineId: z.string().check(z.minLength(1)) })),
  })),
  /** Finite choices frozen at admission; invocation items can only select this roster. */
  engineBindings: z.optional(z.strictObject({
    reference: WorkflowSelectionBindingV1Schema,
    selections: z.array(z.strictObject({
      value: WorkflowLiteralEngineSelectionV1Schema,
      selection: WorkflowStepExecutionSelectionSchema,
      executionTarget: WorkflowRunExecutionTargetV1Schema,
      role: zMini.optional(ResolvedRoleV1Schema),
    })),
  })),
  participantBindings: z.optional(z.strictObject({
    reference: WorkflowParticipantBindingV1Schema,
    selections: z.array(z.strictObject({
      value: ExecutableParticipantSelectionV1Schema,
      participant: WorkflowAcceptedParticipantV1Schema,
      selection: WorkflowStepExecutionSelectionSchema,
      executionTarget: WorkflowRunExecutionTargetV1Schema,
      role: zMini.optional(ResolvedRoleV1Schema),
    })),
  })),
  childRef: zMini.optional(WorkflowDefinitionRefV1StringSchema),
  actionId: z.optional(z.string().check(z.minLength(1))),
  actionContract: z.optional(z.strictObject({ inputSchema: StrictJsonValueSchema, outputSchema: StrictJsonValueSchema,
    secretInputPaths: z.optional(z.array(InputPathSchema)),
    completion: zMini.optional(StrictJsonValueSchema) })),
  actionInput: z.optional(z.record(z.string(), StrictJsonValueSchema)),
}));
export type WorkflowMaterializedLeafV1 = z.infer<typeof WorkflowMaterializedLeafV1Schema>;
export const WorkflowRunStartedByV1Schema = lazyZodSchema(() => z.enum(['user', 'agent', 'trigger']));
export type WorkflowRunStartedByV1 = z.infer<typeof WorkflowRunStartedByV1Schema>;
export const WorkflowFrozenChildrenV1Schema = lazyZodSchema(() => z.record(WorkflowDefinitionRefV1StringSchema, WorkflowDefinitionV1Schema));

/** Private relation frozen by admission, inside the existing Run envelope. */
const WorkflowAcceptedTargetSessionIdsV1Schema = lazyZodSchema(() => z.optional(z.array(preservedBoundedNfcString(191, 'Session ids'))));

const workflowMaterializationFields = () => ({
  approvedOperation: z.optional(WorkflowApprovedOperationV1Schema),
  targetSessionIds: WorkflowAcceptedTargetSessionIdsV1Schema,
  requiresMachineStartCapacity: z.optional(z.boolean()),
  startedBy: WorkflowRunStartedByV1Schema,
  workDepth: z.number().check(z.int(), z.nonnegative(), z.int()),
  roleOverrides: z.optional(WorkflowRoleOverridesV1Schema),
  authoredDefinition: WorkflowDefinitionV1Schema,
  materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
  frozenChildren: WorkflowFrozenChildrenV1Schema,
});

/** Host-stamped cause retained inside the accepted Run's existing origin custody. */
export const WorkflowAcceptedOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('direct'),
  originSessionId: zMini.optional(preservedBoundedNfcString(191, 'Session ids')),
  discussion: z.optional(WorkflowDiscussionOriginV1Schema),
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  /** Invoking policy for contained effects, never a durable present-person grant. */
  actionPolicy: z.optional(z.strictObject({
    surface: z.optional(z.keyof(ActionSurfaceSchema)),
    authority: ActionRequiredAuthoritySchema,
    actionsSettings: z.optional(ActionsSettingsV1Schema),
  })),
}));
export type WorkflowAcceptedOriginV1 = z.infer<typeof WorkflowAcceptedOriginV1Schema>;

const WorkflowAcceptedAutomationSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('automation'),
  automationId: asProtocolZod(AutomationIdV1Schema),
  definitionId: zMini.optional(WorkflowDefinitionIdV1Schema),
  revision: z.optional(WorkflowArtifactRevisionV1Schema),
  savedBy: zMini.optional(zMini.nullable(WorkflowDefinitionSavedByV1Schema)),
}));

const WorkflowAcceptedSnapshotAutomationV1Schema = lazyZodSchema(() => z.strictObject({
  ...workflowMaterializationFields(),
  definition: WorkflowDefinitionV1Schema,
  /** Account-private display metadata frozen with the accepted program. */
  metadata: z.nullable(WorkflowDefinitionMetadataV1Schema),
  inputs: WorkflowResolvedInputsV1Schema,
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  origin: z.optional(WorkflowAcceptedOriginV1Schema),
  resultDelivery: z.optional(WorkflowResultDeliveryV1Schema),
  authorization: z.lazy((): typeof WorkflowAcceptedAuthorizationV1Schema => WorkflowAcceptedAuthorizationV1Schema),
  source: WorkflowAcceptedAutomationSourceV1Schema,
}).check(z.superRefine((value, context) => {
  if (value.source.definitionId !== undefined && value.source.savedBy === undefined) {
    context.addIssue({ code: 'custom', path: ['source', 'savedBy'], message: 'Saved sources must freeze the authorship observation' });
  }
  if (value.workspaceTarget.project.machineId !== value.machineId) {
    context.addIssue({
      code: 'custom',
      path: ['workspaceTarget', 'project', 'machineId'],
      message: 'Project workspace must use the immutable Run Machine',
    });
  }
  if (value.resultDelivery?.kind === 'originating_session' && value.resultDelivery.originSessionId !== value.origin?.originSessionId) {
    context.addIssue({ code: 'custom', path: ['resultDelivery', 'originSessionId'], message: 'Delivery must use the frozen origin Session' });
  }
  if (value.resultDelivery?.kind === 'originating_discussion' && !sameStrictJsonValue(value.origin?.discussion,
    { discussion: value.resultDelivery.discussion, messageId: value.resultDelivery.messageId, throughSeq: value.resultDelivery.throughSeq })) {
    context.addIssue({ code: 'custom', path: ['resultDelivery'], message: 'Delivery must use the frozen Discussion occurrence' });
  }
})));

export const WorkflowAcceptedAuthorizationV1Schema = lazyZodSchema(() => z.strictObject({
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  principal: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('host') }),
    z.strictObject({ kind: z.literal('session'), sessionId: preservedBoundedNfcString(191, 'Session ids') }),
    z.strictObject({
      kind: z.literal('plugin'),
      pluginId: preservedBoundedNfcString(191, 'Plugin ids'),
      contributionLocalId: zMini.optional(preservedBoundedNfcString(191, 'Plugin contribution ids')),
      sourceCustody: PluginSourceCustodyV1Schema,
    }),
    z.strictObject({
      kind: z.literal('api'),
      accountId: preservedBoundedNfcString(191, 'Account ids'),
      principalId: preservedBoundedNfcString(191, 'API principal ids'),
      credentialId: preservedBoundedNfcString(191, 'API credential ids'),
    }),
  ]),
  sourceAuthority: zMini.optional(SessionInputSourceAuthorityV1Schema),
}));
export type WorkflowAcceptedAuthorizationV1 = z.infer<typeof WorkflowAcceptedAuthorizationV1Schema>;

const WORKFLOW_PERMISSION_CEILING_BY_ORDINAL = [
  'read-only',
  'default',
  'safe-yolo',
  'yolo',
] as const;

/**
 * Derives the least privileged canonical ceiling that admits every effective
 * leaf in one normalized frozen Workflow program. Omission has the same
 * canonical `default` meaning used by Session and Execution Run admission.
 * Same-privilege aliases (`plan`, `acceptEdits`, `bypassPermissions`) collapse
 * to one stable admitted intent rather than making definition order authority.
 */
export function deriveWorkflowAcceptedPermissionCeilingV1(
  definition: WorkflowDefinitionV1,
  additionalDefinitions: readonly WorkflowDefinitionV1[] = [],
  additionalPermissions: readonly AgentPermissionIntentV1[] = [],
): AgentPermissionIntentV1 {
  let maximumOrdinal = 0;
  for (const permission of additionalPermissions) {
    const ordinal = resolvePermissionPrivilegeOrdinal(permission);
    if (ordinal === null) throw new TypeError('Workflow permission mode is invalid');
    maximumOrdinal = Math.max(maximumOrdinal, ordinal);
  }
  for (const program of [definition, ...additionalDefinitions]) {
    const pending: WorkflowBlock[] = [...program.blocks];
    while (pending.length > 0) {
      const block = pending.pop()!;
      if (block.kind === 'step') {
        const ordinal = resolvePermissionPrivilegeOrdinal(
          resolveWorkflowStepSelectionV1({ defaults: program.defaults, step: block.execution }).selection.permissionMode ?? 'default',
        );
        if (ordinal === null) throw new TypeError('Workflow step permission mode is invalid');
        maximumOrdinal = Math.max(maximumOrdinal, ordinal);
        continue;
      }
      if (block.kind === 'parallel') {
        for (const branch of block.branches) {
          for (const child of branch.blocks) pending.push(child);
        }
        continue;
      }
      if (block.kind === 'if') {
        for (const child of block.then) pending.push(child);
        for (const child of block.otherwise) pending.push(child);
        continue;
      }
      if (block.kind === 'loop') {
        for (const child of block.body) pending.push(child);
        if (block.repetition.kind === 'evaluate') pending.push(block.repetition.evaluator);
      }
    }
  }
  return WORKFLOW_PERMISSION_CEILING_BY_ORDINAL[maximumOrdinal];
}

/** Reviewed content stays inline; an authorized Artifact binding supplies grant lineage only. */
export const WorkflowAcceptedInlineSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('inline'),
  sourceArtifactId: zMini.optional(WorkflowDefinitionIdV1Schema),
}));

const WorkflowAcceptedDirectSourceV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  WorkflowAcceptedInlineSourceV1Schema,
  z.strictObject({
    kind: z.literal('saved'),
    definitionId: WorkflowDefinitionIdV1Schema,
    revision: WorkflowArtifactRevisionV1Schema,
    savedBy: zMini.nullable(WorkflowDefinitionSavedByV1Schema),
  }),
  z.strictObject({ kind: z.literal('catalog'), ref: WorkflowDefinitionRefV1StringSchema,
    version: z.union([z.number().check(z.int(), z.nonnegative(), z.int()), z.string().check(z.minLength(1))]) }),
]));

const WorkflowAcceptedSnapshotDirectV1Schema = lazyZodSchema(() => z.strictObject({
  ...workflowMaterializationFields(),
  definition: WorkflowDefinitionV1Schema,
  /** Inline sources may have no display metadata; admission freezes that absence. */
  metadata: z.nullable(WorkflowDefinitionMetadataV1Schema),
  source: WorkflowAcceptedDirectSourceV1Schema,
  inputs: WorkflowResolvedInputsV1Schema,
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  origin: WorkflowAcceptedOriginV1Schema,
  authorization: WorkflowAcceptedAuthorizationV1Schema,
  resultDelivery: z.optional(WorkflowResultDeliveryV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.workspaceTarget.project.machineId !== value.machineId) {
    context.addIssue({
      code: 'custom',
      path: ['workspaceTarget', 'project', 'machineId'],
      message: 'Project workspace must use the immutable Run Machine',
    });
  }
  if (value.resultDelivery?.kind === 'originating_session' && value.origin.originSessionId !== value.resultDelivery.originSessionId) {
    context.addIssue({
      code: 'custom',
      path: ['resultDelivery', 'originSessionId'],
      message: 'Result delivery must target the frozen originating Session',
    });
  }
  if (value.resultDelivery?.kind === 'originating_discussion' && !sameStrictJsonValue(value.origin.discussion,
    { discussion: value.resultDelivery.discussion, messageId: value.resultDelivery.messageId, throughSeq: value.resultDelivery.throughSeq })) {
    context.addIssue({ code: 'custom', path: ['resultDelivery'], message: 'Delivery must use the frozen Discussion occurrence' });
  }
})));

/** Immutable admitted program; Artifact edits and caller-turn lifetime cannot alter it. */
export const WorkflowAcceptedSnapshotV1Schema = lazyZodSchema(() => z.union([
  WorkflowAcceptedSnapshotAutomationV1Schema,
  WorkflowAcceptedSnapshotDirectV1Schema,
]));
export type WorkflowAcceptedSnapshotV1 = z.infer<typeof WorkflowAcceptedSnapshotV1Schema>;

export { type WorkflowApprovedOperationV1 } from '../actions/approvedOperationV1.js';

/**
 * The accepted facts a Run list row shows: names, starter, origin, place and
 * destinations. A stored read through this projection drops the frozen
 * program (definitions, leaves, approvals) without admitting it; Run detail
 * and authored-step labels open the complete snapshot.
 */
export const WorkflowAcceptedSnapshotListingV1Schema = lazyZodSchema(() => z.object({
  targetSessionIds: WorkflowAcceptedTargetSessionIdsV1Schema,
  startedBy: WorkflowRunStartedByV1Schema,
  authoredDefinition: z.object({ inputs: WorkflowDefinitionBaseSchema.shape.inputs }),
  metadata: z.nullable(WorkflowDefinitionMetadataV1Schema),
  source: z.union([WorkflowAcceptedDirectSourceV1Schema, WorkflowAcceptedAutomationSourceV1Schema]),
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  origin: z.optional(WorkflowAcceptedOriginV1Schema),
}));
export type WorkflowAcceptedSnapshotListingV1 = z.infer<typeof WorkflowAcceptedSnapshotListingV1Schema>;
