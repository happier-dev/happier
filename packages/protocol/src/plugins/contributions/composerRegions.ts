import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginUiRendererChainBindingV1Schema } from './ui/rendererChainBinding.js';
import { ComposerScopeKindV1Schema } from '../ui/composer.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const MAX_PLUGIN_COMPOSER_REGIONS_V1 = 64;

/** A manifest-declared rich region adjacent to the host-owned composer. */
export const PluginComposerRegionContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  placement: z.enum(['beforeComposer', 'afterComposer']),
  renderer: PluginUiRendererChainBindingV1Schema,
  scopes: z.array(ComposerScopeKindV1Schema).min(1).optional(),
  order: z.number().finite().optional(),
}).strict();
export type PluginComposerRegionContributionV1 = z.infer<
  typeof PluginComposerRegionContributionV1Schema
>;
