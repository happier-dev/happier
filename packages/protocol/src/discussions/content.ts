import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { DocEditProposalV1Schema, DocPassageRefV1Schema } from '../artifacts/artifactCollaborationV1.js';

import { DiscussionIdSchema, DiscussionLocalIdSchema } from './references.js';
export {
  DiscussionIdSchema, DiscussionMessageIdSchema, DiscussionLocalIdSchema,
  DiscussionAccountIdSchema, DiscussionAddressV1Schema, DiscussionSelectionSourceV1Schema,
} from './references.js';
export type { DiscussionId, DiscussionMessageId, DiscussionLocalId, DiscussionAddressV1,
  DiscussionSelectionSourceV1 } from './references.js';
import { DiscussionParticipantRefV1Schema } from './references.js';
import { SessionInputReturnedAnswerV1Schema, SessionInputSourceSessionV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { SessionMessageDiscussionReplyReturnV1Schema } from '../sessions/messages/sessionMessageReplyV1.js';
import { ActionRequestAttributionV1Schema } from '../actions/actionRequestAttributionV1.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { WorkflowDecimalV1Schema } from '../workflows/workflowProgressV1.js';
import { WorkflowRunIdV1Schema, WorkflowInvocationRecordIdSchema } from '../workflows/workflowIdsV1.js';
import { MentionRefV1Schema } from '../runtime/input/mentionRefV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { ComposerReferenceTriggerV1Schema } from '../plugins/contributions/composerReferenceProviders.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { StoredAttachmentPayloadV1Schema, readAttachmentPayloadFilesV1, type StoredAttachmentPayloadV1 } from '../transfers/attachments/attachmentPayloadV1.js';
import type { BinaryBlobReferenceV1 } from '../storage/binaryBlobV1.js';

function nfcString() {
  return z.string().check(z.refine((value) => value === value.normalize('NFC'), 'Session discussion text must be NFC-normalized'));
}

export const DiscussionTitleV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  title: nfcString().check(z.refine((value) => value.trim().length > 0, 'A discussion title must not be blank')),
}));
export type DiscussionTitleV1 = z.infer<typeof DiscussionTitleV1Schema>;
export const DiscussionTitleV1StoredSchema = createStoredReadSchema(DiscussionTitleV1Schema);

// The shared reference grammar owns identity and bounds. Fresh Discussion
// content closes its known extension fields; references never become routing.
const DiscussionInlineReferenceV1Schema = lazyZodSchema(() => {
  const schema = z.extend(MentionRefV1Schema, {
    composerReference: z.optional(asProtocolZod(PluginContributionIdentityV1Schema)),
    composerReferenceTrigger: z.optional(ComposerReferenceTriggerV1Schema),
  });
  return z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<typeof schema.shape, z.core.$strict>;
});

export const DiscussionMessagePartV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('text'), text: nfcString() }),
  z.strictObject({ t: z.literal('mention'), participant: DiscussionParticipantRefV1Schema }),
  z.strictObject({ t: z.literal('reference'), reference: DiscussionInlineReferenceV1Schema }),
  z.strictObject({ t: z.literal('attachment'), attachment: StoredAttachmentPayloadV1Schema }),
]));
export type DiscussionMessagePartV1 = z.infer<typeof DiscussionMessagePartV1Schema>;

/** Immutable authored proposal; its disposition is separate host output. */
export const DiscussionDocEditProposalContentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('doc_edit_proposal'),
  proposal: DocEditProposalV1Schema,
}));
export type DiscussionDocEditProposalContentV1 = z.infer<typeof DiscussionDocEditProposalContentV1Schema>;

/** Display provenance is sealed with the body and never supplies posting authority. */
export const DiscussionExternalSourceV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('channel'),
  providerPluginId: z.string().check(z.minLength(1)),
  conversationDisplayName: nfcString().check(z.minLength(1)),
  senderDisplayName: z.optional(nfcString().check(z.minLength(1))),
  /** Sealed correlation to accepted ingress; never posting or access authority. */
  inputLocalId: z.optional(DiscussionLocalIdSchema),
}));
export type DiscussionExternalSourceV1 = z.infer<typeof DiscussionExternalSourceV1Schema>;

