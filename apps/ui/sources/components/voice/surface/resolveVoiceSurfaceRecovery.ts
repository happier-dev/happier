import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

export type VoiceRecoveryIcon = 'microphone' | 'gear' | 'arrow-clockwise';

export type VoiceSurfaceRecovery = Readonly<{
  kind:
    | 'review_credentials'
    | 'select_execution_machine'
    | 'select_speech_engine'
    | 'open_settings'
    | 'retry'
    | 'reconnect'
    | 'connect_agent'
    | 'install_agent_runtime'
    | 'update_agent_runtime';
  /** The action's one label, drawn and announced alike in every placement (lab ST: Allow · Retry · Set up). */
  labelKey:
    | 'voicePresence.recovery.setUp'
    | 'voicePresence.recovery.allow'
    | 'voiceSurface.reconnect'
    | 'voiceSurface.connectAgent'
    | 'voiceSurface.installAgentRuntime'
    | 'voiceSurface.updateAgentRuntime'
    | 'common.retry';
  /** Its glyph: microphone to allow, gear to set something up, arrow to try again. */
  icon: VoiceRecoveryIcon;
  /**
   * The second remedy for the same cause, offered where there is room for two (the glance and the
   * Voice section), never in the capsule: an unreachable machine is retried first, then replaced.
   */
  alternate?: Readonly<{ labelKey: 'voice.readiness.actions.select_execution_machine'; icon: VoiceRecoveryIcon }>;
}>;

/**
 * The session's one recovery action: its failure's own remedy, otherwise Retry while a lost connection
 * waits between tries (the runtime admits a retry only then). Every placement reads this one answer.
 */
export function resolveVoiceSnapshotRecoveryAction(
  snapshot: Pick<VoiceSessionSnapshot, 'errorRecoveryAction' | 'presentationState' | 'reconnectRetryAvailable'>,
): VoiceMachineRecoveryAction | null {
  if (snapshot.errorRecoveryAction) return snapshot.errorRecoveryAction;
  return snapshot.presentationState === 'reconnecting' && snapshot.reconnectRetryAvailable === true ? 'retry' : null;
}

export function resolveVoiceSurfaceRecovery(
  action: VoiceMachineRecoveryAction | null | undefined,
): VoiceSurfaceRecovery | null {
  switch (action) {
    case 'review_credentials':
      return { kind: 'review_credentials', labelKey: 'voicePresence.recovery.setUp', icon: 'gear' };
    // The lab's short verbs (Allow · Retry · Set up): an unreachable machine may come back, so Retry
    // leads; "Choose a machine" is the alternate where there is room for it (lab ST, review C2).
    case 'select_execution_machine':
      return {
        kind: 'select_execution_machine', labelKey: 'common.retry', icon: 'arrow-clockwise',
        alternate: { labelKey: 'voice.readiness.actions.select_execution_machine', icon: 'gear' },
      };
    case 'select_speech_engine':
      return { kind: 'select_speech_engine', labelKey: 'voicePresence.recovery.setUp', icon: 'gear' };
    case 'open_settings':
      return { kind: 'open_settings', labelKey: 'voicePresence.recovery.setUp', icon: 'gear' };
    case 'open_settings_then_reconnect':
      return { kind: 'open_settings', labelKey: 'voicePresence.recovery.allow', icon: 'microphone' };
    case 'retry':
      return { kind: 'retry', labelKey: 'common.retry', icon: 'arrow-clockwise' };
    case 'reconnect':
      return { kind: 'reconnect', labelKey: 'voiceSurface.reconnect', icon: 'arrow-clockwise' };
    case 'connect_agent':
      return { kind: 'connect_agent', labelKey: 'voiceSurface.connectAgent', icon: 'gear' };
    case 'install_agent_runtime':
      return { kind: 'install_agent_runtime', labelKey: 'voiceSurface.installAgentRuntime', icon: 'gear' };
    case 'update_agent_runtime':
      return { kind: 'update_agent_runtime', labelKey: 'voiceSurface.updateAgentRuntime', icon: 'gear' };
    case 'none':
    default:
      return null;
  }
}
