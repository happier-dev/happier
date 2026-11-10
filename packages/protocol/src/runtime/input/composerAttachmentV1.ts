import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod, projectZodProtocolSchema } from "../../plugins/actions/internalProtocolZodAdapter.js";
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
import { SessionInputForgeEvidenceV1Schema } from '../../sessions/messages/sessionInputForgeEvidenceV1.js';
import { SessionMessageRefV1Schema } from '../../sessions/messages/sessionMessageRefV1.js';
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

function boundedText(maxCodePoints: number, message: string): z.ZodMiniString<string> {
  return z.string().check(z.minLength(1), z.superRefine((value, context) => {
    if (value !== value.trim()) {
      context.addIssue({
        code: "custom",
        message: 'Composer attachment text must not have surrounding whitespace.',
      });
    }
    if (codePointLength(value) > maxCodePoints) {
      context.addIssue({ code: "custom", message });
    }
  }));
}

function canonicalJsonByteLength(value: unknown): number {
  return textEncoder.encode(createCanonicalJsonSigningInput(value)).byteLength;
}

function rejectOversizedCanonicalJson(
  value: unknown,
  context: z.core.$RefinementCtx,
  maxBytes: number,
  label: string,
): void {
  if (canonicalJsonByteLength(value) > maxBytes) {
    context.addIssue({
      code: "custom",
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
export const ComposerInstanceIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_COMPOSER_INSTANCE_ID_CODE_POINTS_V1), z.refine((value) => ComposerInstanceIdProtocolSchema.safeParse(value).success, {
    message: 'Composer instance ids must not have surrounding whitespace.',
  })));
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

export const ComposerAttachmentAuthorPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  label: boundedText(
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
    `Composer attachment labels must be at most ${MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1} code points.`,
  ),
  description: z.optional(boundedText(
    MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
    `Composer attachment descriptions must be at most ${MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1} code points.`,
  )),
  icon: z.optional(PluginUiIconTokenV1Schema),
  tone: z.optional(z.enum(PluginUiToneV1Schema.options.filter((value): value is Exclude<(typeof PluginUiToneV1Schema.options)[number], 'accent'> => !(['accent'] as readonly string[]).includes(value)))),
  /** Immutable source link admitted with the display facts; never a plugin value lookup in history. */
  source: z.optional(SessionMessageRefV1Schema),
}));
export type ComposerAttachmentAuthorPresentationV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAuthorPresentationV1Schema>
>;

export const ComposerAttachmentPresentationV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(ComposerAttachmentAuthorPresentationV1Schema, {
  typeLabel: boundedText(
    MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
    `Composer attachment type labels must be at most ${MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1} code points.`,
  ),
// Persisted fallback display fields are forward-compatible presentation only:
// retain the known immutable fallback while dropping an unknown future display
// field. Identity, routing, values, content, and every enclosing record remain
// closed schemas.
})));
export type ComposerAttachmentPresentationV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentPresentationV1Schema>
>;

export const ComposerAttachmentValueV1Schema = lazyZodSchema(() => PluginJsonValueV2Schema.check(z.superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_VALUE_JSON_BYTES_V1,
    'Composer attachment values',
  );
})));
export type ComposerAttachmentValueV1 = DeepReadonly<z.infer<typeof ComposerAttachmentValueV1Schema>>;

const ComposerAttachmentRecordBaseV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  attachment: asProtocolZod(PluginContributionIdentityV1Schema),
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
  presentation: ComposerAttachmentPresentationV1Schema,
  /** Descriptive annotation admitted from this attachment's preparation callback. */
  forgeEvidence: z.optional(asProtocolZod(SessionInputForgeEvidenceV1Schema)),
}));

function withComposerAttachmentRecordSizeLimit<TSchema extends z.ZodMiniType>(schema: TSchema): TSchema {
  return schema.check(z.superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_RECORD_JSON_BYTES_V1,
    'Composer attachment records',
  );
  })) as TSchema;
}

