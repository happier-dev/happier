import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginUiRendererChainBindingV1Schema } from './ui/rendererChainBinding.js';
import { ComposerScopeKindV1Schema } from '../ui/composer.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

export const MAX_PLUGIN_COMPOSER_REGIONS_V1 = 64;

/** A manifest-declared region in or adjacent to the host-owned composer. */
export const PluginComposerRegionContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  placement: z.enum(['beforeComposer', 'afterComposer', 'statusStrip']),
  /** Status-strip truncation priority; defaults to the public badge's prominent emphasis. */
  emphasis: z.optional(z.enum(['quiet', 'prominent'])),
  renderer: PluginUiRendererChainBindingV1Schema,
  scopes: z.optional(z.array(ComposerScopeKindV1Schema).check(z.minLength(1))),
  order: z.optional(z.number()),
}));
export type PluginComposerRegionContributionV1 = z.infer<
  typeof PluginComposerRegionContributionV1Schema
>;
