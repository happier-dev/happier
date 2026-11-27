import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { DeploymentEnvironmentRefV1Schema, DeploymentPreviewTemplateRefV1Schema } from '../deployments/deploymentEnvironmentRefV1.js';
import {
  WorkflowRoleOverridesV1Schema,
  WorkflowResolvedInputsV1Schema,
  WorkflowRunExecutionTargetV1Schema,
  WorkflowMaterializedLeafV1Schema,
} from '../workflows/workflowDefinitionV1.js';
import { WorkflowDefinitionV1Schema, WorkflowStepSchema } from '../workflows/workflowV1.js';
import { WorkflowVisibleTeamIdV1Schema } from '../workflows/workflowIdsV1.js';
import { AutomationActionTriggerSchema } from './automationActionTriggerV1.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { SessionPlacementSelectionV1Schema } from '../sessions/creation/sessionPlacementSelectionV1.js';
import { AutomationTriggerIdSchema } from './automationTriggerIdentity.js';
import { WorkflowApprovedOperationV1Schema } from '../actions/approvedOperationV1.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfileIdV1.js';
import {
  addAutomationStoredEnvelopeUtf8LimitIssue,
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationStoredContentEnvelopeV1.js';
import {
  AutomationDefinitionDisplayV1Schema,
  type AutomationDefinitionDisplayV1,
} from './automationDefinitionDisplayV1.js';

export {
  AutomationDefinitionDisplayV1Schema,
  type AutomationDefinitionDisplayV1,
} from './automationDefinitionDisplayV1.js';

const UTF8_ENCODER = new TextEncoder();
const visibleTeamIdSchema = lazyZodSchema(() => z.optional(z.nullable(WorkflowVisibleTeamIdV1Schema)));

/** Server-visible structural relationship; never private Workflow content. */
export const AutomationManagedTargetV1Schema = lazyZodSchema(() => z.strictObject({
  homeId: preservedBoundedNfcString(191, 'Home ids'),
  managedId: preservedBoundedNfcString(191, 'Managed resource ids'),
}));
export type AutomationManagedTargetV1 = z.infer<typeof AutomationManagedTargetV1Schema>;

/** Non-executable Event enrollment, stored by the existing Definition revision owner. */
export const AutomationObservationOnlyDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('observationOnly'),
  templateVersion: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  deploymentEnvironment: z.optional(DeploymentEnvironmentRefV1Schema),
}));
export type AutomationObservationOnlyDefinitionV1 = z.infer<typeof AutomationObservationOnlyDefinitionV1Schema>;

export function parseAutomationObservationOnlyDefinitionV1(serialized: unknown): AutomationObservationOnlyDefinitionV1 | null {
  if (typeof serialized !== 'string') return null;
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return null; }
  const parsed = AutomationObservationOnlyDefinitionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Private repository routing only; this configuration never establishes deploy consent. */
