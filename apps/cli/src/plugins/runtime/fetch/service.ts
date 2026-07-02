import type {
    PluginRequestInterceptorContributionV1,
    PluginRequestInterceptorScopeV1,
    PluginRequestInterceptorTargetV1,
    RequestInterceptorRequestPatchV1,
    RequestPolicyResultV1,
} from '@happier-dev/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
    PluginApiRequestInterceptorRegistrationV1,
    RequestPolicyCallerV1,
} from '@happier-dev/plugin-sdk';

export type PluginFetchErrorCode =
    | 'PLUGIN_FETCH_PERMISSION_DENIED'
    | 'PLUGIN_FETCH_ADAPTER_UNAVAILABLE'
    | 'PLUGIN_FETCH_URL_SCOPE_DENIED'
    | 'PLUGIN_FETCH_INTERCEPTOR_DENIED'
    | 'PLUGIN_FETCH_INTERCEPTOR_FAILED';

export class PluginFetchError extends Error {
    readonly code: PluginFetchErrorCode;

    constructor(code: PluginFetchErrorCode, message: string) {
        super(message);
        this.name = 'PluginFetchError';
        this.code = code;
    }
}

export type CreatePluginFetchServiceParams = Readonly<{
    networkAllowed: boolean;
    adapter?: FetchRuntimeServiceV1 | null;
    interceptors?: readonly PluginRequestInterceptorBindingV1[];
    interception?: Readonly<{
        scope?: PluginRequestInterceptorScopeV1;
        caller?: RequestPolicyCallerV1;
        operationId?: string;
    }>;
    pluginId?: string | null;
    allowedUrlOrigins?: readonly string[];
    retry?: Readonly<{
        maxAttempts: number;
        baseDelayMs?: number;
    }>;
}>;

export type PluginRequestInterceptorBindingV1 = Readonly<{
    pluginId: string;
    contribution: PluginRequestInterceptorContributionV1;
    registration: PluginApiRequestInterceptorRegistrationV1;
}>;

const REDACTED_VALUE = '[redacted]';
const SECRET_KEY_PATTERN = /api_?key|secret|token|password|credential/i;
const TIER_ONE_HEADER_NAMES = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-auth-token',
]);
const TIER_TWO_HEADER_NAMES = new Set([
    'forwarded',
    'x-client-ip',
    'x-forwarded-user',
    'x-forwarded-for',
    'x-forwarded-email',
    'x-real-ip',
    'x-user-id',
    'x-user-email',
    'x-user-name',
    'x-signature',
    'x-hub-signature-256',
]);

function createAbortError(): Error {
    const error = new Error('Plugin fetch request was aborted');
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
        throw createAbortError();
    }
}

function mergeAbortSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.length === 0) {
        return undefined;
    }
    if (activeSignals.length === 1) {
        return activeSignals[0];
    }
    const controller = new AbortController();
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(signal.reason);
        }
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort(signal);
            break;
        }
        signal.addEventListener('abort', () => abort(signal), { once: true });
    }
    return controller.signal;
}

function withTimeout(request: FetchRuntimeRequestV1): Readonly<{
    request: FetchRuntimeRequestV1;
    dispose: () => void;
}> {
    if (request.timeoutMs === undefined) {
        return { request, dispose: () => undefined };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(createAbortError());
    }, Math.max(0, request.timeoutMs));
    return {
        request: {
            ...request,
            signal: mergeAbortSignals([request.signal, controller.signal]),
        },
        dispose: () => clearTimeout(timer),
    };
}

