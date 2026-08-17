import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';
import { PluginUiIconTokenV1Schema } from './ui/tokens.js';
import {
  ComposerReferenceCandidateIdV1Schema,
} from './composerReferenceCandidateIdV1.js';

export {
  ComposerReferenceCandidateIdV1Schema,
  MAX_COMPOSER_REFERENCE_CANDIDATE_ID_UTF8_BYTES_V1,
  type ComposerReferenceCandidateIdV1,
} from './composerReferenceCandidateIdV1.js';

const textEncoder = new TextEncoder();

export const MAX_COMPOSER_REFERENCE_QUERY_UTF8_BYTES_V1 = 256;
export const MAX_COMPOSER_REFERENCE_CANDIDATES_V1 = 32;
export const MAX_COMPOSER_REFERENCE_LABEL_CODE_POINTS_V1 = 128;
export const MAX_COMPOSER_REFERENCE_DESCRIPTION_CODE_POINTS_V1 = 512;
export const MAX_COMPOSER_REFERENCE_PAGE_JSON_BYTES_V1 = 64 * 1024;
export const MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1 = 16 * 1024;
export const MAX_COMPOSER_REFERENCE_TRIGGERS_V1 = 3;
export const COMPOSER_REFERENCE_TRIGGER_CHARACTERS_V1 = ['@', '$', '/'] as const;
export const ComposerReferenceTriggerV1Schema = z.enum(COMPOSER_REFERENCE_TRIGGER_CHARACTERS_V1);
export type ComposerReferenceTriggerV1 = z.infer<typeof ComposerReferenceTriggerV1Schema>;
/**
 * Resolve context is model-visible text, not a capability envelope. Keeping it
 * scalar prevents a provider from handing the host a path, Action, Resource, or
 * callback-shaped value that another consumer could mistake for authority.
 */
export const MAX_COMPOSER_REFERENCE_CONTEXT_UTF8_BYTES_V1 = MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedUtf8String(maxBytes: number, message: string): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (utf8ByteLength(value) > maxBytes) {
      context.addIssue({ code: 'custom', message });
    }
  });
}

function boundedCodePointString(maxCodePoints: number, message: string): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (codePointLength(value) > maxCodePoints) {
      context.addIssue({ code: 'custom', message });
    }
  });
}

function jsonByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

/**
 * The declarative half of a composer reference provider. Runtime callbacks are
 * deliberately absent: a provider must be manifest-declared before activation
 * can bind its `search` and `resolve` functions.
 */
export const PluginComposerReferenceProviderPresentationV1Schema = z.object({
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema,
  triggers: z.array(ComposerReferenceTriggerV1Schema)
    .min(1)
    .max(MAX_COMPOSER_REFERENCE_TRIGGERS_V1)
    .superRefine((triggers, context) => {
      const seen = new Set<string>();
      triggers.forEach((trigger, index) => {
        if (seen.has(trigger)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index],
            message: 'Composer reference triggers must be unique.',
          });
        }
        seen.add(trigger);
      });
    })
    .default(['@']),
}).strict();
export type PluginComposerReferenceProviderPresentationV1 = z.infer<
  typeof PluginComposerReferenceProviderPresentationV1Schema
>;

export const PluginComposerReferenceProviderContributionV1Schema =
  PluginComposerReferenceProviderPresentationV1Schema.extend({
    id: asProtocolZod(PluginContributionLocalIdSchema),
  }).strict();
export type PluginComposerReferenceProviderContributionV1 = z.infer<
  typeof PluginComposerReferenceProviderContributionV1Schema
>;

export const ComposerReferenceCandidateLabelV1Schema = boundedCodePointString(
    MAX_COMPOSER_REFERENCE_LABEL_CODE_POINTS_V1,
    `Composer reference labels must be at most ${MAX_COMPOSER_REFERENCE_LABEL_CODE_POINTS_V1} code points.`,
);

export const ComposerReferenceCandidateDescriptionV1Schema = boundedCodePointString(
    MAX_COMPOSER_REFERENCE_DESCRIPTION_CODE_POINTS_V1,
    `Composer reference descriptions must be at most ${MAX_COMPOSER_REFERENCE_DESCRIPTION_CODE_POINTS_V1} code points.`,
);

export const ComposerReferenceContextV1Schema = boundedUtf8String(
  MAX_COMPOSER_REFERENCE_CONTEXT_UTF8_BYTES_V1,
  `Composer reference context must be at most ${MAX_COMPOSER_REFERENCE_CONTEXT_UTF8_BYTES_V1} UTF-8 bytes.`,
);

export const ComposerReferenceCandidateV1Schema = z.object({
  id: ComposerReferenceCandidateIdV1Schema,
  label: ComposerReferenceCandidateLabelV1Schema,
  description: ComposerReferenceCandidateDescriptionV1Schema.optional(),
}).strict();
export type ComposerReferenceCandidateV1 = z.infer<typeof ComposerReferenceCandidateV1Schema>;

export const ComposerReferenceCandidatePageV1Schema = z.array(ComposerReferenceCandidateV1Schema)
  .max(MAX_COMPOSER_REFERENCE_CANDIDATES_V1)
  .superRefine((candidates, context) => {
    const ids = new Set<string>();
    candidates.forEach((candidate, index) => {
      if (ids.has(candidate.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: 'Composer reference candidate ids must be unique within a page.',
        });
      }
      ids.add(candidate.id);
    });
    if (jsonByteLength(candidates) > MAX_COMPOSER_REFERENCE_PAGE_JSON_BYTES_V1) {
      context.addIssue({
        code: 'custom',
        message: `Composer reference candidate pages must be at most ${MAX_COMPOSER_REFERENCE_PAGE_JSON_BYTES_V1} JSON bytes.`,
      });
    }
  });
export type ComposerReferenceCandidatePageV1 = z.infer<typeof ComposerReferenceCandidatePageV1Schema>;

export const ComposerReferenceResolutionV1Schema = ComposerReferenceCandidateV1Schema.extend({
  context: ComposerReferenceContextV1Schema,
}).strict().superRefine((resolution, context) => {
  if (jsonByteLength(resolution) > MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1) {
    context.addIssue({
      code: 'custom',
      message: `Composer reference resolutions must be at most ${MAX_COMPOSER_REFERENCE_RESOLUTION_JSON_BYTES_V1} JSON bytes.`,
    });
  }
});
export type ComposerReferenceResolutionV1 = Readonly<{
  id: string;
  label: string;
  description?: string;
  context: string;
}>;

/** Normalizes the author-visible search query once at the provider boundary. */
export function normalizeComposerReferenceQueryV1(query: string): string {
  if (typeof query !== 'string') throw new Error('Composer reference queries must be strings.');
  const normalized = query.normalize('NFC');
  if (utf8ByteLength(normalized) > MAX_COMPOSER_REFERENCE_QUERY_UTF8_BYTES_V1) {
    throw new Error(`Composer reference queries must be at most ${MAX_COMPOSER_REFERENCE_QUERY_UTF8_BYTES_V1} UTF-8 bytes.`);
  }
  return normalized;
}
