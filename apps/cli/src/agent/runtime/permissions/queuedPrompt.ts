export type PermissionModeQueuedPrompt = Readonly<{
  text: string;
  localId: string | null;
  localIds?: readonly string[];
  /**
   * Committed transcript seq of the user row this prompt came from (HF-1 watermark custody).
   * Travels with the prompt through the queue so provider acceptance can confirm the
   * owed-delivery watermark for exactly the accepted rows. Absent when the row seq is unknown
   * (the watermark then stays behind — at-least-once redelivery, never silent loss).
   */
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
  /**
   * Pending-queue local ids whose delivery is already owned by the provider path.
   * These prompts intentionally may not have a committed transcript seq yet, so
   * the prompt loop must not wait for a committed row before dispatching them.
   */
  providerClaimedPendingLocalIds?: readonly string[];
}>;

function appendUniqueString(target: string[], value: unknown): void {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || target.includes(normalized)) return;
  target.push(normalized);
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

export function normalizePermissionModeQueuedPromptProviderClaimedPendingLocalIds(
  prompt: PermissionModeQueuedPrompt,
): string[] {
  const localIds: string[] = [];
  for (const localId of prompt.providerClaimedPendingLocalIds ?? []) {
    appendUniqueString(localIds, localId);
  }
  return localIds;
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
  const [first] = prompts;
  const localIds: string[] = [];
  const userMessageSeqs: number[] = [];
  const providerClaimedPendingLocalIds: string[] = [];
  for (const prompt of prompts) {
    for (const localId of normalizePermissionModeQueuedPromptLocalIds(prompt)) {
      appendUniqueString(localIds, localId);
    }
    for (const seq of normalizePermissionModeQueuedPromptUserMessageSeqs(prompt)) {
      appendUniqueSeq(userMessageSeqs, seq);
    }
    for (const localId of normalizePermissionModeQueuedPromptProviderClaimedPendingLocalIds(prompt)) {
      appendUniqueString(providerClaimedPendingLocalIds, localId);
    }
  }
  const maxUserMessageSeq = userMessageSeqs.length === 0 ? null : Math.max(...userMessageSeqs);
  return {
    text: prompts.map((prompt) => prompt.text).join('\n'),
    localId: first?.localId ?? null,
    ...(localIds.length === 0 ? {} : { localIds }),
    ...(maxUserMessageSeq === null ? {} : { userMessageSeq: maxUserMessageSeq }),
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
    ...(providerClaimedPendingLocalIds.length === 0 ? {} : { providerClaimedPendingLocalIds }),
  };
}