function assertUrlAllowed(params: Readonly<{
    request: FetchRuntimeRequestV1;
    allowedUrlOrigins: readonly string[] | undefined;
    pluginId: string | null | undefined;
}>): void {
    const allowedUrlOrigins = params.allowedUrlOrigins;
    if (!allowedUrlOrigins || allowedUrlOrigins.length === 0) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch without a declared URL origin scope`,
        );
    }
    if (allowedUrlOrigins.includes('*')) {
        return;
    }
    let origin: string;
    try {
        origin = new URL(params.request.url).origin;
    } catch {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch with an invalid URL`,
        );
    }
    if (!allowedUrlOrigins.includes(origin)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch for undeclared URL origin '${origin}'`,
        );
    }
}

function readOrigin(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

function targetAllowsUrl(target: PluginRequestInterceptorTargetV1, url: string): boolean {
    const allowedUrlOrigins = target.urlOrigins;
    if (!allowedUrlOrigins || allowedUrlOrigins.length === 0 || allowedUrlOrigins.includes('*')) {
        return true;
    }
    const origin = readOrigin(url);
    return origin !== null && allowedUrlOrigins.includes(origin);
}

function selectTarget(
    contribution: PluginRequestInterceptorContributionV1,
    scope: PluginRequestInterceptorScopeV1,
    request: FetchRuntimeRequestV1,
): PluginRequestInterceptorTargetV1 | null {
    return contribution.targets.find((target) => (
        target.scope === scope && targetAllowsUrl(target, request.url)
    )) ?? null;
}

function normalizeHeaderName(name: string): string {
    return name.trim().toLowerCase();
}

function isTierOneHeader(name: string): boolean {
    const normalized = normalizeHeaderName(name);
    return TIER_ONE_HEADER_NAMES.has(normalized)
        || SECRET_KEY_PATTERN.test(normalized)
        || normalized.endsWith('api-key')
        || normalized.endsWith('auth-token')
        || normalized.endsWith('session-secret')
        || normalized.endsWith('account-token')
        || normalized.endsWith('provider-credential');
}

function isTierTwoHeader(name: string): boolean {
    const normalized = normalizeHeaderName(name);
    return TIER_TWO_HEADER_NAMES.has(normalized)
        || normalized.startsWith('x-forwarded-')
        || normalized.startsWith('x-user-')
        || normalized.includes('signature');
}

function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (SECRET_KEY_PATTERN.test(key)) {
                parsed.searchParams.set(key, REDACTED_VALUE);
            }
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function redactBody(value: unknown, redactPrimitive: boolean = true): unknown {
    if (value === undefined || value === null) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactBody(entry, false));
    }
    if (!isPlainRecord(value)) {
        return typeof value === 'object' || redactPrimitive ? REDACTED_VALUE : value;
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
        output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED_VALUE : redactBody(child, false);
    }
    return Object.freeze(output);
}

function redactHeaders(headers: FetchRuntimeRequestV1['headers']): FetchRuntimeRequestV1['headers'] {
    if (!headers) {
        return headers;
    }
    return Object.freeze(Object.fromEntries(Object.entries(headers).map(([key, value]) => [
        key,
        isTierOneHeader(key) || isTierTwoHeader(key) ? REDACTED_VALUE : value,
    ])));
}

function redactRequestForInterceptor(request: FetchRuntimeRequestV1): FetchRuntimeRequestV1 {
    return Object.freeze({
        ...request,
        url: redactUrl(request.url),
        headers: redactHeaders(request.headers),
        body: redactBody(request.body),
    });
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
    return isPlainRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isHeaderPatch(value: unknown): boolean {
    if (!isPlainRecord(value)) {
        return false;
    }
    return (value.remove === undefined || isStringArray(value.remove))
        && (value.set === undefined || isStringRecord(value.set));
}

function isRequestPatch(value: unknown): value is RequestInterceptorRequestPatchV1 {
    if (!isPlainRecord(value)) {
        return false;
    }
    const allowedKeys = new Set(['url', 'method', 'headers', 'metadata']);
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
        return false;
    }
    return (value.url === undefined || typeof value.url === 'string')
        && (value.method === undefined || typeof value.method === 'string')
        && (value.headers === undefined || isHeaderPatch(value.headers))
        && (value.metadata === undefined || isPlainRecord(value.metadata));
}

function isDiagnosticMetadata(value: unknown): value is Readonly<Record<string, unknown>> {
    return isPlainRecord(value);
}

function hasOnlyKeys(
    value: Readonly<Record<string, unknown>>,
    allowedKeys: ReadonlySet<string>,
): boolean {
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

const ALLOW_RESULT_KEYS = new Set(['kind', 'request', 'auditMetadata']);
const DENY_RESULT_KEYS = new Set(['kind', 'code', 'reason', 'auditMetadata']);
const ERROR_RESULT_KEYS = new Set(['kind', 'code', 'reason', 'retryable', 'auditMetadata']);

function isRequestPolicyResult(value: unknown): value is RequestPolicyResultV1 {
    if (!isPlainRecord(value) || typeof value.kind !== 'string') {
        return false;
    }
    if (value.auditMetadata !== undefined && !isDiagnosticMetadata(value.auditMetadata)) {
        return false;
    }
    if (value.kind === 'allow') {
        return hasOnlyKeys(value, ALLOW_RESULT_KEYS)
            && (value.request === undefined || isRequestPatch(value.request));
    }
    if (value.kind === 'deny') {
        return hasOnlyKeys(value, DENY_RESULT_KEYS)
            && typeof value.code === 'string'
            && value.code.trim().length > 0
            && (value.reason === undefined || typeof value.reason === 'string');
    }
    if (value.kind === 'error') {
        return hasOnlyKeys(value, ERROR_RESULT_KEYS)
            && typeof value.code === 'string'
            && value.code.trim().length > 0
            && (value.reason === undefined || typeof value.reason === 'string')
            && (value.retryable === undefined || typeof value.retryable === 'boolean');
    }
    return false;
}

function removeHeader(headers: Record<string, string>, name: string): void {
    const normalized = normalizeHeaderName(name);
    for (const key of Object.keys(headers)) {
        if (normalizeHeaderName(key) === normalized) {
            delete headers[key];
        }
    }
}

function applyRequestPatch(
    request: FetchRuntimeRequestV1,
    patch: RequestInterceptorRequestPatchV1 | undefined,
): FetchRuntimeRequestV1 {
    if (!patch) {
        return request;
    }
    const headers = { ...(request.headers ?? {}) };
    for (const name of patch.headers?.remove ?? []) {
        removeHeader(headers, name);
    }
    for (const [name, value] of Object.entries(patch.headers?.set ?? {})) {
        removeHeader(headers, name);
        headers[name] = value;
    }
    const metadata = patch.metadata
        ? Object.freeze({ ...(request.metadata ?? {}), ...patch.metadata })
        : request.metadata;
    return Object.freeze({
        ...request,
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        ...(patch.method !== undefined ? { method: patch.method } : {}),
        ...(Object.keys(headers).length > 0 ? { headers: Object.freeze(headers) } : { headers: undefined }),
        ...(metadata !== undefined ? { metadata } : {}),
    });
}

function isTransientFetchError(error: unknown): boolean {
    if (!(error instanceof Error)) {
        return false;
    }
    const code = String((error as Error & { code?: unknown }).code ?? '');
    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    if (ms <= 0) {
        return;
    }
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(createAbortError());
        }, { once: true });
    });
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    assertNotAborted(signal);
    if (!signal) {
        return await operation;
    }
    return await new Promise<T>((resolve, reject) => {
        const abort = () => {
            cleanup();
            reject(createAbortError());
        };
        const cleanup = () => {
            signal.removeEventListener('abort', abort);
        };
        signal.addEventListener('abort', abort, { once: true });
        operation.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error: unknown) => {
                cleanup();
                reject(error);
            },
        );
    });
}

function sortInterceptors(
    interceptors: readonly PluginRequestInterceptorBindingV1[],
): readonly PluginRequestInterceptorBindingV1[] {
    return Object.freeze([...interceptors].sort((left, right) => (
        (left.contribution.order ?? 0) - (right.contribution.order ?? 0)
        || left.pluginId.localeCompare(right.pluginId)
        || left.contribution.id.localeCompare(right.contribution.id)
    )));
}

function createDefaultOperationId(
    scope: PluginRequestInterceptorScopeV1,
    request: FetchRuntimeRequestV1,
): string {
    const method = (request.method ?? 'GET').trim().toUpperCase() || 'GET';
    const digest = createHash('sha256')
        .update(method)
        .update('\0')
        .update(redactUrl(request.url))
        .digest('hex')
        .slice(0, 16);
    return `${scope}:${method}:${digest}`;
}

function createTerminalFetchAdapter(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    return async (request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
        assertNotAborted(request.signal);
        assertUrlAllowed({
            request,
            allowedUrlOrigins: params.allowedUrlOrigins,
            pluginId: params.pluginId,
        });
        if (!params.adapter) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_ADAPTER_UNAVAILABLE',
                'ctx.fetch network access is unavailable in this host context because no host fetch adapter is bound',
            );
        }
        return await params.adapter(request);
    };
}

export function createPluginFetchService(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    const interceptors = sortInterceptors(params.interceptors ?? []);
    const terminal = createTerminalFetchAdapter(params);
    const activeInterceptorKeysByOperation = new AsyncLocalStorage<Set<string>>();
    const scope = params.interception?.scope ?? 'plugin-fetch';
    const caller = params.interception?.caller ?? Object.freeze({
        scope: 'plugin-fetch' as const,
        ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    });

    async function fetchThroughPolicies(request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> {
        const activeInterceptorKeys = activeInterceptorKeysByOperation.getStore();
        if (!activeInterceptorKeys) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                'Request interceptor recursion state is unavailable for this operation',
            );
        }
        let effectiveRequest = request;
        for (const binding of interceptors) {
            assertNotAborted(effectiveRequest.signal);
            const activeKey = `${binding.pluginId}:${binding.contribution.id}`;
            if (activeInterceptorKeys.has(activeKey)) {
                continue;
            }
            const target = selectTarget(binding.contribution, scope, effectiveRequest);
            if (!target) {
                continue;
            }
            activeInterceptorKeys.add(activeKey);
            let result: RequestPolicyResultV1;
            try {
                result = await binding.registration.handle({
                    interceptorId: binding.contribution.id,
                    pluginId: binding.pluginId,
                    target,
                    originalRequest: redactRequestForInterceptor(request),
                    effectiveRequest: redactRequestForInterceptor(effectiveRequest),
                    caller,
                    operation: {
                        id: params.interception?.operationId ?? createDefaultOperationId(scope, request),
                        attempt: Number(request.metadata?.attempt ?? 1),
                    },
                });
            } catch (error) {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    error instanceof Error ? error.message : `Request interceptor '${binding.contribution.id}' failed`,
                );
            } finally {
                activeInterceptorKeys.delete(activeKey);
            }
            if (!isRequestPolicyResult(result)) {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    `Request interceptor '${binding.contribution.id}' returned an invalid policy result`,
                );
            }
            if (result.kind === 'deny') {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_DENIED',
                    result.reason ?? `Request interceptor '${binding.contribution.id}' denied the request with code '${result.code}'`,
                );
            }
            if (result.kind === 'error') {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    result.reason ?? `Request interceptor '${binding.contribution.id}' failed with code '${result.code}'`,
                );
            }
            if (result.kind !== 'allow') {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    `Request interceptor '${binding.contribution.id}' returned an invalid policy result`,
                );
            }
            const nextRequest = applyRequestPatch(effectiveRequest, result.request);
            if (!targetAllowsUrl(target, nextRequest.url)) {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_URL_SCOPE_DENIED',
                    `Request interceptor '${binding.contribution.id}' rewrote the request outside its declared target URL origins`,
                );
            }
            effectiveRequest = nextRequest;
        }
        return await terminal(effectiveRequest);
    }

    async function executeFetch(request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> {
        assertNotAborted(request.signal);
        if (!params.networkAllowed) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_PERMISSION_DENIED',
                `Plugin '${params.pluginId ?? 'unknown'}' cannot call ctx.fetch without declaring network permission`,
            );
        }
        assertUrlAllowed({
            request,
            allowedUrlOrigins: params.allowedUrlOrigins,
            pluginId: params.pluginId,
        });
        const timeout = withTimeout(request);
        const maxAttempts = Math.max(1, params.retry?.maxAttempts ?? 1);
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(timeout.request.signal);
                try {
                    return await raceWithAbort(fetchThroughPolicies({
                        ...timeout.request,
                        metadata: Object.freeze({
                            ...(timeout.request.metadata ?? {}),
                            attempt,
                        }),
                    }), timeout.request.signal);
                } catch (error) {
                    if (attempt >= maxAttempts || !isTransientFetchError(error)) {
                        throw error;
                    }
                    await delay(params.retry?.baseDelayMs ?? 0, timeout.request.signal);
                }
            }
        } finally {
            timeout.dispose();
        }
        throw new PluginFetchError(
            'PLUGIN_FETCH_ADAPTER_UNAVAILABLE',
            'ctx.fetch retry exhausted without a terminal result',
        );
    }

    return async (request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> => {
        const existingOperationState = activeInterceptorKeysByOperation.getStore();
        if (existingOperationState) {
            return await executeFetch(request);
        }
        return await activeInterceptorKeysByOperation.run(new Set<string>(), async () => (
            await executeFetch(request)
        ));
    };
}
