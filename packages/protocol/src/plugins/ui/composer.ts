import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import {
  ComposerAttachmentAuthorValueV1Schema,
  ComposerAttachmentUpdateV1Schema,
  ComposerAttachmentViewV1Schema,
  ComposerInstanceIdSchema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
} from '../../runtime/input/composerAttachmentV1.js';
import { ComposerStagedMediaContentV1Schema } from '../../runtime/input/composerContentV1.js';
import { MentionRefV1Schema } from '../../runtime/input/mentionRefV1.js';
import { ComposerReferenceTriggerV1Schema } from '../contributions/composerReferenceProviders.js';
import { ReviewCommentDraftMessageV1Schema } from '../../messages/structured/reviewCommentsV1.js';
import {
  PluginContributionIdentityV1Schema,
  PluginContributionLocalIdSchema,
} from '../contributionIdentity.js';
import { PluginJsonValueV2Schema } from '../contributions/publicTypes.js';
import { PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH } from '../contributions/ui/rendererChainBinding.js';
import { PluginUiIconTokenV1Schema } from '../contributions/ui/tokens.js';
import { PluginUiInstanceKeyV1Schema } from './semanticCommands.js';
import {
  ComposerRefV1Schema,
  composerRefsV1Equal,
  type ComposerRefV1,
} from './composerRef.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from './targetedContributions.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/** Type-only public projection; Composer schemas keep their plain JSON runtime values. */
type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export const MAX_COMPOSER_DECORATIONS_V1 = 64;
export const MAX_COMPOSER_INPUT_LOCK_REASONS_V1 = 16;

// Text length belongs to the mounted product Composer/submission owner. An
// SDK-only ceiling would accept a host draft and then reject that same draft
// when a plugin reads it back.
const ComposerTextV1Schema = lazyZodSchema(() => z.string());
const ComposerRefV1ZodSchema = asProtocolZod(ComposerRefV1Schema);
/**
 * The composer-scope grammar lives in its own leaf because it is the one
 * Composer value projected onto the browser-safe public authoring surface;
 * this module keeps publishing it so every incumbent consumer is unchanged.
 */
export { ComposerRefV1Schema } from './composerRef.js';
export {
  COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1,
  composerRefV1Key,
  composerRefsV1Equal,
} from './composerRef.js';
export type { ComposerRefV1 } from './composerRef.js';

export const ComposerScopeKindV1Schema = lazyZodSchema(() => z.enum([
  'session',
  'discussion',
  'newSession',
  'pendingMessage',
  'participantMessage',
  'automationAuthoring',
  'workflowAuthoring',
]));
export type ComposerScopeKindV1 = z.infer<typeof ComposerScopeKindV1Schema>;

export const ComposerTextPositionV1Schema = lazyZodSchema(() => z.strictObject({
  offset: z.number().check(z.int(), z.nonnegative()),
}));
export type ComposerTextPositionV1 = DeepReadonly<z.infer<typeof ComposerTextPositionV1Schema>>;

export const ComposerTextRangeV1Schema = lazyZodSchema(() => z.strictObject({
  start: z.number().check(z.int(), z.nonnegative()),
  end: z.number().check(z.int(), z.nonnegative()),
}).check(z.refine((range) => range.start <= range.end, {
  path: ['end'],
  message: 'Composer range end must be at or after its start.',
})));
export type ComposerTextRangeV1 = DeepReadonly<z.infer<typeof ComposerTextRangeV1Schema>>;

/** Exact reference selector; no synthetic reference instance identity exists. */
export const ComposerReferenceSelectorV1Schema = lazyZodSchema(() => z.strictObject({
  ref: z.string().check(z.minLength(1)),
  start: z.number().check(z.int(), z.nonnegative()),
  end: z.number().check(z.int(), z.positive()),
}).check(z.refine((selector) => selector.start < selector.end, {
  path: ['end'],
  message: 'Composer reference selector end must be after its start.',
})));
export type ComposerReferenceSelectorV1 = DeepReadonly<z.infer<typeof ComposerReferenceSelectorV1Schema>>;

/**
 * A Composer-only reference carries the range it occupies in the exact draft
 * snapshot. Persisted structured-input mentions deliberately remain positionless:
 * their submitted text can be transformed after composition, so their canonical
 * runtime owner validates identity and token only.
 */