/**
 * The contentless record projection a saved, portable authoring document may
 * carry across devices. It keeps this owner's identity, value, presentation and
 * record-size bounds and deliberately admits no `content` member: a
 * transfer-owned staged-media claim is device-local and is not durable saved
 * content, while a durable SessionMedia reference belongs to an admitted
 * Session input rather than a portable definition.
 */
export const PortableComposerAttachmentV1Schema = withComposerAttachmentRecordSizeLimit(
  ComposerAttachmentRecordBaseV1Schema,
);
export type PortableComposerAttachmentV1 = DeepReadonly<z.infer<typeof PortableComposerAttachmentV1Schema>>;

/** A draft may retain only a transfer-owned opaque staged-media claim. */
export const ComposerAttachmentDraftV1Schema = withComposerAttachmentRecordSizeLimit(
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ComposerAttachmentRecordBaseV1Schema, {
    content: z.optional(ComposerStagedMediaContentV1Schema),
  }))),
);
export type ComposerAttachmentDraftV1 = DeepReadonly<z.infer<typeof ComposerAttachmentDraftV1Schema>>;

/** Admission replaces a staged claim with the one durable SessionMedia reference. */
export const ComposerAttachmentInputV1Schema = withComposerAttachmentRecordSizeLimit(
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ComposerAttachmentRecordBaseV1Schema, {
    content: z.optional(ComposerSessionMediaContentV1Schema),
  }))),
);
export type ComposerAttachmentInputV1 = DeepReadonly<z.infer<typeof ComposerAttachmentInputV1Schema>>;

/**
 * Dispatch-only projection of an admitted, contentless attachment. It carries
 * the prepared value plus optional fresh provider-neutral data; model-visible
 * context remains in the one host-rendered context block.
 */
export const ResolvedComposerAttachmentDispatchV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ComposerAttachmentRecordBaseV1Schema, {
  data: z.optional(ComposerAttachmentValueV1Schema),
})).check(z.superRefine((value, context) => {
  rejectOversizedCanonicalJson(
    value,
    context,
    MAX_COMPOSER_ATTACHMENT_RECORD_JSON_BYTES_V1,
    'Resolved composer attachment dispatch records',
  );
})));
export type ResolvedComposerAttachmentDispatchV1 = DeepReadonly<z.infer<
  typeof ResolvedComposerAttachmentDispatchV1Schema
>>;

export const ComposerAttachmentAuthorValueV1Schema = lazyZodSchema(() => z.strictObject({
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
  presentation: ComposerAttachmentAuthorPresentationV1Schema,
}));
export type ComposerAttachmentAuthorValueV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAuthorValueV1Schema>
>;
export const ComposerAttachmentAuthorValueV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(ComposerAttachmentAuthorValueV1Schema));

export const ComposerAttachmentUpdateV1Schema = lazyZodSchema(() => z.strictObject({
  value: ComposerAttachmentValueV1Schema,
  presentation: z.optional(ComposerAttachmentAuthorPresentationV1Schema),
}));
export type ComposerAttachmentUpdateV1 = DeepReadonly<z.infer<typeof ComposerAttachmentUpdateV1Schema>>;

export const ComposerAttachmentAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({
    status: z.enum(['unavailable', 'invalid']),
    reason: z.optional(boundedText(512, 'Composer attachment availability reasons must be at most 512 code points.')),
  }),
]));
export type ComposerAttachmentAvailabilityV1 = DeepReadonly<
  z.infer<typeof ComposerAttachmentAvailabilityV1Schema>
>;

export const ComposerAttachmentViewV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ComposerAttachmentRecordBaseV1Schema, {
  availability: ComposerAttachmentAvailabilityV1Schema,
  // A draft snapshot may expose only the opaque stage; durable SessionMedia
  // references begin at canonical admission and never re-enter Composer UI.
  content: z.optional(ComposerStagedMediaContentV1Schema),
})));
export type ComposerAttachmentViewV1 = DeepReadonly<z.infer<typeof ComposerAttachmentViewV1Schema>>;
