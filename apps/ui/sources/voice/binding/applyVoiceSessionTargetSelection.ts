import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';

import { voiceSessionBindingManager } from './voiceConversationBindingRuntime';

export async function applyVoiceSessionTargetSelection(params: Readonly<{
    controlSessionId: string;
    targetSessionId: string | null | undefined;
    updateLastFocused: boolean;
}>): Promise<void> {
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    const targetSessionId = normalizeNonEmptyString(params.targetSessionId);
    if (!controlSessionId) return;
    await voiceSessionBindingManager.syncTargetSession({
        controlSessionId,
        targetSessionId,
    });
    if (params.updateLastFocused) {
        useVoiceTargetStore.getState().setLastFocusedSessionId(targetSessionId);
    }
    useVoiceTargetStore.getState().setPrimaryActionSessionId(targetSessionId);
}
