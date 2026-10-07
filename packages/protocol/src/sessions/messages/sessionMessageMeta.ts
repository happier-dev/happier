import { z } from 'zod';

import { createSentFromSchema } from '../../sentFrom.js';
import { createSessionPermissionModeSchema } from '../metadata/sessionPermissionModes.js';
import {
  SESSION_MEDIA_MESSAGE_META_KIND_V1,
  createSessionMediaMessageMetaV1Schema,
} from './sessionMediaV1.js';
import { HappierMetaEnvelopeSchema } from '../../messages/structured/HappierMetaEnvelope.js';
import { BrowserContextMessageMetaV1Schema } from '../../browser/context/v1.js';
import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY,
  HAPPIER_SKILL_MENTIONS_METADATA_KEY,
  HappierStructuredInputV1Schema,
} from '../../runtime/input/structuredInputV1.js';
import { VendorPluginMentionV1Schema } from '../../runtime/input/vendorPluginMentionV1.js';
import { SkillMentionV1Schema } from '../../runtime/input/skillMentionV1.js';
import { ExecutionRunInputTurnV1Schema } from '../../execution/runs/responseSchemas.js';
import {
  SESSION_INPUT_AUTHORITY_META_KEY,
  SESSION_INPUT_REQUEST_META_KEY,
  SESSION_MESSAGE_PROVENANCE_META_KEY,
  SessionInputAuthoritySchema,
  SessionInputRequestSchema,
  SessionMessageProvenanceSchema,
} from './sessionInputAdmission.js';

export type SessionUserMessageDeliveryIntentV1 =
  | 'default'
  | 'explicit_pending'
  | 'explicit_immediate'
  | 'interrupt';

const SESSION_USER_MESSAGE_DELIVERY_INTENTS = new Set<SessionUserMessageDeliveryIntentV1>([
  'default',
  'explicit_pending',
  'explicit_immediate',
  'interrupt',
]);

/** Optional segment details are best-effort; only the version and kind identify a segment. */
export const SessionMessageStreamSegmentV1Schema = z.object({
  v: z.literal(1),
  segmentKind: z.enum(['assistant', 'thinking']),
  segmentLocalId: z.string().min(1).nullish().catch(undefined),
  segmentState: z.enum(['streaming', 'complete', 'interrupted']).nullish().catch(undefined),
  startedAtMs: z.number().nullish().catch(undefined),
  updatedAtMs: z.number().nullish().catch(undefined),
  interruptedReason: z.string().optional().catch(undefined),
}).strict();

export const SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY = 'happierDeliveryIntentV1';
export const SESSION_TOOL_ANSWER_DELIVERY_KIND = 'tool-answer-delivery.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSessionToolAnswerDeliveryMeta(meta: unknown): boolean {
  if (!isRecord(meta)) return false;
  const happier = meta.happier;
  return isRecord(happier) && happier.kind === SESSION_TOOL_ANSWER_DELIVERY_KIND;
}

export function readSessionUserMessageDeliveryIntentMeta(
  meta: unknown,
): SessionUserMessageDeliveryIntentV1 | null {
  if (!isRecord(meta)) return null;
  const value = meta[SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY];
  return typeof value === 'string' && SESSION_USER_MESSAGE_DELIVERY_INTENTS.has(value as SessionUserMessageDeliveryIntentV1)
    ? value as SessionUserMessageDeliveryIntentV1
    : null;
}

