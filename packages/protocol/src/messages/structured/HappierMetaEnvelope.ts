import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { PluginContributionReferenceV2Schema } from '../../plugins/contributions/publicTypes.js';
import { ConversationTurnOriginV1Schema } from './conversationTurnOriginV1.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

/**
 * Message-level structured meta payload envelope stored under `message.meta.happier`.
 *
 * UI renderers must Zod-parse `payload` by kind and never deep-merge untrusted objects.
 */
export const HappierMetaEnvelopeSchema = lazyZodSchema(() => z.object({
  kind: z.string().check(z.minLength(1)),
  payload: z.optional(z.unknown()),
  resources: z.optional(z.array(asProtocolZod(PluginContributionReferenceV2Schema))),
  conversationTurnOriginV1: z.optional(ConversationTurnOriginV1Schema),
}));

export type HappierMetaEnvelope = z.infer<typeof HappierMetaEnvelopeSchema>;
