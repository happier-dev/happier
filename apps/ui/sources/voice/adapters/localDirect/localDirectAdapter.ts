import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import type { VoiceAdapterController, VoiceSessionSnapshot } from '@/voice/session/types';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  getVoiceConversationRuntimeSnapshot,
  useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';

export function createLocalDirectVoiceAdapter(): VoiceAdapterController {
  const id = 'local_direct';

  const getSnapshot = (): VoiceSessionSnapshot => deriveLocalVoiceSessionSnapshot(id, getVoiceConversationRuntimeSnapshot());

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

  return {
    id,
    start,
    stop,
    toggle,
    interrupt,
    setMuted,
    sendContextUpdate: () => {},
    getSnapshot,
    subscribe: (listener) => useVoiceConversationRuntimeStore.subscribe(() => listener()),
  };
}
