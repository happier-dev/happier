import { storage } from '@/sync/domains/state/storage';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { findVoiceConversationSessionId } from '@/voice/persistence/voiceConversationSession';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';

import { invalidatePersistentVoiceTranscript } from './invalidatePersistentVoiceTranscript';
import { clearVoiceAgentRunMetadataFromSession } from './voiceAgentRunMetadata';

function resolveVoiceAgentRunMetadataSessionId(state: any): string | null {
    const boundConversationSessionId =
        voiceConversationBindingResolver.resolveByControlSessionId({
            controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        })?.conversationSessionId ?? null;
    if (boundConversationSessionId && state?.sessions?.[boundConversationSessionId]) {
        return boundConversationSessionId;
    }
    return findVoiceConversationSessionId(state);
}

export async function resetVoiceAgentPersistenceState(params: Readonly<{
    stop: () => Promise<void>;
}>): Promise<void> {
    // Reset is one user intent. Bind its server-backed settings mutation before
    // stopping the runtime so a Home focus change during that await cannot
    // retarget the transcript invalidation to the newly active Account.
    const expectedSettingsScope = storage.getState().settingsScope ?? null;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    await params.stop();
    invalidatePersistentVoiceTranscript(expectedSettingsScope);

    const state = storage.getState() as any;
    if (accountLifetime && !accountLifetime.isCurrent()
        || !areAccountSettingsScopesEqual(expectedSettingsScope, state.settingsScope)) return;
    const conversationSessionId = resolveVoiceAgentRunMetadataSessionId(state);
    if (conversationSessionId) {
        await clearVoiceAgentRunMetadataFromSession({ sessionId: conversationSessionId, accountLifetime: accountLifetime ?? undefined }).catch(() => {});
    }
}
