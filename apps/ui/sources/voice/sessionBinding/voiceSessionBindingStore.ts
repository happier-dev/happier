import { createStore } from 'zustand/vanilla';

import type { VoiceSessionBinding } from './voiceSessionBindingTypes';

type VoiceSessionBindingStoreState = Readonly<{
  bindingsByConversationSessionId: Record<string, VoiceSessionBinding>;
  bind: (binding: VoiceSessionBinding) => void;
  unbind: (conversationSessionId: string) => void;
  getByConversationSessionId: (conversationSessionId: string) => VoiceSessionBinding | null;
  getByControlSessionId: (controlSessionId: string) => VoiceSessionBinding | null;
  list: () => ReadonlyArray<VoiceSessionBinding>;
}>;

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function createVoiceSessionBindingStore() {
  return createStore<VoiceSessionBindingStoreState>((set, get) => ({
    bindingsByConversationSessionId: {},
    bind: (binding) =>
      set((state) => ({
        ...state,
        bindingsByConversationSessionId: {
          ...Object.fromEntries(
            Object.entries(state.bindingsByConversationSessionId).filter(
              ([conversationSessionId, existing]) =>
                existing.controlSessionId !== binding.controlSessionId || conversationSessionId === binding.conversationSessionId,
            ),
          ),
          [binding.conversationSessionId]: binding,
        },
      })),
    unbind: (conversationSessionId) =>
      set((state) => {
        const normalized = normalizeId(conversationSessionId);
        if (!normalized) return state;
        const next = { ...state.bindingsByConversationSessionId };
        delete next[normalized];
        return {
          ...state,
          bindingsByConversationSessionId: next,
        };
      }),
    getByConversationSessionId: (conversationSessionId) => {
      const normalized = normalizeId(conversationSessionId);
      if (!normalized) return null;
      return get().bindingsByConversationSessionId[normalized] ?? null;
    },
    getByControlSessionId: (controlSessionId) => {
      const normalized = normalizeId(controlSessionId);
      if (!normalized) return null;
      for (const binding of Object.values(get().bindingsByConversationSessionId)) {
        if (binding.controlSessionId === normalized) return binding;
      }
      return null;
    },
    list: () => Object.values(get().bindingsByConversationSessionId),
  }));
}

export const voiceSessionBindingStore = createVoiceSessionBindingStore();
