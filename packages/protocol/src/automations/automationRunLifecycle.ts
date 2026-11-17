import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { AutomationOccurredAtV1Schema } from './automationOccurredAtV1.js';
import { ExecutionRunOutputObservationSchema } from '../reviews/reviewNarration.js';

const Id = z.string().check(z.trim(), z.minLength(1), z.maxLength(191));
/** Public routing facts; source lifecycle and access remain with the Run owner. */
export const AutomationRunLifecycleSourceSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('execution_run'), machineId: Id, runId: Id, sessionId: z.optional(Id),
    observation: z.optional(ExecutionRunOutputObservationSchema),
  }),
  z.strictObject({ kind: z.literal('workflow_run'), runId: Id }),
]));
export type AutomationRunLifecycleSource = z.infer<typeof AutomationRunLifecycleSourceSchema>;
export const AutomationRunLifecycleConditionSchema = lazyZodSchema(() => z.enum(['terminal', 'needs_attention']));
export const AutomationRunLifecycleConfigurationSchema = lazyZodSchema(() => z.strictObject({
  source: AutomationRunLifecycleSourceSchema,
  condition: AutomationRunLifecycleConditionSchema,
}));
export const AutomationRunLifecycleTriggerSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationRunLifecycleConfigurationSchema, {
  kind: z.literal('runLifecycle'),
})));
export type AutomationRunLifecycleTrigger = z.infer<typeof AutomationRunLifecycleTriggerSchema>;
export const AutomationRunLifecycleTriggerInputSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationRunLifecycleTriggerSchema, { enabled: z.boolean() })));
export const AutomationRunLifecycleOccurrenceEvidenceV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(AutomationRunLifecycleConfigurationSchema, {
  v: z.literal(1), kind: z.literal('runLifecycle'),
  /** Execution terminal's finished timestamp, saved output revision, or FIN's current revision. */
  sourceRevision: z.number().check(z.int(), z.nonnegative(), z.int()),
  occurredAt: AutomationOccurredAtV1Schema,
  /** Exact-machine host provenance for an Execution Run spawned by a Workflow. */
  originRunId: z.optional(Id),
})));
export type AutomationRunLifecycleOccurrenceEvidenceV1 = z.infer<typeof AutomationRunLifecycleOccurrenceEvidenceV1Schema>;
export const AutomationExecutionRunLifecycleSourceSchema = lazyZodSchema(() => AutomationRunLifecycleSourceSchema._zod.def.options[0]);
export const AutomationExecutionRunLifecycleReportRequestSchema = lazyZodSchema(() => z.strictObject({
  machineId: Id, occurrence: AutomationRunLifecycleOccurrenceEvidenceV1Schema,
}));
export const AutomationExecutionRunLifecycleReportResponseSchema = lazyZodSchema(() => z.strictObject({ ok: z.literal(true), consumed: z.boolean() }));
/** Exact sources assigned to the incumbent Machine observer; not a Run-state projection. */
export const AutomationExecutionRunLifecycleSourcesResponseSchema = lazyZodSchema(() => z.strictObject({
  sources: z.array(AutomationExecutionRunLifecycleSourceSchema),
}));
