import type { Message } from '../domains/messages/messageTypes';
import type { StorageState } from './types';

export type MessageStoreRef = Readonly<{
  sessionId: string;
  messageId: string;
}>;

type MessagesByRefsSelectorSnapshot = Readonly<{
  messages: readonly (Message | null)[];
}>;

const EMPTY_MESSAGES_BY_REFS_SELECTOR_SNAPSHOT: MessagesByRefsSelectorSnapshot = Object.freeze({
  messages: Object.freeze([]) as readonly (Message | null)[],
});

const legacyMessageSignatureCache = new WeakMap<Message, Readonly<{
  messagesVersion: number;
  signature: string;
}>>();

export function buildMessageLegacySignature(message: Message | null, messagesVersion: number): string {
  if (!message) return 'null';
  const cached = legacyMessageSignatureCache.get(message);
  if (cached?.messagesVersion === messagesVersion) return cached.signature;

  let signature: string;
  try {
    signature = JSON.stringify(message) ?? 'null';
  } catch {
    signature = `${message.id}:${message.kind}:${message.createdAt}`;
  }
  legacyMessageSignatureCache.set(message, { messagesVersion, signature });
  return signature;
}

export function buildMessageRefsSelectionKey(messageRefs: readonly MessageStoreRef[]): string {
  return messageRefs
    .map((ref) => `${ref.sessionId.length}:${ref.sessionId}:${ref.messageId.length}:${ref.messageId}`)
    .join('|');
}

function areMessageRefsEqual(
  previous: readonly (Message | null)[] | null,
  next: readonly (Message | null)[],
): boolean {
  if (previous === null || previous.length !== next.length) return false;
  return previous.every((message, index) => message === next[index]);
}

export function createMessagesByRefsSelector(
  selectedRefs: readonly MessageStoreRef[],
): (state: StorageState) => MessagesByRefsSelectorSnapshot {
  let previousSignature: string | null = null;
  let previousMessageRefs: readonly (Message | null)[] | null = null;
  let previousSnapshot: MessagesByRefsSelectorSnapshot | null = null;

  return (state) => {
    if (selectedRefs.length === 0) return EMPTY_MESSAGES_BY_REFS_SELECTOR_SNAPSHOT;

    const messages: Array<Message | null> = [];
    const signatureParts: string[] = [];
    for (const ref of selectedRefs) {
      const session = state.sessionMessages[ref.sessionId];
      const message = session?.messagesById?.[ref.messageId] ?? null;
      const revision = session?.messageRevisionsById?.[ref.messageId];
      messages.push(message);
      signatureParts.push(ref.sessionId, ref.messageId);
      if (typeof revision === 'number' && Number.isFinite(revision)) {
        signatureParts.push(`r:${Math.trunc(revision)}`);
      } else {
        signatureParts.push(`l:${buildMessageLegacySignature(message, session?.messagesVersion ?? 0)}`);
      }
    }

    const signature = signatureParts.join('\u0000');
    if (
      previousSnapshot !== null
      && previousSignature === signature
      && areMessageRefsEqual(previousMessageRefs, messages)
    ) {
      return previousSnapshot;
    }

    previousSignature = signature;
    previousMessageRefs = messages;
    previousSnapshot = { messages };
    return previousSnapshot;
  };
}
