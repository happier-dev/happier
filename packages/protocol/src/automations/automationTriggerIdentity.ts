import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  defineProtocolNumber,
  defineProtocolString,
} from '../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

/** Stable identity of one mutable automatic trigger. */
export const AutomationTriggerIdProtocolSchema = defineProtocolString({
  minLength: 1,
  maxLength: 191,
  pattern: '^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])',
});
export const AutomationTriggerIdSchema = asProtocolZod(AutomationTriggerIdProtocolSchema)
  .brand<'AutomationTriggerId'>();
export type AutomationTriggerId = z.infer<typeof AutomationTriggerIdSchema>;

/** Independent currentness witness for one trigger definition. */
export const AutomationTriggerRevisionProtocolSchema = defineProtocolNumber({
  integer: true,
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const AutomationTriggerRevisionSchema = asProtocolZod(
  AutomationTriggerRevisionProtocolSchema,
);
export type AutomationTriggerRevision = z.infer<typeof AutomationTriggerRevisionSchema>;

export const AutomationTriggerKindSchema = lazyZodSchema(() => z.enum([
  'schedule',
  'pluginEvent',
  'sessionLifecycle',
  'runLifecycle',
  'prComment',
  'ciFailed',
]));
export type AutomationTriggerKind = z.infer<typeof AutomationTriggerKindSchema>;
