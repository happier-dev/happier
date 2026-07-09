import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type {
    ManagedConnectionSupervisor,
    ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';

import { catchUpSessionMessagesAfterSeq } from '../../sessionMessageCatchUp';
import type { SessionCatchUpRequest } from '../../sessionChangesSyncOnConnect';

type NonReadyProbeResult = Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>>;

type StartupCatchUpPort = {
    closed: boolean;
    token: string;
    sessionId: string;
    sessionConnectionSupervisor: ManagedConnectionSupervisor | null;
    recoveryRuntime?: {
        catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
        scheduleNextStartupMessageCatchUpRetry: () => void;
    };
    currentConnectionState?: { phase?: string | null };
    startupMessageCatchUpInitialAfterSeq: number;
    startupMessageCatchUpInitialAfterSeqIsExplicit: boolean;
    startupMessageCatchUpInitialAuthorization?: SessionCatchUpRequest['authorization'];
    startupMessageCatchUpRetryIndex: number;
    startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
    catchUpSessionMessages: (request: SessionCatchUpRequest) => Promise<void>;
    scheduleNextStartupMessageCatchUpRetry: () => void;
    shouldRunStartupTranscriptCatchUp: () => boolean;
    classifyTransportErrorToProbeResult: (error: unknown) => NonReadyProbeResult | null;
    handleCatchUpUpdate: (update: unknown, opts: { catchUpAfterSeq: number; catchUpAuthorization: SessionCatchUpRequest['authorization'] }) => void;
};

export function catchUpSessionMessagesViaPort(
    port: StartupCatchUpPort,
    catchUpRequest: SessionCatchUpRequest,
): Promise<void> {
    if (port.recoveryRuntime) {
        return port.recoveryRuntime.catchUpSessionMessages(catchUpRequest);
    }

    const request = () => catchUpSessionMessagesAfterSeq({
        token: port.token,
        sessionId: port.sessionId,
        afterSeq: catchUpRequest.afterSeq,
        onUpdate: (update) => port.handleCatchUpUpdate(update, {
            catchUpAfterSeq: catchUpRequest.afterSeq,
            catchUpAuthorization: catchUpRequest.authorization,
        }),
    });
    const supervisor = port.sessionConnectionSupervisor;
    if (!supervisor) {
        return request();
    }

    const probeReportScope = supervisor.captureProbeReportScope?.();

    return runSupervisedRequest({
        supervisor,
        requireAuth: true,
        requireOnline: false,
        request,
    }).catch((error) => {
        const probeResult = port.classifyTransportErrorToProbeResult(error);
        if (typeof supervisor.reportProbeResult === 'function' && probeResult) {
            supervisor.reportProbeResult(probeResult, probeReportScope);
        }
        throw error;
    });
}

export function scheduleNextStartupCatchUpRetryViaPort(
    port: StartupCatchUpPort,
    retryDelaysMs: readonly number[],
): void {
    if (port.recoveryRuntime) {
        port.recoveryRuntime.scheduleNextStartupMessageCatchUpRetry();
        return;
    }

    if (port.closed) return;
    if (port.startupMessageCatchUpRetryTimer) return;
    if (!port.shouldRunStartupTranscriptCatchUp()) return;
    if (port.currentConnectionState?.phase === 'auth_failed') return;

    const retryIndex = port.startupMessageCatchUpRetryIndex;
    const delayMs = retryDelaysMs[retryIndex];
    if (typeof delayMs !== 'number') return;

    port.startupMessageCatchUpRetryTimer = setTimeout(() => {
        port.startupMessageCatchUpRetryTimer = null;
        if (port.closed) return;

        port.startupMessageCatchUpRetryIndex = retryIndex + 1;
        void port.catchUpSessionMessages({
            afterSeq: port.startupMessageCatchUpInitialAfterSeq,
            authorization: port.startupMessageCatchUpInitialAuthorization
                ?? (port.startupMessageCatchUpInitialAfterSeqIsExplicit ? 'explicit_cursor' : 'startup_recovery'),
        })
            .catch((error) => {
                if (isAuthenticationError(error)) {
                    return false;
                }
                return true;
            })
            .then((shouldContinue) => {
                if (shouldContinue === true) {
                    port.scheduleNextStartupMessageCatchUpRetry();
                }
            });
    }, delayMs);
    port.startupMessageCatchUpRetryTimer.unref?.();
}
