import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginUiHostApiMethodV1Schema,
    PluginUiHostApiRequestEnvelopeV1Schema,
    PluginUiResourceSubscriptionRequestV1Schema,
    PluginUiResourceUnsubscribeRequestV1Schema,
    type PluginUiHostApiErrorCodeV1,
    type PluginUiHostApiMethodV1,
    type PluginUiHostApiRequestEnvelopeV1,
    type PluginUiJsonValueV1,
    type PluginUiResourceSubscriptionEventV1,
    type PluginUiResourceSubscriptionRequestV1,
    type PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type {
    PluginUiHostApi,
    PluginUiHostMethod,
    PluginUiResource,
    PluginUiSurfaceContext,
} from '@happier-dev/plugin-sdk/ui';

import { createPluginUiHostSubscriptionRegistry } from '../hostApi/subscriptions';
import { decodeBase64 } from '@/encryption/base64';

export class PluginReactNativeHostApiError extends Error {
    readonly code: PluginUiHostApiErrorCodeV1;
    readonly diagnostics: readonly string[];

    constructor(input: Readonly<{
        code: PluginUiHostApiErrorCodeV1;
        diagnostics?: readonly string[];
    }>) {
        super(input.code);
        this.name = 'PluginReactNativeHostApiError';
        this.code = input.code;
        this.diagnostics = Object.freeze([...(input.diagnostics ?? [])]);
    }
}

export type PluginReactNativeHostApiRequestHandler = (
    request: PluginUiHostApiRequestEnvelopeV1,
) => PluginUiJsonValueV1 | Promise<PluginUiJsonValueV1>;

export type PluginReactNativeHostApiSubscription = Readonly<{
    subscriptionId: string;
    unsubscribe: () => Promise<void>;
}>;

export type PluginReactNativeHostApiV1 = Readonly<{
    version: typeof PLUGIN_UI_HOST_API_VERSION_V1;
    surface: PluginUiSurfaceContextV1;
    getSurfaceContext: () => PluginUiSurfaceContextV1;
    request: (
        method: PluginUiHostApiMethodV1,
        payload?: PluginUiJsonValueV1,
    ) => Promise<PluginUiJsonValueV1 | undefined>;
    requestSessionResource: (payload: PluginUiJsonValueV1) => Promise<PluginUiJsonValueV1 | undefined>;
    subscribeResource: (
        payload: PluginUiResourceSubscriptionRequestV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ) => Promise<PluginReactNativeHostApiSubscription>;
    dispatchAction: (payload: PluginUiJsonValueV1) => Promise<PluginUiJsonValueV1 | undefined>;
    openSurface: (payload: PluginUiJsonValueV1) => Promise<PluginUiJsonValueV1 | undefined>;
    logDiagnostic: (payload: PluginUiJsonValueV1) => Promise<void>;
    copy: (payload: PluginUiJsonValueV1) => Promise<PluginUiJsonValueV1 | undefined>;
    openExternal: (payload: PluginUiJsonValueV1) => Promise<PluginUiJsonValueV1 | undefined>;
}>;

export type PluginReactNativeHostApiAdapter = Readonly<{
    api: PluginReactNativeHostApiV1;
    publishSubscriptionEvent: (event: PluginUiResourceSubscriptionEventV1) => boolean;
    dispose: () => void;
}>;

export type PluginReactNativeSurfaceRenderContextV1 = Readonly<{
    hostApi?: PluginReactNativeHostApiV1;
    surface?: PluginUiSurfaceContextV1;
}>;

function throwHostApiError(
    code: PluginUiHostApiErrorCodeV1,
    diagnostics: readonly string[] = [],
): never {
    throw new PluginReactNativeHostApiError({ code, diagnostics });
}

