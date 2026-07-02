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

function areVoiceMachineErrorsEqual(
    a: VoiceConversationRuntimeSnapshot['error'],
    b: VoiceConversationRuntimeSnapshot['error'],
): boolean {
    if (a === b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    return a.kind === b.kind && a.reason === b.reason && a.recoverable === b.recoverable;
}

function areVoiceConversationRuntimeSnapshotsEqual(
    a: VoiceConversationRuntimeSnapshot,
    b: VoiceConversationRuntimeSnapshot,
): boolean {
    return (
        a.controlSessionId === b.controlSessionId
        && a.state === b.state
        && a.micMuted === b.micMuted
        && areVoiceMachineErrorsEqual(a.error, b.error)
    );
}

export const useVoiceConversationRuntimeStore = create<VoiceConversationRuntimeStoreState>((set) => ({
    snapshot: DEFAULT_VOICE_CONVERSATION_RUNTIME_SNAPSHOT,
    setSnapshot: (next) =>
        set((state) => {
            const nextSnapshot = typeof next === 'function' ? next(state.snapshot) : next;
            if (areVoiceConversationRuntimeSnapshotsEqual(state.snapshot, nextSnapshot)) {
                return state;
            }
            return { snapshot: nextSnapshot };
        }),
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
