import {
    isBaseCredentialDiagnosticKey,
    splitSensitiveDiagnosticKeySegments,
    type PluginRequestInterceptorContributionV1,
} from '@happier-dev/protocol';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
    HttpMethod,
    PluginFetchCredentialBinding,
    HttpService,
    PluginWebSocketConnection,
    PluginWebSocketOpenInput,
} from '@happier-dev/plugin-sdk/http';
import { PluginError } from '@happier-dev/plugin-sdk';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
    TargetPluginInterceptorResult as PluginInterceptorResult,
} from '../lifecycle/contributions/targetRequestInterceptors';
import type {
    PluginInvocationServiceBinding,
    PluginInvocationServicesSeed,
} from '../invocation/services/types';
import {
    assessPluginNetworkOriginLocality,
    type PluginNetworkAddressResolver,
} from './originLocality';
import {
    normalizePluginWebSocketOpenInput,
    type PluginWebSocketRuntimeOptions,
} from './webSocket';

// The fetch owner enforces this security/resource bound; it is not author configuration.
export const MAX_PLUGIN_FETCH_RESPONSE_BODY_BYTES = 32 * 1024 * 1024;

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

export type CreatePluginHttpServiceParams = Readonly<{
    adapter?: Pick<PluginHttpRuntimeAdapter, 'request'> | null;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    pluginId?: string | null;
    allowedUrlOrigins?: readonly string[];
    /** Host-private redaction for invocation-scoped credential representations. */
    redactInterceptorText?(value: string): string;
    /**
     * Host-private custody of credential header names injected for this exact
     * request. Public SDK requests never carry this fact.
     */
    readPrivateCredentialHeaderNames?(request: Parameters<HttpService['request']>[0]): ReadonlySet<string> | undefined;
    recordDisclosureMismatch?(mismatch: PluginHttpDisclosureMismatch): void;
    retry?: Readonly<{
        maxAttempts: number;
        baseDelayMs?: number;
    }>;
    revalidateFinalPolicy?: (effect: Readonly<{
        request: Parameters<HttpService['request']>[0];
        attempt: number;
    }>) => void | Promise<void>;
}>;

/**
 * Host-private transport contract. The public SDK sees only HttpService; the
 * lifecycle signal lets this one transport owner distinguish connect abortion
 * from a generation or host retirement after the connection opens.
 */
export type PluginHttpRuntimeAdapter = Omit<HttpService, 'openWebSocket'> & Readonly<{
    openWebSocket(
        input: PluginWebSocketOpenInput,
        options?: PluginWebSocketRuntimeOptions,
    ): Promise<PluginWebSocketConnection>;
}>;

export type PluginHttpDisclosureMismatch = Readonly<{
    capability: 'network';
    origin: string;
    method: HttpMethod;
}>;

export type StablePluginHttpFinalPolicyEffect = Readonly<{
    seed: PluginInvocationServicesSeed;
    serviceBinding: PluginInvocationServiceBinding;
    request: Parameters<HttpService['request']>[0];
    attempt: number;
}>;

export type StablePluginHttpHost = Readonly<{
    bind(
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
        policy?: StablePluginHttpBindingPolicy,
    ): HttpService;
}>;

type StablePluginHttpResponse = Awaited<ReturnType<HttpService['request']>>;
type PluginHttpRequest = Parameters<HttpService['request']>[0];
type PluginHttpResponse = Awaited<ReturnType<HttpService['request']>>;

export type StablePluginHttpCredentialBindingHost = Readonly<{
    request(input: Readonly<{
        seed: PluginInvocationServicesSeed;
        serviceBinding: PluginInvocationServiceBinding;
        credentialBinding: PluginFetchCredentialBinding;
        request: Parameters<HttpService['request']>[0];
        signal: AbortSignal | undefined;
        execute(injection: Readonly<{
            headers: Readonly<Record<string, string>>;
            secretHeaderNames: readonly string[];
        }>): Promise<StablePluginHttpResponse>;
    }>): Promise<StablePluginHttpResponse>;
}>;

