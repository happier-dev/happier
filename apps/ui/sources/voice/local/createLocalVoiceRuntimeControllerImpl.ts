import {
    announceLocalVoiceAgentAssistantText,
    appendLocalVoiceAgentContextUpdate,
    abortLocalVoiceTurn,
    isLocalVoiceAgentActive,
    sendLocalVoiceAgentTextTurn,
    sendLocalVoiceAgentTextUpdate,
    setLocalVoiceMuted,
    stopLocalVoiceSession,
    toggleLocalVoiceTurn,
} from './localVoiceEngine';
import type { LocalVoiceRuntimeController } from './localVoiceRuntimeController';

export function createLocalVoiceRuntimeControllerImpl(): LocalVoiceRuntimeController {
    return {
        abortTurn: async (sessionId) => await abortLocalVoiceTurn(sessionId),
        announceAgentAssistantText: (sessionId, text) => announceLocalVoiceAgentAssistantText(sessionId, text),
        appendAgentContextUpdate: (sessionId, update) => appendLocalVoiceAgentContextUpdate(sessionId, update),
        isAgentActive: (sessionId) => isLocalVoiceAgentActive(sessionId),
        setMuted: async (sessionId, muted) => await setLocalVoiceMuted(sessionId, muted),
        sendAgentTextTurn: async ({ controlSessionId, text, durableDispatch }) =>
            await sendLocalVoiceAgentTextTurn(controlSessionId, text, durableDispatch),
        sendAgentTextUpdate: async (sessionId, update) => await sendLocalVoiceAgentTextUpdate(sessionId, update),
        stopSession: async () => await stopLocalVoiceSession(),
        toggleTurn: async (sessionId) => await toggleLocalVoiceTurn(sessionId),
    };
}
