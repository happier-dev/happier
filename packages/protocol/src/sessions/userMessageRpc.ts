import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1, HappierStructuredInputV1Schema as HappierStructuredInputV1EnvelopeSchema, RawIngressStructuredInputV1Schema, hasAdmittedComposerAttachmentSelectionV1, readAttachmentEnvelopeLocalImagePaths, readHappierStructuredInputV1FromMeta, readIngressComposerAttachmentSelectionV1, sanitizeHappierStructuredInputV1, sanitizeSessionStructuredInputMeta, type HappierStructuredInputV1 as HappierStructuredInputV1Envelope } from '../runtime/input/structuredInputV1.js';
import { ComposerContentHandleV1Schema, type ComposerContentHandleV1 } from '../runtime/input/composerContentV1.js';
import { ComposerInstanceIdSchema, MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 } from '../runtime/input/composerAttachmentV1.js';
import { SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND } from '../runtime/input/imageInputV1.js';
import {
  SessionMediaMessageMetaV1Schema,
  type SessionMediaMessageMetaV1,
} from './messages/sessionMediaV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ComposerRefV1Schema } from '../plugins/ui/composerRef.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { SessionExecutionTargetV1Schema } from './creation/sessionExecutionTargetV1.js';
import { SessionIdSchema } from './idsV1.js';
import { PendingLocalIdSchema } from './pending/pendingLocalId.js';
import { hasSessionInputContentV1 } from './messages/sessionInputAuthoringV1.js';
import { SessionAttachmentsMessageMetaV1Schema } from '../messages/structured/sessionAttachmentsInputV1.js';

type MetadataRecord = Record<string, unknown>;

export {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  HappierStructuredInputV1EnvelopeSchema,
  SESSION_ATTACHMENT_UPLOAD_STRUCTURED_INPUT_PROVENANCE_KIND,
  hasAdmittedComposerAttachmentSelectionV1,
  readAttachmentEnvelopeLocalImagePaths,
  readHappierStructuredInputV1FromMeta,
  readIngressComposerAttachmentSelectionV1,
  sanitizeHappierStructuredInputV1,
};
export type { HappierStructuredInputV1Envelope };

/**
 * The Session send RPC is Message *ingress*, not persistence. Generic sanitization emits the
 * persisted envelope, whose Composer attachments may carry only a durable SessionMedia
 * reference — so on its own it deletes the transfer-owned staged claim a media attachment
 * still carries before the daemon's SessionMedia finalizer has run, and an attachment-only
 * media message then looks blank. The validated ingress arm is therefore carried through
 * intact for that finalizer, which remains the only writer of the persisted form.
 */
export function sanitizeSessionUserMessageSendMeta(
  value: MetadataRecord,
  options: Readonly<{ allowedLocalImagePaths?: ReadonlySet<string>; text?: string }> = {},
): MetadataRecord {
  const sanitized = sanitizeSessionStructuredInputMeta(value, options);
  const ingressComposerAttachments = readIngressComposerAttachmentSelectionV1(value);
  if (!ingressComposerAttachments || ingressComposerAttachments.length === 0) return sanitized;

  const sanitizedEnvelope = sanitized[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1];
  return {
    ...sanitized,
    [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: {
      ...(sanitizedEnvelope && typeof sanitizedEnvelope === 'object' && !Array.isArray(sanitizedEnvelope)
        ? sanitizedEnvelope as MetadataRecord
        : {}),
      v: 1,
      composerAttachments: ingressComposerAttachments,
    },
  };
}

export const SessionUserMessageSendMetaSchema = lazyZodSchema(() => z.pipe(z
  .record(z.string(), z.unknown()), z.transform((value) => sanitizeSessionUserMessageSendMeta(value))));
export type SessionUserMessageSendMeta = z.infer<typeof SessionUserMessageSendMetaSchema>;

export const SessionUserMessageSendRequestSchema = lazyZodSchema(() => z.looseObject({
  text: z.string(),
  localId: z.optional(PendingLocalIdSchema),
  meta: z._default(SessionUserMessageSendMetaSchema, {}),
}).check(z.superRefine((request, context) => {
  // Read the boundary's own preserved ingress arm, not the persisted projection: a staged
  // media attachment is a submitted attachment, and the persisted projection cannot hold one.
  const ingress = RawIngressStructuredInputV1Schema.safeParse(request.meta[HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]);
  const attachmentCount = ingress.success
    ? (ingress.data.composerAttachments?.length ?? 0) + (ingress.data.sessionAttachments?.length ?? 0)
    : 0;
  if (hasSessionInputContentV1({ text: request.text, attachmentCount })) return;
  context.addIssue({
    code: "custom",
    path: ['text'],
    message: 'A blank message requires at least one admitted attachment.',
  });
})));
export type SessionUserMessageSendRequest = z.infer<typeof SessionUserMessageSendRequestSchema>;

/** Each staged attachment may consume its captured source snapshot and its finalization child. */
export const MAX_COMPOSER_STAGED_MEDIA_RELEASE_INTENTS_V1 = 2 * MAX_COMPOSER_ATTACHMENT_INSTANCES_V1;

/** Exact finalizer custody, shared by Pending settlement and the private runner carrier. */
export const ComposerStagedMediaReleaseIntentV1Schema = lazyZodSchema(() => z.strictObject({
  handle: ComposerContentHandleV1Schema,
  executionTarget: SessionExecutionTargetV1Schema,
  owner: asProtocolZod(PluginContributionIdentityV1Schema),
  claimant: z.strictObject({
    composer: asProtocolZod(ComposerRefV1Schema),
    attachmentInstanceId: ComposerInstanceIdSchema,
  }),
}));
export type ComposerStagedMediaReleaseIntentV1 = z.infer<typeof ComposerStagedMediaReleaseIntentV1Schema>;

const ComposerStagedMediaReleaseIntentsV1Schema = lazyZodSchema(() => z.array(
  ComposerStagedMediaReleaseIntentV1Schema,
).check(z.maxLength(MAX_COMPOSER_STAGED_MEDIA_RELEASE_INTENTS_V1)));
const ComposerStagedMediaHandlesV1Schema = lazyZodSchema(() => z.array(
  ComposerContentHandleV1Schema,
).check(z.maxLength(MAX_COMPOSER_STAGED_MEDIA_RELEASE_INTENTS_V1)));

/** Invocation-scoped Pending edit preparation through the canonical Session admission lifecycle. */
export const SessionPendingMessageComposerAdmissionPrepareRequestV1Schema = lazyZodSchema(() => z.strictObject({
  localId: PendingLocalIdSchema,
  text: z.string(),
  structuredInput: RawIngressStructuredInputV1Schema,
  sourceComposerRef: z.optional(asProtocolZod(ComposerRefV1Schema)),
}));
export type SessionPendingMessageComposerAdmissionPrepareRequestV1 = z.infer<
  typeof SessionPendingMessageComposerAdmissionPrepareRequestV1Schema
>;

export const SessionPendingMessageComposerAdmissionPrepareResponseV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({
    ok: z.literal(true),
    text: z.string(),
    structuredInput: HappierStructuredInputV1EnvelopeSchema,
    stagedMediaHandles: ComposerStagedMediaHandlesV1Schema,
    stagedMediaReleaseIntents: z.optional(ComposerStagedMediaReleaseIntentsV1Schema),
    sessionAttachmentMetadata: z.optional(z.strictObject({
      key: z.enum(['happier', 'happierAttachments']),
      envelope: SessionAttachmentsMessageMetaV1Schema,
    })),
    sessionMediaMetadata: z.optional(z.strictObject({
      key: z.enum(['happier', 'happierMedia']),
      envelope: SessionMediaMessageMetaV1Schema,
    })),
    /** Existing staged-media settlement owner cleanup facts for a prepare that never PATCHes. */
    sessionMediaCleanup: z.optional(z.strictObject({
      workingDirectory: z.string().check(z.minLength(1), z.maxLength(32_768)),
      createdWorkspaceRelativePaths: z.array(z.string().check(z.minLength(1), z.maxLength(32_768))).check(z.maxLength(64)),
    })),
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.string().check(z.minLength(1)),
    errorCode: z.string().check(z.minLength(1)),
  }),
]));
export type SessionPendingMessageComposerAdmissionPrepareResponseV1 = z.infer<
  typeof SessionPendingMessageComposerAdmissionPrepareResponseV1Schema