export type StablePluginHttpHostParams = Readonly<{
    adapter: PluginHttpRuntimeAdapter;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    credentialBindingHost?: StablePluginHttpCredentialBindingHost;
    /** Host-private redaction for an invocation-bound interceptor snapshot. */
    redactInterceptorText?(input: Readonly<{
        seed: PluginInvocationServicesSeed;
        value: string;
    }>): string;
    retry?: CreatePluginHttpServiceParams['retry'];
    revalidateFinalPolicy?: (
        effect: StablePluginHttpFinalPolicyEffect,
    ) => void | Promise<void>;
    recordDisclosureMismatch?(effect: Readonly<{
        seed: PluginInvocationServicesSeed;
        mismatch: PluginHttpDisclosureMismatch;
    }>): void;
    /** DNS boundary for the private-network decision; defaults to the host resolver. */
    resolveNetworkAddresses?: PluginNetworkAddressResolver;
}>;

export type StablePluginHttpBindingPolicy = Readonly<{
    interceptorRegistry?: PluginRequestInterceptorRegistryV1 | null;
    credentialBindingHost?: StablePluginHttpCredentialBindingHost | null;
    revalidateFinalPolicy?: StablePluginHttpHostParams['revalidateFinalPolicy'] | null;
}>;

const REDACTED_VALUE = '[redacted]';
const NO_PRIVATE_CREDENTIAL_HEADER_NAMES: ReadonlySet<string> = new Set();
const HTTP_CREDENTIAL_QUERY_DIAGNOSTIC_SEGMENTS = new Set([
    'auth',
    'authentication',
    'credential',
    'credentials',
    'secret',
]);
const HTTP_CREDENTIAL_QUERY_DIAGNOSTIC_SUFFIXES = new Set(['token']);
const HTTP_METHODS = new Set<HttpMethod>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/**
 * The interceptor boundary has one deliberately closed V1 disclosure set.
 * Host-injected credential names remain separately private per request. Do
 * not infer semantic caller headers from keywords: every non-member is
 * intentionally visible and mutable to a matching trusted policy.
 */
const STANDARD_SECURITY_SENSITIVE_INTERCEPTOR_HEADER_NAMES_V1 = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'www-authenticate',
    'proxy-authenticate',
    'authentication-info',
    'proxy-authentication-info',
    'dpop',
    'signature',
    'signature-input',
    'host',
    'origin',
    'referer',
    'forwarded',
    'x-api-key',
    'api-key',
    'x-auth-token',
    'x-client-ip',
    'x-real-ip',
    'x-signature',
    'x-hub-signature-256',
]);
const STANDARD_SECURITY_SENSITIVE_INTERCEPTOR_HEADER_PREFIXES_V1 = [
    'sec-',
    'x-forwarded-',
] as const;

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

