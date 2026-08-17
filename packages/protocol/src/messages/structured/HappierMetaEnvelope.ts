import { z } from 'zod';
import { PluginContributionReferenceV2Schema } from '../../plugins/contributions/publicTypes.js';
import { ConversationTurnOriginV1Schema } from './conversationTurnOriginV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/**
 * Message-level structured meta payload envelope stored under `message.meta.happier`.
 *
 * UI renderers must Zod-parse `payload` by kind and never deep-merge untrusted objects.
 */
export const HappierMetaEnvelopeSchema = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
  resources: z.array(asProtocolZod(PluginContributionReferenceV2Schema)).optional(),
  conversationTurnOriginV1: ConversationTurnOriginV1Schema.optional(),
});

export type HappierMetaEnvelope = z.infer<typeof HappierMetaEnvelopeSchema>;
