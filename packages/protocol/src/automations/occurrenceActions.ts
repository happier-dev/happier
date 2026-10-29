import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AutomationV3RunMutationResponseSchema, AutomationV3RunReplyHandoffRedeliverRequestSchema } from './automationApiV3.js';
import { AUTOMATION_OCCURRENCE_ACTION_IDS, type AutomationOccurrenceActionId } from './occurrenceActionIds.js';
export { AUTOMATION_OCCURRENCE_ACTION_IDS, type AutomationOccurrenceActionId } from './occurrenceActionIds.js';

export const AutomationOccurrenceActionIdSchema = lazyZodSchema(() => z.enum(AUTOMATION_OCCURRENCE_ACTION_IDS));
const run = lazyZodSchema(() => z.strictObject({ runId: z.string().check(z.trim(), z.minLength(1)) }));
const redeliver = lazyZodSchema(() => z.strictObject({ ...run.shape, ...AutomationV3RunReplyHandoffRedeliverRequestSchema.shape }));
export const AutomationOccurrenceInputSchemas = {
  'automation.run.cancel': run,
  'automation.run.reply_handoff.retry': run,
  'automation.run.result.redeliver': redeliver,
} as const;
export const AutomationOccurrenceOutputSchemas = {
  'automation.run.cancel': AutomationV3RunMutationResponseSchema,
  'automation.run.reply_handoff.retry': AutomationV3RunMutationResponseSchema,
  'automation.run.result.redeliver': AutomationV3RunMutationResponseSchema,
} as const;
export type AutomationOccurrenceInput = z.infer<typeof run> | z.infer<typeof redeliver>;

/** Existing V3 routes remain the only mutation writers. Home authority comes from the captured transport. */
export function automationOccurrenceRequest(actionId: AutomationOccurrenceActionId, raw: AutomationOccurrenceInput) {
  const input = AutomationOccurrenceInputSchemas[actionId].parse(raw);
  const operation = actionId === 'automation.run.cancel' ? 'cancel'
    : actionId === 'automation.run.reply_handoff.retry' ? 'retry-reply-handoff' : 'deliver-result-again';
  return { path: `/v3/automations/runs/${encodeURIComponent(input.runId)}/${operation}`,
    body: actionId === 'automation.run.result.redeliver'
      ? AutomationV3RunReplyHandoffRedeliverRequestSchema.parse({ expectedRevision: 'expectedRevision' in input ? input.expectedRevision : undefined }) : undefined };
}
