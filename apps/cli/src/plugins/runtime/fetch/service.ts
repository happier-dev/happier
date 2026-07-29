import type { PluginRequestInterceptorContributionV1 } from '@happier-dev/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
} from '@/plugins/runtime/exec/privateContract';
import type {
    HttpMethod,
    PluginInterceptedRequest,
    PluginInterceptorResult,
    PluginFetchCredentialBinding,
    PluginFetchService,
} from '@happier-dev/plugin-sdk/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
} from '../invocation/services/types';

export type PluginFetchErrorCode =
    | 'PLUGIN_FETCH_PERMISSION_DENIED'
    | 'PLUGIN_FETCH_ADAPTER_UNAVAILABLE'
    | 'PLUGIN_FETCH_URL_SCOPE_DENIED'
    | 'PLUGIN_FETCH_INTERCEPTOR_DENIED'
    | 'PLUGIN_FETCH_INTERCEPTOR_FAILED';

// The fetch owner enforces this security/resource bound; it is not author configuration.
const MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;

export class PluginFetchError extends Error {
    readonly code: PluginFetchErrorCode;

    constructor(code: PluginFetchErrorCode, message: string) {
        super(message);
        this.name = 'PluginFetchError';
        this.code = code;
    }
}

export type PluginRequestInterceptorDeclarationV1 = Readonly<{
    pluginId: string;
    contribution: PluginRequestInterceptorContributionV1;
}>;

export type PluginRequestInterceptorBindingV1 = Readonly<{
    pluginId: string;
    contribution: PluginRequestInterceptorContributionV1;
    invoke(request: PluginInterceptedRequest, signal: AbortSignal | undefined): Promise<PluginInterceptorResult>;
}>;

export type PluginRequestInterceptorRegistryV1 = Readonly<{
    declarations: readonly PluginRequestInterceptorDeclarationV1[];
    activateContributionsOnDemand(demands: readonly Readonly<{
        pluginId: string;
        family: 'requestInterceptors';
        localId: string;
    }>[] ): Promise<unknown>;
    readBindings(): readonly PluginRequestInterceptorBindingV1[];
}>;

export type CreatePluginFetchServiceParams = Readonly<{
    networkAllowed: boolean;
    adapter?: FetchRuntimeServiceV1 | null;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    pluginId?: string | null;
    allowedUrlOrigins?: readonly string[];
    retry?: Readonly<{
        maxAttempts: number;
        baseDelayMs?: number;
    }>;
    revalidateFinalPolicy?: (effect: Readonly<{
        request: FetchRuntimeRequestV1;
        attempt: number;
    }>) => void | Promise<void>;
}>;

export type StablePluginFetchFinalPolicyEffect = Readonly<{
    seed: PluginInvocationServicesSeed;
    serviceBinding: PluginInvocationServiceBinding;
    request: FetchRuntimeRequestV1;
    attempt: number;
}>;

export type StablePluginFetchHost = Readonly<{
    bind(seed: PluginInvocationServicesSeed, binding: PluginInvocationServiceBinding): PluginFetchService;
    bindRuntime(seed: PluginInvocationServicesSeed, binding: PluginInvocationServiceBinding): FetchRuntimeServiceV1;
}>;

type StablePluginFetchResponse = Awaited<ReturnType<PluginFetchService['request']>>;

export type StablePluginFetchCredentialBindingHost = Readonly<{
    request(input: Readonly<{
        seed: PluginInvocationServicesSeed;
        serviceBinding: PluginInvocationServiceBinding;
        credentialBinding: PluginFetchCredentialBinding;
        request: Parameters<PluginFetchService['request']>[0];
        signal: AbortSignal | undefined;
        execute(credentialHeaders: Readonly<Record<string, string>>): Promise<StablePluginFetchResponse>;
    }>): Promise<StablePluginFetchResponse>;
}>;

export type StablePluginFetchHostParams = Readonly<{
    adapter: FetchRuntimeServiceV1;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    credentialBindingHost?: StablePluginFetchCredentialBindingHost;
    retry?: CreatePluginFetchServiceParams['retry'];
    revalidateFinalPolicy?: (
        effect: StablePluginFetchFinalPolicyEffect,
    ) => void | Promise<void>;
}>;

