import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import {
  ComposerAttachmentAuthorValueV1Schema,
  MAX_COMPOSER_ATTACHMENT_INSTANCES_V1,
} from '../../runtime/input/composerAttachmentV1.js';

/** One attachment draft authored by the authenticated plugin caller. */
export const PluginSessionInputAttachmentV1Schema = lazyZodSchema(() => z.object({
  attachmentLocalId: asProtocolZod(PluginContributionLocalIdSchema),
  value: ComposerAttachmentAuthorValueV1Schema,
}).strict());
export type PluginSessionInputAttachmentV1 = z.infer<typeof PluginSessionInputAttachmentV1Schema>;

/** The one attachment-list boundary shared by every Session-input surface. */
export const PluginSessionInputAttachmentsV1Schema = lazyZodSchema(() => z.array(PluginSessionInputAttachmentV1Schema)
  .min(1)
  .max(MAX_COMPOSER_ATTACHMENT_INSTANCES_V1));

/** Text or at least one attachment is content; whitespace alone is not. */
export function hasSessionInputContentV1(input: Readonly<{
  text: string;
  attachmentCount: number;
}>): boolean {
  return input.text.trim().length > 0 || input.attachmentCount > 0;
}

/** Applies the canonical content rule to Session-input authoring shapes. */
export function requireSessionInputContent(
  value: Readonly<{ text?: unknown; message?: unknown; attachments?: unknown; structuredInput?: unknown }>,
  context: z.RefinementCtx,
): void {
  const raw = typeof value.text === 'string' ? value.text : value.message;
  const text = typeof raw === 'string' ? raw : '';
  const structuredInput = value.structuredInput;
  const structuredAttachments = structuredInput !== null && typeof structuredInput === 'object'
    ? (structuredInput as { composerAttachments?: unknown }).composerAttachments
    : undefined;
  const attachmentCount = (Array.isArray(value.attachments) ? value.attachments.length : 0)
    + (Array.isArray(structuredAttachments) ? structuredAttachments.length : 0);
  if (hasSessionInputContentV1({ text, attachmentCount })) return;
  context.addIssue({
    code: 'custom',
    path: [typeof value.text === 'string' || value.message === undefined ? 'text' : 'message'],
    message: 'A Session input must carry non-empty text or at least one attachment',
  });
}
