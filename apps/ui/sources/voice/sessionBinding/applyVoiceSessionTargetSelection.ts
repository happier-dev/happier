import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';

import { voiceSessionBindingManager } from './voiceSessionBindingRuntime';

function normalizeSessionId(value: string | null | undefined): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function applyVoiceSessionTargetSelection(params: Readonly<{
    controlSessionId: string;
    targetSessionId: string | null | undefined;
    updateLastFocused: boolean;
}>): void {
    const targetSessionId = normalizeSessionId(params.targetSessionId);
    if (params.updateLastFocused) {
        useVoiceTargetStore.getState().setLastFocusedSessionId(targetSessionId);
    }
    useVoiceTargetStore.getState().setPrimaryActionSessionId(targetSessionId);
    voiceSessionBindingManager.syncTargetSession({
        controlSessionId: params.controlSessionId,
        targetSessionId,
    });
}
