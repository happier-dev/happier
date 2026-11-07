import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

import { MENTION_BOUNDS, MENTION_KIND_V1, MentionRefV1Schema, buildMentionRefForKindV1, readMentionRefOpaqueForKindV1 } from '../runtime/input/mentionRefV1.js';
import { PortableComposerAttachmentV1Schema } from '../runtime/input/composerAttachmentV1.js';
import { formatInlineReferenceTokenV1, scanInlineReferenceTokensV1 } from '../runtime/input/inlineReferenceTokenV1.js';
import type { WorkflowStep } from './workflowV1.js';

/**
 * The saved, portable half of a Composer document: literal text, positionless
 * canonical references and contentless portable attachment records. A
 * transfer-owned staged-media claim is device-local and is deliberately not
 * durable definition content.
 */
export const WorkflowStepComposerDocumentSchema = lazyZodSchema(() => z.strictObject({
  text: z.string().check(z.minLength(1)),
  displayText: z.optional(z.string()),
  references: z._default(z.array(MentionRefV1Schema).check(z.maxLength(MENTION_BOUNDS.maxPerMessage)), []),
  attachments: z._default(z.array(PortableComposerAttachmentV1Schema), []),
}));
export type WorkflowStepComposerDocument = z.infer<typeof WorkflowStepComposerDocumentSchema>;

/** The token's binding address, shared by validation, editing and materialization. */
export function readWorkflowStepInputIndexV1(ref: string): number | null {
  const opaque = readMentionRefOpaqueForKindV1(MENTION_KIND_V1.workflowInput, ref);
  if (opaque === null || !/^\d+$/.test(opaque)) return null;
  const index = Number(opaque);
  return Number.isSafeInteger(index) ? index : null;
}

/** Removing an indexed binding must never retarget an authored token to its successor. */
export function removeWorkflowStepInputV1(step: WorkflowStep, removedIndex: number): WorkflowStep {
  const rewrittenTokens = new Map<string, string>();
  const references = step.document.references.map((mention) => {
    if (mention.kind !== MENTION_KIND_V1.workflowInput) return mention;
    const index = readWorkflowStepInputIndexV1(mention.ref);
    if (index === null || index < removedIndex) return mention;
    // Existing validation keeps this visible invalid draft token out of Save/Run.
    // A nonnumeric address cannot become valid when another binding is appended.
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.workflowInput, index === removedIndex ? 'removed' : String(index - 1));
    const inline = scanInlineReferenceTokensV1(mention.token).find(token => token.start === 0 && token.end === mention.token.length && token.ref === mention.ref);
    const token = inline ? formatInlineReferenceTokenV1({ label: inline.label, ref }) : mention.token;
    if (token !== mention.token) rewrittenTokens.set(mention.token, token);
    return { ...mention, ref, token };
  });
  let text = step.document.text;
  for (const token of scanInlineReferenceTokensV1(text).reverse()) {
    const replacement = rewrittenTokens.get(text.slice(token.start, token.end));
    if (replacement !== undefined) text = text.slice(0, token.start) + replacement + text.slice(token.end);
  }
  return { ...step, input: step.input.filter((_input, index) => index !== removedIndex),
    document: { ...step.document, text, references } };
}
