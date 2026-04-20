import { buildDaemonInitialPromptLocalId } from '@/agent/runtime/daemonInitialPrompt';
import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import type {
    ManagedConnectionSupervisor,
    ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';
import type { UserMessage } from '../../../types';

import { catchUpSessionMessagesAfterSeq } from '../../sessionMessageCatchUp';

type NonReadyProbeResult = Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>>;

type StartupCatchUpPort = {
    closed: boolean;
    token: string;
    sessionId: string;
    sessionConnectionSupervisor: ManagedConnectionSupervisor | null;
    recoveryRuntime?: {
        catchUpSessionMessages: (afterSeq: number) => Promise<void>;
        scheduleNextStartupMessageCatchUpRetry: () => void;
    };
    currentConnectionState?: { phase?: string | null };
    startupMessageCatchUpInitialAfterSeq: number;
    startupMessageCatchUpRetryIndex: number;
    startupMessageCatchUpRetryTimer: ReturnType<typeof setTimeout> | null;
    pendingMessages: UserMessage[];
    pendingMessageCallback: ((message: UserMessage) => void) | null;
    userMessageCallbackAttachedAtMs: number | null;
    startupMessageCatchUpStarted: boolean;
    daemonInitialPrompt: string | null;
    daemonInitialPromptSeeded: boolean;
    lastObservedMessageSeq: number;
    enqueueSessionUserMessage: (params: Readonly<{
        text: string;
        localId?: string;
        meta?: Record<string, unknown>;
    }>) => void;
    catchUpSessionMessages: (afterSeq: number) => Promise<void>;
    scheduleNextStartupMessageCatchUpRetry: () => void;
    shouldRunStartupTranscriptCatchUp: () => boolean;
    kickUserSocketConnect: () => void;
    classifyTransportErrorToProbeResult: (error: unknown) => NonReadyProbeResult | null;
    handleCatchUpUpdate: (update: unknown) => void;
};

export function catchUpSessionMessagesViaPort(
    port: StartupCatchUpPort,
    afterSeq: number,
): Promise<void> {
    if (port.recoveryRuntime) {
        return port.recoveryRuntime.catchUpSessionMessages(afterSeq);
    }

    const request = () => catchUpSessionMessagesAfterSeq({
        token: port.token,
        sessionId: port.sessionId,
        afterSeq,
        onUpdate: (update) => port.handleCatchUpUpdate(update),
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
        void port.catchUpSessionMessages(port.startupMessageCatchUpInitialAfterSeq)
            .catch((error) => {
                if (isAuthenticationError(error)) {
                    return false;
                }
                return true;
            })
            .then((shouldContinue) => {
                if (shouldContinue !== false) {
                    port.scheduleNextStartupMessageCatchUpRetry();
                }
            });
    }, delayMs);
    port.startupMessageCatchUpRetryTimer.unref?.();
}

export function attachSessionUserMessageHandler(
    port: StartupCatchUpPort,
    callback: (data: UserMessage) => void,
): void {
    port.pendingMessageCallback = callback;
    if (port.userMessageCallbackAttachedAtMs === null) {
        port.userMessageCallbackAttachedAtMs = Date.now();
    }
    port.kickUserSocketConnect();
    const startupCatchUpInitialAfterSeq = port.lastObservedMessageSeq;
    while (port.pendingMessages.length > 0) {
        callback(port.pendingMessages.shift()!);
    }
    if (!port.startupMessageCatchUpStarted) {
        port.startupMessageCatchUpStarted = true;
        port.startupMessageCatchUpRetryIndex = 0;
        port.startupMessageCatchUpInitialAfterSeq = startupCatchUpInitialAfterSeq;
        void port.catchUpSessionMessages(startupCatchUpInitialAfterSeq)
            .catch((error) => {
                if (isAuthenticationError(error)) {
                    return false;
                }
                return true;
            })
            .then((shouldContinue) => {
                if (shouldContinue !== false) {
                    port.scheduleNextStartupMessageCatchUpRetry();
                }
            });
    }
    if (!port.daemonInitialPromptSeeded && typeof port.daemonInitialPrompt === 'string') {
        port.daemonInitialPromptSeeded = true;
        const initialPrompt = port.daemonInitialPrompt;
        const initialPromptLocalId = buildDaemonInitialPromptLocalId(port.sessionId);
        port.daemonInitialPrompt = null;
        port.enqueueSessionUserMessage({
            text: initialPrompt,
            ...(initialPromptLocalId ? { localId: initialPromptLocalId } : {}),
            meta: {
                source: 'daemon-initial-prompt',
                sentFrom: 'cli',
            },
        });
    }
}
