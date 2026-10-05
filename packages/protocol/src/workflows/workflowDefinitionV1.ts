import { z } from 'zod';
import { PluginSourceCustodyV1Schema } from '../plugins/runtime/sourceCustody.js';

import {
  WorkflowDefinitionV1Schema,
  type WorkflowBlock,
  type WorkflowDefinitionV1,
  WorkflowStepExecutionSelectionSchema,
  WorkflowEngineSelectionV1Schema,
} from './workflowV1.js';
import { WorkflowDefinitionIdV1Schema } from './workflowIdsV1.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { AgentPermissionIntentV1Schema, type AgentPermissionIntentV1 } from '../runtime/permissionIntentV1.js';
import { resolvePermissionPrivilegeOrdinal } from '../actions/permissionPrivilege.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { SessionInputSourceAuthorityV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { WorkflowBlockIdSchema, WorkflowInputNameSchema } from './workflowReferenceV1.js';
import { WorkflowAcceptedWorkspaceTargetV1Schema } from './workflowWorkspaceV1.js';
import { resolveWorkflowStepSelectionV1 } from './workflowStepSelectionV1.js';
import { RoleOverrideV1Schema, ResolvedRoleV1Schema } from '../prompts/roles/rolesV1.js';
import { WorkflowDefinitionRefV1StringSchema } from './workflowDefinitionRefV1.js';
import { ARTIFACT_EXCERPT_MAX_CHARS_V1 } from '../artifacts/artifactExcerptV1.js';
import { ArtifactSavedByV1Schema } from '../artifacts/artifactBinaryV1.js';

/** One deliberate engine edit; replay retains every other accepted leaf fact. */
export const WorkflowReplayAgentOverrideV1Schema = z.object({
  sourceKey: z.union([z.literal('$root'), WorkflowDefinitionRefV1StringSchema]),
  blockId: WorkflowBlockIdSchema,
  engine: WorkflowEngineSelectionV1Schema,
}).strict();
export type WorkflowReplayAgentOverrideV1 = z.infer<typeof WorkflowReplayAgentOverrideV1Schema>;

export const WorkflowRoleOverridesV1Schema = z.array(RoleOverrideV1Schema).superRefine((overrides, context) => {
  const seen = new Set<string>();
  overrides.forEach((override, index) => {
    if (seen.has(override.roleId)) context.addIssue({
      code: 'custom', path: [index, 'roleId'], message: 'Workflow role overrides must be unique by role id',
    });
    seen.add(override.roleId);
  });
});
export type WorkflowRoleOverridesV1 = z.infer<typeof WorkflowRoleOverridesV1Schema>;

export const WorkflowArtifactRevisionV1Schema = z.object({
  headerVersion: z.number().int().nonnegative().safe(),
  bodyVersion: z.number().int().nonnegative().safe(),
}).strict();
export type WorkflowArtifactRevisionV1 = z.infer<typeof WorkflowArtifactRevisionV1Schema>;

export const WorkflowDefinitionMetadataV1Schema = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional(),
}).strict();
export type WorkflowDefinitionMetadataV1 = z.infer<typeof WorkflowDefinitionMetadataV1Schema>;

export const WorkflowDefinitionSavedByV1Schema = ArtifactSavedByV1Schema;
export type WorkflowDefinitionSavedByV1 = z.infer<typeof WorkflowDefinitionSavedByV1Schema>;

export const WorkflowDefinitionArtifactHeaderV1Schema = z.object({
  kind: z.literal('workflow-definition.v1'),
  definitionId: WorkflowDefinitionIdV1Schema,
  revision: WorkflowArtifactRevisionV1Schema,
  metadata: WorkflowDefinitionMetadataV1Schema,
  savedBy: WorkflowDefinitionSavedByV1Schema.optional(),
  /** Static authored step labels, written atomically with the definition for header-only cards. */
  previewSteps: z.array(z.string()).optional(),
  excerpt: z.string().max(ARTIFACT_EXCERPT_MAX_CHARS_V1).optional(),
}).strict();
export type WorkflowDefinitionArtifactHeaderV1 = z.infer<typeof WorkflowDefinitionArtifactHeaderV1Schema>;

