import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';

import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { DeploymentEnvironmentRefV1Schema } from '../deployments/deploymentEnvironmentRefV1.js';
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

export const AutomationStoredWorkflowDefinitionV2Schema = lazyZodSchema(() => z.strictObject({
  workspace: z.strictObject({
    directory: z.string().check(z.minLength(1)),
    workspaceRefId: zMini.optional(preservedBoundedNfcString(191, 'Workspace reference ids')),
  }),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  inputs: zMini.optional(WorkflowResolvedInputsV1Schema),
  visibleTeamId: zMini.optional(zMini.nullable(preservedBoundedNfcString(191, 'Team ids'))),
  roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
  inlineDefinition: zMini.optional(WorkflowDefinitionV1Schema),
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
function createAutomationStoredWorkflowDefinitionRecipeV2Schema(definitionSchema: z.ZodMiniType) {
  return z.strictObject({
    v: z.literal(2),
    templateVersion: z.number().check(z.int(), z.nonnegative(), z.int()),
    workflow: AutomationStoredContentEnvelopeV1Schema,
    managedTarget: z.optional(z.nullable(AutomationManagedTargetV1Schema)),
    triggerEvidence: z.null(),
  }).check(z.superRefine((value, context) => {
    addAutomationStoredEnvelopeUtf8LimitIssue(
      value,
      context,
      'Automation workflow definition recipe exceeds its UTF-8 byte limit',
    );
    if (value.workflow.t === 'plain' && !definitionSchema.safeParse(value.workflow.v).success) {
      context.addIssue({
        code: "custom",
        path: ['workflow'],
        message: 'Automation workflow definition is invalid',
      });
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
