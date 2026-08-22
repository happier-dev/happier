import type { HappyMcpExecutionRunService } from '@/mcp/startHappyServer';
import {
    executeExecutionRunAction,
    getExecutionRun,
    listExecutionRuns,
    sendExecutionRunMessage,
    startExecutionRun,
    stopExecutionRun,
    waitForExecutionRun,
} from '@/session/services/executionRuns';
import { normalizeExecutionRunWaitTimeoutMs } from '@/session/services/executionRunWaitTiming';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';

function readUnknownRecordProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
}

export function createSessionClientExecutionRunService(
    params: Readonly<{
        token: string;
        sessionId: string;
        getStoredContentCryptoContext: () => SessionStoredContentCryptoContext;
    }>,
): HappyMcpExecutionRunService {
    const readExecutionRunServiceContext = (): Readonly<{
        token: string;
        sessionId: string;
    }> & SessionStoredContentCryptoContext => {
        return {
            token: params.token,
            sessionId: params.sessionId,
            ...params.getStoredContentCryptoContext(),
        };
    };

    return {
        start: async (request: unknown) =>
            await startExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            }),
        list: async (request: unknown) =>
            await listExecutionRuns({
                ...readExecutionRunServiceContext(),
                request,
            }),
        get: async (request: unknown) =>
            await getExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            }),
        send: async (request: unknown) =>
            await sendExecutionRunMessage({
                ...readExecutionRunServiceContext(),
                request,
            }),
        stop: async (request: unknown) =>
            await stopExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            }),
        action: async (request: unknown) =>
            await executeExecutionRunAction({
                ...readExecutionRunServiceContext(),
                request,
            }),
        wait: async (request: unknown) => {
            const rawTimeoutSeconds = readUnknownRecordProperty(request, 'timeoutSeconds');
            const rawPollIntervalMs = readUnknownRecordProperty(request, 'pollIntervalMs');
            const requestPollIntervalMs =
                typeof rawPollIntervalMs === 'number' && Number.isFinite(rawPollIntervalMs) && rawPollIntervalMs > 0
                    ? Math.min(60_000, rawPollIntervalMs)
                    : null;
            const envPollIntervalRaw = (process.env.HAPPIER_SESSION_RUN_WAIT_POLL_INTERVAL_MS ?? '').trim();
            const envPollIntervalParsed = envPollIntervalRaw ? Number.parseInt(envPollIntervalRaw, 10) : NaN;
            const envPollIntervalMs =
                Number.isFinite(envPollIntervalParsed) && envPollIntervalParsed > 0 ? Math.min(60_000, envPollIntervalParsed) : 1_000;

            return await waitForExecutionRun({
                ...readExecutionRunServiceContext(),
                runId: String(readUnknownRecordProperty(request, 'runId') ?? ''),
                timeoutMs: normalizeExecutionRunWaitTimeoutMs(rawTimeoutSeconds),
                pollIntervalMs: requestPollIntervalMs ?? envPollIntervalMs,
            });
        },
    } as const;
}
