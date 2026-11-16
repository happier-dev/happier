import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { ThemeProfileV1Schema } from '../../account/settings/themeProfiles.js';

/** Data-only theme declaration; MODEL owns portable theme admission and rendering. */
export const PluginThemeContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    theme: ThemeProfileV1Schema,
}));
export type PluginThemeContributionV1 = z.infer<typeof PluginThemeContributionV1Schema>;
