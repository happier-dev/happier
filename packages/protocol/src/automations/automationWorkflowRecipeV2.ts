import * as zMini from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
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
import { AutomationTriggerIdSchema } from './automationTriggerIdentity.js';
import { AutomationIdV1Schema } from './automationIdV1.js';
import { WorkflowApprovedOperationV1Schema } from '../actions/approvedOperationV1.js';
import { ApprovalProfileIdV1Schema } from '../actions/approvalProfiles.js';
import { ArtifactSavedByV1Schema } from '../artifacts/artifactBinaryV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  addAutomationStoredEnvelopeUtf8LimitIssue,
  AutomationStoredContentEnvelopeV1Schema,
  MAX_AUTOMATION_STORED_ENVELOPE_UTF8_BYTES,
} from './automationStoredContentEnvelopeV1.js';
import {
  isAvailableE2eeAutomationAccountEncryptionV1,
  type AvailableAutomationAccountEncryptionV1,
} from './automationAccountCurrentnessV1.js';
import { openAccountScopedBlobCiphertext } from '../crypto/accountScopedCipher.js';
import {
  AutomationDefinitionDisplayV1Schema,
  type AutomationDefinitionDisplayV1,
} from './automationDefinitionDisplayV1.js';

export {
  AutomationDefinitionDisplayV1Schema,
  type AutomationDefinitionDisplayV1,
} from './automationDefinitionDisplayV1.js';

const UTF8_ENCODER = new TextEncoder();
const visibleTeamIdSchema = lazyZodSchema(() => z.optional(z.nullable(preservedBoundedNfcString(191, 'Team ids'))));

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

// Current-dev predecessor: workflowDeploymentConsent wrote empty steps and a
// saved program. The trigger consent owner converts that proof on stored reads;
// remove this reader after those retained rows/accepted Runs have been rewritten.
const LegacyAutomationDeploymentTriggerV1Schema = lazyZodSchema(() => z.strictObject({
  ...AutomationDeploymentTriggerV1Schema.shape,
  approval: z.optional(z.strictObject({
    savedFor: z.strictObject({ automationId: asProtocolZod(AutomationIdV1Schema), triggerId: AutomationTriggerIdSchema }),
    savedBy: ArtifactSavedByV1Schema, operation: WorkflowApprovedOperationV1Schema,
    // Ignored predecessor payload: never traverse it or carry it into domain consent.
    basis: z.unknown(),
    program: z.strictObject({ definition: WorkflowDefinitionV1Schema, children: z.record(z.string(), WorkflowDefinitionV1Schema) }),
  })),
}));

export const AutomationStoredWorkflowDefinitionV2Schema = lazyZodSchema(() => z.strictObject({
  /** Present for every new definition; omitted only by retained 0.2 storage. */
  display: z.optional(AutomationDefinitionDisplayV1Schema),
  approvalProfileId: z.optional(z.nullable(ApprovalProfileIdV1Schema)),
  workspace: z.strictObject({
    directory: z.string().check(z.minLength(1)),
    workspaceRefId: zMini.optional(preservedBoundedNfcString(191, 'Workspace reference ids')),
  }),
  executionTarget: WorkflowRunExecutionTargetV1Schema,
  inputs: zMini.optional(WorkflowResolvedInputsV1Schema),
  visibleTeamId: visibleTeamIdSchema,
  roleOverrides: zMini.optional(WorkflowRoleOverridesV1Schema),
  inlineDefinition: zMini.optional(WorkflowDefinitionV1Schema),
  deploymentTriggers: z.optional(z.array(AutomationDeploymentTriggerV1Schema)),
  /** Preview lifecycle source; the claimant reads current saved template intent. */
  deploymentPreview: z.optional(z.pick(DeploymentEnvironmentRefV1Schema, { serverId: true, environmentId: true })),
  /** Host-produced person consent; never an authored trigger operand. */
  actionApprovals: z.optional(z.array(z.strictObject({
    triggerId: AutomationTriggerIdSchema,
    operation: WorkflowApprovedOperationV1Schema,
  }))),
  onComplete: z.optional(z.strictObject({ kind: z.literal('originating_session') })),
}));
export type AutomationStoredWorkflowDefinitionV2 = z.infer<typeof AutomationStoredWorkflowDefinitionV2Schema>;
export type WorkflowTriggerContextV1 = AutomationStoredWorkflowDefinitionV2;
export const AutomationStoredWorkflowDefinitionV2ReadSchema = createStoredReadSchema(lazyZodSchema(() => z.strictObject({
  ...AutomationStoredWorkflowDefinitionV2Schema.shape,
  deploymentTriggers: z.optional(z.array(LegacyAutomationDeploymentTriggerV1Schema)),
})));

export type AutomationStoredWorkflowDefinitionV2OpenResult =
  | Readonly<{ kind: 'available'; definition: AutomationStoredWorkflowDefinitionV2 }>
  | Readonly<{ kind: 'contentInvalid' | 'modeMismatch' }>;

/**
 * The one Account-codec opener for the V2 Workflow definition carrier. It
 * never reinterprets an E2EE envelope as plain content, while stored reads
 * retain the released fields needed by pre-display rows.
 */
export function openAutomationStoredWorkflowDefinitionV2(params: Readonly<{
  workflow: unknown;
  encryption: AvailableAutomationAccountEncryptionV1;
}>): AutomationStoredWorkflowDefinitionV2OpenResult {
  const envelope = createStoredReadSchema(AutomationStoredContentEnvelopeV1Schema).safeParse(params.workflow);
  if (!envelope.success) return { kind: 'contentInvalid' };
  let raw: unknown;
  if (!isAvailableE2eeAutomationAccountEncryptionV1(params.encryption)) {
    if (envelope.data.t !== 'plain') return { kind: 'modeMismatch' };
    raw = envelope.data.v;
  } else {
    if (envelope.data.t !== 'encrypted') return { kind: 'modeMismatch' };
    const opened = openAccountScopedBlobCiphertext({
      kind: 'automation_template_payload',
      material: params.encryption.material.material,
      ciphertext: envelope.data.c,
    });
    if (!opened) return { kind: 'contentInvalid' };
    raw = opened.value;
  }
  const definition = AutomationStoredWorkflowDefinitionV2ReadSchema.safeParse(raw);
  return definition.success
    ? { kind: 'available', definition: definition.data }
    : { kind: 'contentInvalid' };
}

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
