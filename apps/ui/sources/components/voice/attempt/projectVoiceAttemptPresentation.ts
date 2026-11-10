import type { VoiceAttemptPresentation } from '@happier-dev/protocol/voice/attemptPresentation';
import { t } from '@/text';
import { resolveVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { presentVoiceUsageLimitMessage, resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { translateVoiceReadiness } from '@/voice/settings/panels/voiceProviderReadinessPresentation';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import type { VoiceAttemptControl } from './resolveVoiceAttemptControl';
import { opensAgentRuntimeSettings, type VoiceAttemptRecoveryContext } from './voiceAttemptRecovery';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { resolveConnectedServiceUxDiagnosticPresentation } from '@/components/sessions/connectedServices/diagnostics/connectedServiceUxDiagnostics';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { presentProviderError, presentProviderRecoveryAction } from '@/providers/connection/errorPresentation';
import { presentSessionStartupFailureCause } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import type { VoiceRuntimeFailureCause } from '@/voice/runtime/voiceRuntimeFailureCode';

/** One sanitized presenter for host surfaces, public Plugin UI, and the Action read. */
export function projectVoiceAttemptPresentation(input: Readonly<{
    control: VoiceAttemptControl;
    attemptId: string | null;
    ended: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
    errorProviderMessage?: string;
    errorProviderError?: ProviderErrorV1;
    errorUsageLimit?: import('@/voice/runtime/machine/voiceConversationRuntimeTypes').VoiceMachineError['usageLimit'];
    errorFailureCause?: VoiceRuntimeFailureCause;
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
    const provider = input.errorProviderError ? presentProviderError(input.errorProviderError) : null;
    const providerRecovery = input.errorProviderError ? presentProviderRecoveryAction(input.errorProviderError, {
        retry: control.recoveryAvailable,
    }) : null;
    const reconnectProfile = recoveryAction === 'connect_agent'
        ? connectedService?.actions.find(action => action.kind === 'reconnect_profile') : undefined;
    const recoveryPresentation = !control.recoveryAvailable ? null
        : provider ? providerRecovery ? { label: t(providerRecovery.titleKey), icon: 'gear' as const } : null
        : control.surfaceState === 'permission_required'
            ? { label: t('voicePresence.recovery.allow'), icon: 'microphone' as const }
            : recovery
                ? { label: reconnectProfile ? t(reconnectProfile.labelKey) : opensAgentRuntimeSettings(recoveryAction, recoveryContext) && agentTitle
                    ? t('voiceSurface.setUpAgent', { agent: agentTitle }) : t(recovery.labelKey), icon: recovery.icon }
                : { label: t('voicePresence.recovery.setUp'), icon: 'gear' as const };
    const failureKind = input.errorCode ? resolveVoiceMachineErrorKind(input.errorCode) : null;
    const statusPresentation = resolveVoiceSurfaceStatusPresentation(control.surfaceState, input.errorMessage);
    const sessionCause = input.errorFailureCause && 'failureReason' in input.errorFailureCause ? input.errorFailureCause : undefined;
    const startupCode = sessionCause?.code ?? input.errorMessage;
    const startupMessage = startupCode ? presentSessionStartupFailureCause(startupCode, undefined, sessionCause) : null;
    const failureMessage = provider ? t(provider.descriptionKey) : connectedService ? t(connectedService.bodyKey)
        : failureKind === 'authentication_required' && input.errorMessage === 'agent_signed_out' && agentTitle && agentMachineLabel
            ? t('settingsVoice.local.machineErrors.agent_signed_out', { agent: agentTitle, machine: agentMachineLabel })
        : startupMessage ?? (failureKind === null ? null
        : failureKind === 'provider_error' && input.errorProviderMessage ? input.errorProviderMessage
        : failureKind === 'provider_error' && input.errorMessage === 'usage_limit' ? presentVoiceUsageLimitMessage(input.errorUsageLimit)
        : translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, input.errorMessage ?? undefined), { service: input.serviceTitle }));
    const failureTitle = provider ? t(provider.titleKey)
        : failureKind === 'provider_error' && input.errorMessage?.toLowerCase() === 'usage_limit'
            ? translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, input.errorMessage), { service: input.serviceTitle })
        : failureKind === 'execution_machine_unavailable' || failureKind === 'session_unavailable' ? failureMessage
        : failureKind === 'provider_error' && statusPresentation.labelKey === 'voiceAssistant.connectionError'
            ? t(statusPresentation.labelKey) : null;
    return {
        attemptId: input.attemptId, surfaceState: control.surfaceState, live: control.live, muted: control.muted,
        canStart: control.canStart, canStop: control.canStop, canMute: control.canMute,
        canCommitInput: control.canCommitInput === true, canDismissFailedAttempt: control.canDismissFailedAttempt === true,
        canDismissEnded: input.ended, failureKind, failureMessage,
        ...(failureTitle ? { failureTitle } : {}),
        ...(provider ? { providerError: input.errorProviderError } : {}),
        recovery: recoveryPresentation ? { ...recoveryPresentation, action: recoveryAction,
            runtimeTarget: recoveryContext.runtimeRecoveryTarget } : null,
    };
}
