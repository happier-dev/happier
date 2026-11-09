import { useSyncExternalStore } from 'react';
import { localVoiceTtsController } from '@/voice/backends/tts/localVoiceTtsController';

/** Read-only presentation; Stop is dispatched through ui.voice_global.say.stop. */
export function useVoiceSayState(): ReturnType<typeof localVoiceTtsController.readSay> {
    return useSyncExternalStore(localVoiceTtsController.subscribeSay,
        localVoiceTtsController.readSay, localVoiceTtsController.readSay);
}
