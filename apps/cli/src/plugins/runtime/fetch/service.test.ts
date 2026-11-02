import { describe, expect, it, vi } from 'vitest';
import { snapshotPluginHttpRequest } from './request';
import { createPluginInvocationSecretRedactor } from '../invocation/services/logger';

import {
    PluginConnectedAccountDescriptorContributionV2Schema,
    type PluginRequestInterceptorContributionV1,
} from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import { logger } from '@/ui/logger';
import { runTracedExternalActionStage } from '@/daemon/externalActions/externalActionPhase';
import type {
    HttpService,
    PluginWebSocketClose,
    PluginWebSocketConnection,
} from '@happier-dev/plugin-sdk/http';
import type {
    TargetPluginInterceptedRequest as PluginInterceptedRequest,
    TargetPluginInterceptorResult as PluginInterceptorResult,
} from '../lifecycle/contributions/targetRequestInterceptors';
import { createPluginInvocationServiceBinding } from '../invocation/services/factory';
import { createUnavailablePluginServices } from '../invocation/services/unavailable';
import { createConnectedAccountConfigurationOwner, type ConnectedAccountConfigurationRecord } from '@happier-dev/cli-common/connectedAccounts';
// Compose the real account owner and factories without extending the plugin's
// production export surface for this host-boundary test.
import {
    createStablePluginHttpHost as createProductionStablePluginHttpHost,
    createPluginHttpService as createProductionPluginHttpService,
    type PluginHttpRuntimeAdapter,
    type PluginHttpRuntimeRequestOptions,
    type CreatePluginHttpServiceParams,
    type PluginRequestInterceptorRegistryV1,
} from './service';

type CanonicalFetchRequest = Parameters<HttpService['request']>[0];

it.each(['same', 'cross'] as const)('keeps registered custom credentials only on %s-origin 302 redirects', async origin => {
    const raw = 'registered-header-credential-42';
    const seed = { plugin: { id: 'acme.headers', version: '1.0.0' },
        contribution: { id: 'send', qualifiedId: 'acme.headers/actions/send' },
        occurrenceId: 'header-occurrence', correlationId: 'header-request', surface: 'agent' as const,
        signal: new AbortController().signal, isOccurrenceCurrent: () => true };
    const scope = { pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
    const redactor = createPluginInvocationSecretRedactor();
    redactor.beginInvocation(scope, seed.signal);
    redactor.registerRaw(scope, raw);
    const sent: CanonicalFetchRequest[] = [];
    const nextUrl = origin === 'same' ? 'https://api.example.test/result' : 'https://other.example.test/result';
    const host = createProductionStablePluginHttpHost({
        adapter: { async request(request) {
            sent.push(request);
            const headers: Readonly<Record<string, string>> = sent.length === 1 ? { location: nextUrl } : {};
            return { status: sent.length === 1 ? 302 : 200,
                headers,
                finalUrl: request.url, body: new Uint8Array() };
        }, async openWebSocket() { throw new Error('Not used'); } },
        containsRegisteredSecret: ({ value }) => redactor.containsRegisteredValue(scope, value),
    });
    const service = host.bind(seed, createPluginInvocationServiceBinding(seed.occurrenceId, 'registered-header'));
    try {
        await expect(service.request({ url: 'https://api.example.test/start', redirect: 'follow',
            headers: { 'x-api-key': raw, 'x-request-id': 'visible-request' } })).resolves.toMatchObject({ status: 200 });
        expect(sent.map(request => request.url)).toEqual(['https://api.example.test/start', nextUrl]);
        expect(sent[0]?.headers).toEqual({ 'x-api-key': raw, 'x-request-id': 'visible-request' });
        expect(sent[1]?.headers).toEqual(origin === 'same'
            ? { 'x-api-key': raw, 'x-request-id': 'visible-request' }
            : { 'x-request-id': 'visible-request' });
    } finally { redactor.completeInvocation(scope); }
});

it.each([307, 308])('refuses cross-origin %s resend of a registered secret body without secret-use declarations', async status => {
    const raw = 'registered-body-"quoted"\nsecond-line';
    const seed = { plugin: { id: 'acme.body', version: '1.0.0' },
        contribution: { id: 'send', qualifiedId: 'acme.body/actions/send' },
        occurrenceId: 'body-occurrence', correlationId: 'body-request', surface: 'agent' as const,
        signal: new AbortController().signal, isOccurrenceCurrent: () => true };
    const scope = { pluginId: seed.plugin.id, occurrenceId: seed.occurrenceId, correlationId: seed.correlationId };
    const redactor = createPluginInvocationSecretRedactor();
    redactor.beginInvocation(scope, seed.signal);
    redactor.registerRaw(scope, raw);
    const sent: string[] = [];
    let nextUrl = 'https://other.example.test/resend';
    const host = createProductionStablePluginHttpHost({
        adapter: { async request(request) {
            sent.push(request.url);
            const headers: Readonly<Record<string, string>> = sent.length === 1 ? { location: nextUrl } : {};
            return { status: sent.length === 1 ? status : 200,
                headers,
                finalUrl: request.url, body: new Uint8Array() };
        }, async openWebSocket() { throw new Error('Not used'); } },
        containsRegisteredSecret: ({ value }) => redactor.containsRegisteredValue(scope, value),
    });
    const service = host.bind(seed, createPluginInvocationServiceBinding(seed.occurrenceId, 'registered-body'));
    try {
        await expect(service.request({ url: 'https://api.example.test/send', method: 'POST', redirect: 'follow',
            body: new TextEncoder().encode(JSON.stringify({ password: raw })) }))
            .rejects.toMatchObject({ code: 'credential_request_redirect_refused' });
        expect(sent).toEqual(['https://api.example.test/send']);
        sent.length = 0;
        await expect(service.request({ url: 'https://api.example.test/send', method: 'POST', redirect: 'follow',
            body: new TextEncoder().encode('ordinary body') })).resolves.toMatchObject({ status: 200 });
        expect(sent).toEqual(['https://api.example.test/send', nextUrl]);
        sent.length = 0;
        nextUrl = 'https://api.example.test/resend';
        await expect(service.request({ url: 'https://api.example.test/send', method: 'POST', redirect: 'follow',
            body: new TextEncoder().encode(JSON.stringify({ password: raw })) })).resolves.toMatchObject({ status: 200 });
        expect(sent).toEqual(['https://api.example.test/send', nextUrl]);
    } finally { redactor.completeInvocation(scope); }
});

it('snapshots an explicit Account purpose binding without Voice fields or mutable header names', () => {
    const headerNames = ['authorization'];
    const input: CanonicalFetchRequest = { url: 'https://api.example.com/projects', redirect: 'error',
        credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'upstream',
            origin: 'https://api.example.com', method: 'GET', headerNames } };
    const snapshot = snapshotPluginHttpRequest(input);
    expect(snapshot).toEqual(input);
    headerNames.push('x-mutated-after-admission');
    expect(snapshot.credentialBinding).toEqual({ kind: 'connectedAccountPurpose', purpose: 'upstream',
        origin: 'https://api.example.com', method: 'GET', headerNames: ['authorization'] });
});

describe('finite HTTP admission lifetime', () => {
    it('finishes an admitted streamed body after configuration withdrawal with no step authority reads', async () => {
        const revocation = new AbortController();
        let current = true;
        const isOccurrenceCurrent = vi.fn(() => current);
        const disposed = vi.fn(async () => {});
        const host = createProductionStablePluginHttpHost({ adapter: {
            async request() { throw new Error('Not used'); },
            async requestStream(request) { return { status: 200, finalUrl: request.url, headers: {},
                chunks: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode('first'); yield new TextEncoder().encode('last'); } },
                dispose: disposed }; },
            async openWebSocket() { throw new Error('Not used'); },
        } });
        const service = host.bind({ plugin: { id: 'acme.stream', version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'acme.stream/actions/read' },
            occurrenceId: 'stream', correlationId: 'stream-request', surface: 'cli',
            signal: new AbortController().signal, isOccurrenceCurrent,
        }, { ...createPluginInvocationServiceBinding('stream', 'stream'), networkRevocationSignal: revocation.signal });
        const response = await service.requestStream({ url: 'https://example.test/body', redirect: 'error' });
        const chunks = response.chunks[Symbol.asyncIterator]();
        expect(new TextDecoder().decode((await chunks.next()).value)).toBe('first');
        const readsAtAdmission = isOccurrenceCurrent.mock.calls.length;
        current = false;
        revocation.abort();
        expect(new TextDecoder().decode((await chunks.next()).value)).toBe('last');
        expect(await chunks.next()).toMatchObject({ done: true });
        expect(isOccurrenceCurrent).toHaveBeenCalledTimes(readsAtAdmission);
        expect(disposed).toHaveBeenCalledOnce();
    });

    it('returns an admitted response after revocation within its original admitted binding', async () => {
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        const revocation = new AbortController();
        let current = true;
        let admissionReads = 0;
        const seed = {
            plugin: { id: 'acme.finite', version: '1.0.0' },
            contribution: { id: 'fetch', qualifiedId: 'acme.finite/actions/fetch' },
            occurrenceId: 'finite-http-occurrence', correlationId: 'finite-http-request',
            surface: 'cli' as const, signal: new AbortController().signal,
            retirementSignal: revocation.signal,
            isOccurrenceCurrent() { admissionReads += 1; return current; },
        };
        const host = createProductionStablePluginHttpHost({ adapter: {
            async request(request) {
                enter();
                await held;
                return { status: 200, headers: {}, finalUrl: request.url,
                    body: new Uint8Array(Buffer.from('completed')) };
            },
            async openWebSocket() { throw new Error('Not used by finite request'); },
        } });
        const service = host.bind(seed, {
            ...createPluginInvocationServiceBinding(seed.occurrenceId, 'finite-http'),
            networkRevocationSignal: revocation.signal,
        });
        const pending = service.request({ url: 'https://example.test/finite', redirect: 'error' });
        await entered;
        current = false;
        revocation.abort('permission withdrawn');
        release();
        await expect(pending).resolves.toMatchObject({ status: 200,
            body: new Uint8Array(Buffer.from('completed')) });
        expect(admissionReads).toBe(1);
    });
});

