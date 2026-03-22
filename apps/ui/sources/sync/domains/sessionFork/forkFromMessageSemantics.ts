import type { Message } from '@/sync/domains/messages/messageTypes';

export function resolveForkFromMessageSemantics(params: Readonly<{
  message: Message;
  messageSeqInclusive: number;
}>): Readonly<{ upToSeqInclusive: number; restoredDraftText: string | null }> {
  const seq = Math.max(0, Math.trunc(params.messageSeqInclusive));
  if (params.message.kind !== 'user-text') {
    return { upToSeqInclusive: seq, restoredDraftText: null };
  }

  // Generic "branch and edit" semantics: fork from the state before the clicked user message and
  // restore that user message as an editable draft when there is earlier committed context.
  //
  // Important: keep `upToSeqInclusive` equal to the clicked message seq so provider-native forks can resolve
  // vendor message ids precisely. The daemon will compute the effective replay cutoff (seq - 1) for user messages.
  if (seq >= 2) {
    const text = typeof params.message.text === 'string' ? params.message.text : '';
    const restoredDraftText = text.trim().length > 0 ? text : null;
    return { upToSeqInclusive: seq, restoredDraftText };
  }

  return { upToSeqInclusive: seq, restoredDraftText: null };
}
