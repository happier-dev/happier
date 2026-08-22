import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";
import { defineProtocolString } from '../../plugins/actions/protocolComposableSchema.js';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import {
  buildQualifiedPluginContributionKey,
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../../plugins/contributions/publicTypes.js';
import { PluginUiIconTokenV1Schema, PluginUiToneV1Schema } from '../../plugins/contributions/ui/tokens.js';
import { MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 } from '../../plugins/interactions/transientV1.js';
import {
  ComposerInstanceIdProtocolSchema,
  MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1,
} from './composerInstanceId.js';
import { MENTION_BOUNDS } from './mentionRefV1.js';
import {
  ComposerSessionMediaContentV1Schema,
  ComposerStagedMediaContentV1Schema,
} from './composerContentV1.js';

const textEncoder = new TextEncoder();

/** Type-only public projection; attachment schemas keep their plain JSON runtime values. */
type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export const MAX_COMPOSER_ATTACHMENT_INSTANCES_V1 = MENTION_BOUNDS.maxPerMessage;
export const MAX_COMPOSER_ATTACHMENT_KEY_CODE_POINTS_V1 = MENTION_BOUNDS.maxRefChars;
export const MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1 = MENTION_BOUNDS.maxLabelChars;
export const MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1 = 512;
export const MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1 = 16 * 1024;
export const MAX_COMPOSER_ATTACHMENT_RECORD_JSON_BYTES_V1 = MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1;

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedText(maxCodePoints: number, message: string): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (value !== value.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Composer attachment text must not have surrounding whitespace.',
      });
    }
    if (codePointLength(value) > maxCodePoints) {
      context.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
}

function canonicalJsonByteLength(value: unknown): number {
  return textEncoder.encode(createCanonicalJsonSigningInput(value)).byteLength;
}

