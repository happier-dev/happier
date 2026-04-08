import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { voiceSessionBindingManager } from './voiceSessionBindingRuntime';

export function applyVoiceSessionTargetSelection(params: Readonly<{
    controlSessionId: string;
    targetSessionId: string | null | undefined;
    updateLastFocused: boolean;
}>): void {
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    const targetSessionId = normalizeNonEmptyString(params.targetSessionId);
    if (!controlSessionId) return;
    if (params.updateLastFocused) {
        useVoiceTargetStore.getState().setLastFocusedSessionId(targetSessionId);
    }
    useVoiceTargetStore.getState().setPrimaryActionSessionId(targetSessionId);
    voiceSessionBindingManager.syncTargetSession({
        controlSessionId,
        targetSessionId,
    });
}