const REDACTED_VALUE = '[redacted]';
const SECRET_KEY_PATTERN = /api_?key|secret|token|password|credential/i;
const HTTP_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TIER_ONE_HEADER_NAMES = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'x-auth-token',
]);

export function isLiteralPrivateNetworkHostname(hostname: string): boolean {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
    const ipKind = isIP(normalized);
    if (ipKind === 4) {
        const [first = 0, second = 0] = normalized.split('.').map(Number);
        return first === 10
            || first === 127
            || (first === 169 && second === 254)
            || (first === 172 && second >= 16 && second <= 31)
            || (first === 192 && second === 168);
    }
    if (ipKind === 6) {
        return normalized === '::1'
            || normalized.startsWith('fc')
            || normalized.startsWith('fd')
            || normalized.startsWith('fe8')
            || normalized.startsWith('fe9')
            || normalized.startsWith('fea')
            || normalized.startsWith('feb');
    }
    return false;
}
const TIER_TWO_HEADER_NAMES = new Set([
    'chatgpt-account-id',
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
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Invocation bindings created by one stable host are distinct service objects,
// but nested fetches still belong to the same logical async operation.
const activeInterceptorKeysByOperation = new AsyncLocalStorage<Set<string>>();

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

function mergeAbortSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
    signal: AbortSignal | undefined;
    dispose(): void;
}> {
    const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
    if (activeSignals.length === 0) return { signal: undefined, dispose: () => undefined };
    if (activeSignals.length === 1) return { signal: activeSignals[0], dispose: () => undefined };

    const controller = new AbortController();
    const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = [];
    const dispose = () => {
        for (const { signal, listener } of listeners.splice(0)) {
            signal.removeEventListener('abort', listener);
        }
    };
    const abort = (signal: AbortSignal) => {
        if (!controller.signal.aborted) controller.abort(signal.reason);
        dispose();
    };
    for (const signal of activeSignals) {
        if (signal.aborted) {
            abort(signal);
            break;
        }
        const listener = () => abort(signal);
        listeners.push({ signal, listener });
        signal.addEventListener('abort', listener, { once: true });
    }
    return { signal: controller.signal, dispose };
}

function withTimeout(request: FetchRuntimeRequestV1): Readonly<{
    request: FetchRuntimeRequestV1;
    dispose: () => void;
}> {
    if (request.timeoutMs === undefined) return { request, dispose: () => undefined };
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new TypeError('Plugin fetch timeoutMs must be a positive safe integer');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(createAbortError()), request.timeoutMs);
    const mergedSignal = mergeAbortSignals([request.signal, controller.signal]);
    return {
        request: Object.freeze({
            ...request,
            signal: mergedSignal.signal,
        }),
        dispose: () => {
            clearTimeout(timer);
            mergedSignal.dispose();
        },
    };
}

function readHttpUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
            ? url
            : null;
    } catch {
        return null;
    }
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
            `Plugin '${params.pluginId ?? 'unknown'}' cannot fetch without a declared URL origin scope`,
        );
    }
    const url = readHttpUrl(params.request.url);
    if (!url) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' supplied an invalid HTTP(S) URL`,
        );
    }
    if (!allowedUrlOrigins.includes('*') && !allowedUrlOrigins.includes(url.origin)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Plugin '${params.pluginId ?? 'unknown'}' cannot fetch undeclared URL origin '${url.origin}'`,
        );
    }
}

function normalizeRequestMethod(method: string | undefined): HttpMethod | null {
    const normalized = (method ?? 'GET').trim().toUpperCase();
    return HTTP_METHODS.has(normalized as HttpMethod) ? normalized as HttpMethod : null;
}

function contributionAllowsRequest(
    contribution: PluginRequestInterceptorContributionV1,
    request: FetchRuntimeRequestV1,
): boolean {
    const url = readHttpUrl(request.url);
    const method = normalizeRequestMethod(request.method);
    return url !== null
        && method !== null
        && contribution.origins.includes(url.origin)
        && (contribution.methods === undefined || contribution.methods.includes(method));
}

function normalizeHeaderName(name: string): string {
    return name.trim().toLowerCase();
}

function isProtectedHeader(name: string): boolean {
    const normalized = normalizeHeaderName(name);
    return TIER_ONE_HEADER_NAMES.has(normalized)
        || TIER_TWO_HEADER_NAMES.has(normalized)
        || SECRET_KEY_PATTERN.test(normalized)
        || normalized.startsWith('x-forwarded-')
        || normalized.startsWith('x-user-')
        || normalized.includes('signature')
        || normalized.endsWith('api-key')
        || normalized.endsWith('auth-token')
        || normalized.endsWith('session-secret')
        || normalized.endsWith('account-token')
        || normalized.endsWith('provider-credential');
}

function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (SECRET_KEY_PATTERN.test(key)) parsed.searchParams.set(key, REDACTED_VALUE);
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function redactHeaders(headers: FetchRuntimeRequestV1['headers']): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [
        key,
        isProtectedHeader(key) ? REDACTED_VALUE : value,
    ])));
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, keys: ReadonlySet<string>): boolean {
    return Object.keys(value).every((key) => keys.has(key));
}

function isValidHeaderRecord(value: unknown): value is Readonly<Record<string, string>> {
    if (!isPlainRecord(value)) return false;
    const normalizedNames = new Set<string>();
    for (const [name, headerValue] of Object.entries(value)) {
        const normalized = normalizeHeaderName(name);
        if (!HEADER_NAME_PATTERN.test(name) || normalizedNames.has(normalized)
            || typeof headerValue !== 'string' || /[\r\n]/.test(headerValue)) {
            return false;
        }
        normalizedNames.add(normalized);
    }
    return true;
}

function readPluginInterceptorResult(value: unknown): PluginInterceptorResult | null {
    if (!isPlainRecord(value) || typeof value.decision !== 'string') return null;
    if (value.decision === 'deny') {
        return hasOnlyKeys(value, new Set(['decision', 'code']))
            && typeof value.code === 'string'
            && value.code.trim().length > 0
            ? value as PluginInterceptorResult
            : null;
    }
    if (value.decision !== 'continue' || !hasOnlyKeys(value, new Set(['decision', 'request']))) return null;
    const request = value.request;
    if (!isPlainRecord(request) || !hasOnlyKeys(request, new Set(['url', 'method', 'headers', 'body']))) return null;
    return typeof request.url === 'string'
        && typeof request.method === 'string'
        && normalizeRequestMethod(request.method) !== null
        && isValidHeaderRecord(request.headers)
        && (request.body === undefined || request.body instanceof Uint8Array)
        ? value as PluginInterceptorResult
        : null;
}

function snapshotInterceptorRequest(request: FetchRuntimeRequestV1): Readonly<{
    publicRequest: PluginInterceptedRequest;
    bodySnapshot?: Uint8Array;
}> {
    const method = normalizeRequestMethod(request.method);
    if (!method) throw new PluginFetchError('PLUGIN_FETCH_INTERCEPTOR_FAILED', 'Fetch request has an unsupported HTTP method');
    const body = request.body instanceof Uint8Array ? new Uint8Array(request.body) : undefined;
    return Object.freeze({
        publicRequest: Object.freeze({
            url: redactUrl(request.url),
            method,
            headers: redactHeaders(request.headers),
            ...(body ? { body } : {}),
        }),
        ...(body ? { bodySnapshot: new Uint8Array(body) } : {}),
    });
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
    return left === undefined && right === undefined
        || left !== undefined && right !== undefined
            && left.length === right.length
            && left.every((byte, index) => byte === right[index])
        || false;
}

function findHeader(
    headers: Readonly<Record<string, string>>,
    normalizedName: string,
): readonly [string, string] | null {
    return Object.entries(headers).find(([name]) => normalizeHeaderName(name) === normalizedName) ?? null;
}

function adaptContinuedRequest(params: Readonly<{
    pluginId: string;
    interceptorId: string;
    contribution: PluginRequestInterceptorContributionV1;
    effectiveRequest: FetchRuntimeRequestV1;
    publicRequest: PluginInterceptedRequest;
    bodySnapshot?: Uint8Array;
    result: Extract<PluginInterceptorResult, { decision: 'continue' }>;
}>): FetchRuntimeRequestV1 {
    const returned = params.result.request;
    if (!bytesEqual(returned.body, params.bodySnapshot)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_INTERCEPTOR_FAILED',
            `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a body mutation`,
        );
    }

    let nextUrl = params.effectiveRequest.url;
    if (returned.url !== params.publicRequest.url) {
        if (redactUrl(params.effectiveRequest.url) !== params.effectiveRequest.url
            || redactUrl(returned.url) !== returned.url
            || !readHttpUrl(returned.url)) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a forbidden URL mutation`,
            );
        }
        nextUrl = returned.url;
    }

    const nextHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(returned.headers)) {
        const normalized = normalizeHeaderName(name);
        const existing = findHeader(params.effectiveRequest.headers ?? {}, normalized);
        if (isProtectedHeader(name)) {
            if (!existing || value !== REDACTED_VALUE) {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a protected header mutation`,
                );
            }
            continue;
        }
        nextHeaders[name] = value;
    }
    for (const [name, value] of Object.entries(params.effectiveRequest.headers ?? {})) {
        if (!isProtectedHeader(name)) continue;
        const returnedEntry = findHeader(returned.headers, normalizeHeaderName(name));
        if (!returnedEntry || returnedEntry[1] !== REDACTED_VALUE) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a protected header mutation`,
            );
        }
        nextHeaders[name] = value;
    }

    const nextRequest = Object.freeze({
        ...params.effectiveRequest,
        url: nextUrl,
        method: returned.method,
        headers: Object.freeze(nextHeaders),
    });
    const nextOrigin = readHttpUrl(nextRequest.url)?.origin;
    if (!nextOrigin || !params.contribution.origins.includes(nextOrigin)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_URL_SCOPE_DENIED',
            `Request interceptor '${params.pluginId}/${params.interceptorId}' rewrote outside its declared origin`,
        );
    }
    if (!contributionAllowsRequest(params.contribution, nextRequest)) {
        throw new PluginFetchError(
            'PLUGIN_FETCH_INTERCEPTOR_FAILED',
            `Request interceptor '${params.pluginId}/${params.interceptorId}' rewrote outside its declared methods`,
        );
    }
    return nextRequest;
}