type TestFetchRequest = Omit<CanonicalFetchRequest, 'body' | 'redirect'> & Readonly<{
    body?: unknown;
    redirect?: CanonicalFetchRequest['redirect'];
    signal?: AbortSignal;
    metadata?: Readonly<Record<string, unknown>>;
}>;
type TestFetchResponse = Awaited<ReturnType<HttpService['request']>>;
type TestFetchAdapter = (
    request: TestFetchRequest,
    options?: PluginHttpRuntimeRequestOptions,
) => Promise<TestFetchResponse>;
type TestHttpServiceParams = Omit<CreatePluginHttpServiceParams, 'adapter'> & Readonly<{
    adapter?: TestFetchAdapter | null;
}>;

type LegacyPolicyInput = Readonly<{
    originalRequest: TestFetchRequest;
    effectiveRequest: TestFetchRequest;
    operation: Readonly<{ id: string; attempt: number }>;
}>;

type LegacyTestInterceptor = Readonly<{
    pluginId: string;
    contribution: PluginRequestInterceptorContributionV1;
    registration: Readonly<{
        id: string;
        handle(input: LegacyPolicyInput): unknown;
    }>;
}>;

function translateLegacyPolicyResult(
    request: PluginInterceptedRequest,
    result: unknown,
): unknown {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
    const record = result as Readonly<Record<string, unknown>>;
    if (record.decision === 'continue' || record.decision === 'deny') return result;
    if (record.kind === 'deny') return { decision: 'deny', code: record.code };
    if (record.kind !== 'allow' || Object.keys(record).some((key) => key !== 'kind' && key !== 'request')) return result;
    const patch = record.request;
    if (patch === undefined) return { decision: 'continue', request } satisfies PluginInterceptorResult;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return result;
    const patchRecord = patch as Readonly<Record<string, unknown>>;
    if (Object.keys(patchRecord).some((key) => !['url', 'method', 'headers'].includes(key))) return result;
    const headers = { ...request.headers };
    const headerPatch = patchRecord.headers;
    if (headerPatch && typeof headerPatch === 'object' && !Array.isArray(headerPatch)) {
        const headerRecord = headerPatch as Readonly<Record<string, unknown>>;
        for (const name of Array.isArray(headerRecord.remove) ? headerRecord.remove : []) {
            if (typeof name !== 'string') return result;
            for (const existing of Object.keys(headers)) {
                if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
            }
        }
        if (headerRecord.set && typeof headerRecord.set === 'object' && !Array.isArray(headerRecord.set)) {
            for (const [name, value] of Object.entries(headerRecord.set)) {
                if (typeof value !== 'string') return result;
                headers[name] = value;
            }
        }
    }
    return {
        decision: 'continue',
        request: {
            url: typeof patchRecord.url === 'string' ? patchRecord.url : request.url,
            method: typeof patchRecord.method === 'string' ? patchRecord.method : request.method,
            headers,
        },
    };
}

function legacyInterceptorRegistry(
    interceptors: readonly LegacyTestInterceptor[],
): PluginRequestInterceptorRegistryV1 {
    return Object.freeze({
        declarations: Object.freeze(interceptors.map(({ pluginId, contribution }) => Object.freeze({ pluginId, contribution }))),
        activateContributionsOnDemand: async () => Object.freeze([]),
        readBindings: () => Object.freeze(interceptors.map((entry) => Object.freeze({
            pluginId: entry.pluginId,
            contribution: entry.contribution,
            invoke: async (request: PluginInterceptedRequest) => {
                const result = await entry.registration.handle({
                    originalRequest: request,
                    effectiveRequest: request,
                    operation: { id: 'plugin-fetch:test', attempt: 1 },
                });
                return translateLegacyPolicyResult(request, result) as PluginInterceptorResult;
            },
        }))),
    });
}

function createPluginHttpService(
    params: TestHttpServiceParams & Readonly<{ interceptors?: readonly LegacyTestInterceptor[] }>,
) {
    const { adapter, interceptors, interceptorRegistry, ...productionParams } = params;
    const service = createProductionPluginHttpService({
        ...productionParams,
        ...(adapter ? {
            adapter: Object.freeze({
                request: async (
                    request: CanonicalFetchRequest,
                    options: Parameters<HttpService['request']>[1] = {},
                ) => await adapter({
                    ...request,
                    signal: options.signal,
                }),
            }),
        } : {}),
        ...(interceptorRegistry
            ? { interceptorRegistry }
            : interceptors
                ? { interceptorRegistry: legacyInterceptorRegistry(interceptors) }
                : {}),
    });
    return async (request: TestFetchRequest, options: Readonly<{ signal?: AbortSignal }> = {}) => {
        const { body, metadata: _metadata, signal, redirect = 'error', ...input } = request;
        const encodedBody = body === undefined
            ? undefined
            : body instanceof Uint8Array
                ? body
                : new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body));
        return await service.request({ ...input, ...(encodedBody ? { body: encodedBody } : {}), redirect }, {
            signal: options.signal ?? signal,
        });
    };
}

function createStablePluginHttpHost(
    params: Omit<Parameters<typeof createProductionStablePluginHttpHost>[0], 'adapter'> & Readonly<{
        adapter: TestFetchAdapter;
    }>,
) {
    return createProductionStablePluginHttpHost({
        ...params,
        adapter: Object.freeze({
            request: async (
                request: CanonicalFetchRequest,
                options: PluginHttpRuntimeRequestOptions = {},
            ) => await params.adapter({
                ...request,
                signal: options.signal,
            }, options),
            async openWebSocket(): Promise<never> {
                throw new Error('WebSocket is unavailable in this HTTP request fixture');
            },
        }),
    });
}

function createResponse(body: unknown): TestFetchResponse {
    const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body ?? ''));
    return Object.freeze({
        status: 200,
        finalUrl: 'https://api.example.test/result',
        headers: Object.freeze({}),
        body: bytes,
    });
}

