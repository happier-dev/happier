import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  getVoiceConversationRuntimeSnapshot,
  useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';

export function createLocalConversationVoiceAdapter(): VoiceAdapterController {
  const id = 'local_conversation';

  const getSnapshot = (): VoiceSessionSnapshot => {
    return deriveLocalVoiceSessionSnapshot(id, getVoiceConversationRuntimeSnapshot());
  };

  const start = async (opts: Readonly<{ sessionId: string; initialContext?: string }>) => {
    void opts.initialContext;
    await localVoiceRuntimeController.toggleTurn(opts.sessionId);
  };

  const toggle = async (opts: Readonly<{ sessionId: string }>) => start(opts);

  const stop = async (_opts: Readonly<{ sessionId: string }>) => {
    await localVoiceRuntimeController.stopSession();
  };

  const interrupt = async (opts: Readonly<{ sessionId: string }>) => {
    await localVoiceRuntimeController.abortTurn(opts.sessionId);
  };

  const setMuted = async (opts: Readonly<{ sessionId: string; muted: boolean }>) => {
    await localVoiceRuntimeController.setMuted(opts.sessionId, opts.muted);
  };

  const sendContextUpdate = (opts: Readonly<{ sessionId: string; update: string }>) => {
    localVoiceRuntimeController.appendAgentContextUpdate(opts.sessionId, opts.update);
  };

  const sendTextTurn = async (opts: Readonly<{ controlSessionId: string; conversationSessionId: string; text: string }>) => {
    await localVoiceRuntimeController.sendAgentTextTurn({
      controlSessionId: opts.controlSessionId,
      text: opts.text,
    });
  };

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    setMuted,
    sendContextUpdate,
    sendTextTurn,
    getSnapshot,
    subscribe: (listener) => useVoiceConversationRuntimeStore.subscribe(() => listener()),
  };
}
