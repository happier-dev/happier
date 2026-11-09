import * as React from 'react';

import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { localVoiceTtsController } from '@/voice/backends/tts/localVoiceTtsController';

/** Only the originating row changes when speech starts, stops, or moves to another message. */
export function useVoiceReadAloudMessagePhase(sessionAddress: SessionAddress | null, routeMessageId: string | null) {
    const serverId = sessionAddress?.serverId;
    const sessionId = sessionAddress?.sessionId;
    const read = React.useCallback(() => {
        const source = localVoiceTtsController.readSaySource();
        return source && serverId && sessionId && source.routeMessageId === routeMessageId
            && areSessionAddressesEqual(source.sessionAddress, { serverId, sessionId })
            ? localVoiceTtsController.readSay()
            : 'idle';
    }, [serverId, sessionId, routeMessageId]);
    return React.useSyncExternalStore(localVoiceTtsController.subscribeSay, read, read);
}
