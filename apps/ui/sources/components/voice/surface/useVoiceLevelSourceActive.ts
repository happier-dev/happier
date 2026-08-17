import * as React from 'react';

import {
    voiceRuntimeLevelStore,
    type VoiceRuntimeLevelSourceActivity,
} from '@/voice/runtime/levels/voiceRuntimeLevelStore';

/**
 * The app-level projection of both source lifecycles. The level store changes
 * this object only when a source opens or closes, so it is safe React input for
 * the one energy/attempt provider while continuous amplitude remains outside
 * React on the shared-value path.
 */
export function useVoiceLevelSourceActivity(): VoiceRuntimeLevelSourceActivity {
    return React.useSyncExternalStore(
        React.useCallback(
            (listener) => voiceRuntimeLevelStore.subscribeSourceActivity(() => listener()),
            [],
        ),
        React.useCallback(() => voiceRuntimeLevelStore.getSourceActivitySnapshot(), []),
        React.useCallback(() => voiceRuntimeLevelStore.getSourceActivitySnapshot(), []),
    );
}
