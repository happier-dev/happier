import { create } from 'zustand';

import type { VoiceConversationRuntimeSnapshot } from './voiceConversationRuntimeTypes';

type VoiceConversationRuntimeStoreState = Readonly<{
    snapshot: VoiceConversationRuntimeSnapshot;
    setSnapshot: (
        next:
            | VoiceConversationRuntimeSnapshot
            | ((current: VoiceConversationRuntimeSnapshot) => VoiceConversationRuntimeSnapshot),
    ) => void;
}>;

export const DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT: VoiceConversationRuntimeSnapshot = {
    controlSessionId: null,
    state: 'disconnected',
    micMuted: false,
    error: null,
};

export const useVoiceConversationRuntimeStore = create<VoiceConversationRuntimeStoreState>((set) => ({
    snapshot: DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    setSnapshot: (next) =>
        set((state) => ({
            snapshot: typeof next === 'function' ? next(state.snapshot) : next,
        })),
}));

export function getVoiceConversationRuntimeSnapshot(): VoiceConversationRuntimeSnapshot {
    return useVoiceConversationRuntimeStore.getState().snapshot;
}

export function setVoiceConversationRuntimeSnapshot(
    next:
        | VoiceConversationRuntimeSnapshot
        | ((current: VoiceConversationRuntimeSnapshot) => VoiceConversationRuntimeSnapshot),
): void {
    useVoiceConversationRuntimeStore.getState().setSnapshot(next);
}