export function withSessionUserMessageDeliveryIntentMeta(
  meta: Record<string, unknown> | null | undefined,
  intent: SessionUserMessageDeliveryIntentV1,
): Record<string, unknown> & { happierDeliveryIntentV1: SessionUserMessageDeliveryIntentV1 } {
  return {
    ...(meta ?? {}),
    [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: intent,
  };
}

/**
 * Message-level metadata (stored in encrypted message bodies).
 *
 * Stored readers derive a known-field projection with createStoredReadSchema;
 * additive domain fields are ignored rather than copied into application state.
 * Source-owned opaque payloads remain intact for their codecs to interpret.
 */
export function createSessionMessageMetaSchema(zod: typeof z) {
  const sessionMediaMessageMetaV1Schema = createSessionMediaMessageMetaV1Schema(zod);
  const happierEnvelopeSchema = zod.union([
    sessionMediaMessageMetaV1Schema.safeExtend({
      resources: HappierMetaEnvelopeSchema.shape.resources,
      conversationTurnOriginV1: HappierMetaEnvelopeSchema.shape.conversationTurnOriginV1,
    }),
    HappierMetaEnvelopeSchema.passthrough().refine((value) => value.kind !== SESSION_MEDIA_MESSAGE_META_KIND_V1),
  ]);
  return zod
    .object({
      sentFrom: createSentFromSchema(zod).optional(),
      /**
       * High-level origin of the message, used by agents to avoid treating
       * self-sent client traffic as a "new prompt" event.
       *
       * Forward-compatible: unknown strings are allowed.
       */
      source: zod.union([zod.enum(['ui', 'cli']), zod.string()]).optional(),
      permissionMode: createSessionPermissionModeSchema(zod).optional(),
      model: zod.string().nullable().optional(),
      fallbackModel: zod.string().nullable().optional(),
      customSystemPrompt: zod.string().nullable().optional(),
      appendSystemPrompt: zod.string().nullable().optional(),
      allowedTools: zod.array(zod.string()).nullable().optional(),
      disallowedTools: zod.array(zod.string()).nullable().optional(),
      displayText: zod.string().optional(),
      [SESSION_MESSAGE_PROVENANCE_META_KEY]: SessionMessageProvenanceSchema.optional(),
      [SESSION_INPUT_REQUEST_META_KEY]: SessionInputRequestSchema.optional(),
      [SESSION_INPUT_AUTHORITY_META_KEY]: SessionInputAuthoritySchema.optional(),
      happier: happierEnvelopeSchema.optional(),
      happierMedia: sessionMediaMessageMetaV1Schema.optional(),
      [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: zod.unknown().optional(),
      happierStreamSegmentV1: SessionMessageStreamSegmentV1Schema.optional().catch(undefined),
      happierStreamKey: zod.unknown().optional(),
      happierSidechainStreamKey: zod.unknown().optional(),
      happierSyntheticNoResponseV1: zod.unknown().optional(),
      happierUnsupportedContentV1: zod.unknown().optional(),
      // These optional source projections must not make otherwise readable transcript text unparsed.
      // Their input admission remains at the structured-input/browser/Run owners.
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: HappierStructuredInputV1Schema.optional().catch(undefined),
      [HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY]: zod.array(VendorPluginMentionV1Schema).optional().catch(undefined),
      [HAPPIER_SKILL_MENTIONS_METADATA_KEY]: zod.array(SkillMentionV1Schema).optional().catch(undefined),
      happierBrowserContext: BrowserContextMessageMetaV1Schema.optional().catch(undefined),
      happierExecutionRunInputTurnV1: ExecutionRunInputTurnV1Schema.optional().catch(undefined),
      // Legacy attachment/native identity carriers are decoded by their existing source owners.
      happierAttachments: zod.unknown().optional(),
      opencodeMessageId: zod.unknown().optional(),
      opencodeRemoteSessionId: zod.unknown().optional(),
      remoteSessionId: zod.unknown().optional(),
      providerSessionId: zod.unknown().optional(),
      sidechainId: zod.unknown().optional(),
      sidechain_id: zod.unknown().optional(),
      isSidechain: zod.unknown().optional(),
      is_sidechain: zod.unknown().optional(),
      isThinking: zod.unknown().optional(),
      runtimeEventKind: zod.unknown().optional(),
      runtimeIssueCode: zod.unknown().optional(),
    })
    .passthrough()
    .superRefine((value, ctx) => {
      if (
        value[SESSION_INPUT_REQUEST_META_KEY] !== undefined
        && value[SESSION_INPUT_AUTHORITY_META_KEY] !== undefined
      ) {
        ctx.addIssue({
          code: 'custom',
          path: [SESSION_INPUT_AUTHORITY_META_KEY],
          message: 'Input request and admitted authority metadata cannot coexist',
        });
      }
    });
}

export const SessionMessageMetaSchema = createSessionMessageMetaSchema(z);
export type SessionMessageMeta = z.infer<typeof SessionMessageMetaSchema>;