/**
 * The authored human document must contain meaningful parts. Adjacent empty text
 * runs are rejected so clients agree about visible content and retry equality.
 */
export const DiscussionTextMessageContentV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  parts: z.array(DiscussionMessagePartV1Schema).check(z.minLength(1)),
  externalSource: z.optional(DiscussionExternalSourceV1Schema),
}).check(z.superRefine((value, context) => {
  let hasMeaningfulPart = false;
  for (let index = 0; index < value.parts.length; index += 1) {
    const part = value.parts[index]!;
    if (part.t !== 'text') {
      hasMeaningfulPart = true;
      continue;
    }
    if (part.text.trim().length > 0) {
      hasMeaningfulPart = true;
      continue;
    }
    const previous = index > 0 ? value.parts[index - 1] : undefined;
    if (!previous || previous.t === 'text') {
      context.addIssue({
        code: 'custom',
        path: ['parts', index],
        message: 'Discussion content must not contain adjacent or leading empty text parts',
      });
    }
  }
  if (!hasMeaningfulPart) {
    context.addIssue({
      code: 'custom',
      path: ['parts'],
      message: 'Discussion content must contain at least one mention, reference, attachment or non-blank text run',
    });
  }
  const roots = new Set<string>(), blobs = new Set<string>();
  for (const [index, part] of value.parts.entries()) {
    if (part.t !== 'attachment') continue;
    if (roots.has(part.attachment.id)) context.addIssue({ code: 'custom', path: ['parts', index], message: 'Attachment identities must be unique' });
    roots.add(part.attachment.id);
    for (const file of readAttachmentPayloadFilesV1(part.attachment)) {
      if (blobs.has(file.blobId)) context.addIssue({ code: 'custom', path: ['parts', index], message: 'Attachment leaf identities must be unique' });
      blobs.add(file.blobId);
    }
  }
})));
export type DiscussionTextMessageContentV1 = z.infer<typeof DiscussionTextMessageContentV1Schema>;

/** Passage details remain inside the existing plain/encrypted message envelope. */
export const DiscussionDocPassageCommentContentV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('doc_passage_comment'),
  passage: DocPassageRefV1Schema,
  content: DiscussionTextMessageContentV1Schema,
}));
export type DiscussionDocPassageCommentContentV1 = z.infer<typeof DiscussionDocPassageCommentContentV1Schema>;

export const DiscussionMessageContentV1Schema = lazyZodSchema(() => z.union([
  DiscussionTextMessageContentV1Schema,
  z.strictObject({ kind: z.literal('workflow_result'), value: StrictJsonValueSchema, summary: nfcString(),
    source: z.strictObject({ runId: WorkflowRunIdV1Schema, invocationRecordId: WorkflowInvocationRecordIdSchema,
      invocationAttempt: WorkflowDecimalV1Schema }) }),
  DiscussionDocPassageCommentContentV1Schema,
  DiscussionDocEditProposalContentV1Schema,
]));
export type DiscussionMessageContentV1 = z.infer<typeof DiscussionMessageContentV1Schema>;
export const DiscussionMessageContentV1StoredSchema = createStoredReadSchema(DiscussionMessageContentV1Schema);

export function isDiscussionDocEditProposalContentV1(content: DiscussionMessageContentV1): content is DiscussionDocEditProposalContentV1 {
  return 'kind' in content && content.kind === 'doc_edit_proposal';
}

/** Text consumers share one projection; previews omit reviewed Doc text, full human reads retain it. */
export function readDiscussionMessagePartsV1(content: DiscussionMessageContentV1,
  projection: 'body' | 'preview' = 'body'): readonly DiscussionMessagePartV1[] {
  if (!('kind' in content)) return content.parts;
  if (content.kind === 'workflow_result') return [{ t: 'text', text: content.summary }];
  if (content.kind === 'doc_passage_comment') return content.content.parts;
  if (projection === 'preview') return [{ t: 'text', text: content.proposal.reason }];
  return [{ t: 'text', text: [content.proposal.before, content.proposal.after, content.proposal.reason].join('\n') }];
}