function createRequestEnvelope(input: Readonly<{
    requestId: string;
    surface: PluginUiSurfaceContextV1;
    method: PluginUiHostApiMethodV1;
    payload?: PluginUiJsonValueV1;
}>): PluginUiHostApiRequestEnvelopeV1 {
    const envelope: PluginUiHostApiRequestEnvelopeV1 = {
        version: 1,
        requestId: input.requestId,
        surface: input.surface,
        method: input.method,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    const parsed = PluginUiHostApiRequestEnvelopeV1Schema.safeParse(envelope);
    if (!parsed.success) {
        throwHostApiError('invalid_payload');
    }
    return envelope;
}

export function createPluginReactNativeHostApiAdapter(params: Readonly<{
    surface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    handleRequest: PluginReactNativeHostApiRequestHandler;
    allowedMethods?: readonly PluginUiHostApiMethodV1[];
    isSurfaceCurrent?: (surface: PluginUiSurfaceContextV1) => boolean;
    createRequestId?: () => string;
}>): PluginReactNativeHostApiAdapter {
    const allowedMethods = new Set(params.allowedMethods ?? PluginUiHostApiMethodV1Schema.options);
    const listeners = new Map<string, (event: PluginUiResourceSubscriptionEventV1) => void>();
    let disposed = false;
    let sequence = 0;
    const createRequestId = params.createRequestId ?? (() => {
        sequence += 1;
        return `${params.requestIdPrefix}:${sequence}`;
    });
    const subscriptions = createPluginUiHostSubscriptionRegistry({
        deliverSubscriptionEvent: (event) => {
            listeners.get(event.subscriptionId)?.(event);
        },
    });

    function assertActive(method: PluginUiHostApiMethodV1): void {
        if (disposed || params.isSurfaceCurrent?.(params.surface) === false) {
            throwHostApiError('stale_surface');
        }
        if (!allowedMethods.has(method)) {
            throwHostApiError('denied');
        }
    }

    async function request(
        rawMethod: PluginUiHostApiMethodV1,
        payload?: PluginUiJsonValueV1,
    ): Promise<PluginUiJsonValueV1 | undefined> {
        const parsedMethod = PluginUiHostApiMethodV1Schema.safeParse(rawMethod);
        if (!parsedMethod.success) {
            throwHostApiError('unsupported_method');
        }
        const method = parsedMethod.data;
        if (method === 'getSurfaceContext') {
            assertActive(method);
            return params.surface;
        }
        assertActive(method);
        const envelope = createRequestEnvelope({
            requestId: createRequestId(),
            surface: params.surface,
            method,
            ...(payload !== undefined ? { payload } : {}),
        });

        try {
            return await params.handleRequest(envelope);
        } catch {
            throwHostApiError('internal_error', ['host_api_handler_failed']);
        }
    }

    async function retireSettledSubscription(subscriptionId: string): Promise<void> {
        const unsubscribePayload = PluginUiResourceUnsubscribeRequestV1Schema.parse({
            subscriptionId,
        });
        const envelope = createRequestEnvelope({
            requestId: createRequestId(),
            surface: params.surface,
            method: 'unsubscribeResource',
            payload: unsubscribePayload,
        });
        try {
            await params.handleRequest(envelope);
        } catch {
            // Surface retirement remains authoritative even when host cleanup fails.
        }
    }

    async function subscribeResource(
        payload: PluginUiResourceSubscriptionRequestV1,
        listener: (event: PluginUiResourceSubscriptionEventV1) => void,
    ): Promise<PluginReactNativeHostApiSubscription> {
        const parsedPayload = PluginUiResourceSubscriptionRequestV1Schema.safeParse(payload);
        if (!parsedPayload.success) {
            throwHostApiError('invalid_payload');
        }
        await request('subscribeResource', parsedPayload.data);
        if (disposed || params.isSurfaceCurrent?.(params.surface) === false) {
            await retireSettledSubscription(parsedPayload.data.subscriptionId);
            throwHostApiError('stale_surface');
        }
        listeners.set(parsedPayload.data.subscriptionId, listener);
        subscriptions.register({
            surface: params.surface,
            subscriptionId: parsedPayload.data.subscriptionId,
        });

        return Object.freeze({
            subscriptionId: parsedPayload.data.subscriptionId,
            unsubscribe: async () => {
                listeners.delete(parsedPayload.data.subscriptionId);
                subscriptions.dispose({
                    surface: params.surface,
                    subscriptionId: parsedPayload.data.subscriptionId,
                });
                const unsubscribePayload = PluginUiResourceUnsubscribeRequestV1Schema.parse({
                    subscriptionId: parsedPayload.data.subscriptionId,
                });
                await request('unsubscribeResource', unsubscribePayload);
            },
        });
    }

    const api: PluginReactNativeHostApiV1 = Object.freeze({
        version: PLUGIN_UI_HOST_API_VERSION_V1,
        surface: params.surface,
        getSurfaceContext: () => {
            assertActive('getSurfaceContext');
            return params.surface;
        },
        request,
        requestSessionResource: (payload) => request('requestSessionResource', payload),
        subscribeResource,
        dispatchAction: (payload) => request('dispatchAction', payload),
        openSurface: (payload) => request('openSurface', payload),
        logDiagnostic: async (payload) => {
            await request('logDiagnostic', payload);
        },
        copy: (payload) => request('copy', payload),
        openExternal: (payload) => request('openExternal', payload),
    });

    return Object.freeze({
        api,
        publishSubscriptionEvent: (event) => subscriptions.publish(params.surface, event),
        dispose: () => {
            const activeSubscriptionIds = [...listeners.keys()];
            disposed = true;
            listeners.clear();
            subscriptions.disposeSurface(params.surface);
            for (const subscriptionId of activeSubscriptionIds) {
                void retireSettledSubscription(subscriptionId);
            }
        },
    });
}

export function createPluginReactNativeSurfaceRenderContext(input: PluginReactNativeSurfaceRenderContextV1): PluginReactNativeSurfaceRenderContextV1 {
    return Object.freeze({
        ...(input.hostApi !== undefined ? { hostApi: input.hostApi } : {}),
        ...(input.surface !== undefined ? { surface: input.surface } : {}),
    });
}

const CANONICAL_PLUGIN_UI_HOST_METHODS = Object.freeze([
    'context',
    'watchContext',
    'executeAction',
    'readResource',
    'watchResource',
    'openSurface',
    'diagnostic',
    'readClipboard',
    'writeClipboard',
    'openExternalLink',
] satisfies readonly PluginUiHostMethod[]);

export type CanonicalPluginReactNativeHostApiAdapter = Readonly<{
    api: PluginUiHostApi;
    dispose: () => void;
}>;

function canonicalReferencePayload(reference: string | Readonly<{ pluginId: string; localId: string }>): PluginUiJsonValueV1 {
    return typeof reference === 'string'
        ? reference
        : { pluginId: reference.pluginId, localId: reference.localId };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throwHostApiError('unavailable', ['aborted']);
    }
}

