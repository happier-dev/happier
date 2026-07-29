import {
    PLUGIN_UI_HOST_API_SEMVER_V1,
    PluginUiHostApiWireEnvelopeV1Schema,
    type PluginUiHostApiDomainMethodV1,
    type PluginUiHostApiWireEnvelopeV1,
    type PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui';

import { PluginError } from '../errors.js';
import type { PluginErrorData } from '../errors.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import type { JsonValue, PluginReference } from '../identity.js';
import type { Disposable } from '../lifecycle.js';
import type {
    PluginUiHostApi,
    PluginUiHostApiVersion,
    PluginUiResource,
    PluginUiSurfaceContext,
} from './hostApi.js';

export interface PluginUiHostApiClientTransport {
    send(message: PluginUiHostApiWireEnvelopeV1): void | Promise<void>;
    subscribe(listener: (message: unknown) => void): Disposable;
}

export interface CreatePluginUiHostApiClientFromTransportOptions {
    readonly identity: PluginUiHostApiWireIdentityV1;
    readonly transport: PluginUiHostApiClientTransport;
    readonly apiRange?: string;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly createRequestId?: () => string;
    readonly createSubscriptionId?: () => string;
}

export class PluginUiHostApiClientError extends PluginError {
    constructor(
        code: string,
        message?: string,
        retryable = false,
        data: Pick<PluginErrorData, 'details' | 'remediation' | 'diagnostics'> = {},
    ) {
        super({
            code,
            ...(message === undefined ? {} : { message }),
            retryable,
            ...(data.details === undefined ? {} : { details: data.details }),
            ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
            ...(data.diagnostics === undefined ? {} : { diagnostics: data.diagnostics }),
        });
        this.name = 'PluginUiHostApiClientError';
    }
}

type PendingRequest = Readonly<{
    method: PluginUiHostApiDomainMethodV1;
    resolve(value: JsonValue | undefined): void;
    reject(error: PluginUiHostApiClientError): void;
    timeout: ReturnType<typeof setTimeout>;
    abortCleanup?: () => void;
}>;
type SubscriptionRecord = Readonly<{
    method: 'watchContext' | 'watchResource';
    listener(value: JsonValue): void;
}>;

let generatedId = 0;
function defaultId(prefix: string): string {
    generatedId += 1;
    return `${prefix}-${Date.now()}-${generatedId}`;
}
function sameIdentity(expected: PluginUiHostApiWireIdentityV1, actual: PluginUiHostApiWireIdentityV1): boolean {
    return expected.pluginId === actual.pluginId && expected.pluginVersion === actual.pluginVersion
        && expected.viewId === actual.viewId && expected.generation === actual.generation
        && expected.sessionId === actual.sessionId;
}
function asJsonReference(reference: PluginReference): JsonValue {
    return typeof reference === 'string' ? reference : { pluginId: reference.pluginId, localId: reference.localId };
}
function diagnosticToJson(data: PluginDiagnosticData): JsonValue {
    return {
        code: data.code,
        severity: data.severity,
        ...(data.message === undefined ? {} : { message: data.message }),
        ...(data.details === undefined ? {} : { details: data.details }),
        ...(data.remediation === undefined ? {} : { remediation: data.remediation }),
    };
}
function isJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
    return value !== undefined && value !== null && !Array.isArray(value) && typeof value === 'object';
}
function requireRecord(value: JsonValue | undefined, label: string): Readonly<Record<string, JsonValue>> {
    if (!isJsonRecord(value)) throw new PluginUiHostApiClientError('invalid_payload', `${label} must be an object.`);
    return value;
}
function requireExactKeys(record: Readonly<Record<string, JsonValue>>, keys: readonly string[], label: string): void {
    const allowed = new Set(keys);
    if (Object.keys(record).some((key) => !allowed.has(key))) {
        throw new PluginUiHostApiClientError('invalid_payload', `Host returned unknown ${label} fields.`);
    }
}
function readEnum<const TValue extends string>(value: JsonValue | undefined, values: readonly TValue[], label: string): TValue {
    if (typeof value === 'string') {
        const matched = values.find((candidate) => candidate === value);
        if (matched !== undefined) return matched;
    }
    throw new PluginUiHostApiClientError('invalid_payload', `Host returned an invalid ${label}.`);
}
function readSurface(value: JsonValue): PluginUiSurfaceContext {
    const record = requireRecord(value, 'surface context');
    const allowedKeys = new Set(['placement', 'platform', 'locale', 'direction', 'colorScheme', 'contrast', 'textScale', 'reducedMotion', 'screenReaderEnabled', 'safeAreaInsets', 'session', 'project', 'browser']);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new PluginUiHostApiClientError('invalid_payload', 'Host returned unknown surface context fields.');
    const insets = requireRecord(record.safeAreaInsets, 'safeAreaInsets');
    if (Object.keys(insets).some((key) => !['top', 'right', 'bottom', 'left'].includes(key))) throw new PluginUiHostApiClientError('invalid_payload', 'Host returned unknown safe-area fields.');
    const placements: readonly PluginUiSurfaceContext['placement'][] = [
        'session.details', 'session.preview', 'session.tool', 'session.side', 'session.rightSidebarTab',
        'workspace.details', 'workspace.main', 'project.details', 'project.main', 'project.rightSidebarTab',
        'app.settingsPage', 'app.sidePanel', 'app.bottomPanel', 'app.rightSidebarTab', 'browser.panel', 'services.panel',
    ];
    const placement = readEnum(record.placement, placements, 'placement');
    const platform = readEnum(record.platform, ['web', 'ios', 'android', 'desktop'] as const, 'platform');
    const direction = readEnum(record.direction, ['ltr', 'rtl'] as const, 'direction');
    const colorScheme = readEnum(record.colorScheme, ['light', 'dark'] as const, 'color scheme');
    const contrast = readEnum(record.contrast, ['normal', 'high'] as const, 'contrast');
    if (typeof record.locale !== 'string' || record.locale.trim() === ''
        || typeof record.textScale !== 'number' || !Number.isFinite(record.textScale) || record.textScale <= 0
        || typeof record.reducedMotion !== 'boolean'
        || typeof record.screenReaderEnabled !== 'boolean'
        || !['top', 'right', 'bottom', 'left'].every((key) => typeof insets[key] === 'number' && Number.isFinite(insets[key]) && Number(insets[key]) >= 0)) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned an invalid surface context.');
    }
    function optionalString(source: Readonly<Record<string, JsonValue>>, key: string): string | undefined {
        const entry = source[key];
        if (entry === undefined) return undefined;
        if (typeof entry !== 'string' || entry.trim() === '') throw new PluginUiHostApiClientError('invalid_payload', `Surface ${key} must be a non-empty string.`);
        return entry;
    }
    function optionalObject(key: 'session' | 'project' | 'browser', keys: readonly string[]): Readonly<Record<string, JsonValue>> | undefined {
        const entry = record[key];
        if (entry === undefined) return undefined;
        const parsed = requireRecord(entry, key);
        if (Object.keys(parsed).some((field) => !keys.includes(field))) throw new PluginUiHostApiClientError('invalid_payload', `Host returned unknown ${key} fields.`);
        return parsed;
    }
    const sessionRecord = optionalObject('session', ['id', 'agentId', 'state']);
    const projectRecord = optionalObject('project', ['id', 'machineId']);
    const browserRecord = optionalObject('browser', ['targetId', 'origin']);
    const session = sessionRecord === undefined ? undefined : {
        id: optionalString(sessionRecord, 'id') ?? (() => { throw new PluginUiHostApiClientError('invalid_payload', 'Surface session.id is required.'); })(),
        ...(optionalString(sessionRecord, 'agentId') === undefined ? {} : { agentId: optionalString(sessionRecord, 'agentId') }),
        ...(optionalString(sessionRecord, 'state') === undefined ? {} : { state: optionalString(sessionRecord, 'state') }),
    };
    const project = projectRecord === undefined ? undefined : {
        id: optionalString(projectRecord, 'id') ?? (() => { throw new PluginUiHostApiClientError('invalid_payload', 'Surface project.id is required.'); })(),
        machineId: optionalString(projectRecord, 'machineId') ?? (() => { throw new PluginUiHostApiClientError('invalid_payload', 'Surface project.machineId is required.'); })(),
    };
    const browser = browserRecord === undefined ? undefined : {
        targetId: optionalString(browserRecord, 'targetId') ?? (() => { throw new PluginUiHostApiClientError('invalid_payload', 'Surface browser.targetId is required.'); })(),
        ...(optionalString(browserRecord, 'origin') === undefined ? {} : { origin: optionalString(browserRecord, 'origin') }),
    };
    return {
        placement,
        platform,
        locale: record.locale,
        direction,
        colorScheme,
        contrast,
        textScale: record.textScale,
        reducedMotion: record.reducedMotion,
        screenReaderEnabled: record.screenReaderEnabled,
        safeAreaInsets: { top: Number(insets.top), right: Number(insets.right), bottom: Number(insets.bottom), left: Number(insets.left) },
        ...(session === undefined ? {} : { session }),
        ...(project === undefined ? {} : { project }),
        ...(browser === undefined ? {} : { browser }),
    };
}
function decodeBase64(value: string): Uint8Array {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned malformed resource bytes.');
    }
    try {
        if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(value, 'base64'));
        const decoded = globalThis.atob(value);
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
        throw new PluginUiHostApiClientError('invalid_payload', 'Host returned malformed resource bytes.');
    }
}