/** A restored body is a new physical revision, not a rewrite of its historical row. */
export function retargetWorkflowDefinitionArtifactHeaderV1(input: Readonly<{
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  expectedRevision: WorkflowArtifactRevisionV1;
  nextRevision: WorkflowArtifactRevisionV1;
}>): WorkflowDefinitionArtifactHeaderV1 {
  const parsed = WorkflowDefinitionArtifactHeaderV1Schema.safeParse(input.header);
  if (!parsed.success || parsed.data.definitionId !== input.artifactId
    || parsed.data.revision.headerVersion !== input.expectedRevision.headerVersion
    || parsed.data.revision.bodyVersion !== input.expectedRevision.bodyVersion) {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'content_unavailable' });
  }
  // Validation may normalize display text; advancing a revision must not rewrite stored metadata.
  return { ...parsed.data, ...input.header, revision: WorkflowArtifactRevisionV1Schema.parse(input.nextRevision) };
}

export const WorkflowDefinitionArtifactBodyV1Schema = z.object({
  kind: z.literal('workflow-definition.v1'),
  definition: WorkflowDefinitionV1Schema,
}).strict();
export type WorkflowDefinitionArtifactBodyV1 = z.infer<typeof WorkflowDefinitionArtifactBodyV1Schema>;

export const WorkflowResolvedInputsV1Schema = z.record(z.string(), StrictJsonValueSchema).superRefine(
  (inputs, context) => {
    for (const inputName of Object.keys(inputs)) {
      if (!WorkflowInputNameSchema.safeParse(inputName).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [inputName],
          message: 'Invalid Workflow input name',
        });
      }
    }
  },
);
export type WorkflowResolvedInputsV1 = z.infer<typeof WorkflowResolvedInputsV1Schema>;

/**
 * Default execution class frozen for the admitted Run. Workflow-only attached
 * Runs are retired; Session-attached Execution Runs outside Workflows are not.
 */
export const WorkflowRunExecutionTargetV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session') }).strict(),
  z.object({ kind: z.literal('detached_run') }).strict(),
]);
export type WorkflowRunExecutionTargetV1 = z.infer<typeof WorkflowRunExecutionTargetV1Schema>;

export const WorkflowMaterializedLeafV1Schema = z.object({
  sourceKey: z.string().min(1), blockId: z.string().min(1),
  kind: z.enum(['step', 'action', 'workflow', 'wait']),
  selection: WorkflowStepExecutionSelectionSchema,
  /** Lexical workspace intent before defaults are flattened into selection. */
  authoredWorkspace: WorkflowStepExecutionSelectionSchema.shape.workspace.unwrap(),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  role: ResolvedRoleV1Schema.optional(),
  childRef: WorkflowDefinitionRefV1StringSchema.optional(),
  actionId: z.string().min(1).optional(),
  actionContract: z.object({ inputSchema: StrictJsonValueSchema, outputSchema: StrictJsonValueSchema,
    completion: StrictJsonValueSchema.optional() }).strict().optional(),
  actionInput: z.record(z.string(), StrictJsonValueSchema).optional(),
}).strict();
export type WorkflowMaterializedLeafV1 = z.infer<typeof WorkflowMaterializedLeafV1Schema>;
export const WorkflowRunStartedByV1Schema = z.enum(['user', 'agent', 'trigger']);
export type WorkflowRunStartedByV1 = z.infer<typeof WorkflowRunStartedByV1Schema>;
export const WorkflowFrozenChildrenV1Schema = z.record(WorkflowDefinitionRefV1StringSchema, WorkflowDefinitionV1Schema);

const workflowMaterializationFields = {
  startedBy: WorkflowRunStartedByV1Schema,
  workDepth: z.number().int().nonnegative().safe(),
  roleOverrides: WorkflowRoleOverridesV1Schema.optional(),
  authoredDefinition: WorkflowDefinitionV1Schema,
  materializedLeaves: z.array(WorkflowMaterializedLeafV1Schema),
  frozenChildren: WorkflowFrozenChildrenV1Schema,
};

