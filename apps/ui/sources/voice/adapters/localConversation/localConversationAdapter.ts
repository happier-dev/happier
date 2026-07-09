import { createLocalVoiceAdapter } from '@/voice/adapters/local/createLocalVoiceAdapter';
import { resolveLocalConversationTranscriptMode } from './resolveLocalConversationTranscriptMode';
import type { VoiceAdapterController } from '@/voice/session/types';

export function createLocalConversationVoiceAdapter(): VoiceAdapterController {
  return createLocalVoiceAdapter('local_conversation', {
    contextUpdates: true,
    textTurns: true,
    resolveBindingTranscriptMode: resolveLocalConversationTranscriptMode,
  });
}
