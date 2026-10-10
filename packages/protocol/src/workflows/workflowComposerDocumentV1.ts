import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { MENTION_BOUNDS, MentionRefV1Schema } from '../runtime/input/mentionRefV1.js';
import { PortableComposerAttachmentV1Schema } from '../runtime/input/composerAttachmentV1.js';

/**
 * The saved, portable half of a Composer document: literal text, positionless
 * canonical references and contentless portable attachment records. A
 * transfer-owned staged-media claim is device-local and is deliberately not
 * durable definition content.
 */
export const WorkflowStepComposerDocumentSchema = lazyZodSchema(() => z.object({
  text: z.string().min(1),
  displayText: z.string().optional(),
  references: z.array(MentionRefV1Schema).max(MENTION_BOUNDS.maxPerMessage).default([]),
  attachments: z.array(PortableComposerAttachmentV1Schema).default([]),
}).strict());
export type WorkflowStepComposerDocument = z.infer<typeof WorkflowStepComposerDocumentSchema>;