function isTransientFetchError(error: unknown): boolean {
    if (!(error instanceof Error) || error.name === 'AbortError') return false;
    const code = String((error as Error & { code?: unknown }).code ?? '');
    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EAI_AGAIN';
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
    assertNotAborted(signal);
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const abort = () => {
            clearTimeout(timer);
            cleanup();
            reject(createAbortError());
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
    });
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    assertNotAborted(signal);
    if (!signal) return await operation;
    return await new Promise<T>((resolve, reject) => {
        const abort = () => {
            cleanup();
            reject(createAbortError());
        };
        const cleanup = () => signal.removeEventListener('abort', abort);
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

function bindingIdentity(pluginId: string, localId: string): string {
    return `${pluginId}\u0000requestInterceptors\u0000${localId}`;
}

function declarationsEqual(
    left: PluginRequestInterceptorContributionV1,
    right: PluginRequestInterceptorContributionV1,
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function resolveDemandedBindings(params: Readonly<{
    declarations: readonly PluginRequestInterceptorDeclarationV1[];
    bindings: readonly PluginRequestInterceptorBindingV1[];
}>): readonly PluginRequestInterceptorBindingV1[] {
    const bindingsByIdentity = new Map<string, PluginRequestInterceptorBindingV1[]>();
    for (const binding of params.bindings) {
        const key = bindingIdentity(binding.pluginId, binding.contribution.id);
        const entries = bindingsByIdentity.get(key) ?? [];
        entries.push(binding);
        bindingsByIdentity.set(key, entries);
    }
    const seenDeclarations = new Set<string>();
    const resolved: PluginRequestInterceptorBindingV1[] = [];
    for (const declaration of params.declarations) {
        const key = bindingIdentity(declaration.pluginId, declaration.contribution.id);
        if (seenDeclarations.has(key)) {
            throw new PluginFetchError('PLUGIN_FETCH_INTERCEPTOR_FAILED', 'Duplicate request interceptor declaration');
        }
        seenDeclarations.add(key);
        const candidates = bindingsByIdentity.get(key) ?? [];
        if (candidates.length !== 1
            || !declarationsEqual(candidates[0]!.contribution, declaration.contribution)) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                `Request interceptor '${declaration.pluginId}/${declaration.contribution.id}' has no unique current binding`,
            );
        }
        resolved.push(candidates[0]!);
    }
    return Object.freeze(resolved.sort((left, right) => (
        (left.contribution.priority ?? 0) - (right.contribution.priority ?? 0)
        || left.pluginId.localeCompare(right.pluginId)
        || left.contribution.id.localeCompare(right.contribution.id)
    )));
}

function createTerminalFetchAdapter(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    return async (request) => {
        assertNotAborted(request.signal);
        assertUrlAllowed({
            request,
            allowedUrlOrigins: params.allowedUrlOrigins,
            pluginId: params.pluginId,
        });
        if (!params.adapter) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_ADAPTER_UNAVAILABLE',
                'Plugin fetch network access is unavailable in this host context',
            );
        }
        return await params.adapter(request);
    };
}

