import type { VoiceAdapterController } from '@/voice/session/types';
import { createLocalConversationVoiceAdapter } from './localConversation/localConversationAdapter';
import { createLocalDirectVoiceAdapter } from './localDirect/localDirectAdapter';
import { createRealtimeElevenLabsVoiceAdapter } from './realtimeElevenLabs/realtimeElevenLabsAdapter';

export function createBuiltinVoiceAdapters(): ReadonlyArray<VoiceAdapterController> {
  return [
    createRealtimeElevenLabsVoiceAdapter(),
    createLocalDirectVoiceAdapter(),
    createLocalConversationVoiceAdapter(),
  ];
}

