import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema, sameStrictJsonValue } from '../json/strictJsonValue.js';
import { preservedBoundedNfcString } from '../strings/preservedBoundedNfcString.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import { WorkflowAuthoredResultReferenceSchema } from '../workflows/workflowReferenceV1.js';
import { DeploymentDeployIntentInputV1Schema, DeploymentDeploySemanticInputV1Schema,
  type DeploymentDeployIntentInputV1, type DeploymentDeploySemanticInputV1 } from '../deployments/deploymentDeployIntentV1.js';

/** Saved SHA consent contains authored repository operands, never stored content. */
export const DeploymentShaApprovalInputV1Schema = lazyZodSchema(() => DeploymentDeploySemanticInputV1Schema.check(
  z.refine(input => input.sourceIntent === undefined || (input.sourceIntent.kind === 'repository'
    && input.sourceIntent.pullRequestHead === undefined),
  { message: 'SHA approval bindings require repository source operands.' })));

function isDeploymentShaApprovalInput(input: unknown): input is DeploymentDeploySemanticInputV1 {
  const parsed = DeploymentShaApprovalInputV1Schema.safeParse(input);
  return parsed.success && sameStrictJsonValue(parsed.data, input);
}

/** Fixed operands remain exact; only explicitly named producer operands resolve at Run admission. */
export const WorkflowApprovedOperationStepV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.string().check(z.minLength(1)),
  input: z.record(z.string(), StrictJsonValueSchema),
  binding: z.optional(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('deployment_sha') }),
    z.strictObject({ kind: z.literal('producer_result'), references: z.record(z.string().check(z.minLength(1)), WorkflowAuthoredResultReferenceSchema) }),
  ])),
}).check(z.refine(step => step.binding === undefined
  || (step.binding.kind === 'producer_result'
    ? Object.keys(step.binding.references).length > 0
      && Object.keys(step.binding.references).every(field => !Object.hasOwn(step.input, field))
    : step.actionId === 'deployments.deploy' && isDeploymentShaApprovalInput(step.input)),
{ message: 'Approval bindings require distinct producer operands or exact supported deployment operands.' })));
export type WorkflowApprovedOperationStepV1 = z.infer<typeof WorkflowApprovedOperationStepV1Schema>;

function deploymentShaEffectOperands(input: DeploymentDeployIntentInputV1) {
  // The request key identifies the invocation, rather than changing its effect.
  const { sha: _sha, requestKey: _requestKey, ...semantic } = input;
  const effect = { ...semantic, whenBusy: semantic.whenBusy ?? 'refuse' };
  if (semantic.sourceIntent?.kind !== 'repository') return effect;
  const { sha: _sourceSha, ...sourceIntent } = semantic.sourceIntent;
  return { ...effect, sourceIntent };
}

/** The shared exact-input matcher, including the declared deployment SHA variable. */
export function matchesApprovedOperationStepV1(
  step: WorkflowApprovedOperationStepV1,
  actionId: string,
  input: unknown,
): boolean {
  if (step.actionId !== actionId) return false;
  if (!step.binding) return sameStrictJsonValue(step.input, input);
  // Only the private Run owner can replace these references with persisted facts.
  if (step.binding.kind === 'producer_result') return false;
  if (actionId !== 'deployments.deploy' || !isDeploymentShaApprovalInput(step.input)) return false;
  const candidate = DeploymentDeployIntentInputV1Schema.safeParse(input);
  if (!candidate.success || !sameStrictJsonValue(candidate.data, input)
    || (candidate.data.sourceIntent !== undefined && (candidate.data.sourceIntent.kind !== 'repository'
      || candidate.data.sourceIntent.pullRequestHead !== undefined))) return false;
  return sameStrictJsonValue(deploymentShaEffectOperands(step.input), deploymentShaEffectOperands(candidate.data));
}

/** Original operation facts. These data alone are never review or execution authority. */
export const WorkflowApprovedOperationParentV1Schema = lazyZodSchema(() => z.strictObject({
  actionId: z.string().check(z.minLength(1)), input: z.record(z.string(), StrictJsonValueSchema),
}));

/** Exact person-approved effects, private to the existing operation owner. */
export const WorkflowApprovedOperationV1Schema = lazyZodSchema(() => z.strictObject({
  parent: WorkflowApprovedOperationParentV1Schema,
  approvedBy: z.strictObject({ accountId: preservedBoundedNfcString(191, 'Account ids') }),
  steps: z.array(WorkflowApprovedOperationStepV1Schema),
}));
export type WorkflowApprovedOperationV1 = z.infer<typeof WorkflowApprovedOperationV1Schema>;
// Consent carries authority: a stored reader must not erase an unknown restriction.
defineStoredReadProjection(WorkflowApprovedOperationV1Schema, () => WorkflowApprovedOperationV1Schema);