function withTimeout(request: PluginHttpRequest, signal: AbortSignal | undefined): Readonly<{
    signal: AbortSignal | undefined;
    dispose: () => void;
}> {
    if (request.timeoutMs === undefined) return { signal, dispose: () => undefined };
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
        throw new TypeError('Plugin fetch timeoutMs must be a positive safe integer');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(createAbortError()), request.timeoutMs);
    const mergedSignal = mergeAbortSignals([signal, controller.signal]);
    return {
        signal: mergedSignal.signal,
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

function assertValidUrlAndRecordDisclosureMismatch(params: Readonly<{
    request: PluginHttpRequest;
    allowedUrlOrigins: readonly string[] | undefined;
    pluginId: string | null | undefined;
    recordDisclosureMismatch?: (mismatch: PluginHttpDisclosureMismatch) => void;
}>): void {
    const allowedUrlOrigins = params.allowedUrlOrigins;
    const url = readHttpUrl(params.request.url);
    if (!url) {
        throw new PluginError({
            code: 'plugin_fetch_invalid_url',
            message: `Plugin '${params.pluginId ?? 'unknown'}' supplied an invalid credential-free HTTP(S) URL`,
        });
    }
    const method = normalizeRequestMethod(params.request.method);
    if (!method) {
        throw new PluginError({
            code: 'plugin_fetch_invalid_url',
            message: `Plugin '${params.pluginId ?? 'unknown'}' supplied an invalid HTTP method`,
        });
    }
    if (!allowedUrlOrigins?.includes('*') && !allowedUrlOrigins?.includes(url.origin)) {
        try {
            params.recordDisclosureMismatch?.({
                capability: 'network',
                origin: url.origin,
                method,
            });
        } catch {
            // Cooperative-disclosure diagnostics cannot alter network semantics.
        }
    }
}

function normalizeRequestMethod(method: string | undefined): HttpMethod | null {
    const normalized = (method ?? 'GET').trim().toUpperCase();
    return HTTP_METHODS.has(normalized as HttpMethod) ? normalized as HttpMethod : null;
}

function contributionAllowsRequest(
    contribution: PluginRequestInterceptorContributionV1,
    request: PluginHttpRequest,
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

function isHttpCredentialQueryDiagnosticKey(key: string): boolean {
    if (isBaseCredentialDiagnosticKey(key)) return true;
    const segments = splitSensitiveDiagnosticKeySegments(key);
    return segments.some((segment) => HTTP_CREDENTIAL_QUERY_DIAGNOSTIC_SEGMENTS.has(segment))
        || HTTP_CREDENTIAL_QUERY_DIAGNOSTIC_SUFFIXES.has(segments.at(-1) ?? '');
}

function isProtectedHeader(name: string): boolean {
    const normalized = normalizeHeaderName(name);
    return STANDARD_SECURITY_SENSITIVE_INTERCEPTOR_HEADER_NAMES_V1
        .has(normalized)
        || STANDARD_SECURITY_SENSITIVE_INTERCEPTOR_HEADER_PREFIXES_V1
            .some((prefix) => normalized.startsWith(prefix));
}

function isPrivateCredentialHeader(
    name: string,
    privateCredentialHeaderNames: ReadonlySet<string>,
): boolean {
    return privateCredentialHeaderNames.has(normalizeHeaderName(name));
}

function isProtectedInterceptorHeader(
    name: string,
    privateCredentialHeaderNames: ReadonlySet<string>,
): boolean {
    return isProtectedHeader(name) || isPrivateCredentialHeader(name, privateCredentialHeaderNames);
}

function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        for (const key of [...parsed.searchParams.keys()]) {
            if (isHttpCredentialQueryDiagnosticKey(key)) parsed.searchParams.set(key, REDACTED_VALUE);
        }
        return parsed.toString();
    } catch {
        return url;
    }
}

function redactInterceptorUrl(
    url: string,
    redactInterceptorText: CreatePluginHttpServiceParams['redactInterceptorText'],
): string {
    if (!redactInterceptorText) return redactUrl(url);
    let redacted: string;
    try {
        redacted = redactInterceptorText(url);
    } catch {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: 'Request interceptor credential redaction failed',
        });
    }
    if (typeof redacted !== 'string') {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: 'Request interceptor credential redaction failed',
        });
    }
    return redactUrl(redacted);
}

function redactHeaders(
    headers: PluginHttpRequest['headers'],
    privateCredentialHeaderNames: ReadonlySet<string>,
): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [
        key,
        isProtectedInterceptorHeader(key, privateCredentialHeaderNames) ? REDACTED_VALUE : value,
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
    if (!isPlainRecord(request) || !hasOnlyKeys(request, new Set(['url', 'method', 'headers']))) return null;
    return typeof request.url === 'string'
        && typeof request.method === 'string'
        && normalizeRequestMethod(request.method) !== null
        && isValidHeaderRecord(request.headers)
        ? value as PluginInterceptorResult
        : null;
}

function snapshotInterceptorRequest(
    request: PluginHttpRequest,
    redactInterceptorText: CreatePluginHttpServiceParams['redactInterceptorText'],
    privateCredentialHeaderNames: ReadonlySet<string>,
): Readonly<{
    publicRequest: PluginInterceptedRequest;
}> {
    const method = normalizeRequestMethod(request.method);
    if (!method) {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: 'Fetch request has an unsupported HTTP method',
        });
    }
    return Object.freeze({
        publicRequest: Object.freeze({
            url: redactInterceptorUrl(request.url, redactInterceptorText),
            method,
            headers: redactHeaders(request.headers, privateCredentialHeaderNames),
        }),
    });
}

