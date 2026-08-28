import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';
import type { PluginJsonSchemaV2 } from '../plugins/contributions/publicTypes.js';

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
      sourceConfig: sourceConfigSchema,
      displayLabel: { type: 'string', minLength: 1, maxLength: 256 },
    },
    required: ['v', 'sourceInstanceId', 'sourceContractVersion', 'sourceConfig', 'displayLabel'],
  };
}

export const PluginEventAutomationSetupResultV1Schema = z.object({
  v: z.literal(1),
  sourceInstanceId: AutomationEventSourceInstanceIdV1Schema,
  sourceContractVersion: AutomationEventPositiveSafeIntegerV1Schema,
  sourceConfig: asProtocolZod(AutomationEventSourceConfigV1Schema),
  displayLabel: AutomationEventSourceDisplayLabelV1Schema,
}).strict();
export type PluginEventAutomationSetupResultV1 = z.infer<
  typeof PluginEventAutomationSetupResultV1Schema
>;
