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

function normalizeBinding(binding: VoiceSessionBinding): VoiceSessionBinding | null {
  const adapterId = normalizeId(binding.adapterId);
  const controlSessionId = normalizeId(binding.controlSessionId);
  const conversationSessionId = normalizeId(binding.conversationSessionId);
  const transcriptMode = binding.transcriptMode === 'native_session' || binding.transcriptMode === 'synthetic'
    ? binding.transcriptMode
    : null;
  if (!adapterId || !controlSessionId || !conversationSessionId || !transcriptMode) return null;

  return {
    adapterId,
    controlSessionId,
    conversationSessionId,
    transcriptMode,
    targetSessionId: normalizeId(binding.targetSessionId),
    updatedAt: Number.isFinite(binding.updatedAt) ? Number(binding.updatedAt) : 0,
  };
}

export function createVoiceSessionBindingStore() {
  return createStore<VoiceSessionBindingStoreState>((set, get) => ({
    bindingsByConversationSessionId: {},
    bind: (binding) =>
      set((state) => {
        const normalized = normalizeBinding(binding);
        if (!normalized) return state;
        return {
          ...state,
          bindingsByConversationSessionId: {
            ...Object.fromEntries(
              Object.entries(state.bindingsByConversationSessionId).filter(
                ([conversationSessionId, existing]) =>
                  existing.controlSessionId !== normalized.controlSessionId || conversationSessionId === normalized.conversationSessionId,
              ),
            ),
            [normalized.conversationSessionId]: normalized,
          },
        };
      }),
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
