import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';

const Id = z.string().trim().min(1).max(191);
/** Public routing facts; source lifecycle and access remain with the Run owner. */
export const AutomationRunLifecycleSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('execution_run'), machineId: Id, runId: Id, sessionId: Id.optional() }).strict(),
  z.object({ kind: z.literal('workflow_run'), runId: Id }).strict(),
]));
export type AutomationRunLifecycleSource = z.infer<typeof AutomationRunLifecycleSourceSchema>;
export const AutomationRunLifecycleConditionSchema = lazyZodSchema(() => z.enum(['terminal', 'needs_attention']));
export const AutomationRunLifecycleConfigurationSchema = lazyZodSchema(() => z.object({
  source: AutomationRunLifecycleSourceSchema,
  condition: AutomationRunLifecycleConditionSchema,
}).strict());
export const AutomationRunLifecycleTriggerSchema = lazyZodSchema(() => AutomationRunLifecycleConfigurationSchema.extend({
  kind: z.literal('runLifecycle'),
}).strict());
export type AutomationRunLifecycleTrigger = z.infer<typeof AutomationRunLifecycleTriggerSchema>;
export const AutomationRunLifecycleTriggerInputSchema = lazyZodSchema(() => AutomationRunLifecycleTriggerSchema.extend({ enabled: z.boolean() }).strict());
export const AutomationRunLifecycleOccurrenceEvidenceV1Schema = lazyZodSchema(() => AutomationRunLifecycleConfigurationSchema.extend({
  v: z.literal(1), kind: z.literal('runLifecycle'),
  /** Execution terminal's finished timestamp, or FIN's current revision. */
  sourceRevision: z.number().int().nonnegative().safe(),
  occurredAt: AutomationOccurredAtV1Schema,
  /** Exact-machine host provenance for an Execution Run spawned by a Workflow. */
  originRunId: Id.optional(),
}).strict());
export type AutomationRunLifecycleOccurrenceEvidenceV1 = z.infer<typeof AutomationRunLifecycleOccurrenceEvidenceV1Schema>;
export const AutomationExecutionRunLifecycleSourceSchema = AutomationRunLifecycleSourceSchema.options[0];
export const AutomationExecutionRunLifecycleReportRequestSchema = lazyZodSchema(() => z.object({
  machineId: Id, occurrence: AutomationRunLifecycleOccurrenceEvidenceV1Schema,
}).strict());
export const AutomationExecutionRunLifecycleReportResponseSchema = lazyZodSchema(() => z.object({ ok: z.literal(true), consumed: z.boolean() }).strict());
/** Exact sources assigned to the incumbent Machine observer; not a Run-state projection. */
export const AutomationExecutionRunLifecycleSourcesResponseSchema = lazyZodSchema(() => z.object({
  sources: z.array(AutomationExecutionRunLifecycleSourceSchema),
}).strict());
