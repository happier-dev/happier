import type { Message } from '@/sync/domains/messages/messageTypes';

export function resolveForkFromMessageSemantics(params: Readonly<{
  message: Message;
  messageSeqInclusive: number;
}>): Readonly<{ upToSeqInclusive: number; restoredDraftText: string | null }> {
  const seq = Math.max(0, Math.trunc(params.messageSeqInclusive));
  if (params.message.kind !== 'user-text') {
    return { upToSeqInclusive: seq, restoredDraftText: null };
  }

  // OpenCode-style "branch and edit": fork from the state before the user message and restore it as an editable draft.
  // Only apply when there's at least one prior committed message.
  if (seq >= 2) {
    const text = typeof params.message.text === 'string' ? params.message.text : '';
    const restoredDraftText = text.trim().length > 0 ? text : null;
    return { upToSeqInclusive: Math.max(0, seq - 1), restoredDraftText };
  }

  return { upToSeqInclusive: seq, restoredDraftText: null };
}
