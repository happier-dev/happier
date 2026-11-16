import type { Message } from "@happier-dev/session-core/messages";
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

/**
 * `retain(previous, next)` lets a reader keep the message it already holds across a change it does not
 * present (a streamed text delta for a row whose text leaf follows it): that reader is not notified.
 */
export type MessagesByRefsSelectorOptions = Readonly<{
  retain?: (previous: Message, next: Message) => boolean;
}>;

export function createMessagesByRefsSelector(
  selectedRefs: readonly MessageStoreRef[],
  options?: MessagesByRefsSelectorOptions,
): (state: StorageState) => MessagesByRefsSelectorSnapshot {
  let previousSignatureParts: readonly string[] | null = null;
  let previousMessageRefs: readonly (Message | null)[] | null = null;
  let previousSnapshot: MessagesByRefsSelectorSnapshot | null = null;
  const retain = options?.retain;

  return (state) => {
    if (selectedRefs.length === 0) return EMPTY_MESSAGES_BY_REFS_SELECTOR_SNAPSHOT;

    const messages: Array<Message | null> = [];
    const signatureParts: string[] = [];
    selectedRefs.forEach((ref, index) => {
      const session = state.sessionMessages[ref.sessionId];
      const message = session?.messagesById?.[ref.messageId] ?? null;
      const previous = previousMessageRefs?.[index] ?? null;
      if (retain && previous && message && previous !== message && previous.id === message.id
        && retain(previous, message)) {
        // The retained message keeps its own revision part: a later in-place write still notifies.
        messages.push(previous);
        signatureParts.push(previousSignatureParts![index]!);
        return;
      }
      const revision = session?.messageRevisionsById?.[ref.messageId];
      messages.push(message);
      if (typeof revision === 'number' && Number.isFinite(revision)) {
        signatureParts.push(`${ref.sessionId}\u0000${ref.messageId}\u0000r:${Math.trunc(revision)}`);
      } else {
        signatureParts.push(`${ref.sessionId}\u0000${ref.messageId}\u0000l:${buildMessageLegacySignature(message, session?.messagesVersion ?? 0)}`);
      }
    });

    if (
      previousSnapshot !== null
      && previousSignatureParts !== null
      && areSignaturePartsEqual(previousSignatureParts, signatureParts)
      && areMessageRefsEqual(previousMessageRefs, messages)
    ) {
      return previousSnapshot;
    }

    previousSignatureParts = signatureParts;
    previousMessageRefs = messages;
    previousSnapshot = { messages };
    return previousSnapshot;
  };
}

function areSignaturePartsEqual(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((part, index) => part === next[index]);
}
