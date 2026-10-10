import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import {
  WorkflowRoleOverridesV1Schema,
  WorkflowResolvedInputsV1Schema,
  WorkflowRunExecutionTargetV1Schema,
} from '../workflows/workflowDefinitionV1.js';
import { WorkflowDefinitionV1Schema } from '../workflows/workflowV1.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import {
  addAutomationStoredEnvelopeUtf8LimitIssue,
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationStoredContentEnvelopeV1.js';

const UTF8_ENCODER = new TextEncoder();

export const AutomationStoredWorkflowDefinitionV2Schema = lazyZodSchema(() => z.object({
  workspace: z.object({
    directory: z.string().min(1),
    workspaceRefId: preservedBoundedNfcString(191, 'Workspace reference ids').optional(),
  }).strict(),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  inputs: WorkflowResolvedInputsV1Schema.optional(),
  visibleTeamId: preservedBoundedNfcString(191, 'Team ids').nullable().optional(),
  roleOverrides: WorkflowRoleOverridesV1Schema.optional(),
  inlineDefinition: WorkflowDefinitionV1Schema.optional(),
  onComplete: z.object({ kind: z.literal('originating_session') }).strict().optional(),
}).strict());
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
function createAutomationStoredWorkflowDefinitionRecipeV2Schema(definitionSchema: z.ZodType) {
  return z.object({
    v: z.literal(2),
    templateVersion: z.number().int().nonnegative().safe(),
    workflow: AutomationStoredContentEnvelopeV1Schema,
    triggerEvidence: z.null(),
  }).strict().superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Automation workflow definition recipe exceeds its UTF-8 byte limit',
    );
    if (value.workflow.t === 'plain' && !definitionSchema.safeParse(value.workflow.v).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workflow'],
        message: 'Automation workflow definition is invalid',
      });
    }
  });
}

// Writes admit the canonical plain payload. Stored reads re-read the opaque plain payload through
// the tolerant definition reader, so an extra stored field is dropped instead of hiding the recipe.
export const AutomationStoredWorkflowDefinitionRecipeV2Schema = defineStoredReadProjection(
  createAutomationStoredWorkflowDefinitionRecipeV2Schema(AutomationStoredWorkflowDefinitionV2Schema),
  () => createStoredReadSchema(
    createAutomationStoredWorkflowDefinitionRecipeV2Schema(AutomationStoredWorkflowDefinitionV2ReadSchema),
  ).transform((recipe) => recipe.workflow.t === 'plain'
    ? {
      ...recipe,
      workflow: AutomationStoredContentEnvelopeV1Schema.parse({
        t: 'plain',
        v: AutomationStoredWorkflowDefinitionV2ReadSchema.parse(recipe.workflow.v),
      }),
    }
    : recipe),
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
