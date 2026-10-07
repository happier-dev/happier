import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
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
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { ExecutionRunWaitConditionSchema } from '@happier-dev/protocol/execution/runs/waitForTerminal';

function readUnknownRecordProperty(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
}

export function createSessionClientExecutionRunService(
    params: Readonly<{
        token: string;
        serverUrl?: string;
        sessionId: string;
        getStoredContentCryptoContext: () => SessionStoredContentCryptoContext;
    }>,
): HappyMcpExecutionRunService {
    const serverUrl = params.serverUrl ?? resolveServerHttpBaseUrl();
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
            await runWithServerHttpBaseUrl(serverUrl, async () => startExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            })),
        list: async (request: unknown) =>
            await runWithServerHttpBaseUrl(serverUrl, async () => listExecutionRuns({
                ...readExecutionRunServiceContext(),
                request,
            })),
        get: async (request: unknown) =>
            await runWithServerHttpBaseUrl(serverUrl, async () => getExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            })),
        send: async (request: unknown) =>
            await runWithServerHttpBaseUrl(serverUrl, async () => sendExecutionRunMessage({
                ...readExecutionRunServiceContext(),
                request,
            })),
        stop: async (request: unknown) =>
            await runWithServerHttpBaseUrl(serverUrl, async () => stopExecutionRun({
                ...readExecutionRunServiceContext(),
                request,
            })),
        action: async (request: unknown) =>
            await runWithServerHttpBaseUrl(serverUrl, async () => executeExecutionRunAction({
                ...readExecutionRunServiceContext(),
                request,
            })),
        wait: async (request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
            const rawTimeoutSeconds = readUnknownRecordProperty(request, 'timeoutSeconds');
            const condition = readUnknownRecordProperty(request, 'condition');
            const after = readUnknownRecordProperty(request, 'after');

            return await runWithServerHttpBaseUrl(serverUrl, async () => waitForExecutionRun({
                ...readExecutionRunServiceContext(),
                runId: String(readUnknownRecordProperty(request, 'runId') ?? ''),
                timeoutMs: normalizeExecutionRunWaitTimeoutMs(rawTimeoutSeconds),
                ...(condition === undefined ? {} : { condition: ExecutionRunWaitConditionSchema.parse(condition) }),
                ...(after === undefined ? {} : { after: ExecutionRunGetResponseSchema.parse(after) }),
                ...(options?.signal ? { signal: options.signal } : {}),
            }));
        },
    } as const;
}
