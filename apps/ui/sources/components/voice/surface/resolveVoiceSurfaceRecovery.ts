import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';

export type VoiceSurfaceRecovery = Readonly<{
  kind:
    | 'review_credentials'
    | 'select_execution_machine'
    | 'open_settings'
    | 'retry'
    | 'reconnect'
    | 'connect_agent'
    | 'install_agent_runtime'
    | 'update_agent_runtime';
  labelKey:
    | 'voiceSurface.reviewCredentials'
    | 'voice.readiness.actions.select_execution_machine'
    | 'voiceSurface.reconnect'
    | 'voiceSurface.connectAgent'
    | 'voiceSurface.installAgentRuntime'
    | 'voiceSurface.updateAgentRuntime'
    | 'modals.openSettings'
    | 'common.retry';
}>;

export function resolveVoiceSurfaceRecovery(
  action: VoiceMachineRecoveryAction | null | undefined,
): VoiceSurfaceRecovery | null {
  switch (action) {
    case 'review_credentials':
      return { kind: 'review_credentials', labelKey: 'voiceSurface.reviewCredentials' };
    case 'select_execution_machine':
      return {
        kind: 'select_execution_machine',
        labelKey: 'voice.readiness.actions.select_execution_machine',
      };
    case 'open_settings':
    case 'open_settings_then_reconnect':
      return { kind: 'open_settings', labelKey: 'modals.openSettings' };
    case 'retry':
      return { kind: 'retry', labelKey: 'common.retry' };
    case 'reconnect':
      return { kind: 'reconnect', labelKey: 'voiceSurface.reconnect' };
    case 'connect_agent':
      return { kind: 'connect_agent', labelKey: 'voiceSurface.connectAgent' };
    case 'install_agent_runtime':
      return { kind: 'install_agent_runtime', labelKey: 'voiceSurface.installAgentRuntime' };
    case 'update_agent_runtime':
      return { kind: 'update_agent_runtime', labelKey: 'voiceSurface.updateAgentRuntime' };
    case 'none':
    default:
      return null;
  }
}
