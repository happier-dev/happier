import { z } from 'zod';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

import { AutomationEventPositiveSafeIntegerV1Schema } from './automationEventDeclarationV1.js';
import {
  AutomationEventSourceConfigV1Schema,
  AutomationEventSourceDisplayLabelV1Schema,
  AutomationEventSourceInstanceIdV1Schema,
} from './automationEventJsonBoundsV1.js';

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
