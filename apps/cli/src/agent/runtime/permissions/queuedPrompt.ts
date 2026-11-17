import type { PermissionMode } from '@/api/types';
import type {
  SessionModelRef,
  CallerInputConstraintsV1,
  SessionInputCausalPermissionAuthorityV1,
  SessionMediaItemV1,
  WorkerUpdateV1,
  SessionMessageProvenance,
} from '@happier-dev/protocol';
import type { HappierStructuredInputV1 } from '@happier-dev/protocol/runtime';
import type { SessionFollowQueuedDelivery, SessionFollowReconciledContext } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import type { WorkflowInvocationIdentity } from '@/agent/runtime/session/contextOnly/hostContextOnlyInput';
import type { WorkflowStepWithdrawal } from '@/agent/runtime/session/contextOnly/workflowStepWithdrawal';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { SessionInputReturnedAnswerV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/participants';
import type { FileReviewNoteV1 } from '@happier-dev/protocol/messages/structured/fileReviewNoteV1';
import type { SessionAttachmentDescriptorV1 } from '@happier-dev/protocol/messages/structured/sessionAttachmentsInputV1';

export type HostContextOnlyInput = (
  | Readonly<{ kind: 'session_follow'; prepared: SessionFollowReconciledContext }>
  | Readonly<{
      kind: 'worker_update'; update: WorkerUpdateV1;
      recheckAdmission: (signal: AbortSignal) => Promise<boolean>;
      acknowledgeAccepted: () => void;
    }>
  | Readonly<{
      kind: 'workflow_step'; localInputId: string; text: string;
      workflowInvocation: WorkflowInvocationIdentity;
      workDepth: number;
      isWorkflowStepDeliverable: (input: Readonly<{ localInputId: string }>) => Promise<boolean>;
      withdrawal: WorkflowStepWithdrawal;
      acknowledgeAccepted: () => void;
    }>
) & Readonly<{ commitHostEvent: (workerEvents?: readonly Readonly<{ localId: string; update: WorkerUpdateV1 }>[]) => Promise<void> }>;

export type PermissionModeQueuedPromptMode = Readonly<{
  discussionAddressing?: DiscussionAddressingV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  callerInputConstraints?: CallerInputConstraintsV1;
  permissionMode: PermissionMode;
  appendSystemPrompt?: string | null;
  modelSelection?: SessionModelRef;
  suppressUserEcho?: boolean;
  providerPromptAlreadyResolved?: boolean;
  /** Exact admitted-input authority; this is part of the batching identity. */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  /** Host-rendered descriptive block; exact bytes are part of batching identity. */
  inputContextBlock?: string;
  /** Protected admission provenance retained as data for host turn stamping. */
  inputProvenance?: SessionMessageProvenance;
  returnedAnswer?: SessionInputReturnedAnswerV1;
}>;

export type PermissionModeQueuedPrompt = Readonly<{
  /** Validated descriptive note backed by the original informational admission receipt. */
  fileReviewNote?: FileReviewNoteV1;
  fileReviewNoteContext?: readonly Readonly<{ note: FileReviewNoteV1; localId: string | null; userMessageSeq: number | null }>[];
  discussionAddressing?: DiscussionAddressingV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  text: string;
  localId: string | null;
  localIds?: readonly string[];
  structuredInput?: HappierStructuredInputV1;
  /** Upload descriptors from this message's canonical attachments.v1 metadata. */
  attachments?: readonly SessionAttachmentDescriptorV1[];
  /** Exact durable items matched to the admitted Composer SessionMedia refs. */
  sessionMedia?: readonly SessionMediaItemV1[];
  /** Exact transcript rows used only to suppress replay of host-consumed local commands. */
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  /** Immutable authority for the exact admitted input(s) in this queue batch. */
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  /** Host-rendered descriptive block applied only at the provider boundary. */
  inputContextBlock?: string;
  inputProvenance?: SessionMessageProvenance;
  returnedAnswer?: SessionInputReturnedAnswerV1;
  /** Retained information joins this real input without adopting its authority. */
  returnedAnswerContext?: readonly Readonly<{
    reply: SessionInputReturnedAnswerV1; text: string;
    localId: string | null; userMessageSeq: number | null;
  }>[];
  /** Public receipt-bound originals retain their own identity when joining another turn. */
  followDeliveries?: readonly SessionFollowQueuedDelivery[];
  /** Trusted host-only turn input. It is never inserted into MessageQueue/Pending/transcript. */
  hostContextOnly?: HostContextOnlyInput;
}>;

function appendUniqueString(target: string[], value: unknown): void {
  if (typeof value !== 'string' || value.trim().length === 0 || target.includes(value)) return;
  target.push(value);
}

function appendUniqueSeq(target: number[], value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return;
  if (target.includes(value as number)) return;
  target.push(value as number);
}

export function normalizePermissionModeQueuedPromptLocalIds(
  prompt: PermissionModeQueuedPrompt,
): string[] {
  const localIds: string[] = [];
  appendUniqueString(localIds, prompt.localId);
  for (const localId of prompt.localIds ?? []) {
    appendUniqueString(localIds, localId);
  }
  return localIds;
}

export function normalizePermissionModeQueuedPromptUserMessageSeqs(
  prompt: PermissionModeQueuedPrompt,
): number[] {
  const seqs: number[] = [];
  for (const seq of prompt.userMessageSeqs ?? []) {
    appendUniqueSeq(seqs, seq);
  }
  appendUniqueSeq(seqs, prompt.userMessageSeq);
  return seqs;
}

export function readHighestPermissionModeQueuedPromptUserMessageSeq(
  prompt: PermissionModeQueuedPrompt,
): number | null {
  const seqs = normalizePermissionModeQueuedPromptUserMessageSeqs(prompt);
  return seqs.length === 0 ? null : Math.max(...seqs);
}

export function combinePermissionModeQueuedPrompts(
  prompts: readonly PermissionModeQueuedPrompt[],
): PermissionModeQueuedPrompt {
  if (prompts.some((prompt) => prompt.hostContextOnly)) {
    throw new Error('Host context-only prompts cannot be queued or batched');
  }
  if (prompts.length > 1 && prompts.some((prompt) => prompt.structuredInput || prompt.attachments?.length)) {
    // Structured input carries one message's fresh dispatch-time context. Queue insertion must
    // isolate it, so reaching the prose batcher would either merge incompatible context or drop
    // a later structured entry.
    throw new Error('Cannot combine multiple structured prompts');
  }
  const [first] = prompts;
  if (prompts.some(prompt => !sameStrictJsonValue(prompt.discussionAddressing ?? null, first?.discussionAddressing ?? null))) {
    throw new Error('Cannot combine distinct Discussion question cutoffs');
  }
  if (prompts.some(prompt => !sameStrictJsonValue(
    prompt.actionRequestAttributionV1 ?? null, first?.actionRequestAttributionV1 ?? null,
  ))) {
    throw new Error('Cannot combine distinct admitted request causes');
  }
  const localIds: string[] = [];
  const userMessageSeqs: number[] = [];
  for (const prompt of prompts) {
    for (const localId of normalizePermissionModeQueuedPromptLocalIds(prompt)) {
      appendUniqueString(localIds, localId);
    }
    for (const seq of normalizePermissionModeQueuedPromptUserMessageSeqs(prompt)) {
      appendUniqueSeq(userMessageSeqs, seq);
    }
  }
  const maxUserMessageSeq = userMessageSeqs.length === 0 ? null : Math.max(...userMessageSeqs);
  return {
    ...(first?.discussionAddressing ? { discussionAddressing: first.discussionAddressing } : {}),
    text: prompts.map((prompt) => prompt.text).join('\n'),
    localId: first?.localId ?? null,
    ...(first?.actionRequestAttributionV1 ? { actionRequestAttributionV1: first.actionRequestAttributionV1 } : {}),
    ...(first?.structuredInput ? { structuredInput: first.structuredInput } : {}),
    ...(first?.attachments ? { attachments: first.attachments } : {}),
    ...(first?.sessionMedia ? { sessionMedia: first.sessionMedia } : {}),
    ...(localIds.length === 0 ? {} : { localIds }),
    ...(maxUserMessageSeq === null ? {} : { userMessageSeq: maxUserMessageSeq }),
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
    ...(first?.causalPermissionAuthority
      ? { causalPermissionAuthority: first.causalPermissionAuthority }
      : {}),
    ...(first?.inputContextBlock
      ? { inputContextBlock: first.inputContextBlock }
      : {}),
    ...(first?.inputProvenance ? { inputProvenance: first.inputProvenance } : {}),
    ...(first?.returnedAnswer ? { returnedAnswer: first.returnedAnswer } : {}),
    ...(first?.fileReviewNote ? { fileReviewNote: first.fileReviewNote } : {}),
    ...(prompts.some(prompt => prompt.fileReviewNoteContext?.length)
      ? { fileReviewNoteContext: prompts.flatMap(prompt => prompt.fileReviewNoteContext ?? []) } : {}),
    ...(prompts.some(prompt => prompt.returnedAnswerContext?.length)
      ? { returnedAnswerContext: prompts.flatMap(prompt => prompt.returnedAnswerContext ?? []) } : {}),
    ...(prompts.some(prompt => prompt.followDeliveries?.length)
      ? { followDeliveries: prompts.flatMap(prompt => prompt.followDeliveries ?? []) } : {}),
  };
}

export function isNextTurnContextQueuedPrompt(prompt: PermissionModeQueuedPrompt): boolean {
  return prompt.fileReviewNote !== undefined || prompt.returnedAnswer?.delivery === 'next_turn'
    || Boolean(prompt.followDeliveries?.length && prompt.followDeliveries.every(({ delivery }) =>
      delivery.delivery === 'next_turn'));
}

export function appendNextTurnContextToQueuedPrompt(
  prompt: PermissionModeQueuedPrompt,
  context: readonly PermissionModeQueuedPrompt[],
): PermissionModeQueuedPrompt {
  const localIds = normalizePermissionModeQueuedPromptLocalIds(prompt);
  const userMessageSeqs = normalizePermissionModeQueuedPromptUserMessageSeqs(prompt);
  const answers = [...prompt.returnedAnswerContext ?? []];
  const followDeliveries = [...prompt.followDeliveries ?? []];
  const fileReviewNotes = [...prompt.fileReviewNoteContext ?? []];
  for (const item of context) {
    if (!isNextTurnContextQueuedPrompt(item)) throw new Error('Only protected next-turn information can join an input');
    if (item.returnedAnswer) answers.push({ reply: item.returnedAnswer, text: item.text,
      localId: item.localId, userMessageSeq: item.userMessageSeq ?? null });
    if (item.fileReviewNote && !(item.localId !== null && fileReviewNotes.some(note => note.localId === item.localId))) {
      fileReviewNotes.push({ note: item.fileReviewNote, localId: item.localId, userMessageSeq: item.userMessageSeq ?? null });
    }
    followDeliveries.push(...item.followDeliveries ?? []);
    // Retained information is represented context, not another native primary
    // input or permission witness. Its exact identity travels with that context.
  }
  return { ...prompt,
    ...(fileReviewNotes.length ? { fileReviewNoteContext: fileReviewNotes } : {}),
    localIds, ...(userMessageSeqs.length ? { userMessageSeqs,
    userMessageSeq: Math.max(...userMessageSeqs) } : {}),
    ...(answers.length ? { returnedAnswerContext: answers } : {}),
    ...(followDeliveries.length ? { followDeliveries } : {}) };
}