export const AutomationDeploymentTriggerFilterV1Schema = lazyZodSchema(() => z.strictObject({
  branch: z.optional(z.string().check(z.minLength(1))),
  paths: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export const AutomationDeploymentTriggerV1Schema = lazyZodSchema(() => z.strictObject({
  triggerId: AutomationTriggerIdSchema,
  ...AutomationDeploymentTriggerFilterV1Schema.shape,
}));
export type AutomationDeploymentTriggerV1 = z.infer<typeof AutomationDeploymentTriggerV1Schema>;

/** Private authority-bearing projection: an unknown restriction must never be erased on a stored read. */
export const WorkflowTriggerActorConsentV1Schema = lazyZodSchema(() => z.strictObject({
  actionIds: AutomationActionTriggerSchema.shape.actionIds,
  phase: AutomationActionTriggerSchema.shape.phase,
  subject: AutomationActionTriggerSchema.shape.subject,
  agentSteps: z.array(z.strictObject({
    sourceKey: WorkflowMaterializedLeafV1Schema.shape.sourceKey,
    blockId: WorkflowMaterializedLeafV1Schema.shape.blockId,
    document: WorkflowStepSchema.shape.document,
    input: WorkflowStepSchema.shape.input,
    inputMode: WorkflowStepSchema.shape.inputMode,
    selection: WorkflowMaterializedLeafV1Schema.shape.selection,
    executionTarget: WorkflowMaterializedLeafV1Schema.shape.executionTarget,
    participant: WorkflowMaterializedLeafV1Schema.shape.participant,
    role: WorkflowMaterializedLeafV1Schema.shape.role,
  })),
  /** Authored identities corresponding to the approved Action effects, absent from earlier 0.3 consent. */
  actionStepRefs: z.optional(z.array(z.strictObject({
    sourceKey: WorkflowMaterializedLeafV1Schema.shape.sourceKey,
    blockId: WorkflowMaterializedLeafV1Schema.shape.blockId,
  }))),
  /** Child Workflow body revisions are pinned even when a child has no executable leaf yet. */
  childRevisions: z.optional(z.array(z.strictObject({
    sourceKey: WorkflowMaterializedLeafV1Schema.shape.sourceKey,
    bodyVersion: z.number().check(z.int(), z.nonnegative()),
  }))),
}));
defineStoredReadProjection(WorkflowTriggerActorConsentV1Schema, () => WorkflowTriggerActorConsentV1Schema);

export const AutomationStoredWorkflowDefinitionV2Schema = lazyZodSchema(() => z.strictObject({
  /** Present for every new definition; omitted only by retained 0.2 storage. */
  display: z.optional(AutomationDefinitionDisplayV1Schema),
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  workspace: z.optional(z.strictObject({
    directory: z.string().check(z.minLength(1)),
    workspaceRefId: zMini.optional(preservedBoundedNfcString(191, 'Workspace reference ids')),
    sessionPlacement: z.optional(SessionPlacementSelectionV1Schema),
  })),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  inputs: zMini.optional(WorkflowResolvedInputsV1Schema),
  visibleTeamId: visibleTeamIdSchema,
  roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
  inlineDefinition: zMini.optional(WorkflowDefinitionV1Schema),
  deploymentTriggers: z.optional(z.array(AutomationDeploymentTriggerV1Schema)),
  /** Preview lifecycle source; the claimant reads current saved template intent. */
  deploymentPreview: z.optional(DeploymentPreviewTemplateRefV1Schema),
  /** Host-produced person consent; never an authored trigger operand. */
  actionApprovals: z.optional(z.array(z.strictObject({
    triggerId: AutomationTriggerIdSchema,
    operation: WorkflowApprovedOperationV1Schema,
  }))),
  /** Actor-reviewed shared trigger facts; private content never enters summaries. */
  actorConsent: z.optional(WorkflowTriggerActorConsentV1Schema),
  /** Q11: opt-in summary posting to an authorized connected source (default off). */
  postSummaryToSource: z.optional(z.boolean()),
  onComplete: z.optional(z.strictObject({ kind: z.literal('originating_session') })),
}));
export type AutomationStoredWorkflowDefinitionV2 = z.infer<typeof AutomationStoredWorkflowDefinitionV2Schema>;
export type WorkflowTriggerContextV1 = AutomationStoredWorkflowDefinitionV2;
export const AutomationStoredWorkflowDefinitionV2ReadSchema = createStoredReadSchema(AutomationStoredWorkflowDefinitionV2Schema);

/**
 * The current Automation definition recipe for managed workflows.
 *
 * The V1 one-shot recipe is retained only for historical reads. This recipe has no synthetic
 * one-shot target. The assignment owns the machine; this payload owns run
 * context and an inline target's definition. Workflow references resolve live
 * at claim and are never copied into this payload.
 */
function createAutomationStoredWorkflowDefinitionRecipeV2Schema(definitionSchema: z.ZodMiniType<{ workspace?: unknown }>) {
  return z.strictObject({
    v: z.literal(2),
    templateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
    workflow: AutomationStoredContentEnvelopeV1Schema,
    /** An Account Action Link has no definition assignment. Its occurrence supplies the Machine. */
    placement: z.optional(z.literal('action_invocation')),
    managedTarget: z.optional(z.nullable(AutomationManagedTargetV1Schema)),
    /** Selected Run audience, readable without opening the private trigger context. */
    visibleTeamId: visibleTeamIdSchema,
    deploymentEnvironment: z.optional(DeploymentEnvironmentRefV1Schema),
    triggerEvidence: z.null(),
  }).check(z.superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Automation workflow definition recipe exceeds its UTF-8 byte limit',
    );
    if (value.workflow.t === 'plain') {
      const definition = definitionSchema.safeParse(value.workflow.v);
      if (!definition.success || (definition.data.workspace === undefined) !== (value.placement === 'action_invocation')) {
        context.addIssue({
          code: "custom",
          path: ['workflow'],
          message: 'Automation workflow definition is invalid for its placement',
        });
      }
    }
  }));
}

