import {
    ensureVoiceConversationSessionForSessionRoot,
    ensureVoiceConversationSessionForVoiceHome,
} from '@/voice/persistence/voiceConversationSession';
import { applyRecoveredGlobalVoiceMachineDecision } from '@/voice/agent/applyRecoveredGlobalVoiceMachineDecision';
import { recoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/recoverUnavailableGlobalVoiceAutoMachine';
import { shouldRecoverUnavailableGlobalVoiceAutoMachine } from '@/voice/agent/shouldRecoverUnavailableGlobalVoiceAutoMachine';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceAdapterTranscriptMode } from '@/voice/session/types';

import type { VoiceConversationBindingResolution } from './voiceConversationBindingTypes';

/**
 * Read the provider-owned transcript-mode decision for a voice adapter from the
 * registry. Generic binding code does not branch on provider ids: each adapter
 * exposes `resolveBindingTranscriptMode` (a capability) that returns the mode or
 * `null` when it has no hidden voice conversation session for these settings.
 */
function resolveBindingTranscriptMode(
    providerId: string,
    settings: unknown,
): VoiceAdapterTranscriptMode | null {
    const adapter = getVoiceAdapterRegistry().get(providerId);
    return adapter?.resolveBindingTranscriptMode?.(settings) ?? null;
}

function shouldForceVoiceHomeForLocalConversation(settings: any): boolean {
    const config = settings?.voice?.adapters?.local_conversation ?? null;
    return config?.agent?.stayInVoiceHome === true;
}

async function ensureVoiceHomeConversationSessionIdWithRecovery(params: Readonly<{
    transcriptMode: VoiceAdapterTranscriptMode;
    controlSessionId: string;
    settings: any;
}>): Promise<string> {
    try {
        return await ensureVoiceConversationSessionForVoiceHome();
    } catch (error) {
        const isGlobalNativeSessionVoiceAgent =
            params.controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            && params.transcriptMode === 'native_session';
        if (!isGlobalNativeSessionVoiceAgent) throw error;
        if (!shouldRecoverUnavailableGlobalVoiceAutoMachine(error)) throw error;
        const recoveryDecision = await recoverUnavailableGlobalVoiceAutoMachine();
        if (recoveryDecision.kind !== 'retry' && recoveryDecision.kind !== 'switch') throw error;
        applyRecoveredGlobalVoiceMachineDecision(recoveryDecision);
        return await ensureVoiceConversationSessionForVoiceHome();
    }
}

export async function ensureVoiceConversationBindingResolution(params: Readonly<{
    providerId: string;
    controlSessionId: string;
    requestedTargetSessionId?: string | null;
    settings: any;
}>): Promise<VoiceConversationBindingResolution | null> {
    const providerId = normalizeNonEmptyString(params.providerId);
    if (!providerId) return null;
    const controlSessionId = normalizeNonEmptyString(params.controlSessionId);
    if (!controlSessionId) return null;

    const transcriptMode = resolveBindingTranscriptMode(providerId, params.settings);
    if (!transcriptMode) return null;

    const targetSessionId = normalizeNonEmptyString(params.requestedTargetSessionId);
    const rootSessionId =
        controlSessionId === VOICE_AGENT_GLOBAL_SESSION_ID
            ? targetSessionId
            : controlSessionId;

    const conversationSessionId =
        rootSessionId && !shouldForceVoiceHomeForLocalConversation(params.settings)
            ? await ensureVoiceConversationSessionForSessionRoot({ sessionId: rootSessionId })
            : await ensureVoiceHomeConversationSessionIdWithRecovery({
                  transcriptMode,
                  controlSessionId,
                  settings: params.settings,
              });

    return {
        controlSessionId,
        conversationSessionId,
        transcriptMode,
        targetSessionId,
    };
}
