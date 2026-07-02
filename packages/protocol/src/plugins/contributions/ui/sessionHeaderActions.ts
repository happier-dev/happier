import { z } from 'zod';

import { PluginUiActionDescriptorV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginUiPredicateV1Schema } from './predicates.js';
import { PluginUiBadgeDescriptorV1Schema, PluginUiDisplayV1Schema } from './tokens.js';

export const PluginSessionHeaderActionPlacementV1Schema = z.object({
  area: z.enum(['primary', 'secondary', 'overflow']).default('secondary'),
  overflow: z.enum(['auto', 'always', 'never']).default('auto'),
}).strict();
export type PluginSessionHeaderActionPlacementV1 = z.infer<typeof PluginSessionHeaderActionPlacementV1Schema>;

export const PluginSessionHeaderActionDescriptorV1Schema = z.object({
  id: z.string().trim().min(1),
  action: PluginUiActionDescriptorV1Schema,
  display: PluginUiDisplayV1Schema,
  placement: PluginSessionHeaderActionPlacementV1Schema,
  visibility: PluginUiPredicateV1Schema.optional(),
  enabled: PluginUiPredicateV1Schema.optional(),
  badge: PluginUiBadgeDescriptorV1Schema.optional(),
  order: z.number().int().optional(),
  compatibility: PluginUiCompatibilityV1Schema.optional(),
}).strict();
export type PluginSessionHeaderActionDescriptorV1 = z.infer<typeof PluginSessionHeaderActionDescriptorV1Schema>;