export function createPluginFetchService(params: CreatePluginFetchServiceParams): FetchRuntimeServiceV1 {
    if (params.retry && (!Number.isSafeInteger(params.retry.maxAttempts) || params.retry.maxAttempts < 1)) {
        throw new TypeError('Plugin fetch retry maxAttempts must be a positive safe integer');
    }
    const terminal = createTerminalFetchAdapter(params);

    async function applyInterceptors(request: FetchRuntimeRequestV1): Promise<FetchRuntimeRequestV1> {
        const activeInterceptorKeys = activeInterceptorKeysByOperation.getStore();
        if (!activeInterceptorKeys) {
            throw new PluginFetchError('PLUGIN_FETCH_INTERCEPTOR_FAILED', 'Request interceptor state is unavailable');
        }
        const registry = params.interceptorRegistry;
        if (!registry) return request;

        const matchingDeclarations = registry.declarations.filter((declaration) => (
            contributionAllowsRequest(declaration.contribution, request)
        ));
        if (matchingDeclarations.length === 0) return request;

        try {
            await registry.activateContributionsOnDemand(Object.freeze(matchingDeclarations.map((declaration) => Object.freeze({
                pluginId: declaration.pluginId,
                family: 'requestInterceptors' as const,
                localId: declaration.contribution.id,
            }))));
        } catch {
            throw new PluginFetchError('PLUGIN_FETCH_INTERCEPTOR_FAILED', 'Request interceptor activation failed');
        }

        const bindings = resolveDemandedBindings({
            declarations: matchingDeclarations,
            bindings: registry.readBindings(),
        });
        let effectiveRequest = request;
        for (const binding of bindings) {
            assertNotAborted(effectiveRequest.signal);
            if (!contributionAllowsRequest(binding.contribution, effectiveRequest)) continue;
            const key = bindingIdentity(binding.pluginId, binding.contribution.id);
            if (activeInterceptorKeys.has(key)) continue;

            const snapshot = snapshotInterceptorRequest(effectiveRequest);
            activeInterceptorKeys.add(key);
            let rawResult: unknown;
            try {
                rawResult = await binding.invoke(snapshot.publicRequest, effectiveRequest.signal);
            } catch {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    `Request interceptor '${binding.pluginId}/${binding.contribution.id}' failed`,
                );
            } finally {
                activeInterceptorKeys.delete(key);
            }
            const result = readPluginInterceptorResult(rawResult);
            if (!result) {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_FAILED',
                    `Request interceptor '${binding.pluginId}/${binding.contribution.id}' returned an invalid result`,
                );
            }
            if (result.decision === 'deny') {
                throw new PluginFetchError(
                    'PLUGIN_FETCH_INTERCEPTOR_DENIED',
                    `Request interceptor '${binding.pluginId}/${binding.contribution.id}' denied the request`,
                );
            }
            effectiveRequest = adaptContinuedRequest({
                pluginId: binding.pluginId,
                interceptorId: binding.contribution.id,
                contribution: binding.contribution,
                effectiveRequest,
                publicRequest: snapshot.publicRequest,
                ...(snapshot.bodySnapshot ? { bodySnapshot: snapshot.bodySnapshot } : {}),
                result,
            });
        }
        return effectiveRequest;
    }

    async function executeFetch(request: FetchRuntimeRequestV1): Promise<FetchRuntimeResponseV1> {
        assertNotAborted(request.signal);
        if (!params.networkAllowed) {
            throw new PluginFetchError(
                'PLUGIN_FETCH_PERMISSION_DENIED',
                `Plugin '${params.pluginId ?? 'unknown'}' cannot fetch without network permission`,
            );
        }
        assertUrlAllowed({ request, allowedUrlOrigins: params.allowedUrlOrigins, pluginId: params.pluginId });
        const timeout = withTimeout(request);
        const maxAttempts = params.retry?.maxAttempts ?? 1;
        try {
            const interceptedRequest = await raceWithAbort(
                applyInterceptors(timeout.request),
                timeout.request.signal,
            );
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(timeout.request.signal);
                const terminalRequest = Object.freeze({
                    ...interceptedRequest,
                    metadata: Object.freeze({
                        ...(interceptedRequest.metadata ?? {}),
                        attempt,
                    }),
                });
                try {
                    if (params.revalidateFinalPolicy) {
                        await raceWithAbort(
                            Promise.resolve(params.revalidateFinalPolicy(Object.freeze({
                                request: terminalRequest,
                                attempt,
                            }))),
                            timeout.request.signal,
                        );
                    }
                    assertNotAborted(timeout.request.signal);
                    return await raceWithAbort(terminal(terminalRequest), timeout.request.signal);
                } catch (error) {
                    if (attempt >= maxAttempts || !isTransientFetchError(error)) throw error;
                    await delay(params.retry?.baseDelayMs ?? 0, timeout.request.signal);
                }
            }
        } finally {
            timeout.dispose();
        }
        throw new PluginFetchError('PLUGIN_FETCH_ADAPTER_UNAVAILABLE', 'Plugin fetch retry exhausted');
    }

    return async (request) => {
        const existingState = activeInterceptorKeysByOperation.getStore();
        if (existingState) return await executeFetch(request);
        return await activeInterceptorKeysByOperation.run(new Set<string>(), async () => await executeFetch(request));
    };
}

