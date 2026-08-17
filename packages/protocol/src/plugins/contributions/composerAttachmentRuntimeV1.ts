import { z } from 'zod';

import {
  ComposerAttachmentAuthorPresentationV1Schema,
  ComposerAttachmentInstanceIdV1Schema,
  ComposerAttachmentKeyV1Schema,
  ComposerAttachmentValueV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
} from '../../runtime/input/composerAttachmentV1.js';
import { ComposerStagedMediaContentV1Schema } from '../../runtime/input/composerContentV1.js';
import { SessionIdSchema } from '../../sessions/idsV1.js';
import { PendingLocalIdSchema } from '../../sessions/pending/pendingLocalId.js';
import type { JsonValue } from '../../json/strictJsonValue.js';
import type { PluginJsonValueV2 } from './publicTypes.js';
import { ComposerReferenceContextV1Schema } from './composerReferenceProviders.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const ComposerAttachmentMessageV1Schema = z.string().min(1).max(512);
function rejectDuplicateAttachmentInstanceIds(
  values: readonly Readonly<{ instanceId: string }>[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value.instanceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, 'instanceId'],
        message: 'Composer attachment callback batches must not repeat an instance id.',
      });
    }
    seen.add(value.instanceId);
  });
}

const ComposerAttachmentPrepareInstanceV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
  content: ComposerStagedMediaContentV1Schema.optional(),
}).strict();

/** Exact input for one current-generation prepare callback. */
export const ComposerAttachmentPrepareRequestV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  attachments: z.array(ComposerAttachmentPrepareInstanceV1Schema)
    .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
    .superRefine(rejectDuplicateAttachmentInstanceIds),
}).strict();
type ComposerAttachmentPrepareRequestWireV1 = z.infer<typeof ComposerAttachmentPrepareRequestV1Schema>;
type ComposerAttachmentValueReplacedV1<TRecord, TValue extends JsonValue> = Readonly<
  Omit<TRecord, 'value'> & Readonly<{ value: TValue }>
>;
export type ComposerAttachmentPrepareRequestV1<
  TDraft extends JsonValue = JsonValue,
> = Readonly<
  Omit<ComposerAttachmentPrepareRequestWireV1, 'attachments'>
  & Readonly<{
    attachments: readonly ComposerAttachmentValueReplacedV1<
      ComposerAttachmentPrepareRequestWireV1['attachments'][number],
      TDraft
    >[];
  }>
>;

const ComposerAttachmentPrepareReadyOutcomeV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  status: z.literal('ready'),
  value: ComposerAttachmentValueV1Schema,
  content: ComposerStagedMediaContentV1Schema.optional(),
  presentation: ComposerAttachmentAuthorPresentationV1Schema.optional(),
}).strict();
const ComposerAttachmentPrepareBlockedOutcomeV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  status: z.enum(['invalid', 'unavailable', 'failed']),
  retryable: z.boolean(),
  message: ComposerAttachmentMessageV1Schema.optional(),
}).strict();
export const ComposerAttachmentPrepareOutcomeV1Schema = z.discriminatedUnion('status', [
  ComposerAttachmentPrepareReadyOutcomeV1Schema,
  ComposerAttachmentPrepareBlockedOutcomeV1Schema,
]);
type ComposerAttachmentPrepareOutcomeWireV1 = z.infer<typeof ComposerAttachmentPrepareOutcomeV1Schema>;
export type ComposerAttachmentPrepareOutcomeV1<
  TPrepared extends JsonValue = PluginJsonValueV2,
> = ComposerAttachmentValueReplacedV1<
  Extract<ComposerAttachmentPrepareOutcomeWireV1, Readonly<{ status: 'ready' }>>,
  TPrepared
> | Exclude<ComposerAttachmentPrepareOutcomeWireV1, Readonly<{ status: 'ready' }>>;

/** Exact result shape. The host also checks one outcome per requested id. */
export const ComposerAttachmentPrepareResultV1Schema = z.object({
  attachments: z.array(ComposerAttachmentPrepareOutcomeV1Schema)
    .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
    .superRefine(rejectDuplicateAttachmentInstanceIds),
}).strict();
type ComposerAttachmentPrepareResultWireV1 = z.infer<typeof ComposerAttachmentPrepareResultV1Schema>;
export type ComposerAttachmentPrepareResultV1<
  TPrepared extends JsonValue = PluginJsonValueV2,
