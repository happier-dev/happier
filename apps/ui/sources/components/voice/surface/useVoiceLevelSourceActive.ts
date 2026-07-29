import * as React from 'react';

import {
    voiceRuntimeLevelStore,
    type VoiceRuntimeLevelChannel,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';

function readVoiceLevelSourceActive(channel: VoiceRuntimeLevelChannel): boolean {
    const snapshot = voiceRuntimeLevelStore.getSnapshot();
    return channel === 'input' ? snapshot.inputSourceActive : snapshot.outputSourceActive;
}

/**
 * Subscribes React only to the low-frequency source lifecycle fact. Continuous
 * amplitude stays on the Reanimated shared-value path and does not trigger renders.
 */
export function useVoiceLevelSourceActive(channel: VoiceRuntimeLevelChannel): boolean {
    return React.useSyncExternalStore(
        React.useCallback(
            (listener) => voiceRuntimeLevelStore.subscribe(channel, () => listener()),
            [channel],
        ),
        React.useCallback(() => readVoiceLevelSourceActive(channel), [channel]),
        React.useCallback(() => readVoiceLevelSourceActive(channel), [channel]),
    );
}
