import { randomUUID } from '@/platform/randomUUID';
import { storage } from '@/sync/domains/state/storage';
import { nowServerMs } from '@/sync/runtime/time';
import type { NormalizedMessage } from '@/sync/typesRaw';

function appendNormalizedMessage(conversationSessionId: string, message: NormalizedMessage): void {
  const state: any = storage.getState();
  state.applyMessagesLoaded?.(conversationSessionId);
  state.applyMessages?.(conversationSessionId, [message]);
}

export function appendVoiceConversationUserText(params: Readonly<{
  conversationSessionId: string;
  text: string;
}>): void {
  const text = String(params.text ?? '').trim();
  if (!text) return;
  appendNormalizedMessage(params.conversationSessionId, {
    id: randomUUID(),
    localId: null,
    createdAt: nowServerMs(),
    isSidechain: false,
    role: 'user',
    content: { type: 'text', text },
  });
}

export function appendVoiceConversationAssistantText(params: Readonly<{
  conversationSessionId: string;
  text: string;
}>): void {
  const text = String(params.text ?? '').trim();
  if (!text) return;
  const uuid = randomUUID();
  appendNormalizedMessage(params.conversationSessionId, {
    id: randomUUID(),
    localId: null,
    createdAt: nowServerMs(),
    isSidechain: false,
    role: 'agent',
    content: [{ type: 'text', text, uuid, parentUUID: null }],
  });
}

export function appendVoiceConversationNoteText(params: Readonly<{
  conversationSessionId: string;
  text: string;
}>): void {
  appendVoiceConversationAssistantText(params);
}
