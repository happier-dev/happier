import { z } from 'zod';

import { ExecutionRunIntentSchema } from '../../execution/runs/index.js';
import { PluginDescriptorBaseV1Schema } from './_descriptors.js';

export const PluginExecutionRunProfileContributionV2Schema = PluginDescriptorBaseV1Schema.safeExtend({
  kind: z.literal('executionRun.profile'),
  intent: ExecutionRunIntentSchema,
  displayKey: z.string().trim().min(1),
  actionIds: z.array(z.string().trim().min(1)).default([]),
}).passthrough();
export type PluginExecutionRunProfileContributionV2 = z.infer<typeof PluginExecutionRunProfileContributionV2Schema>;