function rejectOversizedCanonicalJson(
  value: unknown,
  context: z.RefinementCtx,
  maxBytes: number,
  label: string,
): void {
  if (canonicalJsonByteLength(value) > maxBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${label} must be at most ${maxBytes} canonical JSON bytes.`,
    });
  }
}

/**
 * The opaque composer instance identity keeps one grammar owner, now in its own
 * leaf so the browser-safe composer-scope projection can embed it without
 * reaching this module's attachment/media/mention graph.
 */
export {
  ComposerInstanceIdProtocolSchema,
  MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1,
} from './composerInstanceId.js';

/** Host-created opaque identity for one attachment instance in one composer. */
export const ComposerInstanceIdSchema = z.string()
  .min(1)
  .max(MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1)
  .refine((value) => ComposerInstanceIdProtocolSchema.safeParse(value).success, {
    message: 'Composer instance ids must not have surrounding whitespace.',
  });
export type ComposerInstanceId = z.infer<typeof ComposerInstanceIdSchema>;
export const ComposerAttachmentInstanceIdV1Schema = ComposerInstanceIdSchema;
export type ComposerAttachmentInstanceIdV1 = ComposerInstanceId;

/** The one semantic attachment-upsert identity: exact definition + domain key. */
export function buildComposerAttachmentDedupeKeyV1(
  identity: PluginContributionIdentityV1,
  key: ComposerAttachmentKeyV1,
): string {
  return `plugin:${buildQualifiedPluginContributionKey(identity)}:${key}`;
}

export const ComposerAttachmentKeyV1Schema = boundedText(
  MAX_COMPOSER_ATTACHMENT_KEY_CODE_POINTS_V1,
  `Composer attachment keys must be at most ${MAX_COMPOSER_ATTACHMENT_KEY_CODE_POINTS_V1} code points.`,
);
export type ComposerAttachmentKeyV1 = z.infer<typeof ComposerAttachmentKeyV1Schema>;

export const ComposerAttachmentAuthorPresentationV1Schema = z.object({
  label: boundedText(
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
    `Composer attachment labels must be at most ${MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1} code points.`,
  ),
  description: boundedText(
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
    `Composer attachment descriptions must be at most ${MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1} code points.`,
  ).optional(),
  icon: PluginUiIconTokenV1Schema.optional(),
  tone: PluginUiToneV1Schema.exclude(['accent']).optional(),
}).strict();
export type ComposerAttachmentAuthorPresentationV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAuthorPresentationV1Schema>
>;

export const ComposerAttachmentPresentationV1Schema = ComposerAttachmentAuthorPresentationV1Schema.extend({
  typeLabel: boundedText(
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
    `Composer attachment type labels must be at most ${MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1} code points.`,
  ),
// Persisted fallback display fields are forward-compatible presentation only:
// retain the known immutable fallback while dropping an unknown future display
// field. Identity, routing, values, content, and every enclosing record remain
// closed schemas.
}).strip();
export type ComposerAttachmentPresentationV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentPresentationV1Schema>
>;

export const ComposerAttachmentValueV1Schema = PluginJsonValueV2Schema.superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1,
    'Composer attachment values',
  );
});
export type ComposerAttachmentValueV1 = DeepReadonly<z.infer<typeof ComposerAttachmentValueV1Schema>>;

const ComposerAttachmentRecordBaseV1Schema = z.object({
  v: z.literal(1),
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  attachment: asProtocolZod(PluginContributionIdentityV1Schema),
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
  presentation: ComposerAttachmentPresentationV1Schema,
}).strict();

function withComposerAttachmentRecordSizeLimit<TSchema extends z.ZodTypeAny>(schema: TSchema): TSchema {
  return schema.superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_RECORD_JSON_BYTES_V1,
    'Composer attachment records',
  );
  }) as TSchema;
}

/** A draft may retain only a transfer-owned opaque staged-media claim. */
export const ComposerAttachmentDraftV1Schema = withComposerAttachmentRecordSizeLimit(
  ComposerAttachmentRecordBaseV1Schema.extend({
    content: ComposerStagedMediaContentV1Schema.optional(),
  }).strict(),
);
export type ComposerAttachmentDraftV1 = DeepReadonly<z.infer<typeof ComposerAttachmentDraftV1Schema>>;

/** Admission replaces a staged claim with the one durable SessionMedia reference. */
export const ComposerAttachmentInputV1Schema = withComposerAttachmentRecordSizeLimit(
  ComposerAttachmentRecordBaseV1Schema.extend({
    content: ComposerSessionMediaContentV1Schema.optional(),
  }).strict(),
);
export type ComposerAttachmentInputV1 = DeepReadonly<z.infer<typeof ComposerAttachmentInputV1Schema>>;

/**
 * Dispatch-only projection of an admitted, contentless attachment. It carries
 * the prepared value plus optional fresh provider-neutral data; model-visible
 * context remains in the one host-rendered context block.
 */
export const ResolvedComposerAttachmentDispatchV1Schema = ComposerAttachmentRecordBaseV1Schema.extend({
  data: ComposerAttachmentValueV1Schema.optional(),
}).strict().superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_RECORD_JSON_BYTES_V1,
    'Resolved composer attachment dispatch records',
  );
});
export type ResolvedComposerAttachmentDispatchV1 = DeepReadonly<z.infer<
  typeof ResolvedComposerAttachmentDispatchV1Schema
>>;

export const ComposerAttachmentAuthorValueV1Schema = z.object({
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
  presentation: ComposerAttachmentAuthorPresentationV1Schema,
}).strict();
export type ComposerAttachmentAuthorValueV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAuthorValueV1Schema>
>;

export const ComposerAttachmentUpdateV1Schema = z.object({
  value: ComposerAttachmentValueV1Schema,
  presentation: ComposerAttachmentAuthorPresentationV1Schema.optional(),
}).strict();
export type ComposerAttachmentUpdateV1 = DeepReadonly<z.infer<typeof ComposerAttachmentUpdateV1Schema>>;

export const ComposerAttachmentAvailabilityV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready') }).strict(),
  z.object({
    status: z.enum(['unavailable', 'invalid']),
    reason: boundedText(512, 'Composer attachment availability reasons must be at most 512 code points.').optional(),
  }).strict(),
]);
export type ComposerAttachmentAvailabilityV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAvailabilityV1Schema>
>;

export const ComposerAttachmentViewV1Schema = ComposerAttachmentRecordBaseV1Schema.extend({
  availability: ComposerAttachmentAvailabilityV1Schema,
  // A draft snapshot may expose only the opaque stage; durable SessionMedia
  // references begin at canonical admission and never re-enter Composer UI.
  content: ComposerStagedMediaContentV1Schema.optional(),
}).strict();
export type ComposerAttachmentViewV1 = DeepReadonly<z.infer<typeof ComposerAttachmentViewV1Schema>>;