const WorkflowAcceptedSnapshotAutomationV1Schema = z.object({
  ...workflowMaterializationFields,
  definition: WorkflowDefinitionV1Schema,
  /** Account-private display metadata frozen with the accepted program. */
  metadata: WorkflowDefinitionMetadataV1Schema.nullable(),
  inputs: WorkflowResolvedInputsV1Schema,
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  origin: z.object({ kind: z.literal('direct'), originSessionId: preservedBoundedNfcString(191, 'Session ids').optional() }).strict().optional(),
  resultDelivery: z.object({ kind: z.literal('originating_session'), originSessionId: preservedBoundedNfcString(191, 'Session ids') }).strict().optional(),
  authorization: z.lazy((): typeof WorkflowAcceptedAuthorizationV1Schema => WorkflowAcceptedAuthorizationV1Schema),
  source: z.object({
    kind: z.literal('automation'),
    automationId: preservedBoundedNfcString(191, 'Automation ids'),
    definitionId: WorkflowDefinitionIdV1Schema.optional(),
    revision: WorkflowArtifactRevisionV1Schema.optional(),
    savedBy: WorkflowDefinitionSavedByV1Schema.nullable().optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
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
  if (value.resultDelivery && value.resultDelivery.originSessionId !== value.origin?.originSessionId) {
    context.addIssue({ code: 'custom', path: ['resultDelivery', 'originSessionId'], message: 'Delivery must use the frozen origin Session' });
  }
});

export const WorkflowAcceptedAuthorizationV1Schema = z.object({
  admittedPermissionCeiling: asProtocolZod(AgentPermissionIntentV1Schema),
  principal: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('host') }).strict(),
    z.object({ kind: z.literal('session'), sessionId: preservedBoundedNfcString(191, 'Session ids') }).strict(),
    z.object({
      kind: z.literal('plugin'),
      pluginId: preservedBoundedNfcString(191, 'Plugin ids'),
      contributionLocalId: preservedBoundedNfcString(191, 'Plugin contribution ids').optional(),
      sourceCustody: PluginSourceCustodyV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('api'),
      accountId: preservedBoundedNfcString(191, 'Account ids'),
      principalId: preservedBoundedNfcString(191, 'API principal ids'),
      credentialId: preservedBoundedNfcString(191, 'API credential ids'),
    }).strict(),
  ]),
  sourceAuthority: SessionInputSourceAuthorityV1Schema.optional(),
}).strict();
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

const WorkflowAcceptedDirectSourceV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('inline') }).strict(),
  z.object({
    kind: z.literal('saved'),
    definitionId: WorkflowDefinitionIdV1Schema,
    revision: WorkflowArtifactRevisionV1Schema,
    savedBy: WorkflowDefinitionSavedByV1Schema.nullable(),
  }).strict(),
  z.object({ kind: z.literal('catalog'), ref: WorkflowDefinitionRefV1StringSchema,
    version: z.union([z.number().int().nonnegative().safe(), z.string().min(1)]) }).strict(),
]);

const WorkflowAcceptedSnapshotDirectV1Schema = z.object({
  ...workflowMaterializationFields,
  definition: WorkflowDefinitionV1Schema,
  /** Inline sources may have no display metadata; admission freezes that absence. */
  metadata: WorkflowDefinitionMetadataV1Schema.nullable(),
  source: WorkflowAcceptedDirectSourceV1Schema,
  inputs: WorkflowResolvedInputsV1Schema,
  machineId: preservedBoundedNfcString(191, 'Machine ids'),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  workspaceTarget: WorkflowAcceptedWorkspaceTargetV1Schema,
  origin: z.object({
    kind: z.literal('direct'),
    originSessionId: preservedBoundedNfcString(191, 'Session ids').optional(),
  }).strict(),
  authorization: WorkflowAcceptedAuthorizationV1Schema,
  resultDelivery: z.object({
    kind: z.literal('originating_session'),
    originSessionId: preservedBoundedNfcString(191, 'Session ids'),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.workspaceTarget.project.machineId !== value.machineId) {
    context.addIssue({
      code: 'custom',
      path: ['workspaceTarget', 'project', 'machineId'],
      message: 'Project workspace must use the immutable Run Machine',
    });
  }
  if (value.resultDelivery && value.origin.originSessionId !== value.resultDelivery.originSessionId) {
    context.addIssue({
      code: 'custom',
      path: ['resultDelivery', 'originSessionId'],
      message: 'Result delivery must target the frozen originating Session',
    });
  }
});

/** Immutable admitted program; Artifact edits and caller-turn lifetime cannot alter it. */
export const WorkflowAcceptedSnapshotV1Schema = z.union([
  WorkflowAcceptedSnapshotAutomationV1Schema,
  WorkflowAcceptedSnapshotDirectV1Schema,
]);
export type WorkflowAcceptedSnapshotV1 = z.infer<typeof WorkflowAcceptedSnapshotV1Schema>;
