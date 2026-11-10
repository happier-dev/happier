import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import {
  ComposerReferenceCandidateIdV1Schema,
  ComposerReferenceCandidateV1Schema,
  ComposerReferenceContextV1Schema,
  ComposerReferenceResolutionV1Schema,
  ComposerReferenceTriggerV1Schema,
  type ComposerReferenceCandidateV1,
  type ComposerReferenceResolutionV1,
  type ComposerReferenceTriggerV1,
} from '../../plugins/contributions/composerReferenceProviders.js';
import {
  PluginContributionIdentityV1Schema,
  type PluginContributionIdentityV1,
} from '../../plugins/contributionIdentity.js';
import {
  MentionRefV1Schema,
  buildMentionRefV1,
  parseMentionRefV1,
} from './mentionRefV1.js';
import {
  ResolvedComposerAttachmentDispatchV1Schema,
  type ResolvedComposerAttachmentDispatchV1,
} from './composerAttachmentV1.js';

/**
 * The persisted kind stays an ordinary additive `mentions[]` element. Older
 * readers preserve it inert through the open MentionRef schema; only the
 * current send-time owner interprets the reference identity.
 */
export const COMPOSER_REFERENCE_MENTION_KIND_V1 = 'happier.composerReference';
export const COMPOSER_REFERENCE_MENTION_REF_SCHEME_V1 = 'composerReference';

export type ComposerReferenceMentionPayloadV1 = Readonly<{
  kind: typeof COMPOSER_REFERENCE_MENTION_KIND_V1;
  ref: string;
  composerReference: PluginContributionIdentityV1;
  composerReferenceTrigger?: ComposerReferenceTriggerV1;
  label?: string;
}>;

export type ComposerReferenceMentionV1 = ComposerReferenceMentionPayloadV1 & Readonly<{
  token: string;
}>;

/**
 * Builds the exact selection-time shape that the incumbent Composer insertion
 * owner places into its existing open mention payload. The candidate description
 * is deliberately not persisted; it is refreshed with `resolve` at dispatch.
 */
export function buildComposerReferenceMentionPayloadV1(params: Readonly<{
  reference: PluginContributionIdentityV1;
  candidate: ComposerReferenceCandidateV1;
  trigger?: ComposerReferenceTriggerV1;
}>): ComposerReferenceMentionPayloadV1 {
  const reference = PluginContributionIdentityV1Schema.parse(params.reference);
  const candidate = ComposerReferenceCandidateV1Schema.parse(params.candidate);
  return Object.freeze({
    kind: COMPOSER_REFERENCE_MENTION_KIND_V1,
    ref: buildMentionRefV1(COMPOSER_REFERENCE_MENTION_REF_SCHEME_V1, candidate.id),
    composerReference: reference,
    ...(params.trigger === undefined ? {} : { composerReferenceTrigger: ComposerReferenceTriggerV1Schema.parse(params.trigger) }),
    label: candidate.label,
  });
}

/**
 * Reads a qualified composer reference only when all three identity components
 * are valid and agree. A malformed newer field remains inert rather than being
 * guessed into a different provider/candidate pair.
 */
export function readComposerReferenceMentionV1(value: unknown): Readonly<{
  reference: PluginContributionIdentityV1;
  candidateId: string;
  trigger?: ComposerReferenceTriggerV1;
  label?: string;
}> | null {
  const mention = MentionRefV1Schema.safeParse(value);
  if (!mention.success || mention.data.kind !== COMPOSER_REFERENCE_MENTION_KIND_V1) {
    return null;
  }
  const ref = parseMentionRefV1(mention.data.ref);
  if (!ref || ref.scheme !== COMPOSER_REFERENCE_MENTION_REF_SCHEME_V1) return null;
  const reference = PluginContributionIdentityV1Schema.safeParse(mention.data.composerReference);
  const candidateId = ComposerReferenceCandidateIdV1Schema.safeParse(ref.opaque);
  if (!reference.success || !candidateId.success) return null;
  const trigger = mention.data.composerReferenceTrigger === undefined ? undefined
    : ComposerReferenceTriggerV1Schema.safeParse(mention.data.composerReferenceTrigger);
  if (trigger && !trigger.success) return null;
  return {
    reference: reference.data,
    candidateId: candidateId.data,
    ...(trigger?.success ? { trigger: trigger.data } : {}),
    ...(typeof mention.data.label === 'string' ? { label: mention.data.label } : {}),
  };
}

export const ComposerReferenceContextBlockEntryV1Schema = lazyZodSchema(() => z.strictObject({
  reference: asProtocolZod(PluginContributionIdentityV1Schema),
  candidateId: ComposerReferenceCandidateIdV1Schema,
  resolution: ComposerReferenceResolutionV1Schema,
}).check(z.superRefine((entry, context) => {
  if (entry.candidateId !== entry.resolution.id) {
    context.addIssue({
      code: 'custom',
      path: ['resolution', 'id'],
      message: 'Composer reference resolution must match the requested candidate id.',
    });
  }
})));
export type ComposerReferenceContextBlockEntryV1 = Readonly<{
  reference: PluginContributionIdentityV1;
  candidateId: string;
  resolution: ComposerReferenceResolutionV1;
}>;

export const ComposerAttachmentContextBlockEntryV1Schema = lazyZodSchema(() => z.strictObject({
  attachment: ResolvedComposerAttachmentDispatchV1Schema,
  context: z.optional(z.string().check(z.minLength(1))),
}));
export type ComposerAttachmentContextBlockEntryV1 = Readonly<{
  attachment: ResolvedComposerAttachmentDispatchV1;
  context?: string;
}>;