const ComposerMentionRefV1Schema = lazyZodSchema(() => (<T extends zMini.ZodMiniObject>(schema: T) => zMini.core.clone(schema, { ...schema._zod.def, catchall: zMini.never() }) as zMini.ZodMiniObject<T['shape'], zMini.core.$strict>)(zMini.extend(MentionRefV1Schema, {
  start: z.number().check(z.int(), z.nonnegative()),
  end: z.number().check(z.int(), z.positive()),
  composerReference: zMini.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
  composerReferenceTrigger: zMini.optional(ComposerReferenceTriggerV1Schema),
})).check(zMini.refine((reference) => reference.start < reference.end, {
  path: ['end'],
  message: 'Composer reference end must be after its start.',
})));

export const ComposerCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  text: z.literal(true),
  references: z.boolean(),
  attachments: z.boolean(),
  submit: z.boolean(),
}));
export type ComposerCapabilitiesV1 = DeepReadonly<z.infer<typeof ComposerCapabilitiesV1Schema>>;

export const ComposerInputLockSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  mode: z.enum(['submit', 'editAndSubmit']),
  reasons: z.array(z.string().check(z.minLength(1), z.maxLength(512))).check(z.maxLength(MAX_COMPOSER_INPUT_LOCK_REASONS_V1)),
}));
export type ComposerInputLockSnapshotV1 = DeepReadonly<z.infer<typeof ComposerInputLockSnapshotV1Schema>>;

export const ComposerSnapshotStateV1Schema = lazyZodSchema(() => z.strictObject({
  focused: z.boolean(),
  editable: z.boolean(),
  submittable: z.boolean(),
  submitting: z.boolean(),
  running: z.boolean(),
  inputLock: z.optional(ComposerInputLockSnapshotV1Schema),
}));
export type ComposerSnapshotStateV1 = DeepReadonly<z.infer<typeof ComposerSnapshotStateV1Schema>>;

/** Immutable semantic snapshot produced by the one Composer document owner. */
export const ComposerSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.nonnegative()),
  ref: ComposerRefV1ZodSchema,
  text: ComposerTextV1Schema,
  selection: z.optional(ComposerTextRangeV1Schema),
  references: z.array(ComposerMentionRefV1Schema).check(z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)),
  attachments: z.array(ComposerAttachmentViewV1Schema).check(z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)),
  layout: z.enum(['wrap', 'scroll', 'collapsed']),
  capabilities: ComposerCapabilitiesV1Schema,
  state: ComposerSnapshotStateV1Schema,
}));
export type ComposerSnapshotV1 = DeepReadonly<z.infer<typeof ComposerSnapshotV1Schema>>;

export const ComposerOperationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text.set'), text: ComposerTextV1Schema }),
  z.strictObject({
    kind: z.literal('text.insert'),
    position: ComposerTextPositionV1Schema,
    text: ComposerTextV1Schema,
  }),
  z.strictObject({
    kind: z.literal('text.replaceRange'),
    range: ComposerTextRangeV1Schema,
    text: ComposerTextV1Schema,
  }),
  z.strictObject({ kind: z.literal('text.clear') }),
  z.strictObject({ kind: z.literal('reference.insert'), reference: ComposerMentionRefV1Schema }),
  z.strictObject({ kind: z.literal('reference.remove'), reference: ComposerReferenceSelectorV1Schema }),
  // Host review context uses its existing workspace draft owner, never a
  // caller-qualified plugin attachment or a new submitted anchor shape.
  z.strictObject({ kind: z.literal('reviewComment.add'), comment: ReviewCommentDraftMessageV1Schema }),
  z.strictObject({
    kind: z.literal('attachment.add'),
    // The host qualifies this local ID from the caller. Public authors never
    // supply a plugin or host attachment identity here.
    attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
    value: ComposerAttachmentAuthorValueV1Schema,
    // Content stays separate from attachment-defined JSON value semantics.
    // Repeating this key is the existing attachment-add upsert path.
    content: zMini.optional(ComposerStagedMediaContentV1Schema),
    // Insert a bound token after the host mints this attachment's identity.
    mentionAt: z.optional(ComposerTextRangeV1Schema),
  }),
  z.strictObject({
    kind: z.literal('attachment.update'),
    instanceId: ComposerInstanceIdSchema,
    update: ComposerAttachmentUpdateV1Schema,
  }),
  z.strictObject({
    kind: z.literal('attachment.remove'),
    instanceId: ComposerInstanceIdSchema,
  }),
]));
export type ComposerOperationV1 = DeepReadonly<z.infer<typeof ComposerOperationV1Schema>>;

