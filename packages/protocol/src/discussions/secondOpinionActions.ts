import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DiscussionAddressV1Schema, DiscussionLocalIdSchema, DiscussionTitleV1Schema } from './content.js';
import { DiscussionMessageRefV1Schema } from './messageRefs.js';
import { DiscussionInitialAccountParticipantsV1Schema } from './participants.js';
import { SessionSpawnNewInputV2Schema } from '../sessions/creation/sessionSpawnNewInputV2.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { SessionCreationTargetPreparationRequestV1Schema } from '../sessions/creation/sessionCreationTargetPreparationV1.js';
import { DiscussionSessionParticipantRefV1Schema } from './references.js';
import { WorkflowProjectTargetV1Schema } from '../workflows/workflowWorkspaceV1.js';
import {
  DiscussionSecondOpinionSourceV1Schema,
  DiscussionSecondOpinionReviewerV1Schema,
  DiscussionSecondOpinionPreviewV1Schema,
} from './secondOpinion.js';

/** One retained draft supplies the same resource, quote and question identities on every retry. */
export const DiscussionSecondOpinionRetryV1Schema = lazyZodSchema(() => z.strictObject({
  creationLocalId: DiscussionLocalIdSchema,
  quoteLocalId: DiscussionLocalIdSchema,
  questionLocalId: DiscussionLocalIdSchema,
}).check(z.refine(value => new Set(Object.values(value)).size === 3,
  'Create, quote and question retry identities must be distinct')));

export const DiscussionSecondOpinionStartInputV1Schema = lazyZodSchema(() => z.strictObject({
  intent: z.enum(['preview', 'ask']),
  source: DiscussionSecondOpinionSourceV1Schema,
  title: DiscussionTitleV1Schema.shape.title,
  question: z.string().check(z.refine(value => value === value.normalize('NFC'), 'A question must contain normalized text')),
  reviewers: z.array(DiscussionSecondOpinionReviewerV1Schema),
  participants: z.optional(DiscussionInitialAccountParticipantsV1Schema),
  /** The actual invoking Agent Session is shown as the publishing participant; never alternate producer authority. */
  publisherSessionId: z.optional(DiscussionSessionParticipantRefV1Schema.shape.sessionId),
  retry: DiscussionSecondOpinionRetryV1Schema,
  confirmedPreview: z.optional(DiscussionSecondOpinionPreviewV1Schema),
  /** Ordinary Workflow execution placement for a multi-reviewer ask. */
  project: z.optional(WorkflowProjectTargetV1Schema),
}).check(z.refine(value => value.intent === 'preview' && value.reviewers.length === 0 || value.question.trim().length > 0,
  'A reviewer question must contain text'), z.refine(value => value.intent !== 'ask' || value.reviewers.length > 0,
  'Ask requires at least one reviewer'), z.refine(value => value.intent !== 'ask' || value.confirmedPreview !== undefined,
  'Ask requires the explicit source-access preview')));
export type DiscussionSecondOpinionStartInputV1 = z.infer<typeof DiscussionSecondOpinionStartInputV1Schema>;

/** Exact public child shape only; the receiver separately proves this Discussion's retained creation and slot. */
export function isDiscussionSecondOpinionModelRpcMethodV1(method: string): boolean {
  return method === RPC_METHODS.SESSION_SPAWN_NEW || method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT;
}

export function readDiscussionSecondOpinionModelChildV1(rootInput: unknown, machineId: string, childInput: unknown,
  method: string = RPC_METHODS.SESSION_SPAWN_NEW) {
  const root = DiscussionSecondOpinionStartInputV1Schema.safeParse(rootInput);
  if (!root.success || root.data.intent !== 'ask') return null;
  for (const reviewer of root.data.reviewers) {
  if (reviewer.selection.kind !== 'model' || !reviewer.participantSlotId
    || reviewer.selection.launch.executionTarget.machineId !== machineId) continue;
  const launch = reviewer.selection.launch;
  if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
    const child = SessionCreationTargetPreparationRequestV1Schema.safeParse(childInput);
    if (launch.directory.kind === 'path' && !launch.checkoutCreationDraft && child.success
      && sameStrictJsonValue(child.data, { directory: launch.directory })
      ) return { root: root.data, reviewer, launch, spawn: null };
    continue;
  }
  const child = SessionSpawnNewInputV2Schema.safeParse(childInput);
  if (method !== RPC_METHODS.SESSION_SPAWN_NEW || !child.success
    || child.data.executionTarget.machineId !== machineId || !child.data.discussionParticipant) continue;
  const expected = SessionSpawnNewInputV2Schema.safeParse({ ...launch,
    // Connection labels are local routing, not Home identity. The receiver
    // proves both labels against its captured Home before spending the child.
    executionTarget: { ...launch.executionTarget, serverId: child.data.executionTarget.serverId },
    creationKey: reviewer.participantSlotId, initialTriggers: [],
    discussionParticipant: { discussionId: child.data.discussionParticipant.discussionId,
      participantSlotId: reviewer.participantSlotId },
  });
  if (expected.success && sameStrictJsonValue(expected.data, child.data)) return { root: root.data, reviewer, launch, spawn: child.data };
  }
  return null;
}

const PartialProgressShape = {
  grantedAccountIds: z.array(DiscussionLocalIdSchema),
  discussion: z.optional(DiscussionAddressV1Schema),
};
export const DiscussionSecondOpinionStartResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('preview'), preview: DiscussionSecondOpinionPreviewV1Schema, sourceText: z.string() }),
  z.strictObject({ status: z.literal('preview_changed'), preview: DiscussionSecondOpinionPreviewV1Schema, ...PartialProgressShape }),
  z.strictObject({ status: z.literal('asked'), mode: z.enum(['ask', 'fresh_opinions']), discussion: DiscussionAddressV1Schema,
    messageRef: DiscussionMessageRefV1Schema, grantedAccountIds: z.array(DiscussionLocalIdSchema), runId: z.optional(z.string()) }),
  z.strictObject({ status: z.literal('pending'), stage: z.enum(['grant', 'create', 'invite', 'ask', 'workflow']),
    errorCode: z.string().check(z.minLength(1)), ...PartialProgressShape }),
]));
export type DiscussionSecondOpinionStartResultV1 = z.infer<typeof DiscussionSecondOpinionStartResultV1Schema>;
