import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import {
  PluginJsonSchemaV2Schema,
  PluginLocalizedStringV2Schema,
} from './publicTypes.js';
import { PluginUiRendererChainBindingV1Schema } from './ui/rendererChainBinding.js';
import { PluginUiIconTokenV1Schema } from './ui/tokens.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/** The existing per-plugin contribution ceiling applies to attachment types. */
export const MAX_PLUGIN_COMPOSER_ATTACHMENTS_V1 = 64;

/**
 * Manifest-safe projection of the attachment lifecycle callbacks supplied by
 * an author. The callback functions themselves are activated separately and
 * are never serialized into the manifest.
 */
export const COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1 = Object.freeze([
  'prepareForSend',
  'resolveForDispatch',
  'afterMessageAccepted',
] as const);
export type ComposerAttachmentRuntimeRegistrationFieldV1 =
  typeof COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1[number];

export const PluginComposerAttachmentRuntimeDescriptorV1Schema = z.object({
  prepareForSend: z.literal(true).optional(),
  resolveForDispatch: z.literal(true).optional(),
  afterMessageAccepted: z.literal(true).optional(),
}).strict().superRefine((value, context) => {
  if (COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1.some((field) => value[field] === true)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'An attachment runtime descriptor must declare at least one lifecycle role',
  });
});
export type PluginComposerAttachmentRuntimeDescriptorV1 = z.infer<
  typeof PluginComposerAttachmentRuntimeDescriptorV1Schema
>;

/**
 * Returns only lifecycle roles from one valid manifest descriptor. Keeping the
 * parser here makes registration demand derive from the authored declaration,
 * rather than from an SDK callback object or a host-side guess.
 */
export function readComposerAttachmentRuntimeRegistrationFieldsV1(
  value: unknown,
): readonly ComposerAttachmentRuntimeRegistrationFieldV1[] {
  const parsed = PluginComposerAttachmentRuntimeDescriptorV1Schema.safeParse(value);
  return parsed.success
    ? Object.freeze(COMPOSER_ATTACHMENT_RUNTIME_REGISTRATION_FIELDS_V1.filter((field) => parsed.data[field] === true))
    : Object.freeze([]);
}

export const ComposerAttachmentDisplayV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('badge') }).strict(),
  z.object({
    kind: z.literal('media'),
    media: z.enum(['image', 'video']),
  }).strict(),
  z.object({
    kind: z.literal('surface'),
    renderer: PluginUiRendererChainBindingV1Schema,
    sizing: z.enum(['compact', 'content']),
  }).strict(),
]);
export type ComposerAttachmentDisplayV1 = z.infer<typeof ComposerAttachmentDisplayV1Schema>;

export const ComposerAttachmentPreviewV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('host'),
    presentation: z.enum(['image', 'video']),
  }).strict(),
  z.object({
    kind: z.literal('surface'),
    renderer: PluginUiRendererChainBindingV1Schema,
    presentation: z.enum(['auto', 'popover', 'dialog']),
  }).strict(),
]);
export type ComposerAttachmentPreviewV1 = z.infer<typeof ComposerAttachmentPreviewV1Schema>;

/**
 * Static manifest facts for one plugin-owned attachment type. Runtime callbacks
 * are deliberately absent: activation binds them only after this declaration
 * has been admitted for the current plugin generation.
 */
export const PluginComposerAttachmentContributionV1Schema = z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  icon: PluginUiIconTokenV1Schema,
  cardinality: z.enum(['one', 'many']),
  valueSchema: PluginJsonSchemaV2Schema,
  preparedValueSchema: PluginJsonSchemaV2Schema.optional(),
  picker: PluginUiRendererChainBindingV1Schema.optional(),
  display: ComposerAttachmentDisplayV1Schema.optional(),
  preview: ComposerAttachmentPreviewV1Schema.optional(),
  runtime: PluginComposerAttachmentRuntimeDescriptorV1Schema.optional(),
}).strict().superRefine((value, context) => {
  if (value.preparedValueSchema === undefined) return;
  if (createCanonicalJsonSigningInput(value.preparedValueSchema) === createCanonicalJsonSigningInput(value.valueSchema)) return;
  if (value.runtime?.prepareForSend === true) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['preparedValueSchema'],
    message: 'A distinct preparedValueSchema requires runtime.prepareForSend',
  });
});
export type PluginComposerAttachmentContributionV1 = z.infer<
  typeof PluginComposerAttachmentContributionV1Schema
>;
