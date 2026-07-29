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
    inactiveStatusText: string | null;
    sessionStatusResuming: boolean;
    sessionStatusText: string;
    sessionStatusColor: string;
    sessionStatusDotColor: string;
    sessionStatusPulsing: boolean;
}>): SessionViewConnectionStatus {
    const restartPending = input.connectedServicesRestartState?.status === 'restarting'
        || input.connectedServicesRestartState?.status === 'pending_confirmation';
    return {
        text: restartPending
            ? input.restartingText
            : input.connectedServicesRestartState?.status === 'failed'
                ? input.switchFailedText
                : input.sessionStatusResuming
                    ? input.sessionStatusText
                    : (input.inactiveStatusText || input.sessionStatusText),
        color: input.sessionStatusColor,
        dotColor: input.sessionStatusDotColor,
        isPulsing: restartPending
            || input.sessionStatusPulsing,
    };
}