export const ComposerTransactionV1Schema = lazyZodSchema(() => z.strictObject({
  expectedRevision: z.number().check(z.int(), z.nonnegative()),
  operations: z.array(ComposerOperationV1Schema).check(z.minLength(1)),
}));
export type ComposerTransactionV1 = DeepReadonly<z.infer<typeof ComposerTransactionV1Schema>>;

export const ComposerTransactionResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('applied'),
    revision: z.number().check(z.int(), z.nonnegative()),
    attachmentInstanceIds: z.optional(z.array(ComposerInstanceIdSchema).check(z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1))),
  }),
  z.strictObject({
    status: z.literal('conflict'),
    currentRevision: z.number().check(z.int(), z.nonnegative()),
  }),
  z.strictObject({ status: z.literal('composerUnavailable') }),
  z.strictObject({ status: z.literal('notEditable') }),
  z.strictObject({
    status: z.literal('invalidOperation'),
    operationIndex: z.number().check(z.int(), z.nonnegative()),
    reason: z.string().check(z.minLength(1), z.maxLength(512)),
    detail: zMini.optional(PluginJsonValueV2Schema),
  }),
  z.strictObject({
    status: z.literal('limitExceeded'),
    limit: z.string().check(z.minLength(1), z.maxLength(256)),
    maximum: z.number().check(z.int(), z.nonnegative()),
    actual: z.number().check(z.int(), z.nonnegative()),
  }),
]));
export type ComposerTransactionResultV1 = DeepReadonly<z.infer<typeof ComposerTransactionResultV1Schema>>;

export const ComposerUnavailableReasonV1Schema = lazyZodSchema(() => z.enum(['notFound', 'scopeClosed', 'staleGeneration']));
export type ComposerUnavailableReasonV1 = z.infer<typeof ComposerUnavailableReasonV1Schema>;

export const ComposerReadResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), snapshot: ComposerSnapshotV1Schema }),
  z.strictObject({ status: z.literal('unavailable'), reason: ComposerUnavailableReasonV1Schema, requestId: z.optional(z.string().check(z.minLength(1))) }),
]));
export type ComposerReadResultV1 = DeepReadonly<z.infer<typeof ComposerReadResultV1Schema>>;

export const ComposerFocusResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('focused') }),
  z.strictObject({ status: z.literal('notEditable') }),
  z.strictObject({ status: z.literal('unavailable'), reason: ComposerUnavailableReasonV1Schema }),
]));
export type ComposerFocusResultV1 = DeepReadonly<z.infer<typeof ComposerFocusResultV1Schema>>;

export const ComposerDecorationTreatmentV1Schema = lazyZodSchema(() => z.union([
  z.enum(['highlight', 'muted', 'warning', 'success', 'code']),
  z.strictObject({ kind: z.literal('link'), url: z.string().check(z.url()) }),
]));
export type ComposerDecorationTreatmentV1 = DeepReadonly<z.infer<typeof ComposerDecorationTreatmentV1Schema>>;

export const ComposerDecorationSetV1Schema = lazyZodSchema(() => z.strictObject({
  revision: z.number().check(z.int(), z.nonnegative()),
  ranges: z.array(z.strictObject({
    range: ComposerTextRangeV1Schema,
    treatment: ComposerDecorationTreatmentV1Schema,
    label: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  })).check(z.maxLength(MAX_COMPOSER_DECORATIONS_V1)),
}));
export type ComposerDecorationSetV1 = DeepReadonly<z.infer<typeof ComposerDecorationSetV1Schema>>;

