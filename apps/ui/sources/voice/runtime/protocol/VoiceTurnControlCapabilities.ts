import type {
  VoiceTurnControlAction,
  VoiceTurnControlCapabilities,
} from '@happier-dev/bundled-voice-runtime-contract';

export type {
  VoiceTurnControlAction,
  VoiceTurnControlCapabilities,
} from '@happier-dev/bundled-voice-runtime-contract';

export type VoiceTurnControlActionAvailability =
  | Readonly<{ status: 'available'; basis?: 'played_ms' | 'audio_samples'; strategy?: 'resume' | 'stable_ids' }>
  | Readonly<{ status: 'unavailable'; code: 'voice_turn_action_unsupported' }>;

const UNAVAILABLE = Object.freeze({
  status: 'unavailable' as const,
  code: 'voice_turn_action_unsupported' as const,
});

export function resolveVoiceTurnControlAction(
  capabilities: VoiceTurnControlCapabilities,
  action: VoiceTurnControlAction,
): VoiceTurnControlActionAvailability {
  switch (action) {
    case 'cancel_response':
      return capabilities.cancelResponse === 'immediate' ? { status: 'available' } : UNAVAILABLE;
    case 'truncate_playback':
      return capabilities.truncatePlayback === 'unsupported'
        ? UNAVAILABLE
        : { status: 'available', basis: capabilities.truncatePlayback };
    case 'clear_input':
      return capabilities.clearInput ? { status: 'available' } : UNAVAILABLE;
    case 'stop_session':
      return capabilities.stopSession ? { status: 'available' } : UNAVAILABLE;
    case 'resume_session':
      return capabilities.resumption === 'resume'
        ? { status: 'available', strategy: 'resume' }
        : UNAVAILABLE;
    case 'replay_session':
      return capabilities.replay === 'stable_ids'
        ? { status: 'available', strategy: 'stable_ids' }
        : UNAVAILABLE;
    case 'send_exact_message':
      return capabilities.exactMessage ? { status: 'available' } : UNAVAILABLE;
  }
}
