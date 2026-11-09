import { ActionFailureCauseV1Schema, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { createServerFetchForActiveServer, StaleServerGenerationError, type ServerFetch, type ServerFetchOptions } from '@/sync/http/client';
import { createCapturedServerReadTransport, type CapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { getActiveServerHomeCarrier, getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveActiveServerRuntimeOrigin } from '@/sync/runtime/nativeLoopbackTunnels/runtimeOrigin';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createScopedResolutionSingleFlight } from '@/sync/runtime/orchestration/serverScopedRpc/scopedResolutionSingleFlight';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type AutomationRequestContext = Readonly<{
    request: ServerFetch;
    serverId: string;
    readTransport?: CapturedServerReadTransport;
    accountLifetime?: ServerAccountScopeLifetime;
    invocationSignal?: AbortSignal;
    assertCurrent?: () => void;
}>;

// JSON acquisition only. Strict family parsing and per-invocation admission stay
// in the Automation/Workflow owners; no opened definition or Run is retained.
const automationReads = createScopedResolutionSingleFlight<unknown>();

/** The native HTTP owner has already captured this active generation; no profile/auth recapture. */
export function captureNativeAutomationRequestContext(credentials?: AuthCredentials): AutomationRequestContext {
    const snapshot = getActiveServerSnapshot();
    const homeCarrier = getActiveServerHomeCarrier();
    const request = createServerFetchForActiveServer(snapshot);
    return { serverId: snapshot.serverId, request,
        readTransport: credentials ? createCapturedServerReadTransport({ serverId: snapshot.serverId, credentials,
            prepared: { endpointUrl: snapshot.serverUrl, runtimeOrigin: resolveActiveServerRuntimeOrigin(snapshot),
                homeCarrier, generation: snapshot.generation, request } })
            : apiSocket.createReadTransportForActiveServer({ endpoint: snapshot.serverUrl,
                serverId: snapshot.serverId, generation: snapshot.generation }),
        assertCurrent: () => {
            const current = getActiveServerSnapshot();
            if (current.serverId !== snapshot.serverId || current.generation !== snapshot.generation) throw new StaleServerGenerationError();
        } };
}

export async function readAutomationApiJson(path: string, init: RequestInit, options: ServerFetchOptions,
    context: AutomationRequestContext | undefined, fallback: ServerFetch, credentials?: AuthCredentials): Promise<unknown> {
    options = { recoveryRead: 'unbounded', ...options };
    context ??= captureNativeAutomationRequestContext(credentials);
    context?.assertCurrent?.();
    if (!context?.readTransport) {
        const result = await readAutomationJsonOrThrow(await (context?.request ?? fallback)(path, init, options));
        context?.assertCurrent?.();
        return result;
    }
    const transport = context.readTransport;
    const bindingKey = transport.key;
    const scope = transport.scope ?? bindingKey;
    const abort = new AbortController();
    const retirement = context.accountLifetime?.onRetire(() => abort.abort());
    const cancellation = mergeAbortSignals([init.signal ?? undefined, context.invocationSignal, abort.signal]);
    try {
        const result = await automationReads.run(JSON.stringify([bindingKey, path, init.method ?? 'GET', init.body ?? null]),
            signal => transport.read(path, { ...init, signal }, options, readAutomationJsonOrThrow),
            { scope, signal: cancellation.signal });
        context.assertCurrent?.();
        return result;
    } finally { cancellation.dispose(); retirement?.dispose(); }
}

/** Local mutations also fence direct API readers that have no mounted Action. */
export function invalidateAutomationReadAcquisitions(context?: AutomationRequestContext): void {
    const transport = context?.readTransport;
    if (transport) automationReads.invalidate(transport.scope ?? transport.key);
}

export type AutomationApiErrorPayload = Readonly<{
    code: string;
    status: number;
    message?: string;
    failureCause?: ActionFailureCauseV1;
}>;

export class AutomationApiError extends HappyError {
    constructor(payload: AutomationApiErrorPayload) {
        super(
            payload.message ?? payload.code,
            payload.status === 408 || payload.status === 429 || payload.status >= 500,
            {
                code: payload.code,
                status: payload.status,
                kind: 'server',
                ...(payload.failureCause === undefined ? {} : { failureCause: payload.failureCause }),
            },
        );
        this.name = 'AutomationApiError';
        Object.setPrototypeOf(this, AutomationApiError.prototype);
    }
}

export function isAutomationApiErrorCode(error: unknown, code: string): error is AutomationApiError {
    return error instanceof AutomationApiError && error.code === code;
}

export async function readAutomationJsonOrThrow(response: Response): Promise<unknown> {
    if (!response.ok) {
        let message = `Automation API request failed: ${response.status}`;
        let code = 'automation_api_request_failed';
        let failureCause: ActionFailureCauseV1 | undefined;
        try {
            const error = await response.json();
            const record = error && typeof error === 'object'
                ? error as Record<string, unknown>
                : null;
            if (typeof record?.error === 'string') {
                message = record.error;
                code = message;
            }
            const parsedCause = ActionFailureCauseV1Schema.safeParse(record?.failureCause);
            if (parsedCause.success) failureCause = parsedCause.data;
        } catch {
            // ignore
        }
        throw new AutomationApiError({ code, status: response.status, message,
            ...(failureCause === undefined ? {} : { failureCause }) });
    }
    return await response.json();
}

export function getAutomationAuthHeaders(
    credentials: AuthCredentials,
    options: Readonly<{ includeJsonContentType?: boolean }> = {},
): Record<string, string> {
    const headers: Record<string, string> = {
        Authorization: `Bearer ${credentials.token}`,
    };
    if (options.includeJsonContentType) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}
