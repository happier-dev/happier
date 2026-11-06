import type { VoiceAttemptPresentation } from '@happier-dev/protocol/voice/attemptPresentation';
import { t } from '@/text';
import { resolveVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import type { VoiceAttemptControl } from './resolveVoiceAttemptControl';
import { opensAgentRuntimeSettings, type VoiceAttemptRecoveryContext } from './voiceAttemptRecovery';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';

/** One sanitized presenter for host surfaces, public Plugin UI, and the Action read. */
export function projectVoiceAttemptPresentation(input: Readonly<{
    control: VoiceAttemptControl;
    attemptId: string | null;
    ended: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
    errorProviderMessage?: string;
    errorConnectedServiceDiagnostic?: ConnectedServiceUxDiagnosticV1;
    recoveryAction: VoiceMachineRecoveryAction | null;
    recoveryContext: VoiceAttemptRecoveryContext;
    serviceTitle: string;
    agentTitle: string | null;
    agentMachineLabel: string | null;
}>): VoiceAttemptPresentation {
    const { control, recoveryAction, recoveryContext, agentTitle, agentMachineLabel } = input;
    const recovery = resolveVoiceSurfaceRecovery(recoveryAction);
    const connectedService = resolveConnectedServiceUxDiagnosticPresentation(input.errorConnectedServiceDiagnostic);
    const reconnectProfile = recoveryAction === 'connect_agent'
        ? connectedService?.actions.find(action => action.kind === 'reconnect_profile') : undefined;
    const recoveryPresentation = !control.recoveryAvailable ? null
        : control.surfaceState === 'permission_required'
            ? { label: t('voicePresence.recovery.allow'), icon: 'microphone' as const }
            : recovery
                ? { label: reconnectProfile ? t(reconnectProfile.labelKey) : opensAgentRuntimeSettings(recoveryAction, recoveryContext) && agentTitle
                    ? t('voiceSurface.setUpAgent', { agent: agentTitle }) : t(recovery.labelKey), icon: recovery.icon }
                : { label: t('voicePresence.recovery.setUp'), icon: 'gear' as const };
    const failureKind = input.errorCode ? resolveVoiceMachineErrorKind(input.errorCode) : null;
    const failureMessage = connectedService ? t(connectedService.bodyKey) : failureKind === null ? null
        : failureKind === 'provider_error' && input.errorProviderMessage ? input.errorProviderMessage
        : failureKind === 'authentication_required' && input.errorMessage === 'agent_signed_out' && agentTitle && agentMachineLabel
            ? t('settingsVoice.local.machineErrors.agent_signed_out', { agent: agentTitle, machine: agentMachineLabel })
            : translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, input.errorMessage ?? undefined), { service: input.serviceTitle });
    return {
        attemptId: input.attemptId, surfaceState: control.surfaceState, live: control.live, muted: control.muted,
        canStart: control.canStart, canStop: control.canStop, canMute: control.canMute,
        canCommitInput: control.canCommitInput === true, canDismissFailedAttempt: control.canDismissFailedAttempt === true,
        canDismissEnded: input.ended, failureKind, failureMessage,
        ...(failureKind === 'provider_error' && input.errorMessage?.toLowerCase() === 'usage_limit'
            ? { failureTitle: translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, input.errorMessage), { service: input.serviceTitle }) }
            : {}),
        recovery: recoveryPresentation ? { ...recoveryPresentation, action: recoveryAction,
            runtimeTarget: recoveryContext.runtimeRecoveryTarget } : null,
    };
}