export const ComposerDecorationResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('set') }),
  z.strictObject({ status: z.literal('cleared') }),
  z.strictObject({ status: z.literal('staleRevision'), currentRevision: z.number().check(z.int(), z.nonnegative()) }),
  z.strictObject({ status: z.literal('invalid') }),
  z.strictObject({ status: z.literal('unavailable'), reason: ComposerUnavailableReasonV1Schema }),
]));
export type ComposerDecorationResultV1 = DeepReadonly<z.infer<typeof ComposerDecorationResultV1Schema>>;

export const ComposerInputLockRequestV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.string().check(z.minLength(1), z.maxLength(512)),
  mode: z.enum(['submit', 'editAndSubmit']),
}));
export type ComposerInputLockRequestV1 = DeepReadonly<z.infer<typeof ComposerInputLockRequestV1Schema>>;

/** Dynamic state decoded from the incumbent contextual Resource owner. */
export const ComposerControlChoiceIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256), z.refine((value) => value === value.trim(), { message: 'Composer control choice ids must not have surrounding whitespace.' })));
export type ComposerControlChoiceIdV1 = z.infer<typeof ComposerControlChoiceIdV1Schema>;

/** The exact Resource media type that can carry a V1 Composer control state. */
export const COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1 =
  'application/vnd.happier.composer-control-state+json;v=1';
export const ComposerControlStateContentTypeV1Schema = lazyZodSchema(() => z.literal(
  COMPOSER_CONTROL_STATE_CONTENT_TYPE_V1,
));
export type ComposerControlStateContentTypeV1 = z.infer<
  typeof ComposerControlStateContentTypeV1Schema
>;

/**
 * Per-read ceiling for the one Composer-control state Resource.
 *
 * The Composer control decodes and parses this document synchronously on the
 * UI thread, so its bound is a frame budget rather than a transport quota. It
 * matches the incumbent live-Resource document bound
 * (`MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1`) and comfortably exceeds
 * the largest natural `ComposerControlStateV1` document — roughly 36 KB with
 * every optional field at its schema maximum in 4-byte UTF-8 text.
 */
export const MAX_COMPOSER_CONTROL_STATE_RESOURCE_BYTES_V1 = 64 * 1024;

/** Whether Resource metadata is exactly the V1 Composer control-state media type. */
export function isComposerControlStateContentTypeV1(
  contentType: unknown,
): contentType is ComposerControlStateContentTypeV1 {
  return ComposerControlStateContentTypeV1Schema.safeParse(contentType).success;
}

export const ComposerControlStateV1Schema = lazyZodSchema(() => z.strictObject({
  visible: z.optional(z.boolean()),
  enabled: z.optional(z.boolean()),
  label: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
  icon: zMini.optional(PluginUiIconTokenV1Schema),
  count: z.optional(z.number().check(z.int(), z.nonnegative())),
  selected: z.optional(z.boolean()),
  selectedChoiceIds: z.optional(z.array(ComposerControlChoiceIdV1Schema).check(z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1))),
  accessibilityLabel: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  unavailableReason: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
}));
export type ComposerControlStateV1 = DeepReadonly<z.infer<typeof ComposerControlStateV1Schema>>;

export const ComposerSurfaceRoleV1Schema = lazyZodSchema(() => z.enum([
  'controlCompact',
  'controlInteraction',
  'attachmentPicker',
  'attachmentDisplay',
  'attachmentPreview',
  'region',
]));
export type ComposerSurfaceRoleV1 = z.infer<typeof ComposerSurfaceRoleV1Schema>;

const ComposerControlSurfaceInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  role: z.enum(['controlCompact', 'controlInteraction']),
  composer: ComposerRefV1ZodSchema,
  controlLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  state: ComposerControlStateV1Schema,
}));

const ComposerAttachmentPickerSurfaceInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  role: z.literal('attachmentPicker'),
  composer: ComposerRefV1ZodSchema,
  attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  instances: z.array(ComposerAttachmentViewV1Schema).check(z.maxLength(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1)),
}));

const ComposerAttachmentDisplaySurfaceInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  role: z.enum(['attachmentDisplay', 'attachmentPreview']),
  composer: ComposerRefV1ZodSchema,
  attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  instance: ComposerAttachmentViewV1Schema,
}));

const ComposerRegionSurfaceInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  role: z.literal('region'),
  composer: ComposerRefV1ZodSchema,
  regionLocalId: asProtocolZod(PluginContributionLocalIdSchema),
}));

