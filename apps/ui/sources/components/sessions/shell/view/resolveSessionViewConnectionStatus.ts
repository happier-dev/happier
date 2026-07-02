import type { SessionConnectedServicesAuthSwitchRestartState } from '@/components/sessions/agentInput/hooks/useSessionConnectedServicesAuthSwitch';

export type SessionViewConnectionStatus = Readonly<{
    text: string;
    color: string;
    dotColor: string;
    isPulsing: boolean;
}>;

export function resolveSessionViewConnectionStatus(input: Readonly<{
    connectedServicesRestartState: SessionConnectedServicesAuthSwitchRestartState;
    restartingText: string;
    switchFailedText: string;
    resumingText: string;
    inactiveStatusText: string | null;
    sessionStatusText: string;
    sessionStatusColor: string;
    sessionStatusDotColor: string;
    sessionStatusPulsing: boolean;
    isResuming: boolean;
    isPendingQueueWakeResuming: boolean;
    isSessionStatusResuming: boolean;
}>): SessionViewConnectionStatus {
    const restartPending = input.connectedServicesRestartState?.status === 'restarting'
        || input.connectedServicesRestartState?.status === 'pending_confirmation';
    return {
        text: restartPending
            ? input.restartingText
            : input.connectedServicesRestartState?.status === 'failed'
                ? input.switchFailedText
                : (input.isResuming || input.isPendingQueueWakeResuming || input.isSessionStatusResuming)
                    ? input.resumingText
                    : (input.inactiveStatusText || input.sessionStatusText),
        color: input.sessionStatusColor,
        dotColor: input.sessionStatusDotColor,
        isPulsing: restartPending
            || input.isResuming
            || input.isPendingQueueWakeResuming
            || input.sessionStatusPulsing,
    };
}
