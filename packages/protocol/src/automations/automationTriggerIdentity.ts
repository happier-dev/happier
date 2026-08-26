import { z } from 'zod';

/** Stable identity of one mutable automatic trigger. */
export const AutomationTriggerIdSchema = z.string().trim().min(1).max(191)
  .brand<'AutomationTriggerId'>();
export type AutomationTriggerId = z.infer<typeof AutomationTriggerIdSchema>;

/** Independent currentness witness for one trigger definition. */
export const AutomationTriggerRevisionSchema = z.number().int().nonnegative().safe();
export type AutomationTriggerRevision = z.infer<typeof AutomationTriggerRevisionSchema>;

export const AutomationTriggerKindSchema = z.enum([
  'schedule',
  'pluginEvent',
  'sessionLifecycle',
]);
export type AutomationTriggerKind = z.infer<typeof AutomationTriggerKindSchema>;