/** Opened tree metadata only: history projection never acquires file bytes. */
export function readDiscussionAttachmentPayloadsV1(content: DiscussionMessageContentV1): readonly StoredAttachmentPayloadV1[] {
  return readDiscussionMessagePartsV1(content).flatMap(part => part.t === 'attachment' ? [part.attachment] : []);
}

export function readDiscussionAttachmentReferencesV1(content: DiscussionMessageContentV1): readonly BinaryBlobReferenceV1[] {
  return readDiscussionAttachmentPayloadsV1(content).flatMap(attachment => readAttachmentPayloadFilesV1(attachment));
}

/** Strict content projection shared by composers, codecs and server routing admission. */
export function readDiscussionMentionedParticipantIdsV1(content: DiscussionMessageContentV1): {
  mentionedAccountIds: string[]; mentionedSessionIds: string[];
} {
  const parsed = DiscussionMessageContentV1Schema.parse(content);
  const accounts = new Set<string>(), sessions = new Set<string>();
  for (const part of readDiscussionMessagePartsV1(parsed)) {
    if (part.t !== 'mention') continue;
    if (part.participant.kind === 'account') accounts.add(part.participant.accountId);
    else sessions.add(part.participant.sessionId);
  }
  return { mentionedAccountIds: [...accounts].sort(), mentionedSessionIds: [...sessions].sort() };
}

/**
 * Mandatory host-stamped attribution for a discussion message an Agent posted
 * on behalf of its authenticated execution Account. It is descriptive display
 * metadata: the authenticated principal, never this field, is authority.
 */
export const DiscussionAgentProducerV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal('agent'),
  sessionId: DiscussionIdSchema,
  runId: z.optional(DiscussionIdSchema),
  toolCallId: z.optional(DiscussionIdSchema),
  /** Exact host-stamped causal turn/input, never inferred from display identity. */
  sourceSession: z.optional(SessionInputSourceSessionV1Schema),
  /** Content-free original request cause, stamped only from protected reply custody by the append owner. */
  actionRequestAttributionV1: z.optional(ActionRequestAttributionV1Schema),
  /** Output-only snapshot of the original obligation, stamped by the append owner. */
  replyReturn: z.optional(z.extend(SessionMessageDiscussionReplyReturnV1Schema, {
    outcome: SessionInputReturnedAnswerV1Schema.shape.outcome,
  })),
}).check(z.refine(value => value.sourceSession === undefined || value.sourceSession.sourceSessionId === value.sessionId,
  'A Discussion producer causal source must belong to its actual Session')));
/** Exact accepted Workflow execution, without a fabricated Agent or Session. */
export const DiscussionWorkflowProducerV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('workflow'), runId: WorkflowRunIdV1Schema,
  invocationRecordId: WorkflowInvocationRecordIdSchema, invocationAttempt: WorkflowDecimalV1Schema,
  execution: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('action'), actionId: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('detached_run'), executionRunId: DiscussionIdSchema }),
    z.strictObject({ kind: z.literal('not_started'), blockKind: z.enum(['step', 'action']) }),
  ]),
  outcome: SessionInputReturnedAnswerV1Schema.shape.outcome,
}));
export type DiscussionWorkflowProducerV1 = z.infer<typeof DiscussionWorkflowProducerV1Schema>;
export const DiscussionProducerV1Schema = lazyZodSchema(() => z.union([
  DiscussionAgentProducerV1Schema, DiscussionWorkflowProducerV1Schema,
]));
export type DiscussionProducerV1 = z.infer<typeof DiscussionProducerV1Schema>;
export const DiscussionProducerV1StoredSchema = createStoredReadSchema(DiscussionProducerV1Schema);