/**
 * The stable host admits a WebSocket before handing it to the private driver.
 * Retain one immutable caller snapshot so a getter or later mutation cannot
 * make the driver open a different target than the one the host authorized.
 */
function snapshotPluginWebSocketOpenInput(
    input: PluginWebSocketOpenInput,
): PluginWebSocketOpenInput {
    if (!input) return input;
    const {
        url,
        protocols,
        headers,
        allowInsecureWs,
        connectTimeoutMs,
        maxMessageBytes,
        maxPendingMessages,
        maxPendingBytes,
        maxBufferedSendBytes,
    } = input;
    const copiedProtocols = protocols === undefined
        ? undefined
        : Object.freeze([...protocols]);
    const copiedHeaders = headers === undefined
        ? undefined
        : Object.freeze(headers.map((header) => {
            const { name, value, sensitive } = header;
            return Object.freeze({
                name,
                value,
                ...(sensitive === undefined ? {} : { sensitive }),
            });
        }));
    return Object.freeze({
        url,
        ...(copiedProtocols === undefined ? {} : { protocols: copiedProtocols }),
        ...(copiedHeaders === undefined ? {} : { headers: copiedHeaders }),
        ...(allowInsecureWs === undefined ? {} : { allowInsecureWs }),
        ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
        ...(maxMessageBytes === undefined ? {} : { maxMessageBytes }),
        ...(maxPendingMessages === undefined ? {} : { maxPendingMessages }),
        ...(maxPendingBytes === undefined ? {} : { maxPendingBytes }),
        ...(maxBufferedSendBytes === undefined ? {} : { maxBufferedSendBytes }),
    });
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
    effectiveRequest: PluginHttpRequest;
    publicRequest: PluginInterceptedRequest;
    result: Extract<PluginInterceptorResult, { decision: 'continue' }>;
    privateCredentialHeaderNames: ReadonlySet<string>;
}>): PluginHttpRequest {
    const returned = params.result.request;
    let nextUrl = params.effectiveRequest.url;
    if (returned.url !== params.publicRequest.url) {
        if (params.publicRequest.url !== params.effectiveRequest.url
            || redactUrl(params.effectiveRequest.url) !== params.effectiveRequest.url
            || redactUrl(returned.url) !== returned.url
            || !readHttpUrl(returned.url)) {
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a forbidden URL mutation`,
            });
        }
        nextUrl = returned.url;
    }

    const nextHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(returned.headers)) {
        const normalized = normalizeHeaderName(name);
        const existing = findHeader(params.effectiveRequest.headers ?? {}, normalized);
        if (isProtectedInterceptorHeader(name, params.privateCredentialHeaderNames)) {
            if (!existing || value !== REDACTED_VALUE) {
                throw new PluginError({
                    code: 'plugin_fetch_interceptor_failed',
                    message: `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a protected header mutation`,
                });
            }
            continue;
        }
        nextHeaders[name] = value;
    }
    for (const [name, value] of Object.entries(params.effectiveRequest.headers ?? {})) {
        if (!isProtectedInterceptorHeader(name, params.privateCredentialHeaderNames)) continue;
        const returnedEntry = findHeader(returned.headers, normalizeHeaderName(name));
        if (!returnedEntry || returnedEntry[1] !== REDACTED_VALUE) {
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted a protected header mutation`,
            });
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
        throw new PluginError({
            code: 'plugin_fetch_url_scope_denied',
            message: `Request interceptor '${params.pluginId}/${params.interceptorId}' rewrote outside its declared origin`,
        });
    }
    if (!contributionAllowsRequest(params.contribution, nextRequest)) {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: `Request interceptor '${params.pluginId}/${params.interceptorId}' rewrote outside its declared methods`,
        });
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
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: 'Duplicate request interceptor declaration',
            });
        }
        seenDeclarations.add(key);
        const candidates = bindingsByIdentity.get(key) ?? [];
        if (candidates.length !== 1
            || !declarationsEqual(candidates[0]!.contribution, declaration.contribution)) {
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: `Request interceptor '${declaration.pluginId}/${declaration.contribution.id}' has no unique current binding`,
            });
        }
        resolved.push(candidates[0]!);
    }
    return Object.freeze(resolved.sort((left, right) => (
        (left.contribution.priority ?? 0) - (right.contribution.priority ?? 0)
        || left.pluginId.localeCompare(right.pluginId)
        || left.contribution.id.localeCompare(right.contribution.id)
    )));
}

