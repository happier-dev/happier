import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginIdSchema } from '../../plugins/pluginId.js';
import { VoiceModelPackLocalIdV1Schema } from './contributionV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/** Semantic identity for a public plugin-contributed model pack. */
export const VoiceModelPackIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  packId: VoiceModelPackLocalIdV1Schema,
}));
export type VoiceModelPackIdentityV1 = z.infer<typeof VoiceModelPackIdentityV1Schema>;
