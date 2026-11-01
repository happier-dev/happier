import { isBaseCredentialDiagnosticKey, splitSensitiveDiagnosticKeySegments } from '@happier-dev/protocol/diagnostics/sensitive-keys';
import type { PluginRequestInterceptorContributionV1 } from '@happier-dev/protocol';
import type {
    HttpMethod,
    PluginFetchCredentialBinding,
    HttpService,
    HttpStreamRequest,
    HttpStreamResponse,
    HttpPreparedReadInput,
    PreparedHttpRead,
    PluginWebSocketConnection,
    PluginWebSocketOpenInput,
    PluginInterceptedRequest,
    PluginInterceptorResult,
} from './contracts.js';
import { PluginError } from '../errors.js';
import { snapshotPluginHttpRequest } from './request.js';
import { MAX_PLUGIN_FETCH_REDIRECTS, nextPluginHttpRedirect, toPluginHttpRedirectFailure } from './redirect.js';
import { snapshotPluginHttpStreamRequest, wrapPluginHttpStream } from './stream.js';
import { createPluginHttpTraceDiagnostic, recordPluginHttpTraceResponse, type PluginHttpTraceDiagnostic } from './trace.js';

export type { PluginHttpTraceDiagnostic } from './trace.js';


export type PluginHttpInvocationSeed = Readonly<{ plugin: Readonly<{ id: string }>; contribution?: Readonly<{ qualifiedId: string }>; signal: AbortSignal; retirementSignal?: AbortSignal; isOccurrenceCurrent(): boolean }>;
export type PluginHttpServiceBinding = Readonly<{ networkRevocationSignal?: AbortSignal }>;
export type PluginHttpStreamingSanitizer = Readonly<{ pushBytes(chunk: Uint8Array): Uint8Array; flushBytes(): Uint8Array }>;
export type PluginWebSocketRuntimeOptions = Readonly<{ signal?: AbortSignal; lifecycleSignal?: AbortSignal; messageByteLimits?: null }>;
export type PluginHttpOperationContext = Readonly<{ getStore(): Set<string> | undefined; run<T>(state: Set<string>, run: () => T): T }>;
export type PluginHttpTrace = <T>(stage: string, run: () => Promise<T>, diagnostic?: PluginHttpTraceDiagnostic) => Promise<T>;

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
    operationContext?: PluginHttpOperationContext;
    trace?: PluginHttpTrace;
    adapter?: Pick<PluginHttpRuntimeAdapter, 'request'> & Partial<Pick<PluginHttpRuntimeAdapter, 'requestStream'>> | null;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    pluginId?: string | null;
    operationId?: string;
    /** Host-private redaction for invocation-scoped credential representations. */
    redactInterceptorText?(value: string): string;
    /**
     * Host-private custody of credential header names injected for this exact
     * request. Public SDK requests never carry this fact.
     */
    readPrivateCredentialHeaderNames?(request: Parameters<HttpService['request']>[0]): ReadonlySet<string> | undefined;
    /** Uses the invocation's existing registered redaction values. */
    containsRegisteredSecret?(value: string): boolean;
    retry?: Readonly<{
        maxAttempts: number;
        baseDelayMs?: number;
    }>;
}>;

export type PluginHttpRuntimeRequestOptions = Readonly<{
    signal?: AbortSignal;
}>;

/**
 * Host-private transport contract. The public SDK sees only HttpService; the
 * lifecycle signal lets this one transport owner distinguish connect abortion
 * from a generation or host retirement after the connection opens.
 */
export type PluginHttpRuntimeAdapter = Readonly<{
    request(
        input: Parameters<HttpService['request']>[0],
        options?: PluginHttpRuntimeRequestOptions,
    ): ReturnType<HttpService['request']>;
    requestStream?: HttpService['requestStream'];
    openWebSocket(
        input: PluginWebSocketOpenInput,
        options?: PluginWebSocketRuntimeOptions,
    ): Promise<PluginWebSocketConnection>;
}>;

