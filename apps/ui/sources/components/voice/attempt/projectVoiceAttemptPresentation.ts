import type { VoiceAttemptPresentation } from '@happier-dev/protocol/voice/attemptPresentation';
import { t } from '@/text';
import { SERVER_UNREACHABLE_ERROR_CODE } from '@/sync/runtime/connectivity/transientConnectivityErrors';
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
import { redactVoicePathLikeString } from '@/voice/shared/redactVoicePathLikeData';
import { presentExecutionRunTurnFailure, presentSessionStartupFailureCause } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import type { VoiceRuntimeFailureCause } from '@/voice/runtime/voiceRuntimeFailureCode';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';

/**
 * Whether the attempt failed because its Home did not answer: one cause the Home's own surfaces
 * (sidebar line, page empty state) already state and repair with their Retry.
 */
export function isVoiceAttemptHomeUnreachable(input: Readonly<{
    errorCode?: string | null;
    errorMessage?: string | null;
    errorFailureCause?: VoiceRuntimeFailureCause;
}>): boolean {
    if (!input.errorCode || resolveVoiceMachineErrorKind(input.errorCode) !== 'provider_error') return false;
    const cause = input.errorFailureCause;
    return (cause !== undefined && 'errorCode' in cause && cause.errorCode === SERVER_UNREACHABLE_ERROR_CODE)
        || input.errorMessage?.toLowerCase() === SERVER_UNREACHABLE_ERROR_CODE;
}

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
    /** The Home the attempt talks to, named through the Home label owner when it is unreachable. */
    homeServerId?: string | null;
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
        : provider && recoveryAction !== 'connect_agent' ? providerRecovery ? { label: t(providerRecovery.titleKey), icon: 'gear' as const } : null
        : control.surfaceState === 'permission_required'
            ? { label: t('voicePresence.recovery.allow'), icon: 'microphone' as const }
            : recovery
                ? { label: reconnectProfile ? t(reconnectProfile.labelKey) : opensAgentRuntimeSettings(recoveryAction, recoveryContext) && agentTitle
                    ? t('voiceSurface.setUpAgent', { agent: agentTitle }) : t(recovery.labelKey), icon: recovery.icon }
                : { label: t('voicePresence.recovery.setUp'), icon: 'gear' as const };
    const failureKind = input.errorCode ? resolveVoiceMachineErrorKind(input.errorCode) : null;
    const unreachable = failureKind === 'provider_error' && input.errorFailureCause
        && 'errorCode' in input.errorFailureCause && input.errorFailureCause.errorCode === SERVER_UNREACHABLE_ERROR_CODE;
    const presentationReason = unreachable ? SERVER_UNREACHABLE_ERROR_CODE : input.errorMessage;
    const statusPresentation = resolveVoiceSurfaceStatusPresentation(control.surfaceState, presentationReason);
    const sessionCause = input.errorFailureCause && 'failureReason' in input.errorFailureCause ? input.errorFailureCause : undefined;
    const startupCode = sessionCause?.code ?? input.errorMessage;
    const startupMessage = startupCode ? presentSessionStartupFailureCause(startupCode, undefined, sessionCause, input.errorProviderMessage) : null;
    const turnMessage = presentExecutionRunTurnFailure(sessionCause);
    const providerMessage = turnMessage ? redactVoicePathLikeString(turnMessage) : input.errorProviderMessage;
    const homeUnreachable = isVoiceAttemptHomeUnreachable(input);
    const failureMessage = provider ? t(provider.descriptionKey) : connectedService ? t(connectedService.bodyKey)
        // The Home's own words for the same cause, with its name ("Can't reach This Home"), as the page says it.
        : homeUnreachable && input.homeServerId
            ? t('sidebarFooter.homeUnreachableTitle', {
                home: resolveHomeDisplayLabel(getServerProfileById(input.homeServerId), input.homeServerId, input.homeServerId),
            })
        : failureKind === 'authentication_required' && input.errorMessage === 'agent_signed_out' && agentTitle && agentMachineLabel
            ? t('settingsVoice.local.machineErrors.agent_signed_out', { agent: agentTitle, machine: agentMachineLabel })
        // The machine the attempt was admitted on, by name: the short reason a capsule can read whole.
        : failureKind === 'execution_machine_unavailable' && input.errorMessage?.toLowerCase() === 'voice_agent_target_machine_offline' && agentMachineLabel
            ? t('voice.readiness.execution_machine_offline', { machine: agentMachineLabel })
        : startupMessage ?? (failureKind === null ? null
        : failureKind === 'provider_error' && providerMessage && !unreachable ? providerMessage
        : failureKind === 'provider_error' && input.errorMessage === 'usage_limit' ? presentVoiceUsageLimitMessage(input.errorUsageLimit)
        : translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, presentationReason ?? undefined), { service: input.serviceTitle }));
    const failureTitle = provider ? t(provider.titleKey)
        : failureKind === 'provider_error' && input.errorMessage?.toLowerCase() === 'usage_limit'
            ? translateVoiceReadiness(resolveVoiceMachineErrorTranslationKey(failureKind, input.errorMessage), { service: input.serviceTitle })
        // A short word for the bar and the hero; the full reason reads once, as the caption.
        : failureKind === 'execution_machine_unavailable' ? t('voice.readiness.short.machineUnreachable')
        : failureKind === 'session_unavailable' ? t('voice.readiness.short.sessionUnavailable')
        : failureKind === 'service_temporarily_unavailable' && input.errorMessage === 'audio_user_gesture_required'
            ? t('voice.readiness.short.audioBlocked')
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
