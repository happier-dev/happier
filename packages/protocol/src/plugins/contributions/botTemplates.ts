import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { isPortableRelativePath } from '../../filesystem/portablePathSegment.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';

/** Cold pointer to a packaged JSON BotTemplateReleaseV1; BT2 owns its contents. */
export const PluginBotTemplateContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  path: z.string().check(z.refine(value => isPortableRelativePath(value.startsWith('./') ? value.slice(2) : value),
    'Bot templates must use confined portable package-relative paths')),
}));

export type PluginBotTemplateContributionV1 = z.infer<typeof PluginBotTemplateContributionV1Schema>;
