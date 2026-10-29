import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createClaudePredecessorMessageMetaShape } from '../../agents/claude/predecessorMessageMeta.js';

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
import { SessionFollowRuleSourceEvidenceV1Schema } from '../follow/sessionFollowRuleOccurrenceV1.js';
import { SessionForkVisualOriginV1Schema } from '../board/forkVisualCopies.js';
import { SessionRuntimeIssueSourceV1Schema, SessionRuntimeIssueV1Schema } from '../control/runtimeIssueV1.js';
import { SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY } from '../../providers/selection/v1.js';
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

/**
 * The saved walkthrough revision and stops a question to its generating Run was asked about. Host-stamped by the
 * walkthrough discussion owner beside the question's display text, so the walkthrough can project the exchange
 * under its stop from the transcript itself.
 */
export const SCM_WALKTHROUGH_QUESTION_META_KEY_V1 = 'scmWalkthroughQuestionV1' as const;
export const ScmWalkthroughQuestionMetaV1Schema = lazyZodSchema(() => z.strictObject({
  resultId: z.string().check(z.minLength(1)),
  revision: z.number().check(z.int(), z.nonnegative()),
  stopIds: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
}));
export type ScmWalkthroughQuestionMetaV1 = z.infer<typeof ScmWalkthroughQuestionMetaV1Schema>;

/** Optional segment details are best-effort; only the version and kind identify a segment. */
export const SessionMessageStreamSegmentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  segmentKind: z.enum(['assistant', 'thinking']),
  segmentLocalId: z.catch(z.nullish(z.string().check(z.minLength(1))), undefined),
  segmentState: z.catch(z.nullish(z.enum(['streaming', 'complete', 'interrupted'])), undefined),
  startedAtMs: z.catch(z.nullish(z.number()), undefined),
  updatedAtMs: z.catch(z.nullish(z.number()), undefined),
  interruptedReason: z.catch(z.optional(z.string()), undefined),
  sourceMessageId: z.optional(z.string().check(z.refine((value) => value.trim().length > 0))),
}));

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
    z.safeExtend(sessionMediaMessageMetaV1Schema, {
      resources: HappierMetaEnvelopeSchema.shape.resources,
      conversationTurnOriginV1: HappierMetaEnvelopeSchema.shape.conversationTurnOriginV1,
    }),
    lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.unknown() }) as z.ZodMiniObject<T['shape'], z.core.$loose>)(HappierMetaEnvelopeSchema).check(z.refine((value) => value.kind !== SESSION_MEDIA_MESSAGE_META_KIND_V1))),
  ]);
  return zod.looseObject({
      // Source-owned facts, sealed with this original record; never delivery or Account-rule authority.
      happierFollowRuleEvidenceV1: zod.optional(SessionFollowRuleSourceEvidenceV1Schema),
      ...createClaudePredecessorMessageMetaShape(zod),
      sentFrom: z.optional(createSentFromSchema(zod)),
      /**
       * High-level origin of the message, used by agents to avoid treating
       * self-sent client traffic as a "new prompt" event.
       *
       * Forward-compatible: unknown strings are allowed.
       */
      source: zod.optional(zod.union([zod.enum(['ui', 'cli']), zod.string()])),
      permissionMode: z.optional(createSessionPermissionModeSchema(zod)),
      model: zod.optional(zod.nullable(zod.string())),
      // Preserve invalid presence as well as valid intent: the model-selection
      // owner must refuse it instead of seeing absence and using legacy model.
      [SESSION_MESSAGE_MODEL_SELECTION_V1_META_KEY]: zod.optional(zod.unknown()),
      fallbackModel: zod.optional(zod.nullable(zod.string())),
      customSystemPrompt: zod.optional(zod.nullable(zod.string())),
      appendSystemPrompt: zod.optional(zod.nullable(zod.string())),
      allowedTools: zod.optional(zod.nullable(zod.array(zod.string()))),
      disallowedTools: zod.optional(zod.nullable(zod.array(zod.string()))),
      displayText: zod.optional(zod.string()),
      forkVisualOriginV1: z.catch(z.optional(SessionForkVisualOriginV1Schema), undefined),
      [SESSION_MESSAGE_PROVENANCE_META_KEY]: z.optional(SessionMessageProvenanceSchema),
      [SESSION_INPUT_REQUEST_META_KEY]: z.optional(SessionInputRequestSchema),
      [SESSION_INPUT_AUTHORITY_META_KEY]: z.optional(SessionInputAuthoritySchema),
      happier: zod.optional(happierEnvelopeSchema),
      happierMedia: z.optional(sessionMediaMessageMetaV1Schema),
      [SESSION_USER_MESSAGE_DELIVERY_INTENT_META_KEY]: zod.optional(zod.unknown()),
      happierStreamSegmentV1: z.catch(z.optional(SessionMessageStreamSegmentV1Schema), undefined),
      happierStreamKey: zod.optional(zod.unknown()),
      happierSidechainStreamKey: zod.optional(zod.unknown()),
      happierSyntheticNoResponseV1: zod.optional(zod.unknown()),
      happierUnsupportedContentV1: zod.optional(zod.unknown()),
      // These optional source projections must not make otherwise readable transcript text unparsed.
      // Their input admission remains at the structured-input/browser/Run owners.
      [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: z.catch(z.optional(HappierStructuredInputV1Schema), undefined),
      [HAPPIER_VENDOR_PLUGIN_MENTIONS_METADATA_KEY]: zod.catch(zod.optional(zod.array(VendorPluginMentionV1Schema)), undefined),
      [HAPPIER_SKILL_MENTIONS_METADATA_KEY]: zod.catch(zod.optional(zod.array(SkillMentionV1Schema)), undefined),
      happierBrowserContext: z.catch(z.optional(BrowserContextMessageMetaV1Schema), undefined),
      happierExecutionRunInputTurnV1: z.catch(z.optional(ExecutionRunInputTurnV1Schema), undefined),
      // A saved SCM result's publication or refusal beside its `scm_diff_summary.v1` envelope; the receipt reader validates it.
      scmResultUpdate: zod.optional(zod.unknown()),
      [SCM_WALKTHROUGH_QUESTION_META_KEY_V1]: z.catch(z.optional(ScmWalkthroughQuestionMetaV1Schema), undefined),
      // Legacy attachment/native identity carriers are decoded by their existing source owners.
      happierAttachments: zod.optional(zod.unknown()),
      opencodeMessageId: zod.optional(zod.unknown()),
      opencodeRemoteSessionId: zod.optional(zod.unknown()),
      remoteSessionId: zod.optional(zod.unknown()),
      providerSessionId: zod.optional(zod.unknown()),
      sidechainId: zod.optional(zod.unknown()),
      sidechain_id: zod.optional(zod.unknown()),
      isSidechain: zod.optional(zod.unknown()),
      is_sidechain: zod.optional(zod.unknown()),
      isThinking: zod.optional(zod.unknown()),
      runtimeEventKind: zod.optional(zod.unknown()),
      runtimeIssueCode: zod.optional(zod.unknown()),
      // Display-only host failure evidence travels with the readable transcript,
      // including for collaborators without the owner's Session metadata.
      runtimeIssueSource: zod.catch(zod.optional(SessionRuntimeIssueSourceV1Schema), undefined),
      runtimeIssueV1: zod.catch(zod.optional(SessionRuntimeIssueV1Schema), undefined),
    }).check(zod.superRefine((value, ctx) => {
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
    }));
}

export const SessionMessageMetaSchema = lazyZodSchema(() => createSessionMessageMetaSchema(z));
export type SessionMessageMeta = z.infer<typeof SessionMessageMetaSchema>;
