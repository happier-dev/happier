import { z } from 'zod';

import { PluginIdSchema } from '../../plugins/pluginId.js';
import { VoiceModelPackLocalIdV1Schema } from './contributionV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/** Semantic identity for a public plugin-contributed model pack. */
export const VoiceModelPackIdentityV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  packId: VoiceModelPackLocalIdV1Schema,
}).strict();
export type VoiceModelPackIdentityV1 = z.infer<typeof VoiceModelPackIdentityV1Schema>;
