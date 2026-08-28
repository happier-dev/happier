import { z } from 'zod';

import { AutomationHostIdentifierV1JsonSchema, AutomationIdV1Schema } from './automationIdV1.js';
import {
  AutomationSourceSelectorIdV1JsonSchema,
  AutomationSourceSelectorIdV1Schema,
} from './automationEventDeclarationV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";
import {
  AutomationTriggerIdSchema,
  AutomationTriggerRevisionSchema,
} from './automationTriggerIdentity.js';

/**
 * Host-filled input for an Event source's exact, current history-gap recovery
 * Action. Provider configuration and checkpoint state intentionally remain
 * outside the Action surface.
 */
export const PluginEventAutomationHistoryGapResetActionInputV1Schema = z.object({
  automationId: asProtocolZod(AutomationIdV1Schema),
  triggerId: AutomationTriggerIdSchema,
  triggerRevision: AutomationTriggerRevisionSchema,
  sourceSelectorId: AutomationSourceSelectorIdV1Schema,
}).strict();
export type PluginEventAutomationHistoryGapResetActionInputV1 = z.infer<
  typeof PluginEventAutomationHistoryGapResetActionInputV1Schema
>;

/** A recovery either changed the current gap or observed a safe no-op. */
export const PluginEventAutomationHistoryGapResetActionResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('baselined') }).strict(),
  z.object({ kind: z.literal('noHistoryGap') }).strict(),
  z.object({ kind: z.literal('stale') }).strict(),
]);
export type PluginEventAutomationHistoryGapResetActionResultV1 = z.infer<
  typeof PluginEventAutomationHistoryGapResetActionResultV1Schema
>;

/**
 * Exact Action declaration schemas. Manifest ingestion compares these through
 * the canonical JSON comparison owner before the cold catalog can bind them.
 */
export const PluginEventAutomationHistoryGapResetActionInputV1JsonSchema: PluginJsonSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    automationId: AutomationHostIdentifierV1JsonSchema,
    triggerId: AutomationHostIdentifierV1JsonSchema,
    triggerRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sourceSelectorId: AutomationSourceSelectorIdV1JsonSchema,
  },
  required: ['automationId', 'triggerId', 'triggerRevision', 'sourceSelectorId'],
};

export const PluginEventAutomationHistoryGapResetActionResultV1JsonSchema: PluginJsonSchemaV2 = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'baselined' } },
      required: ['kind'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'noHistoryGap' } },
      required: ['kind'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string', const: 'stale' } },
      required: ['kind'],
    },
  ],
};
