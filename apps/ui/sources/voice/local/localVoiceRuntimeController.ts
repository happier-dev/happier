import { createLocalVoiceRuntimeControllerImpl } from './createLocalVoiceRuntimeControllerImpl';

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
  }>) => Promise<void>;
  sendAgentTextUpdate: (sessionId: string, update: string) => Promise<void>;
  stopSession: () => Promise<void>;
  toggleTurn: (sessionId: string) => Promise<void>;
}>;

export function createLocalVoiceRuntimeController(): LocalVoiceRuntimeController {
  return createLocalVoiceRuntimeControllerImpl();
}

export const localVoiceRuntimeController = createLocalVoiceRuntimeController();