export async function createPluginUiHostApiClientFromTransport(
    options: CreatePluginUiHostApiClientFromTransportOptions,
): Promise<PluginUiHostApi> {
    const createRequestId = options.createRequestId ?? (() => defaultId('plugin-ui-request'));
    const createSubscriptionId = options.createSubscriptionId ?? (() => defaultId('plugin-ui-subscription'));
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pending = new Map<string, PendingRequest>();
    const subscriptions = new Map<string, SubscriptionRecord>();
    const issuedInjectedRequestIds = options.createRequestId === undefined ? undefined : new Set<string>();
    const issuedInjectedSubscriptionIds = options.createSubscriptionId === undefined ? undefined : new Set<string>();
    let online = true;
    let terminalError: PluginUiHostApiClientError | undefined;
    let negotiated: { version: PluginUiHostApiVersion; surface: PluginUiSurfaceContext } | undefined;
    let negotiationTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveNegotiation!: () => void;
    let rejectNegotiation!: (error: PluginUiHostApiClientError) => void;
    const negotiation = new Promise<void>((resolve, reject) => { resolveNegotiation = resolve; rejectNegotiation = reject; });

    function unavailable(code = 'ui_host_unavailable', message = 'Plugin UI host API is unavailable.'): PluginUiHostApiClientError {
        return new PluginUiHostApiClientError(code, message, true);
    }
    function nextRequestId(): string {
        const requestId = createRequestId();
        if (requestId.trim() === '') throw new PluginUiHostApiClientError('invalid_request_id', 'The host API request id must not be empty.');
        if (issuedInjectedRequestIds?.has(requestId)) throw new PluginUiHostApiClientError('duplicate_request_id', 'The host API request id was already issued.');
        issuedInjectedRequestIds?.add(requestId);
        return requestId;
    }
    function nextSubscriptionId(): string {
        const subscriptionId = createSubscriptionId();
        if (subscriptionId.trim() === '') throw new PluginUiHostApiClientError('invalid_subscription_id', 'The host API subscription id must not be empty.');
        if (issuedInjectedSubscriptionIds?.has(subscriptionId)) throw new PluginUiHostApiClientError('duplicate_subscription_id', 'The host API subscription id was already issued.');
        issuedInjectedSubscriptionIds?.add(subscriptionId);
        return subscriptionId;
    }
    function settle(id: string, action: (request: PendingRequest) => void): void {
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        clearTimeout(request.timeout);
        request.abortCleanup?.();
        action(request);
    }
    let transportSubscription: Disposable | undefined;
    let transportDisposed = false;
    function disposeTransport(): void {
        if (transportDisposed || transportSubscription === undefined) return;
        transportDisposed = true;
        void transportSubscription.dispose();
    }
    function terminate(error: PluginUiHostApiClientError): void {
        if (!online) return;
        online = false;
        terminalError = error;
        if (negotiationTimeout) clearTimeout(negotiationTimeout);
        rejectNegotiation(error);
        for (const id of [...pending.keys()]) settle(id, (request) => request.reject(error));
        subscriptions.clear();
        disposeTransport();
    }
    function disconnect(reason: string): void {
        terminate(unavailable(reason));
    }
    transportSubscription = options.transport.subscribe((raw) => {
        const parsed = PluginUiHostApiWireEnvelopeV1Schema.safeParse(raw);
        if (!parsed.success || !sameIdentity(options.identity, parsed.data.identity)) return;
        const message = parsed.data;
        if (message.kind === 'negotiated') {
            if (negotiated) {
                disconnect('invalid_negotiation');
                return;
            }
            if (!/^1(?:\.|$)/u.test(message.apiVersion)) {
                disconnect('incompatible_api_version');
                return;
            }
            if (new Set(message.methods).size !== message.methods.length) {
                disconnect('invalid_negotiation');
                return;
            }
            try {
                if (negotiationTimeout) clearTimeout(negotiationTimeout);
                negotiated = {
                    version: { apiVersion: message.apiVersion, wireVersion: message.wireVersion, methods: message.methods },
                    surface: readSurface(message.surface),
                };
                resolveNegotiation();
            } catch (error) {
                terminate(error instanceof PluginUiHostApiClientError ? error : unavailable());
            }
            return;
        }
        if (message.kind === 'disconnected') { disconnect(message.reason); return; }
        if (message.kind === 'result') settle(message.requestId, (request) => {
            if (request.method === message.method) request.resolve(message.result);
            else request.reject(new PluginUiHostApiClientError('invalid_response_method'));
        });
        if (message.kind === 'error') settle(message.requestId, (request) => {
            if (request.method !== message.method) {
                request.reject(new PluginUiHostApiClientError('invalid_response_method'));
                return;
            }
            request.reject(new PluginUiHostApiClientError(
                message.error.code,
                message.error.message,
                message.error.retryable,
                {
                    ...(message.error.details === undefined ? {} : { details: message.error.details }),
                    ...(message.error.remediation === undefined ? {} : { remediation: message.error.remediation }),
                    ...(message.error.diagnostics === undefined ? {} : { diagnostics: message.error.diagnostics }),
                },
            ));
        });
        if (message.kind === 'subscription') subscriptions.get(message.subscriptionId)?.listener(message.event);
    });
    if (!online) disposeTransport();

    negotiationTimeout = setTimeout(() => disconnect('negotiation_timeout'), timeoutMs);
    if (options.signal?.aborted) disconnect('aborted');
    else options.signal?.addEventListener('abort', () => disconnect('aborted'), { once: true });
    await Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'negotiate', identity: options.identity, apiRange: options.apiRange ?? `^${PLUGIN_UI_HOST_API_SEMVER_V1}`, requiredMethods: [] })).catch(() => disconnect('transport_unavailable'));
    await negotiation;
    if (terminalError) throw terminalError;
    if (!negotiated) throw unavailable('negotiation_failed');

    function request(method: PluginUiHostApiDomainMethodV1, payload?: JsonValue, signal?: AbortSignal): Promise<JsonValue | undefined> {
        if (!online) return Promise.reject(unavailable());
        if (!negotiated?.version.methods.includes(method)) return Promise.reject(new PluginUiHostApiClientError('unsupported_method', `Host method ${method} is unavailable.`));
        if (signal?.aborted) return Promise.reject(new PluginUiHostApiClientError('aborted'));
        let requestId: string;
        try { requestId = nextRequestId(); } catch (error) { return Promise.reject(error); }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                settle(requestId, (entry) => entry.reject(new PluginUiHostApiClientError('timeout')));
                void Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'cancel', identity: options.identity, requestId })).catch(() => disconnect('transport_unavailable'));
            }, timeoutMs);
            const abort = () => {
                void Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'cancel', identity: options.identity, requestId })).catch(() => disconnect('transport_unavailable'));
                settle(requestId, (entry) => entry.reject(new PluginUiHostApiClientError('aborted')));
            };
            signal?.addEventListener('abort', abort, { once: true });
            pending.set(requestId, { method, resolve, reject, timeout, ...(signal ? { abortCleanup: () => signal.removeEventListener('abort', abort) } : {}) });
            Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'request', identity: options.identity, requestId, method, ...(payload === undefined ? {} : { payload }) })).catch(() => disconnect('transport_unavailable'));
        });
    }
    function subscribe(method: 'watchContext' | 'watchResource', payload: JsonValue | undefined, listener: (value: JsonValue) => void): Disposable {
        if (!online) throw unavailable();
        if (!negotiated?.version.methods.includes(method)) throw new PluginUiHostApiClientError('unsupported_method', `Host method ${method} is unavailable.`);
        const subscriptionId = nextSubscriptionId();
        const requestId = nextRequestId();
        subscriptions.set(subscriptionId, { method, listener });
        void Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'subscribe', identity: options.identity, requestId, subscriptionId, method, ...(payload === undefined ? {} : { payload }) })).catch(() => disconnect('transport_unavailable'));
        let disposed = false;
        return { dispose: () => {
            if (disposed) return;
            disposed = true;
            subscriptions.delete(subscriptionId);
            if (!online) return;
            let requestId: string;
            try { requestId = nextRequestId(); } catch { return; }
            void Promise.resolve(options.transport.send({ wireVersion: 1, kind: 'unsubscribe', identity: options.identity, requestId, subscriptionId })).catch(() => disconnect('transport_unavailable'));
        } };
    }

    const initial = negotiated;
    return {
        version: () => initial.version,
        context: async (requestOptions) => {
            if (!online) throw unavailable();
            if (!initial.version.methods.includes('context')) throw new PluginUiHostApiClientError('unsupported_method', 'Host method context is unavailable.');
            if (requestOptions?.signal?.aborted) throw new PluginUiHostApiClientError('aborted');
            return initial.surface;
        },
        watchContext: (listener) => subscribe('watchContext', undefined, (value) => listener(readSurface(value))),
        executeAction: async (action, input, requestOptions) => (await request('executeAction', { action: asJsonReference(action), input }, requestOptions?.signal)) ?? null,
        readResource: async (resource, requestOptions): Promise<PluginUiResource> => {
            const result = requireRecord(await request('readResource', { resource: asJsonReference(resource) }, requestOptions?.signal), 'resource result');
            requireExactKeys(result, ['contentType', 'digest', 'bytesBase64'], 'resource result');
            if (typeof result.contentType !== 'string' || result.contentType.trim() === '' || typeof result.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(result.digest) || typeof result.bytesBase64 !== 'string') throw new PluginUiHostApiClientError('invalid_payload');
            return { contentType: result.contentType, digest: result.digest, bytes: decodeBase64(result.bytesBase64) };
        },
        watchResource: (resource, listener) => subscribe('watchResource', { resource: asJsonReference(resource) }, (value) => {
            const event = requireRecord(value, 'resource event');
            requireExactKeys(event, ['digest'], 'resource event');
            if (typeof event.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(event.digest)) throw new PluginUiHostApiClientError('invalid_payload');
            listener({ digest: event.digest });
        }),
        openSurface: async (view, input, requestOptions) => { await request('openSurface', { view: asJsonReference(view), ...(input === undefined ? {} : { input }) }, requestOptions?.signal); },
        diagnostic: (data) => { void request('diagnostic', diagnosticToJson(data)).catch(() => undefined); },
        readClipboard: async (requestOptions) => {
            const result = requireRecord(await request('readClipboard', undefined, requestOptions?.signal), 'clipboard result');
            if (typeof result.value !== 'string') throw new PluginUiHostApiClientError('invalid_payload');
            return result.value;
        },
        writeClipboard: async (value, requestOptions) => { await request('writeClipboard', { value }, requestOptions?.signal); },
        openExternalLink: async (url, requestOptions) => { await request('openExternalLink', { url }, requestOptions?.signal); },
    };
}
