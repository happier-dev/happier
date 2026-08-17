import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import {
  normalizePredecessorVoiceProviderContributionIdentityV1,
} from '../../voice/providerContributionIdentity.js';

export const CONVERSATION_TURN_ORIGIN_META_FIELD_V1 = 'conversationTurnOriginV1';

const ConversationTurnOriginSourceV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();

/**
 * Generic message provenance for the two interaction channels that share the
 * canonical session transcript. The paired literals prevent unsupported mixed
 * channel/modality states from becoming persistence contracts accidentally.
 */
export const ConversationTurnOriginV1Schema = z.discriminatedUnion('channel', [
  z.object({
    v: z.literal(1),
    channel: z.literal('agent_thread'),
    modality: z.literal('text'),
    source: ConversationTurnOriginSourceV1Schema.optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    channel: z.literal('realtime_conversation'),
    modality: z.literal('voice'),
    source: ConversationTurnOriginSourceV1Schema.optional(),
  }).strict(),
]);

export type ConversationTurnOriginV1 = z.infer<typeof ConversationTurnOriginV1Schema>;

export const AGENT_THREAD_TEXT_CONVERSATION_TURN_ORIGIN_V1 =
  Object.freeze({
    v: 1,
    channel: 'agent_thread',
    modality: 'text',
  } as const satisfies ConversationTurnOriginV1);

export const REALTIME_CONVERSATION_VOICE_TURN_ORIGIN_V1 =
  Object.freeze({
    v: 1,
    channel: 'realtime_conversation',
    modality: 'voice',
  } as const satisfies ConversationTurnOriginV1);

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function normalizeHistoricalVoiceSource(value: unknown): unknown {
  const origin = readRecord(value);
  if (
    !origin
    || origin.channel !== 'realtime_conversation'
    || origin.modality !== 'voice'
  ) {
    return value;
  }
  const source = readRecord(origin.source);
  if (!source) return value;
  const pluginId = source.pluginId;
  const contributionId = source.contributionId;
  if (typeof pluginId !== 'string' || typeof contributionId !== 'string') return value;

  const canonical = normalizePredecessorVoiceProviderContributionIdentityV1({
    pluginId,
    localId: contributionId,
  });
  if (canonical.localId === contributionId) return value;

  return {
    ...origin,
    source: {
      ...source,
      contributionId: canonical.localId,
    },
  };
}

/**
 * Reads the additive provenance field from stored message metadata.
 *
 * Absence is the released legacy Agent/text default. A present but malformed
 * field returns null so context consumers can fail closed instead of silently
 * treating an invalid explicit origin as an ordinary coding row.
 */
export function readConversationTurnOriginV1FromMessageMeta(
  meta: unknown,
): ConversationTurnOriginV1 | null {
  const metaRecord = readRecord(meta);
  const happier = readRecord(metaRecord?.happier);
  if (!happier || !(CONVERSATION_TURN_ORIGIN_META_FIELD_V1 in happier)) {
    return AGENT_THREAD_TEXT_CONVERSATION_TURN_ORIGIN_V1;
  }
  const parsed = ConversationTurnOriginV1Schema.safeParse(
    normalizeHistoricalVoiceSource(
      happier[CONVERSATION_TURN_ORIGIN_META_FIELD_V1],
    ),
  );
  return parsed.success ? parsed.data : null;
}

export function isAgentThreadTextConversationTurnMeta(meta: unknown): boolean {
  const origin = readConversationTurnOriginV1FromMessageMeta(meta);
  return origin?.channel === 'agent_thread' && origin.modality === 'text';
}
