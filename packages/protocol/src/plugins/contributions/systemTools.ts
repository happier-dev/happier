import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginJsonValueV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const PluginSystemToolContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  executableNames: z.array(z.string().trim().min(1)).min(1),
  allowedArguments: z.array(z.string()).optional(),
  platforms: z.array(z.enum(['macos', 'linux', 'windows'])).optional(),
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict();
export type PluginSystemToolContributionV1 = z.infer<typeof PluginSystemToolContributionV1Schema>;
