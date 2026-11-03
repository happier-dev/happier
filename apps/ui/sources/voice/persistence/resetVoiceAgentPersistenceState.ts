import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';

import { invalidatePersistentVoiceTranscript } from './invalidatePersistentVoiceTranscript';
import { clearVoiceAgentRunMetadataFromSession } from './voiceAgentRunMetadata';

function resolveVoiceAgentRunMetadataSessionId(state: ReturnType<typeof storage.getState>): string | null {
    const boundConversationSessionId =
        voiceConversationBindingResolver.resolveByControlSessionId({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        })?.conversationSessionId ?? null;
    if (boundConversationSessionId && state?.sessions?.[boundConversationSessionId]) {
        return boundConversationSessionId;
    }
    return null;
}

export async function resetVoiceAgentPersistenceState(params: Readonly<{
    stop: () => Promise<void>;
}>): Promise<void> {
    // Reset is one user intent. Bind its transcript-memory mutation before
    // stopping the runtime so a Home focus change during that await cannot
    // retarget the transcript invalidation to the newly active Account.
    const expectedSettingsScope = storage.getState().settingsScope ?? null;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    await params.stop();

    const state = storage.getState();
    if (accountLifetime && !accountLifetime.isCurrent()
        || !areAccountSettingsScopesEqual(expectedSettingsScope, state.settingsScope)) return;
    const conversationSessionId = resolveVoiceAgentRunMetadataSessionId(state);
    await invalidatePersistentVoiceTranscript(expectedSettingsScope);
    if (conversationSessionId) {
        await clearVoiceAgentRunMetadataFromSession({ sessionId: conversationSessionId, accountLifetime: accountLifetime ?? undefined }).catch(() => {});
    }
}