/** Closed host-stamped launch input for a composer-mounted renderer. */
export const ComposerSurfaceInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('role', [
  ComposerControlSurfaceInputV1Schema,
  ComposerAttachmentPickerSurfaceInputV1Schema,
  ComposerAttachmentDisplaySurfaceInputV1Schema,
  ComposerRegionSurfaceInputV1Schema,
]));
export type ComposerSurfaceInputV1 = DeepReadonly<z.infer<typeof ComposerSurfaceInputV1Schema>>;

function sameContributionIdentityV1(
  left: Readonly<{ pluginId: string; localId: string }>,
  right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

/**
 * One host-produced composer mount. It carries the current contributor and
 * projection fences but no persisted draft/message state or destination shell.
 */
export const ComposerSurfaceMountBindingV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('composer'),
  contribution: asProtocolZod(PluginContributionIdentityV1Schema),
  occurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema),
  projectionGeneration: z.number().check(z.int(), z.nonnegative()),
  role: ComposerSurfaceRoleV1Schema,
  selectedRenderer: asProtocolZod(PluginContributionIdentityV1Schema),
  rendererChain: z.array(asProtocolZod(PluginContributionIdentityV1Schema)).check(z.minLength(1), z.maxLength(PLUGIN_UI_MAX_RENDERER_CHAIN_LENGTH)),
  composer: ComposerRefV1ZodSchema,
  instanceKey: PluginUiInstanceKeyV1Schema,
  input: ComposerSurfaceInputV1Schema,
}).check(z.superRefine((mount, context) => {
  if (mount.role !== mount.input.role) {
    context.addIssue({
      code: "custom",
      path: ['input', 'role'],
      message: 'Composer mount role must match its closed launch input.',
    });
  }
  if (!composerRefsV1Equal(mount.composer, mount.input.composer)) {
    context.addIssue({
      code: "custom",
      path: ['input', 'composer'],
      message: 'Composer mount input must carry the exact mounted Composer scope.',
    });
  }
  if (
    mount.selectedRenderer.pluginId !== mount.contribution.pluginId
    || mount.rendererChain.some((renderer) => renderer.pluginId !== mount.contribution.pluginId)
  ) {
    context.addIssue({
      code: "custom",
      path: ['rendererChain'],
      message: 'Composer mount renderers must belong to the admitted contributor plugin.',
    });
  }
  if (!mount.rendererChain.some((renderer) => sameContributionIdentityV1(renderer, mount.selectedRenderer))) {
    context.addIssue({
      code: "custom",
      path: ['selectedRenderer'],
      message: 'Composer mount selected renderer must occur in its renderer-chain provenance.',
    });
  }

  switch (mount.input.role) {
    case 'controlCompact':
    case 'controlInteraction':
      if (mount.input.controlLocalId !== mount.contribution.localId) {
        context.addIssue({
          code: "custom",
          path: ['input', 'controlLocalId'],
          message: 'Composer control mount input must name its admitted contribution.',
        });
      }
      break;
    case 'attachmentPicker':
      if (
        mount.input.attachmentLocalId !== mount.contribution.localId
        || mount.input.instances.some((instance) => !sameContributionIdentityV1(instance.attachment, mount.contribution))
      ) {
        context.addIssue({
          code: "custom",
          path: ['input'],
          message: 'Composer attachment picker input must contain only its admitted attachment contribution.',
        });
      }
      break;
    case 'attachmentDisplay':
    case 'attachmentPreview':
      if (
        mount.input.attachmentLocalId !== mount.contribution.localId
        || !sameContributionIdentityV1(mount.input.instance.attachment, mount.contribution)
      ) {
        context.addIssue({
          code: "custom",
          path: ['input'],
          message: 'Composer attachment surface input must contain its admitted attachment contribution.',
        });
      }
      break;
    case 'region':
      if (mount.input.regionLocalId !== mount.contribution.localId) {
        context.addIssue({
          code: "custom",
          path: ['input', 'regionLocalId'],
          message: 'Composer region mount input must name its admitted contribution.',
        });
      }
      break;
  }
})));
export type ComposerSurfaceMountBindingV1 = DeepReadonly<z.infer<typeof ComposerSurfaceMountBindingV1Schema>>;