// Writes admit the canonical plain payload. Stored reads re-read the opaque plain payload through
// the tolerant definition reader, so an extra stored field is dropped instead of hiding the recipe.
export const AutomationStoredWorkflowDefinitionRecipeV2Schema = defineStoredReadProjection(
  createAutomationStoredWorkflowDefinitionRecipeV2Schema(AutomationStoredWorkflowDefinitionV2Schema),
  () => z.pipe(createStoredReadSchema(
    createAutomationStoredWorkflowDefinitionRecipeV2Schema(AutomationStoredWorkflowDefinitionV2ReadSchema),
  ), z.transform((recipe) => recipe.workflow.t === 'plain'
    ? {
      ...recipe,
      workflow: AutomationStoredContentEnvelopeV1Schema.parse({
        t: 'plain',
        v: AutomationStoredWorkflowDefinitionV2ReadSchema.parse(recipe.workflow.v),
      }),
    }
    : recipe)),
);
export type AutomationStoredWorkflowDefinitionRecipeV2 = z.infer<
  typeof AutomationStoredWorkflowDefinitionRecipeV2Schema
>;
export const AutomationStoredWorkflowDefinitionRecipeV2ReadSchema =
  createStoredReadSchema(AutomationStoredWorkflowDefinitionRecipeV2Schema);

export type AutomationStoredWorkflowDefinitionRecipeV2Result =
  | Readonly<{
    kind: 'available';
    recipe: AutomationStoredWorkflowDefinitionRecipeV2;
    serialized: string;
  }>
  | Readonly<{ kind: 'contentInvalid' }>;

export function parseAutomationStoredWorkflowDefinitionRecipeV2(
  serialized: unknown,
): AutomationStoredWorkflowDefinitionRecipeV2Result {
  if (
    typeof serialized !== 'string'
    || UTF8_ENCODER.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
  ) return { kind: 'contentInvalid' };
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return { kind: 'contentInvalid' };
  }
  const parsed = AutomationStoredWorkflowDefinitionRecipeV2ReadSchema.safeParse(value);
  return parsed.success
    ? { kind: 'available', recipe: parsed.data, serialized }
    : { kind: 'contentInvalid' };
}

export function serializeAutomationStoredWorkflowDefinitionRecipeV2(
  recipe: unknown,
): AutomationStoredWorkflowDefinitionRecipeV2Result {
  const parsed = AutomationStoredWorkflowDefinitionRecipeV2Schema.safeParse(recipe);
  if (!parsed.success) return { kind: 'contentInvalid' };
  const serialized = createCanonicalJsonSigningInput(parsed.data);
  return UTF8_ENCODER.encode(serialized).byteLength > MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES
    ? { kind: 'contentInvalid' }
    : { kind: 'available', recipe: parsed.data, serialized };
}