describe('createPluginHttpService', () => {
    it('settles admitted finite HTTP after configuration replacement within its original admitted binding', async () => {
        const accountService = { pluginId: 'configured.plugin', localId: 'account' };
        const descriptor = PluginConnectedAccountDescriptorContributionV2Schema.parse({
            id: accountService.localId,
            title: 'Configured service',
            authentication: { defaultModeId: 'oauth', modes: [{
                id: 'oauth', kind: 'oauthAuthorizationCode',
                callbackUrl: 'https://provider.example.test/callback', pkce: 'required', outcomeReconciliation: 'none',
                configuration: { scope: 'service', changeBehavior: 'refresh', fields: [{
                    id: 'endpoint', title: 'Endpoint', semantic: 'connectedAccountOrigin', required: true,
                    schema: { type: 'string', minLength: 1 },
                }] },
            }] },
        });
        const mode = descriptor.authentication.modes[0]!;
        const identity = { occurrenceId: 'configured-occurrence', sourceCustody: {
            kind: 'development' as const, registeredRootId: 'configured-root',
        } };
        let record: ConnectedAccountConfigurationRecord = {
            revision: 'configuration-1', values: { endpoint: 'https://api.example.test' }, secretRefs: {},
        };
        const configurationOwner = createConnectedAccountConfigurationOwner({
            read: async () => record,
            replace: async ({ replacement }) => {
                record = { ...replacement, revision: 'configuration-2' };
                return { status: 'committed', record };
            },
            destroyAttempt: async () => {},
            secrets: { admit: async () => {}, has: async () => false, read: async () => null },
            isRuntimeCurrent: () => true,
        });
        const admission = await configurationOwner.admit({ intent: 'connect', service: accountService, mode, ...identity });
        if (admission.status !== 'ready') throw new Error('Expected an admitted configuration');
        const binding = {
            ...createPluginInvocationServiceBinding(identity.occurrenceId, 'configured-binding'),
            networkRevocationSignal: configurationOwner.currentnessSignal(admission.snapshot),
        };
        let enter!: () => void;
        let release!: () => void;
        let transportSignal: AbortSignal | undefined;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const adapter = vi.fn(async (input: TestFetchRequest) => {
            transportSignal = input.signal;
            enter();
            return await new Promise<TestFetchResponse>(resolve => {
                release = () => resolve(createResponse('late response'));
            });
        });
        const host = createStablePluginHttpHost({ adapter });
        const http = host.bind({
            plugin: { id: accountService.pluginId, version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'configured.plugin/actions/read' },
            occurrenceId: identity.occurrenceId, correlationId: 'configured-http', surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, binding);
        const pending = http.request({ url: 'https://api.example.test/status', redirect: 'error' })
            .then(value => ({ value }), error => ({ error }));
        try {
            await entered;
            await expect(configurationOwner.replace({
                target: admission.snapshot.target, mode, expectedRevision: record.revision,
                replacement: { values: { endpoint: 'https://replacement.example.test' }, secretRefs: {} }, ...identity,
            })).resolves.toMatchObject({ status: 'committed' });
            expect(transportSignal?.aborted).toBe(false);
            release();
            await expect(pending).resolves.toMatchObject({ value: { status: 200 } });
            expect(adapter).toHaveBeenCalledOnce();
        } finally { release?.(); }
    });

    it('prepares an immutable read without HTTP and keeps its transport independent of the preparing invocation', async () => {
        const invocation = new AbortController();
        const caller = new AbortController();
        let release!: () => void;
        let started!: () => void;
        const entered = new Promise<void>(resolve => { started = resolve; });
        const pending = new Promise<void>(resolve => { release = resolve; });
        const adapter = vi.fn(async (request: TestFetchRequest) => {
            started();
            await pending;
            expect(request.signal?.aborted).toBe(false);
            expect(request.headers?.accept).toBe('application/json');
            expect(new TextDecoder().decode(request.body as Uint8Array)).toBe('query { viewer { login } }');
            return createResponse('ok');
        });
        const host = createStablePluginHttpHost({ adapter });
        const binding = createPluginInvocationServiceBinding('prepared', 'prepared-binding');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'caller.plugin/actions/read' },
            occurrenceId: 'prepared', correlationId: 'prepared', surface: 'agent',
            signal: invocation.signal, isOccurrenceCurrent: () => true,
        }, binding);
        const headers = { accept: 'application/json' };
        const body = new TextEncoder().encode('query { viewer { login } }');
        const read = await service.prepareRead({ intent: 'graphqlQuery', method: 'POST',
            url: 'https://api.example.test/graphql', redirect: 'error', headers, body }, { signal: caller.signal });
        expect(adapter).not.toHaveBeenCalled();
        headers.accept = 'changed';
        body.fill(0);
        invocation.abort();
        caller.abort();
        const response = read.request({ signal: new AbortController().signal });
        await entered;
        release();
        await expect(response).resolves.toMatchObject({ status: 200 });
        await expect(read.request({ signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_fetch_prepared_read_consumed' });
        await read.dispose();
    });

    it('admits prepared reads before transport and settles them after configuration retirement', async () => {
        const retirement = new AbortController();
        const adapter = vi.fn(async () => { retirement.abort(); return createResponse('private'); });
        const host = createStablePluginHttpHost({ adapter });
        const binding = createPluginInvocationServiceBinding('prepared-policy', 'prepared-policy-binding');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'caller.plugin/actions/read' },
            occurrenceId: 'prepared-policy', correlationId: 'prepared-policy', surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, { ...binding, networkRevocationSignal: retirement.signal });
        const otherOrigin = await service.prepareRead({ intent: 'get', url: 'https://other.example.test/read', redirect: 'error' });
        await otherOrigin.dispose();
        // JavaScript callers cannot detach a mutation by mislabelling its method.
        const mutation = { intent: 'get' as const, method: 'DELETE' as const, url: 'https://api.example.test/read', redirect: 'error' as const };
        // @ts-expect-error Deliberately cross the public type boundary to verify runtime admission.
        await expect(service.prepareRead(mutation)).rejects.toMatchObject({ code: 'plugin_fetch_prepared_read_invalid' });
        expect(adapter).not.toHaveBeenCalled();
        const read = await service.prepareRead({ intent: 'get', url: 'https://api.example.test/read', redirect: 'error' });
        await expect(read.request({ signal: new AbortController().signal })).resolves.toMatchObject({ status: 200 });
        await read.dispose();
    });

    it('admits a prepared read once, when prepared, without re-admitting transport', async () => {
        const retirement = new AbortController();
        const adapter = vi.fn(async () => createResponse('read'));
        const host = createStablePluginHttpHost({ adapter, });
        const binding = createPluginInvocationServiceBinding('prepared-once', 'prepared-once-binding');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'caller.plugin/actions/read' },
            occurrenceId: 'prepared-once', correlationId: 'prepared-once', surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, { ...binding, networkRevocationSignal: retirement.signal });
        const read = await service.prepareRead({ intent: 'get', url: 'https://api.example.test/read', redirect: 'error' });
        await expect(read.request({ signal: new AbortController().signal })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledTimes(1);

        retirement.abort();
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('disposes a prepared read by aborting only its own transport', async () => {
        let started!: () => void;
        let complete!: () => void;
        let transportSignal: AbortSignal | undefined;
        const entered = new Promise<void>(resolve => { started = resolve; });
        const host = createStablePluginHttpHost({ adapter: async (request) => {
            transportSignal = request.signal;
            started();
            return await new Promise<TestFetchResponse>((resolve, reject) => {
                complete = () => resolve(createResponse('late response'));
                request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
            });
        } });
        const binding = createPluginInvocationServiceBinding('prepared-dispose', 'prepared-dispose-binding');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'read', qualifiedId: 'caller.plugin/actions/read' },
            occurrenceId: 'prepared-dispose', correlationId: 'prepared-dispose', surface: 'agent',
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        }, binding);
        const read = await service.prepareRead({ intent: 'get', url: 'https://api.example.test/read', redirect: 'error' });
        const result = read.request({ signal: new AbortController().signal }).then(value => ({ value }), error => ({ error }));
        try {
            await entered;
            await read.dispose();
            expect(transportSignal?.aborted).toBe(true);
            await expect(result).resolves.toMatchObject({ error: { name: 'AbortError' } });
        } finally { complete(); }
    });

    it('separates traced HTTP policy and transport waits through the bound host without request content', async () => {
        vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '1');
        const sink = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => undefined);
        let releaseHttp!: () => void;
        let startedHttp!: () => void;
        const httpStarted = new Promise<void>(resolve => { startedHttp = resolve; });
        const httpBoundary = new Promise<void>(resolve => { releaseHttp = resolve; });
        const response = createResponse('private-response-marker');
        const host = createProductionStablePluginHttpHost({
            adapter: {
                request: async () => { startedHttp(); await httpBoundary; return response; },
                openWebSocket: async () => { throw new Error('HTTP-only fixture'); },
            },
        });
        const seed = {
            plugin: { id: 'example.external-plugin', version: '1.0.0' },
            contribution: { id: 'scan', qualifiedId: 'example.external-plugin/actions/scan' },
            occurrenceId: 'external-occurrence', correlationId: 'external-correlation', surface: 'cli' as const,
            signal: new AbortController().signal, isOccurrenceCurrent: () => true,
        };
        const service = host.bind(seed, createPluginInvocationServiceBinding(seed.occurrenceId, 'external-binding'));
        const rootRequestId = '284f241a-d497-4fbe-955b-a91c7a7f4a4a';
        const request = { url: 'https://api.example.test/private-path-marker', redirect: 'error' as const,
            headers: { authorization: 'private-header-marker' } };
        const pending = runTracedExternalActionStage('action.invoke', `rpc_${rootRequestId}`, 'contributed.target_invoke', () =>
            service.request(request));
        const observed = pending.then(value => ({ value }), error => ({ error }));
        const records = () => sink.mock.calls.filter(([message]) => message === '[external-action-stage]');
        try {
            await httpStarted;
            expect(records()).toContainEqual(['[external-action-stage]', expect.objectContaining({
                rootRequestId, stage: 'contributed.http.interceptors.end', elapsedMs: expect.any(Number),
            })]);
            expect(records()).toContainEqual(['[external-action-stage]', expect.objectContaining({
                rootRequestId, stage: 'contributed.http.transport.begin',
            })]);
            expect(records()).not.toContainEqual(['[external-action-stage]', expect.objectContaining({
                stage: 'contributed.http.transport.end',
            })]);
            releaseHttp();
            await expect(observed).resolves.toEqual({ value: response });
            expect(records()).toContainEqual(['[external-action-stage]', expect.objectContaining({
                rootRequestId, stage: 'contributed.http.transport.end', httpStatus: 200, elapsedMs: expect.any(Number),
            })]);
            expect(JSON.stringify(records())).not.toContain('private-');
            vi.stubEnv('HAPPIER_WEB_LATENCY_TRACE', '');
            const count = records().length;
            await service.request(request);
            expect(records()).toHaveLength(count);
        } finally {
            releaseHttp(); await observed; sink.mockRestore(); vi.unstubAllEnvs();
        }
    });

    it('passes the immutable admitted WebSocket target to the adapter instead of rereading caller input', async () => {
        const connection: PluginWebSocketConnection = Object.freeze({
            url: 'wss://gateway.example.test/socket',
            protocol: '',
            closed: Promise.resolve(Object.freeze({ kind: 'remote' as const, wasClean: true })),
            send: async () => undefined,
            receive: async () => Object.freeze({ kind: 'closed' as const, close: {
                kind: 'remote' as const,
                wasClean: true,
            } }),
            close: () => undefined,
            dispose: () => undefined,
        });
        let adapterInput: Parameters<HttpService['openWebSocket']>[0] | null = null;
        const host = createProductionStablePluginHttpHost({
            adapter: Object.freeze({
                request: async () => createResponse('unexpected HTTP request'),
                async openWebSocket(input) {
                    adapterInput = input;
                    return connection;
                },
            }),
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'snapshot', qualifiedId: 'caller.plugin/actions/snapshot' }),
            occurrenceId: 'generation-websocket-snapshot',
            correlationId: 'correlation-websocket-snapshot',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        const service = host.bind(seed, createPluginInvocationServiceBinding('generation-websocket-snapshot', 'binding-websocket-snapshot'));
        let reads = 0;
        const mutableInput = Object.defineProperty({}, 'url', {
            enumerable: true,
            get: () => {
                reads += 1;
                return reads <= 3
                    ? 'wss://gateway.example.test/socket'
                    : 'wss://unadmitted.example.test/socket';
            },
        }) as Parameters<HttpService['openWebSocket']>[0];

        await expect(service.openWebSocket(mutableInput)).resolves.toBe(connection);

        expect(Object.isFrozen(adapterInput)).toBe(true);
        expect(adapterInput).toEqual({ url: 'wss://gateway.example.test/socket' });
        await expect(service.openWebSocket(null as unknown as Parameters<HttpService['openWebSocket']>[0]))
            .rejects.toMatchObject({ code: 'plugin_websocket_invalid_url' });
        await expect(service.openWebSocket({ url: 'ws://gateway.example.test/socket' }))
            .rejects.toMatchObject({ code: 'plugin_websocket_insecure_url_denied' });
        await expect(service.openWebSocket({ url: 'wss://user:password@gateway.example.test/socket' }))
            .rejects.toMatchObject({ code: 'plugin_websocket_invalid_url' });
    });

    it('refuses a WebSocket when its exact binding retires before transport', async () => {
        const adapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            openWebSocket: vi.fn(async (): Promise<never> => {
                throw new Error('transport must not open');
            }),
        });
        const retirement = new AbortController();
        const host = createProductionStablePluginHttpHost({
            adapter,
        });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'retire', qualifiedId: 'caller.plugin/actions/retire' }),
            occurrenceId: 'generation-websocket-retire-after-dns',
            correlationId: 'correlation-websocket-retire-after-dns',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        const binding = Object.freeze({
            ...createPluginInvocationServiceBinding('generation-websocket-retire-after-dns', 'binding-websocket-retire-after-dns'),
            networkRevocationSignal: retirement.signal,
        });

        const service = host.bind(seed, binding);
        retirement.abort();
        await expect(service.openWebSocket({
            url: 'wss://gateway.example.test/socket',
        })).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        expect(adapter.openWebSocket).not.toHaveBeenCalled();
    });

    it('maps exact configured-origin revocation during a pending socket open to the canonical retirement error', async () => {
        let markOpenStarted!: () => void;
        const openStarted = new Promise<void>((resolve) => { markOpenStarted = resolve; });
        const adapter: PluginHttpRuntimeAdapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            openWebSocket: async (_input, options = {}) => await new Promise<never>((_resolve, reject) => {
                markOpenStarted();
                options.lifecycleSignal?.addEventListener('abort', () => {
                    reject(new PluginError({
                        code: 'plugin_websocket_lifecycle_closed',
                        message: 'The adapter observed its host lifecycle signal',
                    }));
                }, { once: true });
            }),
        });
        const revocation = new AbortController();
        const host = createProductionStablePluginHttpHost({ adapter });
        const seed = Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: 'pending-open', qualifiedId: 'caller.plugin/actions/pending-open' }),
            occurrenceId: 'generation-pending-open',
            correlationId: 'correlation-pending-open',
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        const binding = Object.freeze({
            ...createPluginInvocationServiceBinding('generation-pending-open', 'binding-pending-open'),
            networkRevocationSignal: revocation.signal,
        });
        const opening = host.bind(seed, binding).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        const settled = expect(opening).rejects.toMatchObject({ code: 'plugin_final_generation_retired' });
        await openStarted;
        revocation.abort(Object.freeze({ kind: 'configurationReplaced' as const }));
        await settled;
    });

    it('revokes only the exact configured-origin socket and composes with caller, generation, and remote closure', async () => {
        type OpenedConnection = Readonly<{
            connection: PluginWebSocketConnection;
            terminal(): PluginWebSocketClose | null;
            lifecycleAbortCalls(): number;
            closeRemote(): void;
        }>;
        const opened: OpenedConnection[] = [];
        const adapter: PluginHttpRuntimeAdapter = Object.freeze({
            request: async () => createResponse('unexpected HTTP request'),
            async openWebSocket(_input, options = {}) {
                let terminal: PluginWebSocketClose | null = null;
                let lifecycleAbortCalls = 0;
                let resolveClosed!: (close: PluginWebSocketClose) => void;
                const closed = new Promise<PluginWebSocketClose>((resolve) => { resolveClosed = resolve; });
                const finish = (close: PluginWebSocketClose) => {
                    if (terminal) return;
                    terminal = close;
                    resolveClosed(close);
                };
                const onLifecycleAbort = () => {
                    lifecycleAbortCalls += 1;
                    const reason = options.lifecycleSignal?.reason;
                    const kind = (
                        reason
                        && typeof reason === 'object'
                        && 'kind' in reason
                        && (reason.kind === 'generationRetired' || reason.kind === 'hostShutdown')
                    )
                        ? reason.kind
                        : 'aborted' as const;
                    finish(Object.freeze({ kind, wasClean: false }));
                };
                const onCallerAbort = () => {
                    finish(Object.freeze({ kind: 'aborted' as const, wasClean: false }));
                };
                options.lifecycleSignal?.addEventListener('abort', onLifecycleAbort, { once: true });
                options.signal?.addEventListener('abort', onCallerAbort, { once: true });
                const connection: PluginWebSocketConnection = Object.freeze({
                    url: 'wss://gateway.example.test/socket',
                    protocol: 'gateway-v1',
                    closed,
                    async send() {
                        if (terminal) throw new Error('WebSocket is closed');
                    },
                    async receive() {
                        return terminal
                            ? Object.freeze({ kind: 'closed' as const, close: terminal })
                            : Object.freeze({ kind: 'text' as const, text: 'still-open' });
                    },
                    close() {
                        finish(Object.freeze({ kind: 'local' as const, wasClean: false }));
                    },
                    dispose() {
                        finish(Object.freeze({ kind: 'local' as const, wasClean: false }));
                    },
                });
                opened.push(Object.freeze({
                    connection,
                    terminal: () => terminal,
                    lifecycleAbortCalls: () => lifecycleAbortCalls,
                    closeRemote() {
                        finish(Object.freeze({ kind: 'remote' as const, wasClean: true }));
                    },
                }));
                return connection;
            },
        });
        const host = createProductionStablePluginHttpHost({ adapter });
        const createBinding = (id: string, networkRevocationSignal: AbortSignal) => Object.freeze({
            ...createPluginInvocationServiceBinding('generation-websocket', id),
            networkRevocationSignal,
        });
        const createSeed = (
            id: string,
            signal: AbortSignal,
            isOccurrenceCurrent: () => boolean = () => true,
        ) => Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id, qualifiedId: `caller.plugin/actions/${id}` }),
            occurrenceId: 'generation-websocket',
            correlationId: id,
            surface: 'agent' as const,
            signal,
            isOccurrenceCurrent,
        });

        const configurationA = new AbortController();
        const configurationB = new AbortController();
        const serviceA = host.bind(
            createSeed('configured-a', new AbortController().signal),
            createBinding('configured-a', configurationA.signal),
        );
        const serviceB = host.bind(
            createSeed('configured-b', new AbortController().signal),
            createBinding('configured-b', configurationB.signal),
        );
        const connectionA = await serviceA.openWebSocket({ url: 'wss://gateway.example.test/socket' });
        const connectionB = await serviceB.openWebSocket({ url: 'wss://gateway.example.test/socket' });

        configurationA.abort(Object.freeze({ kind: 'configurationReplaced' as const }));
        expect(opened[0]?.terminal()).toMatchObject({ kind: 'aborted', wasClean: false });
        expect(opened[1]?.terminal()).toBeNull();
        await expect(connectionA.closed).resolves.toMatchObject({ kind: 'aborted', wasClean: false });
        await expect(connectionA.send({ kind: 'text', text: 'after-revocation' })).rejects.toThrow(/closed/i);
        await expect(connectionA.receive()).resolves.toMatchObject({ kind: 'closed' });
        await expect(connectionB.send({ kind: 'text', text: 'unrelated-binding' })).resolves.toBeUndefined();
        await expect(connectionB.receive()).resolves.toEqual({ kind: 'text', text: 'still-open' });

        const callerAbort = new AbortController();
        const caller = await host.bind(
            createSeed('caller-abort', new AbortController().signal),
            createBinding('caller-abort', new AbortController().signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' }, { signal: callerAbort.signal });
        callerAbort.abort();
        await expect(caller.closed).resolves.toMatchObject({ kind: 'aborted', wasClean: false });

        let generationCurrent = true;
        const generationAbort = new AbortController();
        const generation = await host.bind(
            createSeed('generation-retired', generationAbort.signal, () => generationCurrent),
            createBinding('generation-retired', new AbortController().signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        generationCurrent = false;
        generationAbort.abort();
        await expect(generation.closed).resolves.toMatchObject({ kind: 'generationRetired', wasClean: false });

        const remoteConfiguration = new AbortController();
        const remote = await host.bind(
            createSeed('remote-close', new AbortController().signal),
            createBinding('remote-close', remoteConfiguration.signal),
        ).openWebSocket({ url: 'wss://gateway.example.test/socket' });
        const remoteRecord = opened.at(-1)!;
        remoteRecord.closeRemote();
        await expect(remote.closed).resolves.toMatchObject({ kind: 'remote', wasClean: true });
        await Promise.resolve();
        remoteConfiguration.abort(Object.freeze({ kind: 'configurationReplaced' as const }));
        expect(remoteRecord.lifecycleAbortCalls()).toBe(0);
    });

    it('exposes a manual 3xx and re-enters interceptors for an explicit next request', async () => {
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse(null),
            status: request.url.endsWith('/start') ? 302 : 200,
            headers: request.url.endsWith('/start')
                ? Object.freeze({ location: 'https://next.example.test/result' })
                : Object.freeze({}),
            finalUrl: request.url,
        }));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: {
                    id: 'observe',
                    origins: ['https://api.example.test', 'https://next.example.test'],
                },
                registration: { id: 'observe', handle: interceptor },
            }]),
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-redirect');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7', correlationId: 'correlation-redirect', surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        const first = await service.request({
            url: 'https://api.example.test/start', method: 'GET', redirect: 'manual',
        });
        expect(first).toMatchObject({
            status: 302,
            headers: { location: 'https://next.example.test/result' },
        });
        await expect(service.request({
            url: first.headers.location!, method: 'GET', redirect: 'manual',
        })).resolves.toMatchObject({ status: 200, finalUrl: 'https://next.example.test/result' });
        expect(interceptor).toHaveBeenCalledTimes(2);
        expect(adapter).toHaveBeenCalledTimes(2);
    });

    it('lets trusted interceptors inspect the request URL while preserving opaque terminal body bytes', async () => {
        const token = '123456:telegram-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const body = new TextEncoder().encode('chat text must remain terminal-only');
        const adapter = vi.fn(async (request: TestFetchRequest) => {
            expect(request.url).toBe(rawUrl);
            expect(request.body).toEqual(body);
            return createResponse('ok');
        });
        const interceptor = vi.fn(async (_input: LegacyPolicyInput) => ({ kind: 'allow' as const }));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'observe', origins: ['https://api.telegram.org'] },
                registration: { id: 'observe', handle: interceptor },
            }]),
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-redacted-path');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7', correlationId: 'correlation-redacted-path', surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: rawUrl,
            method: 'POST',
            body,
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });

        const intercepted = interceptor.mock.calls[0]?.[0].originalRequest;
        expect(intercepted).toMatchObject({
            url: rawUrl,
        });
        expect(intercepted?.body).toBeUndefined();
        expect(intercepted?.url).toContain(token);
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('lets a trusted interceptor rewrite a credential-bearing URL', async () => {
        const token = '123456:telegram-secret';
        const rawUrl = `https://api.telegram.org/bot${token}/getMe`;
        const adapter = vi.fn(async (_request: TestFetchRequest) => createResponse('ok'));
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'acme.policy',
                contribution: { id: 'mutate', origins: ['https://api.telegram.org'] },
                registration: {
                    id: 'mutate',
                    handle: async ({ effectiveRequest }) => ({
                        kind: 'allow',
                        request: { url: `${effectiveRequest.url}?audit=1` },
                    }),
                },
            }]),
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-redacted-path-mutation');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7', correlationId: 'correlation-redacted-path-mutation', surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: rawUrl,
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter.mock.calls[0]?.[0]).toMatchObject({ url: `${rawUrl}?audit=1` });
    });

    it('enforces a bound host deadline when a terminal adapter never settles', async () => {
        const adapter = vi.fn(async () => await new Promise<TestFetchResponse>(() => undefined));
        const host = createStablePluginHttpHost({ adapter });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-never-settles');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7', correlationId: 'correlation-never-settles', surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.telegram.org/slow',
            method: 'GET',
            timeoutMs: 5,
            redirect: 'error',
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('applies current installation-wide interceptor policy while retaining private callback separation', async () => {
        const adapter = vi.fn(async () => Object.freeze({
            ...createResponse('ok'),
            finalUrl: 'https://api.example.test/status',
        }));
        const interceptor = vi.fn(async () => ({
            kind: 'deny' as const,
            code: 'current_callback_must_not_run',
        }));
        const credentialBindingHost = {
            request: vi.fn(async () => {
                throw new Error('current credential callback must not run');
            }),
        };
        const host = createStablePluginHttpHost({
            adapter,
            credentialBindingHost,
        });
        const binding = createPluginInvocationServiceBinding('generation-g', 'binding-retained');
        const service = host.bind({
            plugin: { id: 'retained.plugin', version: '1.0.0' },
            contribution: {
                id: 'run',
                qualifiedId: 'retained.plugin/agents/run',
            },
            occurrenceId: 'generation-g',
            correlationId: 'correlation-retained',
            surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding, {
            interceptorRegistry: legacyInterceptorRegistry([{
                pluginId: 'current.policy',
                contribution: {
                    id: 'deny',
                    origins: ['https://api.example.test'],
                },
                registration: {
                    id: 'deny',
                    handle: interceptor,
                },
            }]),
            credentialBindingHost: null,
        });

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_denied',
        });
        expect(adapter).not.toHaveBeenCalled();
        expect(interceptor).toHaveBeenCalledOnce();
        expect(credentialBindingHost.request).not.toHaveBeenCalled();
    });

    it('admits a binding once and refuses an already withdrawn binding without network I/O', async () => {
        const adapter = vi.fn(async () => createResponse('ok'));
        const host = createStablePluginHttpHost({ adapter });
        const retirement = new AbortController();
        const seed = { plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' }, occurrenceId: 'bound', correlationId: 'bound',
            surface: 'agent' as const, signal: new AbortController().signal, isOccurrenceCurrent: vi.fn(() => true) };
        const binding = { ...createPluginInvocationServiceBinding('bound', 'bound'), networkRevocationSignal: retirement.signal };
        const service = host.bind(seed, binding);
        retirement.abort();
        await expect(service.request({ url: 'https://api.example.test/status', redirect: 'error' })).resolves.toMatchObject({ status: 200 });
        expect(seed.isOccurrenceCurrent).toHaveBeenCalledOnce();
        expect(adapter).toHaveBeenCalledOnce();
        expect(() => host.bind(seed, binding)).toThrowError(expect.objectContaining({ code: 'plugin_final_generation_retired' }));
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('allows trusted plugin requests to a private service origin', async () => {
        const adapter = vi.fn(async () => createResponse('private service'));
        const host = createStablePluginHttpHost({
            adapter,
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-private-disclosure');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7',
            correlationId: 'private-disclosure',
            surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://forge.internal.test/status',
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledOnce();
    });

    it('finishes an admitted retry after configuration retirement within its original admitted binding', async () => {
        const retirement = new AbortController();
        const adapter = vi.fn(async () => {
            if (adapter.mock.calls.length === 1) {
                retirement.abort();
                throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
            }
            return createResponse('completed');
        });
        const host = createStablePluginHttpHost({
            adapter,
            retry: { maxAttempts: 2, baseDelayMs: 0 },
        });
        const baseBinding = createPluginInvocationServiceBinding('generation-7', 'binding-connected-account-retry');
        const binding = Object.freeze({
            ...baseBinding,
            networkRevocationSignal: retirement.signal,
        }) as typeof baseBinding;
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7',
            correlationId: 'correlation-connected-account-retry',
            surface: 'agent',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ body: new TextEncoder().encode('completed') });
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(adapter).toHaveBeenCalledTimes(2);
    });

    it('lets trusted interceptors retarget requests after the credential owner binds once', async () => {
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse('ok'),
            finalUrl: request.url,
        }));
        const retargetInterceptor = legacyInterceptorRegistry([{
            pluginId: 'acme.policy',
            contribution: { id: 'retarget', origins: ['https://api.example.test'] },
            registration: {
                id: 'retarget',
                handle: async ({ effectiveRequest }) => (
                    effectiveRequest.url === 'https://api.example.test/authorized'
                        ? { kind: 'allow', request: { url: 'https://api.example.test/retargeted' } }
                        : effectiveRequest.url === 'https://api.example.test/remethod'
                            ? { kind: 'allow', request: { method: 'DELETE' } }
                            : { kind: 'allow' }
                ),
            },
        }]);
        const credentialBindingHost = {
            request: vi.fn(async (input: Readonly<{
                execute(injection: Readonly<{
                    headers: Readonly<Record<string, string>>;
                    secretHeaderNames: readonly string[];
                }>): Promise<unknown>;
            }>) => await input.execute(Object.freeze({
                headers: Object.freeze({ authorization: 'Bearer account-secret' }),
                secretHeaderNames: Object.freeze(['authorization']),
            }))),
        };
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: retargetInterceptor,
            credentialBindingHost: credentialBindingHost as never,
        });
        const binding = createPluginInvocationServiceBinding('generation-credential', 'binding-credential');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-credential',
            correlationId: 'correlation-credential',
            surface: 'ui',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);
        const credentialBinding = Object.freeze({
            kind: 'voiceAccountOperation' as const,
            provider: Object.freeze({ pluginId: 'caller.plugin', localId: 'voice' }),
            operation: 'catalog',
            parameters: Object.freeze({}),
        });

        // The credential owner authorized exactly this target, so the ordinary
        // request still carries the injected secret.
        await expect(service.request({
            url: 'https://api.example.test/allowed',
            method: 'GET',
            redirect: 'error',
            credentialBinding,
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(adapter.mock.calls[0]?.[0]).toMatchObject({
            url: 'https://api.example.test/allowed',
            headers: expect.objectContaining({ authorization: 'Bearer account-secret' }),
        });

        // Trusted interceptors may refine the bound request.
        await expect(service.request({
            url: 'https://api.example.test/authorized',
            method: 'GET',
            redirect: 'error',
            credentialBinding,
        })).resolves.toMatchObject({ status: 200 });
        await expect(service.request({
            url: 'https://api.example.test/remethod',
            method: 'GET',
            redirect: 'error',
            credentialBinding,
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledTimes(3);
        expect(adapter.mock.calls[1]?.[0]).toMatchObject({ headers: expect.objectContaining({ authorization: expect.stringContaining('Bearer ') }) });
        expect(adapter.mock.calls[2]?.[0]).toMatchObject({ method: 'DELETE' });
    });

    it('lets a trusted interceptor retarget a request carrying raw Authorization', async () => {
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse('ok'),
            finalUrl: request.url,
        }));
        const retargetInterceptor = legacyInterceptorRegistry([{
            pluginId: 'acme.policy',
            contribution: { id: 'retarget', origins: ['https://api.example.test'] },
            registration: {
                id: 'retarget',
                handle: async ({ effectiveRequest }) => (
                    effectiveRequest.url === 'https://api.example.test/endpoint'
                        ? { kind: 'allow', request: { url: 'https://api.example.test/dangerous' } }
                        : effectiveRequest.url === 'https://api.example.test/method'
                            ? { kind: 'allow', request: { method: 'DELETE' } }
                            : {
                                kind: 'allow',
                                request: { headers: { set: { 'x-policy': 'observed' } } },
                            }
                ),
            },
        }]);
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: retargetInterceptor,
        });
        const binding = createPluginInvocationServiceBinding('generation-raw-credential', 'binding-raw-credential');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-raw-credential',
            correlationId: 'correlation-raw-credential',
            surface: 'ui',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, binding);
        const headers = Object.freeze({ authorization: 'Bearer connected-account-secret' });

        // An otherwise unchanged request remains observable to the trusted
        // interceptor and carries its raw credential only to its original endpoint.
        await expect(service.request({
            url: 'https://api.example.test/allowed',
            method: 'GET',
            headers,
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledTimes(1);
        expect(adapter.mock.calls[0]?.[0]).toMatchObject({
            url: 'https://api.example.test/allowed',
            method: 'GET',
            headers: expect.objectContaining({
                authorization: 'Bearer connected-account-secret',
                'x-policy': 'observed',
            }),
        });

        // Raw caller credentials have the same trusted-interceptor contract.
        await expect(service.request({
            url: 'https://api.example.test/endpoint',
            method: 'GET',
            headers,
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });
        await expect(service.request({
            url: 'https://api.example.test/method',
            method: 'GET',
            headers,
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledTimes(3);
        expect(adapter.mock.calls[1]?.[0]).toMatchObject({ headers: expect.objectContaining({ authorization: expect.stringContaining('Bearer ') }) });
        expect(adapter.mock.calls[2]?.[0]).toMatchObject({ method: 'DELETE' });
    });

    it('removes invocation abort listeners after a completed stable request', async () => {
        const invocationAbort = new AbortController();
        const requestAbort = new AbortController();
        const addEventListener = vi.spyOn(invocationAbort.signal, 'addEventListener');
        const removeEventListener = vi.spyOn(invocationAbort.signal, 'removeEventListener');
        const host = createStablePluginHttpHost({
            adapter: async () => Object.freeze({
                ...createResponse('ok'),
                finalUrl: 'https://api.example.test/status',
                arrayBuffer: async () => new Uint8Array([111, 107]).buffer,
            }),
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-listeners');
        const service = host.bind({
            plugin: { id: 'caller.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'caller.plugin/actions/run' },
            occurrenceId: 'generation-7',
            correlationId: 'correlation-listeners',
            surface: 'agent',
            signal: invocationAbort.signal,
            isOccurrenceCurrent: () => true,
        }, binding);

        await expect(service.request({
            url: 'https://api.example.test/status',
            method: 'GET',
            redirect: 'error',
        }, { signal: requestAbort.signal })).resolves.toMatchObject({ status: 200 });

        expect(addEventListener).toHaveBeenCalledTimes(1);
        expect(removeEventListener).toHaveBeenCalledTimes(1);
        expect(removeEventListener).toHaveBeenCalledWith(
            'abort',
            addEventListener.mock.calls[0]?.[1],
        );
    });

    it('keeps interceptor recursion fencing across independently bound stable services', async () => {
        const adapter = vi.fn(async (request: TestFetchRequest) => Object.freeze({
            ...createResponse(request.url),
            finalUrl: request.url,
            arrayBuffer: async () => new ArrayBuffer(0),
        }));
        let nestedService: ReturnType<ReturnType<typeof createStablePluginHttpHost>['bind']>;
        const invoke = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => {
            if (invoke.mock.calls.length > 1) {
                throw new Error('recursive interceptor invocation');
            }
            await nestedService.request({
                url: 'https://api.example.test/nested',
                method: 'GET',
                redirect: 'error',
            });
            return Object.freeze({ decision: 'continue', request });
        });
        const declaration: PluginRequestInterceptorContributionV1 = {
            id: 'shared',
            origins: ['https://api.example.test'],
        };
        const host = createStablePluginHttpHost({
            adapter,
            interceptorRegistry: Object.freeze({
                declarations: Object.freeze([
                    Object.freeze({ pluginId: 'acme.policy', contribution: declaration }),
                ]),
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => Object.freeze([
                    Object.freeze({
                        pluginId: 'acme.policy',
                        contribution: declaration,
                        invoke,
                    }),
                ]),
            }),
        });
        const binding = createPluginInvocationServiceBinding('generation-7', 'binding-shared-recursion');
        const createSeed = (qualifiedId: string) => Object.freeze({
            plugin: Object.freeze({ id: 'caller.plugin', version: '1.0.0' }),
            contribution: Object.freeze({ id: qualifiedId.split('/').at(-1)!, qualifiedId }),
            occurrenceId: 'generation-7',
            correlationId: qualifiedId,
            surface: 'agent' as const,
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        });
        nestedService = host.bind(createSeed('caller.plugin/actions/nested'), binding);
        const outerService = host.bind(createSeed('caller.plugin/actions/outer'), binding);

        await expect(outerService.request({
            url: 'https://api.example.test/outer',
            method: 'GET',
            redirect: 'error',
        })).resolves.toMatchObject({ status: 200 });

        expect(invoke).toHaveBeenCalledTimes(1);
        expect(adapter.mock.calls.map(([request]) => request.url)).toEqual([
            'https://api.example.test/nested',
            'https://api.example.test/outer',
        ]);
    });

    it('activates only matching qualified interceptor demand and re-reads bindings before dispatch', async () => {
        const activationOrder: string[] = [];
        const bindings: Array<{
            pluginId: string;
            occurrenceId: string;
            contribution: { id: string; origins: string[]; methods: ['GET']; priority: number };
            invoke(request: PluginInterceptedRequest): Promise<PluginInterceptorResult>;
        }> = [];
        const activateContributionsOnDemand = vi.fn(async (demands: readonly Readonly<{
            pluginId: string;
            family: string;
            localId: string;
        }>[]) => {
            activationOrder.push(`activate:${demands.map((demand) => demand.pluginId).join(',')}`);
            bindings.push({
                pluginId: 'matching.policy',
                occurrenceId: '7',
                contribution: {
                    id: 'rewrite',
                    origins: ['https://api.example.test'],
                    methods: ['GET'],
                    priority: 10,
                },
                invoke: async (request) => {
                    activationOrder.push('handler');
                    return {
                        decision: 'continue',
                        request: Object.freeze({
                            ...request,
                            headers: Object.freeze({ ...request.headers, 'x-demanded': 'yes' }),
                        }),
                    };
                },
            });
            return Object.freeze([]);
        });
        const adapter = vi.fn(async (request: TestFetchRequest) => {
            activationOrder.push('adapter');
            return createResponse(request.headers?.['x-demanded']);
        });
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: Object.freeze([
                    {
                        pluginId: 'matching.policy',
                        contribution: {
                            id: 'rewrite',
                            origins: ['https://api.example.test'],
                            methods: ['GET'],
                            priority: 10,
                        },
                    },
                    {
                        pluginId: 'other.policy',
                        contribution: {
                            id: 'other',
                            origins: ['https://other.example.test'],
                            methods: ['GET'],
                            priority: 0,
                        },
                    },
                ]),
                activateContributionsOnDemand,
                readBindings: () => Object.freeze([...bindings]),
            },
        } as Parameters<typeof createPluginHttpService>[0] & Readonly<Record<string, unknown>>);

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'GET',
            headers: {},
        })).resolves.toMatchObject({ body: new TextEncoder().encode('yes') });

        expect(activateContributionsOnDemand).toHaveBeenCalledWith([{
            pluginId: 'matching.policy',
            family: 'requestInterceptors',
            localId: 'rewrite',
        }]);
        expect(activationOrder).toEqual([
            'activate:matching.policy',
            'handler',
            'adapter',
        ]);
    });

    it('fails closed when exact qualified demand does not publish its declared binding', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: Object.freeze([{
                    pluginId: 'missing.policy',
                    contribution: { id: 'required', origins: ['https://api.example.test'] },
                }]),
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => Object.freeze([]),
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not borrow a same-local-id binding from another plugin', async () => {
        const borrowed = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request,
        }));
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'shared',
            origins: ['https://api.example.test'],
        };
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [{ pluginId: 'owner.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{ pluginId: 'borrower.policy', contribution, invoke: borrowed }],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(borrowed).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects duplicate current bindings instead of applying interceptor effects twice', async () => {
        const invoke = vi.fn(async (request: PluginInterceptedRequest): Promise<PluginInterceptorResult> => ({
            decision: 'continue',
            request,
        }));
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'once',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const binding = { ...declaration, invoke };
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [binding, binding],
            },
        });

        await expect(service({ url: 'https://api.example.test/data' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(invoke).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects a body supplied by a request-policy interceptor', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'body',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (request): Promise<PluginInterceptorResult> => {
                        return {
                            decision: 'continue',
                            request: { ...request, body: new Uint8Array([9, 2, 3]) },
                        } as unknown as PluginInterceptorResult;
                    },
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'POST',
            body: new Uint8Array([1, 2, 3]),
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('rejects an interceptor result that declares even an undefined body field', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'body-shape',
            origins: ['https://api.example.test'],
        };
        const declaration = { pluginId: 'owner.policy', contribution };
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [declaration],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    ...declaration,
                    invoke: async (request) => ({
                        decision: 'continue',
                        request: { ...request, body: undefined },
                    }) as PluginInterceptorResult,
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/data',
            method: 'POST',
            body: new Uint8Array([1, 2, 3]),
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('reports unavailable host transport without describing it as a permission denial', async () => {
        const service = createPluginHttpService({
        });

        const failure = await service({ url: 'https://example.test/blocked' }).then(
            () => undefined,
            (error: unknown) => error,
        );

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            code: 'plugin_fetch_adapter_unavailable',
        });
    });

    it('applies request-policy interceptors in deterministic lower-order order and composes patches', async () => {
        const order: string[] = [];
        const controller = new AbortController();
        const adapter = vi.fn(async (request) => {
            order.push('adapter');
            expect(request.signal).toBe(controller.signal);
            expect(request.headers).toEqual({
                'x-a': '1',
                'x-b': '1',
                'x-z': '1',
            });
            return createResponse('ok');
        });
        const service = createPluginHttpService({
            adapter,
            interceptors: [
                {
                    pluginId: 'z.plugin',
                    contribution: {
                        id: 'z-last',
                        priority: 20,
                        origins: ['https://example.test'],
                    },
                    registration: {
                        id: 'z-last',
                        handle: async () => {
                            order.push('z');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-z': '1' } } },
                            };
                        },
                    },
                },
                {
                    pluginId: 'b.plugin',
                    contribution: {
                        id: 'b-first',
                        priority: 10,
                        origins: ['https://example.test'],
                    },
                    registration: {
                        id: 'b-first',
                        handle: async () => {
                            order.push('b');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-b': '1' } } },
                            };
                        },
                    },
                },
                {
                    pluginId: 'a.plugin',
                    contribution: {
                        id: 'a-first',
                        priority: 10,
                        origins: ['https://example.test'],
                    },
                    registration: {
                        id: 'a-first',
                        handle: async () => {
                            order.push('a');
                            return {
                                kind: 'allow',
                                request: { headers: { set: { 'x-a': '1' } } },
                            };
                        },
                    },
                },
            ],
        });

        await expect(service({
            url: 'https://example.test/allowed',
            signal: controller.signal,
        })).resolves.toMatchObject({ status: 200 });

        expect(order).toEqual([
            'a',
            'b',
            'z',
            'adapter',
        ]);
    });

    it('rejects pre-aborted requests without invoking interceptors or adapter', async () => {
        const controller = new AbortController();
        controller.abort();
        const adapter = vi.fn(async () => createResponse('unused'));
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'never', origins: ['https://example.test'] },
                registration: { id: 'never', handle: interceptor },
            }],
        });

        await expect(service({
            url: 'https://example.test/aborted',
            signal: controller.signal,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(interceptor).not.toHaveBeenCalled();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not admit a late interceptor result after an in-flight request is aborted', async () => {
        const controller = new AbortController();
        let releaseInterceptor: (() => void) | undefined;
        let markInterceptorStarted: (() => void) | undefined;
        const interceptorStarted = new Promise<void>((resolve) => {
            markInterceptorStarted = resolve;
        });
        const interceptorRelease = new Promise<void>((resolve) => {
            releaseInterceptor = resolve;
        });
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'waiting',
            origins: ['https://example.test'],
        };
        const invoke = vi.fn(async (
            request: PluginInterceptedRequest,
            signal: AbortSignal | undefined,
        ): Promise<PluginInterceptorResult> => {
            expect(signal).toBe(controller.signal);
            markInterceptorStarted?.();
            await interceptorRelease;
            return { decision: 'continue', request };
        });
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [{ pluginId: 'acme.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{ pluginId: 'acme.policy', contribution, invoke }],
            },
        });

        const pending = service({
            url: 'https://example.test/waiting',
            signal: controller.signal,
        });
        await interceptorStarted;
        controller.abort();

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(adapter).not.toHaveBeenCalled();
        releaseInterceptor?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(adapter).not.toHaveBeenCalled();
    });

    it('lets trusted interceptors rewrite ordinary requests beyond their selection origins and methods', async () => {
        const adapter = vi.fn(async () => createResponse('rewritten'));
        const service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'rewrite', origins: ['https://api.example.test'], methods: ['GET'] },
                registration: {
                    id: 'rewrite',
                    handle: async () => ({
                        kind: 'allow',
                        request: { url: 'https://destination.example.test/status', method: 'POST' },
                    }),
                },
            }],
        });

        await expect(service({ url: 'https://api.example.test/status' })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://destination.example.test/status', method: 'POST' }));
    });

    it('admits the rewritten destination through its matching request policies before adapter execution', async () => {
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const rewriteContribution: PluginRequestInterceptorContributionV1 = {
            id: 'rewrite',
            priority: 10,
            origins: ['https://source.example.test', 'https://destination.example.test'],
        };
        const destinationPolicyContribution: PluginRequestInterceptorContributionV1 = {
            id: 'destination-policy',
            priority: 20,
            origins: ['https://destination.example.test'],
        };
        const destinationPolicy = vi.fn(async () => ({
            decision: 'deny' as const,
            code: 'destination_blocked',
        }));
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [
                    { pluginId: 'rewrite.policy', contribution: rewriteContribution },
                    { pluginId: 'destination.policy', contribution: destinationPolicyContribution },
                ],
                activateContributionsOnDemand: async () => {},
                readBindings: () => [
                    {
                        pluginId: 'rewrite.policy',
                        contribution: rewriteContribution,
                        invoke: async (request) => ({
                            decision: 'continue',
                            request: {
                                ...request,
                                url: 'https://destination.example.test/status',
                            },
                        }),
                    },
                    {
                        pluginId: 'destination.policy',
                        contribution: destinationPolicyContribution,
                        invoke: destinationPolicy,
                    },
                ],
            },
        });

        await expect(service({ url: 'https://source.example.test/status' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_denied',
        });
        expect(destinationPolicy).toHaveBeenCalledOnce();
        expect(adapter).not.toHaveBeenCalled();
    });

    it('aborts the host adapter when request timeout elapses', async () => {
        const adapter = vi.fn(async (request) => {
            await new Promise<void>((resolve, reject) => {
                request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {
                    name: 'AbortError',
                })), { once: true });
                setTimeout(resolve, 250);
            });
            return createResponse('late');
        });
        const service = createPluginHttpService({
            adapter,
        });

        await expect(service({
            url: 'https://example.test/slow',
            timeoutMs: 5,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(adapter).toHaveBeenCalledTimes(1);
    });

    it('rejects on timeout even when the host adapter ignores abort signals', async () => {
        const adapter = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return createResponse('late');
        });
        const service = createPluginHttpService({
            adapter,
        });

        await expect(service({
            url: 'https://example.test/slow',
            timeoutMs: 5,
        })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('does not duplicate interceptor effects when the terminal adapter retries', async () => {
        const interceptor = vi.fn(async () => ({ kind: 'allow' as const }));
        const adapter = vi.fn(async () => {
            if (adapter.mock.calls.length === 1) {
                throw Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
            }
            return createResponse('ok');
        });
        const service = createPluginHttpService({
            adapter,
            retry: { maxAttempts: 2 },
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'once', origins: ['https://api.example.test'] },
                registration: { id: 'once', handle: interceptor },
            }],
        });

        await expect(service({ url: 'https://api.example.test/data' }))
            .resolves.toMatchObject({ body: new TextEncoder().encode('ok') });
        expect(adapter).toHaveBeenCalledTimes(2);
        expect(interceptor).toHaveBeenCalledTimes(1);
    });

    it('lets trusted interceptors inspect, replace and remove credential headers', async () => {
        const adapter = vi.fn(async (_request: TestFetchRequest) => createResponse('ok'));
        const interceptor = vi.fn(async ({ effectiveRequest }: LegacyPolicyInput) => {
            expect(effectiveRequest.headers).toMatchObject({ authorization: 'Bearer original', cookie: 'session=original', 'x-user-id': 'user-1' });
            return { kind: 'allow' as const, request: { headers: { set: { authorization: 'Bearer replacement' }, remove: ['cookie'] } } };
        });
        const service = createPluginHttpService({ adapter, interceptors: [{
            pluginId: 'acme.policy', contribution: { id: 'credentials', origins: ['https://api.example.test'] },
            registration: { id: 'credentials', handle: interceptor },
        }] });
        await expect(service({ url: 'https://api.example.test/status', headers: {
            authorization: 'Bearer original', cookie: 'session=original', 'x-user-id': 'user-1',
        } })).resolves.toMatchObject({ status: 200 });
        expect(adapter.mock.calls[0]?.[0].headers).toMatchObject({ authorization: 'Bearer replacement', 'x-user-id': 'user-1' });
        expect(adapter.mock.calls[0]?.[0].headers).not.toHaveProperty('cookie');
    });

    it('allows a matching trusted interceptor to inspect and rewrite caller headers', async () => {
        const seen: TestFetchRequest[] = [];
        const adapter = vi.fn(async (request) => createResponse(request.headers?.['x-tenant-label'] ?? 'missing'));
        const service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'tenant-policy', origins: ['https://api.example.test'] },
                registration: {
                    id: 'tenant-policy',
                    handle: async ({ effectiveRequest }) => {
                        seen.push(effectiveRequest);
                        return {
                            kind: 'allow',
                            request: {
                                headers: {
                                    set: {
                                        'x-tenant-label': 'tenant-rewritten-by-policy',
                                    },
                                },
                            },
                        };
                    },
                },
            }],
        });

        await expect(service({
            url: 'https://api.example.test/status',
            headers: {
                authorization: 'Bearer host-owned',
                'x-forwarded-for': '203.0.113.10',
                'x-tenant-label': 'tenant-caller-value',
            },
        })).resolves.toMatchObject({
            body: new TextEncoder().encode('tenant-rewritten-by-policy'),
        });

        expect(seen).toEqual([expect.objectContaining({
            headers: {
                authorization: 'Bearer host-owned',
                'x-forwarded-for': '203.0.113.10',
                'x-tenant-label': 'tenant-caller-value',
            },
        })]);
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
            headers: {
                authorization: 'Bearer host-owned',
                'x-forwarded-for': '203.0.113.10',
                'x-tenant-label': 'tenant-rewritten-by-policy',
            },
        }));
    });

    it('withholds opaque request bodies from request-policy handlers without changing terminal bytes', async () => {
        const seenBodies: unknown[] = [];
        const service = createPluginHttpService({
            adapter: async (request) => createResponse(request.body),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'body-policy', origins: ['https://api.example.test'] },
                registration: {
                    id: 'body-policy',
                    handle: async ({ originalRequest, effectiveRequest }) => {
                        seenBodies.push(originalRequest.body, effectiveRequest.body);
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await expect(service({
            url: 'https://api.example.test/token',
            headers: { 'content-type': 'application/json' },
            body: '{"access_token":"secret","visible":true}',
        })).resolves.toMatchObject({
            body: new TextEncoder().encode('{"access_token":"secret","visible":true}'),
        });

        await expect(service({
            url: 'https://api.example.test/token',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'client_secret=secret&visible=yes',
        })).resolves.toMatchObject({
            body: new TextEncoder().encode('client_secret=secret&visible=yes'),
        });

        expect(seenBodies).toEqual([undefined, undefined, undefined, undefined]);
    });

    it('maps deny and thrown request-policy handlers to distinct host failures', async () => {
        const denied = createPluginHttpService({
            adapter: async () => createResponse('unused'),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'deny', origins: ['https://api.example.test'] },
                registration: {
                    id: 'deny',
                    handle: async () => ({ kind: 'deny', code: 'policy_blocked' }),
                },
            }],
        });

        await expect(denied({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_denied',
        });

        const failed = createPluginHttpService({
            adapter: async () => createResponse('unused'),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'throw', origins: ['https://api.example.test'] },
                registration: {
                    id: 'throw',
                    handle: async () => {
                        throw new Error('handler exploded');
                    },
                },
            }],
        });

        await expect(failed({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        await expect(failed({ url: 'https://api.example.test/status' })).rejects.not.toThrow('handler exploded');
    });

    it('allows ordinary method rewrites outside the interceptor selection declaration', async () => {
        const adapter = vi.fn(async () => createResponse('rewritten'));
        const service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'get-only', origins: ['https://api.example.test'], methods: ['GET'] },
                registration: {
                    id: 'get-only',
                    handle: async () => ({ kind: 'allow', request: { method: 'POST' } }),
                },
            }],
        });

        await expect(service({ url: 'https://api.example.test/data', method: 'GET' })).resolves.toMatchObject({ status: 200 });
        expect(adapter).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST' }));
    });

    it('classifies malformed request-policy results as interceptor failures', async () => {
        const malformed = createPluginHttpService({
            adapter: async () => createResponse('unused'),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'malformed', origins: ['https://api.example.test'] },
                registration: {
                    id: 'malformed',
                    handle: async () => ({ kind: 'deny' }) as unknown as never,
                },
            }],
        });

        await expect(malformed({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
    });

    it('rejects a continued public request that omits its required method', async () => {
        const contribution: PluginRequestInterceptorContributionV1 = {
            id: 'missing-method',
            origins: ['https://api.example.test'],
        };
        const adapter = vi.fn(async () => createResponse('unsafe'));
        const service = createPluginHttpService({
            adapter,
            interceptorRegistry: {
                declarations: [{ pluginId: 'acme.policy', contribution }],
                activateContributionsOnDemand: async () => Object.freeze([]),
                readBindings: () => [{
                    pluginId: 'acme.policy',
                    contribution,
                    invoke: async (request) => ({
                        decision: 'continue',
                        request: {
                            url: request.url,
                            headers: request.headers,
                        },
                    }) as unknown as PluginInterceptorResult,
                }],
            },
        });

        await expect(service({
            url: 'https://api.example.test/status',
            method: 'GET',
        })).rejects.toMatchObject({ code: 'plugin_fetch_interceptor_failed' });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies invalid allow request patches as interceptor failures', async () => {
        const invalidPatch = createPluginHttpService({
            adapter: async () => createResponse('unused'),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'invalid-patch', origins: ['https://api.example.test'] },
                registration: {
                    id: 'invalid-patch',
                    handle: async () => ({
                        kind: 'allow',
                        request: {
                            headers: {
                                set: { authorization: 42 },
                            },
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(invalidPatch({ url: 'https://api.example.test/status' })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
    });

    it('classifies request body patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const bodyPatch = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'body-patch', origins: ['https://api.example.test'] },
                registration: {
                    id: 'body-patch',
                    handle: async () => ({
                        kind: 'allow',
                        request: {
                            body: 'mutated-body',
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(bodyPatch({
            url: 'https://api.example.test/status',
            body: 'original-body',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('classifies response patches as invalid V1 policy results', async () => {
        const adapter = vi.fn(async () => createResponse('unused'));
        const responsePatch = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'response-patch', origins: ['https://api.example.test'] },
                registration: {
                    id: 'response-patch',
                    handle: async () => ({
                        kind: 'allow',
                        response: {
                            headers: {
                                set: { 'x-plugin': 'mutated' },
                            },
                        },
                    }) as unknown as never,
                },
            }],
        });

        await expect(responsePatch({
            url: 'https://api.example.test/status',
        })).rejects.toMatchObject({
            code: 'plugin_fetch_interceptor_failed',
        });
        expect(adapter).not.toHaveBeenCalled();
    });

    it('does not derive operation ids from raw request URLs or query strings', async () => {
        const operationIds: string[] = [];
        const service = createPluginHttpService({
            adapter: async () => createResponse('ok'),
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'operation-policy', origins: ['https://api.example.test'] },
                registration: {
                    id: 'operation-policy',
                    handle: async ({ operation }) => {
                        operationIds.push(operation.id);
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await service({ url: 'https://api.example.test/status?token=secret&visible=yes' });

        expect(operationIds).toHaveLength(1);
        expect(operationIds[0]).not.toContain('token=secret');
        expect(operationIds[0]).not.toContain('?');
        expect(operationIds[0]).toMatch(/^plugin-fetch:/);
    });

    it('skips the active interceptor during nested ctx.fetch recursion', async () => {
        const calls: string[] = [];
        let service: ReturnType<typeof createPluginHttpService>;
        const adapter = vi.fn(async (request) => {
            calls.push(`adapter:${request.url}`);
            return createResponse(request.url);
        });
        service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'self', origins: ['https://api.example.test'] },
                registration: {
                    id: 'self',
                    handle: async ({ effectiveRequest }) => {
                        calls.push(`interceptor:${effectiveRequest.url}`);
                        if (effectiveRequest.url.endsWith('/outer')) {
                            await service({ url: 'https://api.example.test/nested' });
                        }
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        await expect(service({ url: 'https://api.example.test/outer' })).resolves.toMatchObject({
            status: 200,
        });

        expect(calls).toEqual([
            'interceptor:https://api.example.test/outer',
            'adapter:https://api.example.test/nested',
            'adapter:https://api.example.test/outer',
        ]);
    });

    it('keeps recursion protection scoped to the current logical request', async () => {
        const seen: string[] = [];
        let releaseFirst: () => void = () => undefined;
        let resolveFirstStarted: (() => void) | null = null;
        const firstStarted = new Promise<void>((resolve) => {
            resolveFirstStarted = resolve;
        });

        const adapter = vi.fn(async (request) => createResponse(request.url));
        const service = createPluginHttpService({
            adapter,
            interceptors: [{
                pluginId: 'acme.policy',
                contribution: { id: 'self', origins: ['https://api.example.test'] },
                registration: {
                    id: 'self',
                    handle: async ({ effectiveRequest }) => {
                        seen.push(effectiveRequest.url);
                        if (effectiveRequest.url.endsWith('/one')) {
                            resolveFirstStarted?.();
                            await new Promise<void>((resolveRelease) => {
                                releaseFirst = resolveRelease;
                            });
                        }
                        return { kind: 'allow' };
                    },
                },
            }],
        });

        const first = service({ url: 'https://api.example.test/one' });
        await firstStarted;

        try {
            await expect(service({ url: 'https://api.example.test/two' }))
                .resolves
                .toMatchObject({ body: new TextEncoder().encode('https://api.example.test/two') });
            expect(seen).toEqual([
                'https://api.example.test/one',
                'https://api.example.test/two',
            ]);
        } finally {
            releaseFirst();
        }
        await expect(first)
            .resolves.toMatchObject({ body: new TextEncoder().encode('https://api.example.test/one') });
    });

});
