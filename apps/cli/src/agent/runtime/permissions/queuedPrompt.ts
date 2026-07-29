import type { PermissionMode } from '@/api/types';
import type { ProviderBoundModelRef } from '@happier-dev/protocol';
import type { HappierStructuredInputV1 } from '@happier-dev/protocol/runtime';

export type PermissionModeQueuedPromptMode = Readonly<{
  permissionMode: PermissionMode;
  appendSystemPrompt?: string | null;
  modelSelection?: ProviderBoundModelRef;
  suppressUserEcho?: boolean;
  providerPromptAlreadyResolved?: boolean;
}>;

export type PermissionModeQueuedPrompt = Readonly<{
  text: string;
  localId: string | null;
  localIds?: readonly string[];
  structuredInput?: HappierStructuredInputV1;
  /** Exact transcript rows used only to suppress replay of host-consumed local commands. */
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[];
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
  const [first] = prompts;
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
    text: prompts.map((prompt) => prompt.text).join('\n'),
    localId: first?.localId ?? null,
    ...(first?.structuredInput ? { structuredInput: first.structuredInput } : {}),
    ...(localIds.length === 0 ? {} : { localIds }),
    ...(maxUserMessageSeq === null ? {} : { userMessageSeq: maxUserMessageSeq }),
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
  };
}
