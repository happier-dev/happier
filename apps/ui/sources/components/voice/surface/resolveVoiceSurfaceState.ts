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
  if (input.mode === 'thinking' || input.mode === 'transcribing') return 'thinking';
  if (input.mode === 'listening') return 'listening';
  return 'idle';
}
