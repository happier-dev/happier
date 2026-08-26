import { z } from 'zod';

import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import {
  AutomationOccurrenceKeyV1Schema,
  AutomationOriginOccurredAtV1Schema,
  AutomationSourceSelectorIdV1Schema,
} from './automationOccurrenceV1.js';
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';

export {
  AutomationTriggerIdSchema,
  AutomationTriggerKindSchema,
  AutomationTriggerRevisionSchema,
  type AutomationTriggerId,
  type AutomationTriggerKind,
  type AutomationTriggerRevision,
} from './automationTriggerIdentity.js';

const IDENTIFIER_SCHEMA = z.string().trim().min(1).max(191);

const AutomationScheduleRunCauseSchema = z.object({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('schedule'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  evidence: z.object({
    scheduledFor: AutomationOriginOccurredAtV1Schema,
  }).strict(),
}).strict();

const AutomationPluginEventRunCauseSchema = z.object({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('pluginEvent'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  evidence: z.object({
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  }).strict(),
}).strict();

const AutomationSessionLifecycleRunCauseSchema = z.object({
  kind: z.literal('trigger'),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  triggerKind: z.literal('sessionLifecycle'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
  evidence: z.object({
    event: z.literal('parentTurnCompleted'),
    sourceSessionId: IDENTIFIER_SCHEMA,
    sourceTurnId: IDENTIFIER_SCHEMA,
  }).strict(),
}).strict();

const AutomationManualRunCauseSchema = z.object({
  kind: z.literal('manual'),
  invokedAt: AutomationOriginOccurredAtV1Schema,
}).strict();

const AutomationConversationRunCauseSchema = z.object({
  kind: z.literal('conversation'),
  occurrenceKey: AutomationOccurrenceKeyV1Schema,
  occurredAt: AutomationOriginOccurredAtV1Schema,
}).strict();

/**
 * Immutable, bounded Run provenance. This is the sole current cause owner;
 * private payload bytes remain in the existing trigger-evidence envelope.
 */
export const AutomationRunCauseSchema = asProtocolZod(z.union([
  AutomationScheduleRunCauseSchema,
  AutomationPluginEventRunCauseSchema,
  AutomationSessionLifecycleRunCauseSchema,
  AutomationManualRunCauseSchema,
  AutomationConversationRunCauseSchema,
]));
export type AutomationRunCause = z.infer<typeof AutomationRunCauseSchema>;