> = Readonly<
  Omit<ComposerAttachmentPrepareResultWireV1, 'attachments'>
  & Readonly<{ attachments: readonly ComposerAttachmentPrepareOutcomeV1<TPrepared>[] }>
>;

const ComposerAttachmentResolvedInstanceV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  key: ComposerAttachmentKeyV1Schema,
  value: ComposerAttachmentValueV1Schema,
}).strict();

/** Exact input for fresh resolution immediately before an Agent dispatch. */
export const ComposerAttachmentResolveRequestV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  attachments: z.array(ComposerAttachmentResolvedInstanceV1Schema)
    .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
    .superRefine(rejectDuplicateAttachmentInstanceIds),
}).strict();
type ComposerAttachmentResolveRequestWireV1 = z.infer<typeof ComposerAttachmentResolveRequestV1Schema>;
export type ComposerAttachmentResolveRequestV1<
  TPrepared extends JsonValue = JsonValue,
> = Readonly<
  Omit<ComposerAttachmentResolveRequestWireV1, 'attachments'>
  & Readonly<{
    attachments: readonly ComposerAttachmentValueReplacedV1<
      ComposerAttachmentResolveRequestWireV1['attachments'][number],
      TPrepared
    >[];
  }>
>;

const ComposerAttachmentResolveReadyOutcomeV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  status: z.literal('ready'),
  context: ComposerReferenceContextV1Schema.optional(),
  data: ComposerAttachmentValueV1Schema.optional(),
}).strict();
const ComposerAttachmentResolveBlockedOutcomeV1Schema = z.object({
  instanceId: ComposerAttachmentInstanceIdV1Schema,
  status: z.enum(['unavailable', 'notFound', 'invalid', 'failed']),
  retryable: z.boolean(),
  message: ComposerAttachmentMessageV1Schema.optional(),
}).strict();
export const ComposerAttachmentResolveOutcomeV1Schema = z.discriminatedUnion('status', [
  ComposerAttachmentResolveReadyOutcomeV1Schema,
  ComposerAttachmentResolveBlockedOutcomeV1Schema,
]);
type ComposerAttachmentResolveOutcomeWireV1 = z.infer<typeof ComposerAttachmentResolveOutcomeV1Schema>;
export type ComposerAttachmentResolveOutcomeV1 = ComposerAttachmentResolveOutcomeWireV1;

/** Exact result shape. The host enforces all-or-none dispatch separately. */
export const ComposerAttachmentResolveResultV1Schema = z.object({
  attachments: z.array(ComposerAttachmentResolveOutcomeV1Schema)
    .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
    .superRefine(rejectDuplicateAttachmentInstanceIds),
}).strict();
type ComposerAttachmentResolveResultWireV1 = z.infer<typeof ComposerAttachmentResolveResultV1Schema>;
export type ComposerAttachmentResolveResultV1 = Readonly<
  Omit<ComposerAttachmentResolveResultWireV1, 'attachments'>
  & Readonly<{ attachments: readonly ComposerAttachmentResolveOutcomeV1[] }>
>;

/**
 * Best-effort post-durable-admission notification. sessionId plus localId is its only Message identity;
 * it has no result and cannot alter admission.
 */
export const ComposerAttachmentMessageAcceptedV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  localId: PendingLocalIdSchema,
  attachments: z.array(ComposerAttachmentResolvedInstanceV1Schema)
    .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)
    .superRefine(rejectDuplicateAttachmentInstanceIds),
}).strict();
type ComposerAttachmentMessageAcceptedWireV1 = z.infer<typeof ComposerAttachmentMessageAcceptedV1Schema>;
export type ComposerAttachmentMessageAcceptedV1<
  TPrepared extends JsonValue = JsonValue,
> = Readonly<
  Omit<ComposerAttachmentMessageAcceptedWireV1, 'attachments'>
  & Readonly<{
    attachments: readonly ComposerAttachmentValueReplacedV1<
      ComposerAttachmentMessageAcceptedWireV1['attachments'][number],
      TPrepared
    >[];
  }>
>;