export type StablePluginHttpHost<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    bind(
        seed: Seed,
        binding: Binding,
        policy?: StablePluginHttpBindingPolicy<Seed, Binding>,
    ): HttpService;
    /** Captures operation custody once, before choosing a child RPC's transport. */
    prepareAdapterBinding?(
        seed: Seed,
        binding: Binding,
        policy?: StablePluginHttpBindingPolicy<Seed, Binding>,
    ): (adapter: PluginHttpRuntimeAdapter) => HttpService;
}>;

type StablePluginHttpResponse = Awaited<ReturnType<HttpService['request']>>;
type PluginHttpRequest = Parameters<HttpService['request']>[0];
type PluginHttpResponse = Awaited<ReturnType<HttpService['request']>>;

export type PluginHttpPurposeInjection = Readonly<{
    headers: Readonly<Record<string, string>>;
    secretHeaderNames: readonly string[];
    redact(value: string): string;
    createStreamingSanitizer(): PluginHttpStreamingSanitizer;
}>;

type PluginHttpPurposeRequestContext<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    seed: Seed;
    serviceBinding: Binding;
    signal: AbortSignal | undefined;
}>;

/** The admitted invocation's credential owner, shared by finite and streamed reads. */
export type StablePluginHttpPurposeHost<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    request(input: PluginHttpPurposeRequestContext<Seed, Binding> & Readonly<{
        request: PluginHttpRequest;
        execute(injection?: PluginHttpPurposeInjection): Promise<PluginHttpResponse>;
    }>): Promise<PluginHttpResponse>;
    requestStream(input: PluginHttpPurposeRequestContext<Seed, Binding> & Readonly<{
        request: HttpStreamRequest;
        execute(injection?: PluginHttpPurposeInjection): Promise<HttpStreamResponse>;
    }>): Promise<HttpStreamResponse>;
}>;

export type StablePluginHttpCredentialBindingHost<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    request(input: Readonly<{
        seed: Seed;
        serviceBinding: Binding;
        credentialBinding: PluginFetchCredentialBinding;
        request: Parameters<HttpService['request']>[0];
        signal: AbortSignal | undefined;
        execute(injection: Readonly<{
            headers: Readonly<Record<string, string>>;
            secretHeaderNames: readonly string[];
        }>): Promise<StablePluginHttpResponse>;
    }>): Promise<StablePluginHttpResponse>;
}>;

export type StablePluginHttpHostParams<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    operationContext?: PluginHttpOperationContext;
    trace?: PluginHttpTrace;
    adapter: PluginHttpRuntimeAdapter;
    interceptorRegistry?: PluginRequestInterceptorRegistryV1;
    credentialBindingHost?: StablePluginHttpCredentialBindingHost<Seed, Binding>;
    containsRegisteredSecret?(input: Readonly<{ seed: Seed; value: string }>): boolean;
    purposeHost?: StablePluginHttpPurposeHost<Seed, Binding>;
    /** Host-private redaction for an invocation-bound interceptor snapshot. */
    redactInterceptorText?(input: Readonly<{
        seed: Seed;
        value: string;
    }>): string;
    retry?: CreatePluginHttpServiceParams['retry'];
}>;

export type StablePluginHttpBindingPolicy<Seed extends PluginHttpInvocationSeed = PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding = PluginHttpServiceBinding> = Readonly<{
    interceptorRegistry?: PluginRequestInterceptorRegistryV1 | null;
    credentialBindingHost?: StablePluginHttpCredentialBindingHost<Seed, Binding> | null;
    purposeHost?: StablePluginHttpPurposeHost<Seed, Binding> | null;
}>;

function assertPluginNetworkBindingCurrent(
    seed: PluginHttpInvocationSeed,
    binding: PluginHttpServiceBinding,
): void {
    if (
        !seed.isOccurrenceCurrent()
        || binding.networkRevocationSignal?.aborted
    ) {
        throw new PluginError({
            code: 'plugin_final_generation_retired',
            message: 'Connected-account network configuration is no longer current',
        });
    }
}

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
const HTTP_INTERCEPTOR_PROTECTED_HEADER_ALIASES = new Set([
    'proxy-authorization',
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
    'x-client-ip',
    'x-real-ip',
    'x-signature',
    'x-hub-signature-256',
    'x-user-id',
    'chatgpt-account-id',
]);
const HTTP_INTERCEPTOR_PROTECTED_HEADER_PREFIX_ALIASES = [
    'sec-',
    'x-forwarded-',
] as const;

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// Invocation bindings created by one stable host are distinct service objects,
// but nested fetches still belong to the same logical async operation.


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

