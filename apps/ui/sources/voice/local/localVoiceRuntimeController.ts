import {
  abortLocalVoiceTurn,
  commitLocalVoiceInput,
  announceLocalVoiceAgentAssistantText,
  appendLocalVoiceAgentAttemptContextUpdate,
  appendLocalVoiceAgentAutomaticUiContextUpdate,
  isLocalVoiceAgentActive,
  sendLocalVoiceAgentTextTurn,
  sendLocalVoiceAgentTextUpdate,
  setLocalVoiceMuted,
  stopLocalVoiceSession,
  toggleLocalVoiceTurn,
} from './localVoiceEngine';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { VoiceConversationSelection } from '@/voice/binding/voiceConversationBindingTypes';

export type LocalVoiceRuntimeController = Readonly<{
  abortTurn: (sessionId: string) => Promise<void>;
  commitInput: (sessionId: string) => Promise<void>;
  announceAgentAssistantText: (sessionId: string, text: string) => void;
  /** Explicit current-attempt context; synchronized Session updates do not use this seam. */
  appendAgentContextUpdate: (sessionId: string, update: string) => void;
  appendAgentAutomaticUiContextUpdate: (sessionId: string, update: string) => void;
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
  stopSession: (reason?: 'continued_elsewhere', signal?: AbortSignal) => Promise<void>;
  toggleTurn: (
    sessionId: string,
    currentUiContext?: VoiceCurrentUiToolPort,
    requestedTargetSessionAddress?: SessionAddress | null,
    conversationSelection?: VoiceConversationSelection,
    onConversationSelection?: (selection: VoiceConversationSelection) => void,
  ) => Promise<void>;
}>;

export function createLocalVoiceRuntimeController(): LocalVoiceRuntimeController {
  return {
    abortTurn: async (sessionId) => await abortLocalVoiceTurn(sessionId),
    commitInput: async (sessionId) => await commitLocalVoiceInput(sessionId),
    announceAgentAssistantText: (sessionId, text) => announceLocalVoiceAgentAssistantText(sessionId, text),
    appendAgentContextUpdate: (sessionId, update) => appendLocalVoiceAgentAttemptContextUpdate(sessionId, update),
    appendAgentAutomaticUiContextUpdate: (sessionId, update) => appendLocalVoiceAgentAutomaticUiContextUpdate(sessionId, update),
    isAgentActive: (sessionId) => isLocalVoiceAgentActive(sessionId),
    setMuted: async (sessionId, muted) => await setLocalVoiceMuted(sessionId, muted),
    sendAgentTextTurn: async ({ controlSessionId, text, durableDispatch, onAccepted }) =>
      await sendLocalVoiceAgentTextTurn(controlSessionId, text, durableDispatch, onAccepted),
    sendAgentTextUpdate: async (sessionId, update) => await sendLocalVoiceAgentTextUpdate(sessionId, update),
    stopSession: async (reason, signal) => await stopLocalVoiceSession(reason, signal),
    toggleTurn: async (sessionId, currentUiContext, requestedTargetSessionAddress, conversationSelection, onConversationSelection) =>
      await toggleLocalVoiceTurn(sessionId, currentUiContext, requestedTargetSessionAddress, conversationSelection, onConversationSelection),
  };
}

export const localVoiceRuntimeController = createLocalVoiceRuntimeController();
