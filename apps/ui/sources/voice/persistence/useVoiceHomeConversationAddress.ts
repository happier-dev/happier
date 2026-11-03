import * as React from 'react';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

const readCurrentBinding = () => voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);

/** Exact retained admission, never the newest Session in a recipe pool. */
export function useVoiceHomeConversationAddress(): SessionAddress | null {
    const binding = React.useSyncExternalStore(voiceSessionBindingStore.subscribe, readCurrentBinding, readCurrentBinding);
    return binding?.lifetime === 'runtime_attempt' ? null : binding?.conversationSessionAddress ?? null;
}
