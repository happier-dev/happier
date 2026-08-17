import type {
  VoiceMachineErrorPresentation,
} from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type {
  VoiceSessionMode,
  VoiceSessionPresentationState,
  VoiceSessionStatus,
} from '@/voice/session/types';

export type VoiceSurfaceState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'permission_required'
  | 'error'
  | 'interrupted';

export function resolveVoiceSurfaceState(input: Readonly<{
  status: VoiceSessionStatus;
  mode: VoiceSessionMode;
  errorPresentation?: VoiceMachineErrorPresentation;
  presentationState?: VoiceSessionPresentationState;
}>): VoiceSurfaceState {
  if (input.presentationState === 'reconnecting') return 'reconnecting';
  if (input.presentationState === 'interrupted') return 'interrupted';
  if (input.errorPresentation === 'permission_required') return 'permission_required';
  if (input.status === 'error') return 'error';
  if (input.status === 'connecting') return 'connecting';
  if (input.status !== 'connected') return 'idle';
  if (input.mode === 'speaking') return 'speaking';
  // `transcribing` is a canonical mode of its own (`VoiceSessionMode`); collapsing it into
  // `thinking` made the surface report the assistant as reasoning while it was still turning the
  // user's speech into text.
  if (input.mode === 'transcribing') return 'transcribing';
  if (input.mode === 'thinking') return 'thinking';
  if (input.mode === 'listening') return 'listening';
  return 'idle';
}
