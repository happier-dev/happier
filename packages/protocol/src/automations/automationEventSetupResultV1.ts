import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod, projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationEventPositiveSafeIntegerV1Schema } from './automationColumnBoundsV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';
import { embedProtocolJsonSchema } from '../plugins/actions/protocolComposableSchema.js';

/**
 * Builds the exact Action result schema bound to one Automation Event source
 * declaration. Manifest ingestion and plugin authors share this owner so the
 * strict declaration-to-declaration equality check cannot drift.
 */
export function createPluginEventAutomationSetupResultV1JsonSchema(
  sourceContractVersion: number,
  sourceConfigSchema: PluginJsonSchemaV2,
): PluginJsonSchemaV2 {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      v: { type: 'integer', const: 1 },
      sourceInstanceId: { type: 'string', minLength: 1, maxLength: 512 },
      sourceContractVersion: { type: 'integer', const: sourceContractVersion },
      sourceConfig: embedProtocolJsonSchema(sourceConfigSchema, ['properties', 'sourceConfig']),
      displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
      observationOnly: embedProtocolJsonSchema(projectZodProtocolSchema(AutomationObservationOnlyIntentV1Schema).jsonSchema,
        ['properties', 'observationOnly']),
    },
    required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
  };
}

/** Non-executable authoring intent shared by declarations, setup results and source projections. */
export const AutomationObservationOnlyIntentV1Schema = lazyZodSchema(() => z.strictObject({ kind: z.literal('observationOnly') }));

export const PluginEventAutomationSetupResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
  observationOnly: z.optional(AutomationObservationOnlyIntentV1Schema),
}));
export type PluginEventAutomationSetupResultV1 = z.infer<
  typeof PluginEventAutomationSetupResultV1Schema
>;