function assertValidPluginHttpRequest(params: Readonly<{
    request: PluginHttpRequest;
    pluginId: string | null | undefined;
}>): void {
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
    return isBaseCredentialDiagnosticKey(normalized)
        || HTTP_INTERCEPTOR_PROTECTED_HEADER_ALIASES.has(normalized)
        || HTTP_INTERCEPTOR_PROTECTED_HEADER_PREFIX_ALIASES
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
    effectiveRequest: PluginHttpRequest;
    publicRequest: PluginInterceptedRequest;
    result: Extract<PluginInterceptorResult, { decision: 'continue' }>;
    privateCredentialHeaderNames: ReadonlySet<string>;
}>): PluginHttpRequest {
    const returned = params.result.request;
    // A protected header is withheld from public interceptors and restored
    // from this exact request after they return. Its recipient and method are
    // therefore part of the protected request authority: an interceptor may
    // still refine ordinary headers, but may not carry that header onto a
    // rewritten endpoint or method. This covers both host-injected names and
    // the closed standard set, including raw Connected Account Authorization.
    const carriesProtectedHeader = Object.keys(params.effectiveRequest.headers ?? {}).some((name) => (
        isProtectedInterceptorHeader(name, params.privateCredentialHeaderNames)
    ));
    if (carriesProtectedHeader
        && (returned.url !== params.publicRequest.url
            || normalizeRequestMethod(returned.method) !== params.publicRequest.method)) {
        throw new PluginError({
            code: 'plugin_fetch_interceptor_failed',
            message: `Request interceptor '${params.pluginId}/${params.interceptorId}' attempted to retarget a protected-header request`,
        });
    }
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
    // An already-cancelled caller still observes the started operation's settlement.
    if (signal?.aborted) void operation.catch(() => undefined);
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

function createTerminalFetchAdapter(params: CreatePluginHttpServiceParams): Pick<HttpService, 'request' | 'requestStream'> {
    const runTracedExternalActionInnerStage = params.trace ?? ((_stage, run) => run());
    return Object.freeze({
        async request(
            request: PluginHttpRequest,
            options: Parameters<HttpService['request']>[1] = {},
        ) {
            assertNotAborted(options.signal);
            assertValidPluginHttpRequest({
                request,
                pluginId: params.pluginId,
            });
            const adapter = params.adapter;
            if (!adapter) {
                throw new PluginError({
                    code: 'plugin_fetch_adapter_unavailable',
                    message: 'Plugin fetch network access is unavailable in this host context',
                });
            }
            const diagnostic = createPluginHttpTraceDiagnostic({ pluginId: params.pluginId, operationId: params.operationId, request });
            return await runTracedExternalActionInnerStage('contributed.http.transport', async () => {
                const response = await adapter.request(request, options);
                recordPluginHttpTraceResponse(diagnostic, response);
                return response;
            }, diagnostic);
        },
        async requestStream(request: HttpStreamRequest, options: Parameters<HttpService['requestStream']>[1] = {}) {
            const admitted = snapshotPluginHttpStreamRequest(request);
            assertNotAborted(options.signal);
            assertValidPluginHttpRequest({ request: admitted, pluginId: params.pluginId });
            if (!params.adapter?.requestStream) {
                throw new PluginError({ code: 'plugin_fetch_adapter_unavailable', message: 'Plugin HTTP streaming is unavailable in this host context' });
            }
            const diagnostic = createPluginHttpTraceDiagnostic({ pluginId: params.pluginId, operationId: params.operationId, request: admitted });
            return await runTracedExternalActionInnerStage('contributed.http.transport', async () => {
                const response = await params.adapter!.requestStream!(admitted, options);
                recordPluginHttpTraceResponse(diagnostic, response);
                return response;
            }, diagnostic);
        },
    });
}

export function createPluginHttpService(params: CreatePluginHttpServiceParams): Pick<HttpService, 'request' | 'requestStream'> {
    if (params.retry && (!Number.isSafeInteger(params.retry.maxAttempts) || params.retry.maxAttempts < 1)) {
        throw new TypeError('Plugin fetch retry maxAttempts must be a positive safe integer');
    }
    const terminal = createTerminalFetchAdapter(params);
    const runTracedExternalActionInnerStage = params.trace ?? ((_stage, run) => run());

    async function applyInterceptors(
        request: PluginHttpRequest,
        signal: AbortSignal | undefined,
    ): Promise<PluginHttpRequest> {
        const registry = params.interceptorRegistry;
        if (!registry || registry.declarations.length === 0) return request;
        // Portable hosts track this chain locally; ambient hosts also share keys with nested requests.
        const activeInterceptorKeys = params.operationContext?.getStore() ?? new Set<string>();
        const privateCredentialHeaderNames = params.readPrivateCredentialHeaderNames?.(request)
            ?? NO_PRIVATE_CREDENTIAL_HEADER_NAMES;
        const demandedInterceptorKeys = new Set<string>();
        const appliedInterceptorKeys = new Set<string>();
        let effectiveRequest = request;
        while (true) {
            assertNotAborted(signal);
            const matchingDeclarations = registry.declarations.filter((declaration) => {
                const key = bindingIdentity(declaration.pluginId, declaration.contribution.id);
                return !appliedInterceptorKeys.has(key)
                    && contributionAllowsRequest(declaration.contribution, effectiveRequest);
            });
            if (matchingDeclarations.length === 0) break;

            const undemandedDeclarations = matchingDeclarations.filter((declaration) => (
                !demandedInterceptorKeys.has(bindingIdentity(
                    declaration.pluginId,
                    declaration.contribution.id,
                ))
            ));
            if (undemandedDeclarations.length > 0) {
                try {
                    await registry.activateContributionsOnDemand(Object.freeze(undemandedDeclarations.map((declaration) => Object.freeze({
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
                for (const declaration of undemandedDeclarations) {
                    demandedInterceptorKeys.add(bindingIdentity(
                        declaration.pluginId,
                        declaration.contribution.id,
                    ));
                }
            }

            const bindings = resolveDemandedBindings({
                declarations: matchingDeclarations,
                bindings: registry.readBindings(),
            });
            const binding = bindings.find((candidate) => (
                !activeInterceptorKeys.has(bindingIdentity(
                    candidate.pluginId,
                    candidate.contribution.id,
                ))
            ));
            if (!binding) break;

            const key = bindingIdentity(binding.pluginId, binding.contribution.id);

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
            appliedInterceptorKeys.add(key);
            effectiveRequest = adaptContinuedRequest({
                pluginId: binding.pluginId,
                interceptorId: binding.contribution.id,
                effectiveRequest,
                publicRequest: snapshot.publicRequest,
                result,
                privateCredentialHeaderNames,
            });
        }
        return effectiveRequest;
    }

    async function executeFetch<Response extends Pick<PluginHttpResponse, 'status' | 'headers' | 'finalUrl'>>(
        request: PluginHttpRequest,
        signal: AbortSignal | undefined,
        transport: Readonly<{
            request(request: PluginHttpRequest, options: PluginHttpRuntimeRequestOptions): Promise<Response>;
            dispose?(response: Response): Promise<void>;
            retain?(response: Response, release: () => void, signal: AbortSignal | undefined): Response;
        }>,
    ): Promise<Response> {
        assertNotAborted(signal);
        const timeout = withTimeout(request, signal);
        const maxAttempts = params.retry?.maxAttempts ?? 1;
        let retained = false;
        try {
            const interceptedRequest = await runTracedExternalActionInnerStage('contributed.http.interceptors', () => raceWithAbort(
                applyInterceptors(request, timeout.signal),
                timeout.signal,
            ));
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                assertNotAborted(timeout.signal);
                try {
                    const execute = async (): Promise<Response> => {
                        const privateHeaderNames = params.readPrivateCredentialHeaderNames?.(request) ?? NO_PRIVATE_CREDENTIAL_HEADER_NAMES;
                        let effectiveRequest = interceptedRequest;
                        for (let redirects = 0; ; redirects += 1) {
                            assertNotAborted(timeout.signal);
                            const response = await transport.request({ ...effectiveRequest,
                                redirect: 'manual',
                            }, { signal: timeout.signal });
                            let next: PluginHttpRequest | undefined;
                            try { next = nextPluginHttpRedirect(effectiveRequest, response, privateHeaderNames,
                                (response.status === 307 || response.status === 308)
                                && effectiveRequest.body !== undefined && effectiveRequest.body.byteLength > 0
                                && params.containsRegisteredSecret?.(new TextDecoder().decode(effectiveRequest.body)) === true,
                                params.containsRegisteredSecret); }
                            catch (error) { await transport.dispose?.(response); throw error; }
                            if (!next) return response;
                            await transport.dispose?.(response);
                            if (redirects >= MAX_PLUGIN_FETCH_REDIRECTS) {
                                throw new PluginError({ code: 'plugin_fetch_redirect_limit_exceeded', message: 'HTTP redirect limit exceeded' });
                            }
                            effectiveRequest = next;
                        }
                    };
                    const response = await raceWithAbort(
                        execute(),
                        timeout.signal,
                    );
                    if (transport.retain) {
                        const result = transport.retain(response, timeout.dispose, timeout.signal);
                        retained = true;
                        return result;
                    }
                    return response;
                } catch (error) {
                    if (attempt >= maxAttempts || !isTransientFetchError(error)) throw error;
                    await delay(params.retry?.baseDelayMs ?? 0, timeout.signal);
                }
            }
        } finally {
            if (!retained) timeout.dispose();
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
            const admittedRequest = snapshotPluginHttpRequest(request);
            if (!params.interceptorRegistry || params.interceptorRegistry.declarations.length === 0) {
                return await executeFetch(admittedRequest, options.signal, { request: terminal.request });
            }
            const existingState = params.operationContext?.getStore();
            if (!params.operationContext || existingState) return await executeFetch(admittedRequest, options.signal, { request: terminal.request });
            return await params.operationContext.run(
                new Set<string>(),
                async () => await executeFetch(admittedRequest, options.signal, { request: terminal.request }),
            );
        },
        async requestStream(request: HttpStreamRequest, options: Parameters<HttpService['requestStream']>[1] = {}) {
            const admitted = snapshotPluginHttpStreamRequest(request);
            const execute = () => executeFetch(admitted, options.signal, {
                request: (effective, owner) => terminal.requestStream(snapshotPluginHttpStreamRequest(effective), owner),
                dispose: response => response.dispose(),
                retain: (response, release, signal) => wrapPluginHttpStream(response, { signal, onDispose: release }),
            });
            return !params.operationContext || params.operationContext.getStore()
                ? await execute() : await params.operationContext.run(new Set<string>(), execute);
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

export function createStablePluginHttpHost<Seed extends PluginHttpInvocationSeed, Binding extends PluginHttpServiceBinding>(params: StablePluginHttpHostParams<Seed, Binding>): StablePluginHttpHost<Seed, Binding> {
    const bindWithAdapter = (seed: Seed, binding: Binding, adapter: PluginHttpRuntimeAdapter, policy?: StablePluginHttpBindingPolicy<Seed, Binding>): HttpService => (
        createStablePluginHttpHost({ ...params, adapter }).bind(seed, binding, policy)
    );
    const bindService = (
        seed: Seed,
        binding: Binding,
        privateCredentialHeaderNamesByRequest: WeakMap<
            PluginHttpRequest,
            ReadonlySet<string>
        >,
        policy?: StablePluginHttpBindingPolicy<Seed, Binding>,
        preparedReadMethod?: 'GET' | 'POST',
    ): Pick<HttpService, 'request' | 'requestStream'> & Readonly<{
        admit(request: PluginHttpRequest): Promise<void>;
    }> => {
        const interceptorRegistry =
            policy && 'interceptorRegistry' in policy
                ? policy.interceptorRegistry ?? undefined
                : params.interceptorRegistry;
        const runtimeFetch = createPluginHttpService({
            adapter: preparedReadMethod === undefined ? params.adapter : {
                ...params.adapter,
                async request(request, options) {
                    if ((request.method ?? 'GET') !== preparedReadMethod) {
                        throw new PluginError({ code: 'plugin_fetch_prepared_read_invalid' });
                    }
                    return await params.adapter.request(request, options);
                },
            },
            pluginId: seed.plugin.id,
            operationId: seed.contribution?.qualifiedId,
            ...(params.redactInterceptorText ? {
                redactInterceptorText: (value: string) => params.redactInterceptorText!({ seed, value }),
            } : {}),
            readPrivateCredentialHeaderNames: (request) => (
                privateCredentialHeaderNamesByRequest.get(request)
            ),
            ...(interceptorRegistry ? { interceptorRegistry } : {}),
            ...(params.containsRegisteredSecret ? {
                containsRegisteredSecret: (value: string) => params.containsRegisteredSecret!({ seed, value }),
            } : {}),
            ...(preparedReadMethod !== undefined ? { retry: { maxAttempts: 1 } } : params.retry ? { retry: params.retry } : {}),
            ...(params.operationContext ? { operationContext: params.operationContext } : {}),
            ...(params.trace ? { trace: params.trace } : {}),
        });
        return Object.freeze({
            async admit(request: PluginHttpRequest) {
                assertValidPluginHttpRequest({
                    request,
                    pluginId: seed.plugin.id,
                });
                if (preparedReadMethod !== undefined && (request.method ?? 'GET') !== preparedReadMethod) {
                    throw new PluginError({ code: 'plugin_fetch_prepared_read_invalid' });
                }
            },
            async request(
                request: PluginHttpRequest,
                options: Parameters<HttpService['request']>[1] = {},
            ) {
                const mergedSignal = mergeAbortSignals([seed.signal, options.signal]);
                try {
                    if (preparedReadMethod !== undefined && (request.method ?? 'GET') !== preparedReadMethod) {
                        throw new PluginError({ code: 'plugin_fetch_prepared_read_invalid' });
                    }
                    return await runtimeFetch.request(request, { signal: mergedSignal.signal });
                } finally {
                    mergedSignal.dispose();
                }
            },
            async requestStream(request: HttpStreamRequest, options: Parameters<HttpService['requestStream']>[1] = {}) {
                const merged = mergeAbortSignals([seed.signal, options.signal]);
                let response: HttpStreamResponse | undefined;
                try {
                    response = await runtimeFetch.requestStream(request, { signal: merged.signal });
                    return wrapPluginHttpStream(response, {
                        signal: merged.signal,
                        onDispose: merged.dispose,
                    });
                } catch (error) {
                    await response?.dispose().catch(() => undefined);
                    merged.dispose();
                    throw error;
                }
            },
        });
    };
    return Object.freeze({
        prepareAdapterBinding(seed, binding, policy) {
            return adapter => bindWithAdapter(seed, binding, adapter, policy);
        },
        bind(seed, binding, policy): HttpService {
            assertPluginNetworkBindingCurrent(seed, binding);
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
            const purposeHost = policy && 'purposeHost' in policy ? policy.purposeHost ?? undefined : params.purposeHost;
            const inject = (input: PluginHttpRequest, injection: Readonly<{ headers: Readonly<Record<string, string>>;
                secretHeaderNames: readonly string[] }>): PluginHttpRequest => {
                const privateNames = privateCredentialHeaderNameSet(injection);
                const { credentialBinding: _credentialBinding, ...unbound } = input;
                const request = snapshotPluginHttpRequest({ ...unbound,
                    headers: Object.freeze({ ...input.headers, ...injection.headers }) });
                if (privateNames.size > 0) privateCredentialHeaderNamesByRequest.set(request, privateNames);
                return request;
            };
            const requestBuffered = async (raw: PluginHttpRequest, options: Parameters<HttpService['request']>[1] = {},
                operationSeed = seed, operationFetch = runtimeFetch): Promise<PluginHttpResponse> => {
                const input = snapshotPluginHttpRequest(raw);
                if (input.credentialBinding?.kind === 'connectedAccountPurpose' && !purposeHost) {
                    throw new PluginError({ code: 'plugin_fetch_credential_binding_unavailable', message: 'Connected-account fetch credentials are unavailable in this invocation host' });
                }
                const dispatch = async (purpose?: PluginHttpPurposeInjection) => {
                    if (input.credentialBinding?.kind === 'voiceAccountOperation' && !credentialBindingHost) {
                        throw new PluginError({ code: 'plugin_fetch_credential_binding_unavailable', message: 'Connected-account fetch credentials are unavailable in this invocation host' });
                    }
                    const execute = async (voice: Readonly<{ headers: Readonly<Record<string, string>>; secretHeaderNames: readonly string[] }>) => {
                        const request = inject(input, {
                            headers: Object.freeze({ ...purpose?.headers, ...voice.headers }),
                            secretHeaderNames: Object.freeze([...new Set([...(purpose?.secretHeaderNames ?? []), ...voice.secretHeaderNames])]),
                        });
                        const response = await operationFetch.request(request, options);
                        return Object.freeze({ status: response.status, finalUrl: response.finalUrl,
                            headers: Object.freeze({ ...response.headers }), body: response.body,
                            ...(input.observeTlsPeer && response.tlsPeer ? { tlsPeer: Object.freeze({ ...response.tlsPeer }) } : {}) });
                    };
                    return input.credentialBinding?.kind !== 'voiceAccountOperation'
                        ? await execute({ headers: Object.freeze({}), secretHeaderNames: Object.freeze([]) })
                        : await credentialBindingHost!.request({ seed: operationSeed, serviceBinding: binding,
                            credentialBinding: input.credentialBinding, request: input, signal: options.signal, execute });
                };
                try {
                    const response = purposeHost
                        ? await purposeHost.request({ seed: operationSeed, serviceBinding: binding, request: input, signal: options.signal, execute: dispatch })
                        : await dispatch();
                    return response;
                } catch (error) { throw toPluginHttpRedirectFailure(error); }
            };
            return Object.freeze({
                async prepareRead(
                    input: HttpPreparedReadInput,
                    options: Parameters<HttpService['prepareRead']>[1] = {},
                ): Promise<PreparedHttpRead> {
                    const { intent, method = 'GET', url, headers, body, redirect, timeoutMs, responseBody, observeTlsPeer } = input;
                    if (
                        !((intent === 'get' && method === 'GET') || (intent === 'graphqlQuery' && method === 'POST'))
                        || 'credentialBinding' in input
                        || redirect === 'follow'
                    ) {
                        throw new PluginError({ code: 'plugin_fetch_prepared_read_invalid', message: 'Only an exact GET or declared read-only GraphQL query can be prepared' });
                    }
                    const request: PluginHttpRequest = Object.freeze({
                        url, method, redirect,
                        ...(headers === undefined ? {} : { headers: Object.freeze({ ...headers }) }),
                        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
                        ...(timeoutMs === undefined ? {} : { timeoutMs }),
                        ...(responseBody === undefined ? {} : { responseBody }),
                        ...(observeTlsPeer === undefined ? {} : { observeTlsPeer }),
                    });
                    // Each caller's one admission; the retained dispatch below
                    // consumes it instead of evaluating policy again.
                    const admissionSignal = mergeAbortSignals([seed.signal, options.signal]);
                    try {
                        await raceWithAbort(runtimeFetch.admit(request), admissionSignal.signal);
                    } finally {
                        admissionSignal.dispose();
                    }
                    const lifetime = new AbortController();
                    // Retain the real host admission and currentness owners. Only
                    // transport lifetime transfers from the finite invocation to
                    // this single-use handle; no plugin-provided context is used.
                    const retainedSeed = Object.freeze({ ...seed, signal: lifetime.signal });
                    const retainedFetch = bindService(retainedSeed, binding, privateCredentialHeaderNamesByRequest, policy, method);
                    let consumed = false;
                    return Object.freeze({
                        async request(owner: { signal: AbortSignal }) {
                            if (consumed) {
                                throw new PluginError({ code: 'plugin_fetch_prepared_read_consumed', message: 'A prepared read can be requested only once' });
                            }
                            consumed = true;
                            try {
                                const response = await requestBuffered(request, owner, retainedSeed, retainedFetch);
                                return Object.freeze({ ...response, headers: Object.freeze({ ...response.headers }) });
                            } finally {
                                lifetime.abort();
                            }
                        },
                        async dispose() { lifetime.abort(); },
                    });
                },
                request: (input: PluginHttpRequest, options: Parameters<HttpService['request']>[1] = {}) => requestBuffered(input, options),
                async requestStream(raw: HttpStreamRequest, options: Parameters<HttpService['requestStream']>[1] = {}) {
                    const input = snapshotPluginHttpStreamRequest(raw);
                    if (input.credentialBinding !== undefined && !purposeHost) {
                        throw new PluginError({ code: 'plugin_fetch_credential_binding_unavailable', message: 'Connected-account fetch credentials are unavailable in this invocation host' });
                    }
                    const execute = async (purpose?: PluginHttpPurposeInjection): Promise<HttpStreamResponse> => {
                        if (!purpose) return await runtimeFetch.requestStream(input, options);
                        const request = snapshotPluginHttpStreamRequest(inject(input, purpose));
                        const owner = mergeAbortSignals([options.signal]);
                        let response: HttpStreamResponse | undefined;
                        try {
                            response = await runtimeFetch.requestStream(request, { signal: owner.signal });
                            return wrapPluginHttpStream(response, { signal: owner.signal,
                                sanitizer: purpose.createStreamingSanitizer(),
                                onDispose: owner.dispose });
                        } catch (error) {
                            await response?.dispose().catch(() => undefined);
                            owner.dispose();
                            throw error;
                        }
                    };
                    try {
                        return purposeHost
                            ? await purposeHost.requestStream({ seed, serviceBinding: binding, request: input, signal: options.signal, execute })
                            : await execute();
                    } catch (error) { throw toPluginHttpRedirectFailure(error); }
                },
                async openWebSocket(
                    input: PluginWebSocketOpenInput,
                    options: Parameters<HttpService['openWebSocket']>[1] = {},
                ) {
                    assertPluginNetworkBindingCurrent(seed, binding);
                    const admittedInput = snapshotPluginWebSocketOpenInput(input);
                    const lifecycle = new AbortController();
                    const abortLifecycle = (reason: Readonly<{ kind: string }>) => {
                        if (!lifecycle.signal.aborted) lifecycle.abort(reason);
                    };
                    const abortForSeed = () => abortLifecycle(Object.freeze({
                        kind: seed.isOccurrenceCurrent() ? 'hostShutdown' as const : 'generationRetired' as const,
                    }));
                    const abortForConfigurationRevocation = () => abortLifecycle(Object.freeze({
                        kind: 'networkConfigurationRetired' as const,
                    }));
                    if (seed.signal.aborted) abortForSeed();
                    else seed.signal.addEventListener('abort', abortForSeed, { once: true });
                    if (seed.retirementSignal?.aborted) abortForSeed();
                    else seed.retirementSignal?.addEventListener('abort', abortForSeed, { once: true });
                    if (binding.networkRevocationSignal?.aborted) abortForConfigurationRevocation();
                    else binding.networkRevocationSignal?.addEventListener(
                        'abort',
                        abortForConfigurationRevocation,
                        { once: true },
                    );
                    const detachLifecycle = () => {
                        seed.signal.removeEventListener('abort', abortForSeed);
                        seed.retirementSignal?.removeEventListener('abort', abortForSeed);
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
                            !seed.isOccurrenceCurrent()
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