function createTerminalFetchAdapter(params: CreatePluginHttpServiceParams): HttpService {
    return Object.freeze({
        async request(
            request: PluginHttpRequest,
            options: Parameters<HttpService['request']>[1] = {},
        ) {
            assertNotAborted(options.signal);
            assertValidUrlAndRecordDisclosureMismatch({
                request,
                allowedUrlOrigins: params.allowedUrlOrigins,
                pluginId: params.pluginId,
                recordDisclosureMismatch: params.recordDisclosureMismatch,
            });
            if (!params.adapter) {
                throw new PluginError({
                    code: 'plugin_fetch_adapter_unavailable',
                    message: 'Plugin fetch network access is unavailable in this host context',
                });
            }
            return await params.adapter.request(request, options);
        },
        async openWebSocket() {
            throw new PluginError({
                code: 'plugin_websocket_permission_denied',
                message: 'Plugin WebSocket access requires the network.client capability',
            });
        },
    });
}

export function createPluginHttpService(params: CreatePluginHttpServiceParams): HttpService {
    if (params.retry && (!Number.isSafeInteger(params.retry.maxAttempts) || params.retry.maxAttempts < 1)) {
        throw new TypeError('Plugin fetch retry maxAttempts must be a positive safe integer');
    }
    const terminal = createTerminalFetchAdapter(params);

    async function applyInterceptors(
        request: PluginHttpRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginHttpRequest> {
        const activeInterceptorKeys = activeInterceptorKeysByOperation.getStore();
        if (!activeInterceptorKeys) {
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: 'Request interceptor state is unavailable',
            });
        }
        const registry = params.interceptorRegistry;
        if (!registry) return request;
        const privateCredentialHeaderNames = params.readPrivateCredentialHeaderNames?.(request)
            ?? NO_PRIVATE_CREDENTIAL_HEADER_NAMES;

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
            throw new PluginError({
                code: 'plugin_fetch_interceptor_failed',
                message: 'Request interceptor activation failed',
            });
        }

        const bindings = resolveDemandedBindings({
            declarations: matchingDeclarations,
            bindings: registry.readBindings(),
        });
        let effectiveRequest = request;
        for (const binding of bindings) {
            assertNotAborted(signal);
            if (!contributionAllowsRequest(binding.contribution, effectiveRequest)) continue;
            const key = bindingIdentity(binding.pluginId, binding.contribution.id);
            if (activeInterceptorKeys.has(key)) continue;

            const snapshot = snapshotInterceptorRequest(
                effectiveRequest,
                params.redactInterceptorText,
                privateCredentialHeaderNames,
            );
            activeInterceptorKeys.add(key);
            let rawResult: unknown;
            try {
                rawResult = await binding.invoke(snapshot.publicRequest, signal);
            } catch {
                throw new PluginError({
                    code: 'plugin_fetch_interceptor_failed',
                    message: `Request interceptor '${binding.pluginId}/${binding.contribution.id}' failed`,
                });
            } finally {
                activeInterceptorKeys.delete(key);
            }
            const result = readPluginInterceptorResult(rawResult);
            if (!result) {
                throw new PluginError({
                    code: 'plugin_fetch_interceptor_failed',
                    message: `Request interceptor '${binding.pluginId}/${binding.contribution.id}' returned an invalid result`,
                });
            }
            if (result.decision === 'deny') {
                throw new PluginError({
                    code: 'plugin_fetch_interceptor_denied',
                    message: `Request interceptor '${binding.pluginId}/${binding.contribution.id}' denied the request`,
                });
            }
            effectiveRequest = adaptContinuedRequest({
                pluginId: binding.pluginId,
                interceptorId: binding.contribution.id,
                contribution: binding.contribution,
                effectiveRequest,
                publicRequest: snapshot.publicRequest,
                result,
                privateCredentialHeaderNames,
            });
        }
        return effectiveRequest;
    }

    async function executeFetch(
        request: PluginHttpRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginHttpResponse> {
        assertNotAborted(signal);
        const timeout = withTimeout(request, signal);
        const maxAttempts = params.retry?.maxAttempts ?? 1;
        try {
            const interceptedRequest = await raceWithAbort(
                applyInterceptors(request, timeout.signal),
                timeout.signal,
            );
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(timeout.signal);
                try {
                    if (params.revalidateFinalPolicy) {
                        await raceWithAbort(
                            Promise.resolve(params.revalidateFinalPolicy(Object.freeze({
                                request: interceptedRequest,
                                attempt,
                            }))),
                            timeout.signal,
                        );
                    }
                    assertNotAborted(timeout.signal);
                    return await raceWithAbort(
                        terminal.request(interceptedRequest, { signal: timeout.signal }),
                        timeout.signal,
                    );
                } catch (error) {
                    if (attempt >= maxAttempts || !isTransientFetchError(error)) throw error;
                    await delay(params.retry?.baseDelayMs ?? 0, timeout.signal);
                }
            }
        } finally {
            timeout.dispose();
        }
        throw new PluginError({
            code: 'plugin_fetch_adapter_unavailable',
            message: 'Plugin fetch retry exhausted',
        });
    }

    return Object.freeze({
        async request(
            request: PluginHttpRequest,
            options: Parameters<HttpService['request']>[1] = {},
        ) {
            const existingState = activeInterceptorKeysByOperation.getStore();
            if (existingState) return await executeFetch(request, options.signal);
            return await activeInterceptorKeysByOperation.run(
                new Set<string>(),
                async () => await executeFetch(request, options.signal),
            );
        },
        async openWebSocket() {
            throw new PluginError({
                code: 'plugin_websocket_permission_denied',
                message: 'Plugin WebSocket access requires the stable host network.client binding',
            });
        },
    });
}