export function createStablePluginFetchHost(params: StablePluginFetchHostParams): StablePluginFetchHost {
    const bindRuntime = (
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
    ): FetchRuntimeServiceV1 => {
        const runtimeFetch = createPluginFetchService({
            networkAllowed: binding.availability.fetch === 'available',
            adapter: params.adapter,
            pluginId: seed.plugin.id,
            allowedUrlOrigins: binding.networkOrigins ?? Object.freeze([]),
            ...(params.interceptorRegistry ? { interceptorRegistry: params.interceptorRegistry } : {}),
            ...(params.retry ? { retry: params.retry } : {}),
            ...(params.revalidateFinalPolicy || binding.networkCurrentness || binding.networkScopes?.length ? {
                revalidateFinalPolicy: async (effect) => {
                    if (
                        binding.networkCurrentness
                        && !await binding.networkCurrentness()
                    ) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Connected-account network configuration is no longer current',
                        });
                    }
                    const url = new URL(effect.request.url);
                    const method = (effect.request.method ?? 'GET').toUpperCase();
                    const privateNetwork = isLiteralPrivateNetworkHostname(url.hostname);
                    const withinBoundScope = binding.networkScopes?.some((scope) => (
                        scope.origins.includes(url.origin)
                        && (scope.methods === undefined || scope.methods.includes(method as HttpMethod))
                        && (!privateNetwork || scope.privateNetwork)
                    )) === true;
                    if (!withinBoundScope) {
                        throw new PluginError({
                            code: 'plugin_final_resource_not_selected',
                            message: 'Fetch operation is outside the bound network scope',
                        });
                    }
                    await params.revalidateFinalPolicy?.({
                        seed,
                        serviceBinding: binding,
                        ...effect,
                    });
                },
            } : {}),
        });
        return async (request) => {
            if (!seed.isGenerationCurrent()) {
                throw new PluginError({
                    code: 'plugin_final_generation_retired',
                    message: 'Plugin generation is no longer current',
                });
            }
            const mergedSignal = mergeAbortSignals([seed.signal, request.signal]);
            let response: FetchRuntimeResponseV1;
            try {
                response = await runtimeFetch(Object.freeze({
                    ...request,
                    signal: mergedSignal.signal,
                }));
            } finally {
                mergedSignal.dispose();
            }
            if (!seed.isGenerationCurrent()) {
                throw new PluginError({
                    code: 'plugin_final_generation_retired',
                    message: 'Plugin generation is no longer current',
                });
            }
            return response;
        };
    };
    return Object.freeze({
        bindRuntime,
        bind(seed, binding): PluginFetchService {
            const runtimeFetch = bindRuntime(seed, binding);
            return Object.freeze({
                async request(
                    input: Parameters<PluginFetchService['request']>[0],
                    options: Parameters<PluginFetchService['request']>[1] = {},
                ) {
                    if (!seed.isGenerationCurrent()) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Plugin generation is no longer current',
                        });
                    }
                    if (input.credentialBinding !== undefined && !params.credentialBindingHost) {
                        throw new PluginError({
                            code: 'plugin_fetch_credential_binding_unavailable',
                            message: 'Connected-account fetch credentials are unavailable in this invocation host',
                        });
                    }
                    if (input.redirect === 'follow') {
                        throw new PluginError({
                            code: 'plugin_fetch_redirect_follow_unavailable',
                            message: 'Plugin fetch redirect following is unavailable until each redirect hop can be reauthorized',
                        });
                    }
                    const execute = async (
                        credentialHeaders: Readonly<Record<string, string>>,
                    ): Promise<StablePluginFetchResponse> => {
                        const response = await runtimeFetch(Object.freeze({
                            url: input.url,
                            ...(input.method === undefined ? {} : { method: input.method }),
                            headers: Object.freeze({
                                ...(input.headers ?? {}),
                                ...credentialHeaders,
                            }),
                            ...(input.body === undefined ? {} : { body: input.body }),
                            ...(options.signal === undefined ? {} : { signal: options.signal }),
                            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                            metadata: Object.freeze({ redirect: input.redirect }),
                        }));
                        const bodyBuffer = await response.arrayBuffer();
                        if (bodyBuffer.byteLength > MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES) {
                            throw new PluginError({
                                code: 'plugin_fetch_response_too_large',
                                message: 'Plugin fetch response exceeded the stable response-body limit',
                            });
                        }
                        const finalUrl = (response as FetchRuntimeResponseV1 & Readonly<{ finalUrl?: unknown }>).finalUrl;
                        return Object.freeze({
                            status: response.status,
                            finalUrl: typeof finalUrl === 'string' ? finalUrl : input.url,
                            headers: Object.freeze({ ...response.headers }),
                            body: new Uint8Array(bodyBuffer.slice(0)),
                        });
                    };
                    const stableResponse = input.credentialBinding === undefined
                        ? await execute(Object.freeze({}))
                        : await params.credentialBindingHost!.request(Object.freeze({
                            seed,
                            serviceBinding: binding,
                            credentialBinding: input.credentialBinding,
                            request: input,
                            signal: options.signal,
                            execute,
                        }));
                    if (!seed.isGenerationCurrent()) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Plugin generation is no longer current',
                        });
                    }
                    return stableResponse;
                },
            });
        },
    });
}