>;

/** The exact post-PATCH fact; the Pending writer, not the UI, owns its structured input. */
export const SessionPendingMessageComposerAdmissionAcceptedRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  structuredInput: HappierStructuredInputV1EnvelopeSchema,
  stagedMediaHandles: ComposerStagedMediaHandlesV1Schema,
  stagedMediaReleaseIntents: z.optional(ComposerStagedMediaReleaseIntentsV1Schema),
  sessionMediaMetadata: z.optional(z.strictObject({
    key: z.enum(['happier', 'happierMedia']),
    envelope: SessionMediaMessageMetaV1Schema,
  })),
}));
export type SessionPendingMessageComposerAdmissionAcceptedRequestV1 = Readonly<{
  sessionId: string;
  localId: z.infer<typeof PendingLocalIdSchema>;
  structuredInput: HappierStructuredInputV1Envelope;
  stagedMediaHandles: readonly ComposerContentHandleV1[];
  stagedMediaReleaseIntents?: readonly ComposerStagedMediaReleaseIntentV1[];
  sessionMediaMetadata?: Readonly<{
    key: 'happier' | 'happierMedia';
    envelope: SessionMediaMessageMetaV1;
  }>;
}>;

/** Narrow abandonment of a pre-PATCH staged-media preparation. */
export const SessionPendingMessageComposerAdmissionAbandonedRequestV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  structuredInput: HappierStructuredInputV1EnvelopeSchema,
  stagedMediaHandles: ComposerStagedMediaHandlesV1Schema,
  stagedMediaReleaseIntents: z.optional(ComposerStagedMediaReleaseIntentsV1Schema),
  sessionMediaCleanup: z.strictObject({
    workingDirectory: z.string().check(z.minLength(1), z.maxLength(32_768)),
    createdWorkspaceRelativePaths: z.array(z.string().check(z.minLength(1), z.maxLength(32_768))).check(z.maxLength(64)),
  }),
}));
export type SessionPendingMessageComposerAdmissionAbandonedRequestV1 = Readonly<{
  sessionId: string;
  localId: z.infer<typeof PendingLocalIdSchema>;
  structuredInput: HappierStructuredInputV1Envelope;
  stagedMediaHandles: readonly ComposerContentHandleV1[];
  stagedMediaReleaseIntents?: readonly ComposerStagedMediaReleaseIntentV1[];
  sessionMediaCleanup: Readonly<{
    workingDirectory: string;
    createdWorkspaceRelativePaths: readonly string[];
  }>;
}>;

const SessionUserMessageSendSuccessResponseSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(true),
}));

const SessionUserMessageSendErrorResponseSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(false),
  error: z.string().check(z.minLength(1)),
  errorCode: z.string().check(z.minLength(1)),
}));

export const SessionUserMessageSendResponseSchema = lazyZodSchema(() => z.union([
  SessionUserMessageSendSuccessResponseSchema,
  SessionUserMessageSendErrorResponseSchema,
]));
export type SessionUserMessageSendResponse = z.infer<typeof SessionUserMessageSendResponseSchema>;
