import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
} from '../plugins/actions/protocolComposableSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationIdV1Schema } from './automationIdV1.js';
import {
  AutomationSourceSelectorIdV1ProtocolSchema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import {
  AutomationTriggerIdProtocolSchema,
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionProtocolSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';

/**
 * One canonical strict Action declaration contract. Its executable Zod
 * counterpart retains the incumbent branded identity projections below.
 */
const PluginEventAutomationHistoryGapResetActionInputV1Contract = defineProtocolObject({
  automationId: AutomationIdV1Schema,
  triggerId: AutomationTriggerIdProtocolSchema,
  triggerRevision: AutomationTriggerRevisionProtocolSchema,
  sourceSelectorId: AutomationSourceSelectorIdV1ProtocolSchema,
}, { policy: 'closed' });

/** One canonical strict Action outcome contract. */
const PluginEventAutomationHistoryGapResetActionResultV1Contract = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('baselined') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('noHistoryGap') }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('stale') }, { policy: 'closed' }),
]);

/**
 * Host-filled input for an Event source's exact, current history-gap recovery
 * Action. Provider configuration and checkpoint state intentionally remain
 * outside the Action surface.
 */
export const PluginEventAutomationHistoryGapResetActionInputV1Schema =
  lazyZodSchema(() => z.object({
    automationId: asProtocolZod(AutomationIdV1Schema),
    triggerId: AutomationTriggerIdSchema,
    triggerRevision: AutomationTriggerRevisionSchema,
    sourceSelectorId: AutomationSourceSelectorIdV1Schema,
  }).strict());
export type PluginEventAutomationHistoryGapResetActionInputV1 = z.infer<
  typeof PluginEventAutomationHistoryGapResetActionInputV1Schema
>;

/** A recovery either changed the current gap or observed a safe no-op. */
export const PluginEventAutomationHistoryGapResetActionResultV1Schema =
  asProtocolZod(PluginEventAutomationHistoryGapResetActionResultV1Contract);
export type PluginEventAutomationHistoryGapResetActionResultV1 = ReturnType<
  typeof PluginEventAutomationHistoryGapResetActionResultV1Schema.parse
>;

/**
 * Exact Action declaration schemas. Manifest ingestion compares these through
 * the canonical JSON comparison owner before the cold catalog can bind them.
 */
export const PluginEventAutomationHistoryGapResetActionInputV1JsonSchema =
  PluginEventAutomationHistoryGapResetActionInputV1Contract.jsonSchema;

export const PluginEventAutomationHistoryGapResetActionResultV1JsonSchema =
  PluginEventAutomationHistoryGapResetActionResultV1Contract.jsonSchema;