function privateCredentialHeaderNameSet(input: Readonly<{
    headers: Readonly<Record<string, string>>;
    secretHeaderNames: readonly string[];
}>): ReadonlySet<string> {
    const injectedHeaderNames = new Set(Object.keys(input.headers).map(normalizeHeaderName));
    const secretHeaderNames = new Set(input.secretHeaderNames.map(normalizeHeaderName));
    if (
        injectedHeaderNames.size !== secretHeaderNames.size
        || [...injectedHeaderNames].some((name) => !secretHeaderNames.has(name))
    ) {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: 'Credential header custody does not match the injected request headers',
        });
    }
    return secretHeaderNames;
}

export function createStablePluginHttpHost(params: StablePluginHttpHostParams): StablePluginHttpHost {
    const resolverOptions = params.resolveNetworkAddresses
        ? { resolveAddresses: params.resolveNetworkAddresses }
        : {};
    const bindService = (
        seed: PluginInvocationServicesSeed,
        binding: PluginInvocationServiceBinding,
        privateCredentialHeaderNamesByRequest: WeakMap<
            PluginHttpRequest,
            ReadonlySet<string>
        >,
        policy?: StablePluginHttpBindingPolicy,
    ): Pick<HttpService, 'request'> => {
        const interceptorRegistry =
            policy && 'interceptorRegistry' in policy
                ? policy.interceptorRegistry ?? undefined
                : params.interceptorRegistry;
        const revalidateFinalPolicy =
            policy && 'revalidateFinalPolicy' in policy
                ? policy.revalidateFinalPolicy ?? undefined
                : params.revalidateFinalPolicy;
        const runtimeFetch = createPluginHttpService({
            adapter: params.adapter,
            pluginId: seed.plugin.id,
            allowedUrlOrigins: binding.networkOrigins ?? Object.freeze([]),
            ...(params.redactInterceptorText ? {
                redactInterceptorText: (value: string) => params.redactInterceptorText!({ seed, value }),
            } : {}),
            readPrivateCredentialHeaderNames: (request) => (
                privateCredentialHeaderNamesByRequest.get(request)
            ),
            ...(params.recordDisclosureMismatch ? {
                recordDisclosureMismatch: (mismatch) => params.recordDisclosureMismatch!({ seed, mismatch }),
            } : {}),
            ...(interceptorRegistry ? { interceptorRegistry } : {}),
            ...(params.retry ? { retry: params.retry } : {}),
            ...(revalidateFinalPolicy || binding.networkCurrentness || binding.networkScopes?.length ? {
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
                    const selectedResourceScopes = binding.networkScopes?.filter((scope) => (
                        scope.authority === 'selectedResource'
                    )) ?? [];
                    const privateNetwork = selectedResourceScopes.length === 0
                        ? false
                        : await assessPluginNetworkOriginLocality(url.origin, resolverOptions) === 'private';
                    const withinBoundScope = selectedResourceScopes.some((scope) => (
                        scope.origins.includes(url.origin)
                        && (scope.methods === undefined || scope.methods.includes(method as HttpMethod))
                        && (!privateNetwork || scope.privateNetwork)
                    )) === true;
                    if (selectedResourceScopes.length > 0 && !withinBoundScope) {
                        throw new PluginError({
                            code: 'plugin_final_resource_not_selected',
                            message: 'Fetch operation is outside the bound network scope',
                        });
                    }
                    await revalidateFinalPolicy?.({
                        seed,
                        serviceBinding: binding,
                        ...effect,
                    });
                },
            } : {}),
        });
        return Object.freeze({
            async request(
                request: PluginHttpRequest,
                options: Parameters<HttpService['request']>[1] = {},
            ) {
                if (!seed.isGenerationCurrent()) {
                    throw new PluginError({
                        code: 'plugin_final_generation_retired',
                        message: 'Plugin generation is no longer current',
                    });
                }
                const mergedSignal = mergeAbortSignals([seed.signal, options.signal]);
                let response: PluginHttpResponse;
                try {
                    response = await runtimeFetch.request(request, { signal: mergedSignal.signal });
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
            },
        });
    };
    return Object.freeze({
        bind(seed, binding, policy): HttpService {
            const privateCredentialHeaderNamesByRequest = new WeakMap<
                PluginHttpRequest,
                ReadonlySet<string>
            >();
            const runtimeFetch = bindService(
                seed,
                binding,
                privateCredentialHeaderNamesByRequest,
                policy,
            );
            const credentialBindingHost =
                policy && 'credentialBindingHost' in policy
                    ? policy.credentialBindingHost ?? undefined
                    : params.credentialBindingHost;
            return Object.freeze({
                async request(
                    input: Parameters<HttpService['request']>[0],
                    options: Parameters<HttpService['request']>[1] = {},
                ) {
                    if (!seed.isGenerationCurrent()) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Plugin generation is no longer current',
                        });
                    }
                    if (input.credentialBinding !== undefined && !credentialBindingHost) {
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
                        injection: Readonly<{
                            headers: Readonly<Record<string, string>>;
                            secretHeaderNames: readonly string[];
                        }>,
                    ): Promise<StablePluginHttpResponse> => {
                        const privateCredentialHeaderNames = privateCredentialHeaderNameSet(injection);
                        const request = Object.freeze({
                            url: input.url,
                            ...(input.method === undefined ? {} : { method: input.method }),
                            headers: Object.freeze({
                                ...(input.headers ?? {}),
                                ...injection.headers,
                            }),
                            ...(input.body === undefined ? {} : { body: input.body }),
                            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                            redirect: input.redirect,
                        });
                        if (privateCredentialHeaderNames.size > 0) {
                            privateCredentialHeaderNamesByRequest.set(request, privateCredentialHeaderNames);
                        }
                        const response = await runtimeFetch.request(request, { signal: options.signal });
                        return Object.freeze({
                            status: response.status,
                            finalUrl: response.finalUrl,
                            headers: Object.freeze({ ...response.headers }),
                            body: response.body,
                        });
                    };
                    const stableResponse = input.credentialBinding === undefined
                        ? await execute(Object.freeze({
                            headers: Object.freeze({}),
                            secretHeaderNames: Object.freeze([]),
                        }))
                        : await credentialBindingHost!.request(Object.freeze({
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
                async openWebSocket(
                    input: PluginWebSocketOpenInput,
                    options: Parameters<HttpService['openWebSocket']>[1] = {},
                ) {
                    if (!seed.isGenerationCurrent()) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Plugin generation is no longer current',
                        });
                    }
                    if (binding.networkCurrentness && !await binding.networkCurrentness()) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Connected-account network configuration is no longer current',
                        });
                    }
                    if (binding.networkRevocationSignal?.aborted) {
                        throw new PluginError({
                            code: 'plugin_final_generation_retired',
                            message: 'Connected-account network configuration is no longer current',
                        });
                    }
                    const admittedInput = snapshotPluginWebSocketOpenInput(input);
                    const normalized = normalizePluginWebSocketOpenInput(admittedInput);
                    const privateNetwork = await assessPluginNetworkOriginLocality(
                        normalized.targetOrigin,
                        resolverOptions,
                    ) === 'private';
                    const permitted = binding.networkClientScopes?.some((scope) => (
                        scope.origins.includes(normalized.targetOrigin)
                        && scope.transports.includes('websocket')
                        && (!privateNetwork || scope.privateNetwork)
                    )) === true;
                    if (!permitted) {
                        throw new PluginError({
                            code: 'plugin_websocket_permission_denied',
                            message: 'Plugin WebSocket operation is outside the bound network.client scope',
                        });
                    }
                    const lifecycle = new AbortController();
                    const abortLifecycle = (reason: Readonly<{ kind: string }>) => {
                        if (!lifecycle.signal.aborted) lifecycle.abort(reason);
                    };
                    const abortForSeed = () => abortLifecycle(Object.freeze({
                        kind: seed.isGenerationCurrent() ? 'hostShutdown' as const : 'generationRetired' as const,
                    }));
                    const abortForConfigurationRevocation = () => abortLifecycle(Object.freeze({
                        kind: 'networkConfigurationRetired' as const,
                    }));
                    if (seed.signal.aborted) abortForSeed();
                    else seed.signal.addEventListener('abort', abortForSeed, { once: true });
                    if (binding.networkRevocationSignal?.aborted) abortForConfigurationRevocation();
                    else binding.networkRevocationSignal?.addEventListener(
                        'abort',
                        abortForConfigurationRevocation,
                        { once: true },
                    );
                    const detachLifecycle = () => {
                        seed.signal.removeEventListener('abort', abortForSeed);
                        binding.networkRevocationSignal?.removeEventListener(
                            'abort',
                            abortForConfigurationRevocation,
                        );
                    };
                    try {
                        const connection = await params.adapter.openWebSocket(admittedInput, {
                            signal: options.signal,
                            lifecycleSignal: lifecycle.signal,
                        });
                        if (
                            lifecycle.signal.aborted
                            ||
                            !seed.isGenerationCurrent()
                            || (binding.networkCurrentness !== undefined && !await binding.networkCurrentness())
                        ) {
                            abortLifecycle(Object.freeze({ kind: 'generationRetired' as const }));
                            throw new PluginError({
                                code: 'plugin_final_generation_retired',
                                message: 'Plugin generation retired while its WebSocket was opening',
                            });
                        }
                        void connection.closed.finally(detachLifecycle);
                        return connection;
                    } catch (error) {
                        detachLifecycle();
                        if (lifecycle.signal.aborted) {
                            throw new PluginError({
                                code: 'plugin_final_generation_retired',
                                message: 'Plugin generation retired while its WebSocket was opening',
                            });
                        }
                        throw error;
                    }
                },
            });
        },
    });
}