function readCanonicalResource(value: PluginUiJsonValueV1 | undefined): PluginUiResource {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, PluginUiJsonValueV1>>
        : null;
    const contentType = typeof record?.contentType === 'string' ? record.contentType : '';
    const digest = typeof record?.digest === 'string' ? record.digest : '';
    const bytesBase64 = typeof record?.bytesBase64 === 'string' ? record.bytesBase64 : '';
    if (!contentType || !digest || !bytesBase64) {
        throwHostApiError('invalid_payload', ['resource_response_invalid']);
    }
    try {
        return Object.freeze({
            contentType,
            digest,
            bytes: decodeBase64(bytesBase64, 'base64'),
        });
    } catch {
        throwHostApiError('invalid_payload', ['resource_bytes_invalid']);
    }
}

/**
 * Canonical public SDK adapter for generated V2 renderers. Legacy RN bundles keep
 * the V1 adapter above as an explicit compatibility path; generated renderers never
 * receive that competing request/dispatchAction-shaped API.
 */
export function createCanonicalPluginReactNativeHostApiAdapter(params: Readonly<{
    surface: PluginUiSurfaceContext;
    legacySurface: PluginUiSurfaceContextV1;
    requestIdPrefix: string;
    handleRequest: PluginReactNativeHostApiRequestHandler;
}>): CanonicalPluginReactNativeHostApiAdapter {
    const legacy = createPluginReactNativeHostApiAdapter({
        surface: params.legacySurface,
        requestIdPrefix: params.requestIdPrefix,
        handleRequest: params.handleRequest,
    });
    let disposed = false;
    let subscriptionSequence = 0;
    let subscriptionRetirementSequence = 0;
    const disposables = new Set<() => void>();

    function assertActive(signal?: AbortSignal): void {
        if (disposed) throwHostApiError('stale_surface');
        throwIfAborted(signal);
    }

    function disposable(dispose: () => void): Readonly<{ dispose: () => void }> {
        let active = true;
        const wrapped = () => {
            if (!active) return;
            active = false;
            disposables.delete(wrapped);
            dispose();
        };
        disposables.add(wrapped);
        return Object.freeze({ dispose: wrapped });
    }

    async function retireCanonicalSubscription(subscriptionId: string): Promise<void> {
        subscriptionRetirementSequence += 1;
        const request = createRequestEnvelope({
            requestId: `${params.requestIdPrefix}:resource-retire:${subscriptionRetirementSequence}`,
            surface: params.legacySurface,
            method: 'unsubscribeResource',
            payload: { subscriptionId },
        });
        try {
            await params.handleRequest(request);
        } catch {
            // Local retirement remains final when the host cleanup boundary is unavailable.
        }
    }

    const api = Object.freeze<PluginUiHostApi>({
        version: () => Object.freeze({
            apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
            wireVersion: 1,
            methods: CANONICAL_PLUGIN_UI_HOST_METHODS,
        }),
        context: async (options) => {
            assertActive(options?.signal);
            return params.surface;
        },
        watchContext: (listener) => {
            assertActive();
            listener(params.surface);
            return disposable(() => undefined);
        },
        executeAction: async (action, input, options) => {
            assertActive(options?.signal);
            const result = await legacy.api.request('dispatchAction', {
                action: canonicalReferencePayload(action),
                input: input as PluginUiJsonValueV1,
            });
            // The host response is the canonical settlement. Once an outward
            // effect succeeds, later local retirement must not hide that known
            // result and encourage a blind retry.
            return result as ReturnType<PluginUiHostApi['executeAction']> extends Promise<infer T> ? T : never;
        },
        readResource: async (resource, options) => {
            assertActive(options?.signal);
            const result = await legacy.api.request('requestSessionResource', {
                resource: canonicalReferencePayload(resource),
            });
            assertActive(options?.signal);
            return readCanonicalResource(result);
        },
        watchResource: (resource, listener) => {
            assertActive();
            subscriptionSequence += 1;
            const subscriptionId = `${params.requestIdPrefix}:resource:${subscriptionSequence}`;
            let subscribeSettled = false;
            let retired = false;
            void legacy.api.request('subscribeResource', {
                subscriptionId,
                resource: canonicalReferencePayload(resource),
            }).then((result) => {
                subscribeSettled = true;
                if (retired || disposed) {
                    void retireCanonicalSubscription(subscriptionId);
                    return;
                }
                const record = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Readonly<Record<string, PluginUiJsonValueV1>>
                    : null;
                if (typeof record?.digest === 'string') listener({ digest: record.digest });
            }).catch(() => undefined);
            return disposable(() => {
                retired = true;
                if (subscribeSettled) {
                    void retireCanonicalSubscription(subscriptionId);
                }
            });
        },
        openSurface: async (view, input, options) => {
            assertActive(options?.signal);
            await legacy.api.request('openSurface', {
                view: canonicalReferencePayload(view),
                ...(input !== undefined ? { input: input as PluginUiJsonValueV1 } : {}),
            });
        },
        diagnostic: (data) => {
            assertActive();
            void legacy.api.request('logDiagnostic', data as PluginUiJsonValueV1).catch(() => undefined);
        },
        readClipboard: async (options) => {
            assertActive(options?.signal);
            const result = await legacy.api.request('copy', { operation: 'read' });
            assertActive(options?.signal);
            if (typeof result === 'string') return result;
            const record = result && typeof result === 'object' && !Array.isArray(result)
                ? result as Readonly<Record<string, PluginUiJsonValueV1>>
                : null;
            if (typeof record?.value === 'string') return record.value;
            throwHostApiError('invalid_payload', ['clipboard_read_response_invalid']);
        },
        writeClipboard: async (value, options) => {
            assertActive(options?.signal);
            await legacy.api.request('copy', { operation: 'write', value });
        },
        openExternalLink: async (url, options) => {
            assertActive(options?.signal);
            await legacy.api.request('openExternal', { url });
        },
    });

    return Object.freeze({
        api,
        dispose: () => {
            if (disposed) return;
            disposed = true;
            for (const dispose of [...disposables]) dispose();
            legacy.dispose();
        },
    });
}
