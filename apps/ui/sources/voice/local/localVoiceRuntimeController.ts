import {
  abortLocalVoiceTurn,
  announceLocalVoiceAgentAssistantText,
  appendLocalVoiceAgentContextUpdate,
  isLocalVoiceAgentActive,
  sendLocalVoiceAgentTextTurn,
  sendLocalVoiceAgentTextUpdate,
  setLocalVoiceMuted,
  stopLocalVoiceSession,
  toggleLocalVoiceTurn,
} from './localVoiceEngine';

export type LocalVoiceRuntimeController = Readonly<{
  abortTurn: (sessionId: string) => Promise<void>;
  announceAgentAssistantText: (sessionId: string, text: string) => void;
  appendAgentContextUpdate: (sessionId: string, update: string) => void;
  isAgentActive: (sessionId: string) => boolean;
  setMuted: (sessionId: string, muted: boolean) => Promise<void>;
  sendAgentTextTurn: (params: Readonly<{
    controlSessionId: string;
    text: string;
    durableDispatch?: Readonly<{
      localId: string;
      deliveryCommand: 'interrupt_and_send';
    }>;
    onAccepted?: () => Promise<void>;
  }>) => Promise<void>;
  sendAgentTextUpdate: (sessionId: string, update: string) => Promise<void>;
  stopSession: () => Promise<void>;
  toggleTurn: (sessionId: string) => Promise<void>;
}>;

export function createLocalVoiceRuntimeController(): LocalVoiceRuntimeController {
  return {
    abortTurn: async (sessionId) => await abortLocalVoiceTurn(sessionId),
    announceAgentAssistantText: (sessionId, text) => announceLocalVoiceAgentAssistantText(sessionId, text),
    appendAgentContextUpdate: (sessionId, update) => appendLocalVoiceAgentContextUpdate(sessionId, update),
    isAgentActive: (sessionId) => isLocalVoiceAgentActive(sessionId),
    setMuted: async (sessionId, muted) => await setLocalVoiceMuted(sessionId, muted),
    sendAgentTextTurn: async ({ controlSessionId, text, durableDispatch, onAccepted }) =>
      await sendLocalVoiceAgentTextTurn(controlSessionId, text, durableDispatch, onAccepted),
    sendAgentTextUpdate: async (sessionId, update) => await sendLocalVoiceAgentTextUpdate(sessionId, update),
    stopSession: async () => await stopLocalVoiceSession(),
    toggleTurn: async (sessionId) => await toggleLocalVoiceTurn(sessionId),
  };
}

export const localVoiceRuntimeController = createLocalVoiceRuntimeController();
