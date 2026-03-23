import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { findReusableVoiceConversationRuntimeSessionId } from '@/voice/sessionBinding/voiceConversationSystemSessionLookup';
import { resolveVoiceSessionBindingByControlSessionId } from '@/voice/sessionBinding/resolveVoiceSessionBinding';
import { voiceSessionBindingStore } from '@/voice/sessionBinding/voiceSessionBindingStore';

export function useHasGlobalVoiceAgentConversation(): boolean {
    const voiceSessionSnapshot = useVoiceSessionSnapshot();
    const bindingsByConversationSessionId = React.useSyncExternalStore(
        voiceSessionBindingStore.subscribe,
        () => voiceSessionBindingStore.getState().bindingsByConversationSessionId,
        () => voiceSessionBindingStore.getState().bindingsByConversationSessionId,
    );
    const hasPersistedGlobalVoiceAgentConversation = React.useSyncExternalStore(
        storage.subscribe,
        () => findReusableVoiceConversationRuntimeSessionId(storage.getState() as any) !== null,
        () => findReusableVoiceConversationRuntimeSessionId(storage.getState() as any) !== null,
    );

    return React.useMemo(() => {
        if (
            voiceSessionSnapshot.adapterId === 'local_conversation'
            && typeof voiceSessionSnapshot.sessionId === 'string'
            && voiceSessionSnapshot.sessionId.trim() === VOICE_AGENT_GLOBAL_SESSION_ID
        ) {
            return true;
        }
        if (resolveVoiceSessionBindingByControlSessionId({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
            adapterId: 'local_conversation',
        })) {
            return true;
        }
        return hasPersistedGlobalVoiceAgentConversation;
    }, [
        bindingsByConversationSessionId,
        hasPersistedGlobalVoiceAgentConversation,
        voiceSessionSnapshot.adapterId,
        voiceSessionSnapshot.sessionId,
    ]);
}
