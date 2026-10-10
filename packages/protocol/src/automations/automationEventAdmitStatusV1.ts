import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const AutomationEventRefreshDefinitionStatusV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('refreshDefinition'),
  reason: z.enum(['definitionStale', 'observationTargetChanged']),
}).strict());

export const AutomationEventBlockedStatusV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('blocked'),
  reason: z.enum(['capacity', 'temporarilyUnavailable', 'occurrenceConflict', 'noEnabledAssignment']),
}).strict());

/**
 * The canonical unresolved Event-admission status. Webhook dead-letter
 * diagnostics retain this exact status without the live result's
 * `checkpointSafe` member; they must not copy its reason union.
 */
export const AutomationEventAdmitUnresolvedStatusV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  AutomationEventRefreshDefinitionStatusV1Schema,
  AutomationEventBlockedStatusV1Schema,
]));

export type AutomationEventAdmitUnresolvedStatusV1 = z.infer<
  typeof AutomationEventAdmitUnresolvedStatusV1Schema
>;
