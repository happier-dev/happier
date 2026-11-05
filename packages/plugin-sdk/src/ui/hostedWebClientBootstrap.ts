import { PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1, PluginHostedWebAccountDataBridgeOperationV1Schema, PluginHostedWebAccountDataBridgeResponseV1Schema } from '@happier-dev/protocol/plugins/data/hostedWebAccountDataBridgeV1';
import { PLUGIN_UI_HOST_API_WIRE_VERSION_V1, PluginHostedWebBridgeBootstrapEnvelopeV1Schema, PluginHostedWebBridgeHostMessageEnvelopeV1Schema, PluginUiHostApiWireEnvelopeV1Schema, pluginUiHostApiWireIdentitiesEqual, readPluginHostedWebBridgeFrameOriginV1 } from '@happier-dev/protocol/plugins/ui/client';
import { PluginHostedWebBridgeBootstrapConfigV1Schema, PluginHostedWebBridgeEnvelopeV1Schema, PluginHostedWebBridgeResponseEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';
import type { PluginHostedWebAccountDataBridgeChangeV1, PluginHostedWebAccountDataBridgeOperationV1, PluginHostedWebAccountDataBridgeResponseV1, PluginHostedWebBridgeBootstrapPayloadV1, PluginHostedWebBridgeBootstrapConfigV1, PluginHostedWebBridgeEnvelopeV1, PluginUiHostApiWireEnvelopeV1, PluginUiHostApiWireIdentityV1 } from '@happier-dev/protocol/plugins/ui/client';

import { createPluginUiHostApiClientFromTransport, PluginUiHostApiClientError } from './clientTransport.js';
import { applyPluginUiThemeCssVariables, type PluginUiThemeVariableTarget } from './themeCssVariables.js';
import { createHostedWebNegotiation } from './hostedWebNegotiation.js';
import { projectPluginUiRenderContextForHostApiVersionV1 } from '@happier-dev/protocol/plugins/ui/client';
import {
    PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY,
    readPluginUiHostApiClientBootstrap,
    type PluginUiHostApiClientBootstrap,
} from './clientBootstrap.js';

type HostedWebMessageEvent = Readonly<{
    data?: unknown;
    origin?: string;
    source?: unknown;
    ports?: readonly HostedWebMessagePort[];
}>;

type HostedWebMessagePort = {
    onmessage: ((event: Readonly<{ data?: unknown }>) => void) | null;
    postMessage(message: unknown): void;
    start(): void;
    close(): void;
};

type HostedWebMessageChannel = Readonly<{
    port1: HostedWebMessagePort;
    port2: HostedWebMessagePort;
}>;

export interface HostedWebPluginUiClientRealm {
    readonly location?: Readonly<{ href?: string }>;
    readonly parent?: Readonly<{
        postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]): void;
    }>;
    readonly MessageChannel?: new () => HostedWebMessageChannel;
    readonly ReactNativeWebView?: Readonly<{
        postMessage(message: string): void;
    }>;
    readonly document?: Readonly<{
        documentElement?: PluginUiThemeVariableTarget & Readonly<{ getBoundingClientRect(): Readonly<{ height: number }> }>;
        body?: Readonly<{ scrollHeight: number }> | null;
        addEventListener(type: 'click', listener: (event: unknown) => void, options?: unknown): void;
        removeEventListener(type: 'click', listener: (event: unknown) => void, options?: unknown): void;
    }>;
    readonly ResizeObserver?: new (callback: () => void) => Readonly<{
        observe(target: unknown): void;
        disconnect(): void;
    }>;
    addEventListener(type: 'message', listener: (event: unknown) => void): void;
    removeEventListener(type: 'message', listener: (event: unknown) => void): void;
}

export type AwaitHostedWebPluginUiHostApiClientBootstrapOptions = Readonly<{
    signal?: AbortSignal;
}>;

type InstallHostedWebPluginUiHostApiClientBootstrapOptions = Readonly<{
    /** Host-owned plain HTML needs presentation without an authored SDK import. */
    callerPresentation?: boolean;
}>;

type HostedWebBootstrapConfig = Readonly<PluginHostedWebBridgeBootstrapConfigV1>;

type HostedWebBootstrapState = 'preBootstrap' | 'readySent' | 'bootstrapped' | 'disconnected';

type HostedWebBootstrapController = Readonly<{
    awaitReady(options?: AwaitHostedWebPluginUiHostApiClientBootstrapOptions): Promise<PluginUiHostApiClientBootstrap>;
}>;

// Shared by independently bundled SDK copies in this browsing realm. V1's
// private contract is awaitReady(options?) -> the accepted client bootstrap.
const HOSTED_WEB_GUEST_CONTROLLER_KEY = Symbol.for('happier.pluginUi.hostedWebGuestController.v1');

function readHostedWebBootstrapController(realm: HostedWebPluginUiClientRealm): HostedWebBootstrapController | undefined {
    const value: unknown = Reflect.get(realm, HOSTED_WEB_GUEST_CONTROLLER_KEY);
    if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'awaitReady') !== 'function') return undefined;
    return value as HostedWebBootstrapController;
}

/**
 * Private guest-side Data transport. It is intentionally not exported from a
 * package entry point: the hosted bootstrap owns its identity, readiness,
 * cancellation, currentness, and disconnection.
 */
export type HostedWebAccountDataTransport = Readonly<{
    request(
        operation: PluginHostedWebAccountDataBridgeOperationV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<PluginHostedWebAccountDataBridgeResponseV1>;
    subscribe(listener: (change: PluginHostedWebAccountDataBridgeChangeV1) => void): Readonly<{
        dispose(): void;
    }>;
    subscribeDisconnect(listener: () => void): Readonly<{
        dispose(): void;
    }>;
}>;

type PendingAccountDataRequest = Readonly<{
    resolve(value: PluginHostedWebAccountDataBridgeResponseV1): void;
    reject(error: PluginUiHostApiClientError): void;
}>;

// The accepted bootstrap carries its owner's live private Data lookup, rather
// than relying on module identity. Absence means non-hosted, not Data denial.
const HOSTED_WEB_GUEST_ACCOUNT_DATA_KEY = Symbol.for('happier.pluginUi.hostedWebGuestAccountData.v1');
type HostedWebBootstrapWithAccountData = PluginUiHostApiClientBootstrap & Readonly<{
    [HOSTED_WEB_GUEST_ACCOUNT_DATA_KEY]?: () => HostedWebAccountDataTransport | undefined;
}>;

/**
 * Internal carrier for `createPluginUiRenderContext`; it is not part of the
 * author-facing `@happier-dev/plugin-sdk/ui/client` export surface.
 */
export function readHostedWebAccountDataTransport(
    bootstrap: PluginUiHostApiClientBootstrap,
): HostedWebAccountDataTransport | undefined {
    return (bootstrap as HostedWebBootstrapWithAccountData)[HOSTED_WEB_GUEST_ACCOUNT_DATA_KEY]?.();
}

/**
 * Distinguishes a hosted bootstrap that explicitly has no mounted Data bridge
 * from a non-hosted bootstrap, which must remain available for host injection.
 */
export function isHostedWebAccountDataCapabilityKnown(
    bootstrap: PluginUiHostApiClientBootstrap,
): boolean {
    return Object.hasOwn(bootstrap, HOSTED_WEB_GUEST_ACCOUNT_DATA_KEY);
}

function readRequiredQueryValue(url: URL, key: string): string | null {
    const value = url.searchParams.get(key)?.trim();
    return value ? value : null;
}

function readHostedWebBootstrapConfig(realm: HostedWebPluginUiClientRealm): HostedWebBootstrapConfig | null {
    const inlineConfig: unknown = Reflect.get(realm, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__');
    if (inlineConfig !== undefined) {
        const parsed = PluginHostedWebBridgeBootstrapConfigV1Schema.safeParse(inlineConfig);
        return parsed.success ? parsed.data : null;
    }
    const href = realm.location?.href;
    if (typeof href !== 'string' || href.trim() === '') return null;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    const frameOrigin = readPluginHostedWebBridgeFrameOriginV1(url);
    const instanceId = readRequiredQueryValue(url, 'happierInstanceId');
    const nonce = readRequiredQueryValue(url, 'happierBridgeNonce');
    const hostOrigin = readRequiredQueryValue(url, 'happierHostOrigin');
    if (!frameOrigin || !instanceId || !nonce || !hostOrigin) return null;
    const parsed = PluginHostedWebBridgeBootstrapConfigV1Schema.safeParse({
        identity: Object.freeze({ instanceId, mountNonce: nonce }),
        frameOrigin,
        hostOrigin,
    });
    return parsed.success ? parsed.data : null;
}

function readMessageData(raw: unknown): unknown {
    const event = raw && typeof raw === 'object' ? raw as HostedWebMessageEvent : {};
    if (typeof event.data !== 'string') return event.data;
    try {
        return JSON.parse(event.data) as unknown;
    } catch {
        return undefined;
    }
}

function addressesThisSurface(
    config: HostedWebBootstrapConfig,
    envelope: Readonly<{
        identity: PluginUiHostApiWireIdentityV1;
    }>,
): boolean {
    return pluginUiHostApiWireIdentitiesEqual(config.identity, envelope.identity);
}

function asBootstrap(
    payload: PluginHostedWebBridgeBootstrapPayloadV1,
    transport: PluginUiHostApiClientBootstrap['transport'],
    readAccountDataTransport: () => HostedWebAccountDataTransport | undefined,
): PluginUiHostApiClientBootstrap {
    return Object.freeze(Object.defineProperty({
        identity: payload.identity,
        ...(payload.authorPlugin === undefined ? {} : { authorPlugin: payload.authorPlugin }),
        transport,
        ...(payload.launchInput === undefined ? {} : { launchInput: payload.launchInput }),
        ...(payload.subPath === undefined ? {} : { subPath: payload.subPath }),
        ...(payload.composerRef === undefined ? {} : { composerRef: payload.composerRef }),
    }, HOSTED_WEB_GUEST_ACCOUNT_DATA_KEY, { value: readAccountDataTransport }));
}

function readAccountDataCapability(payload: unknown): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const capabilities = Reflect.get(payload, 'capabilities');
    return capabilities !== null
        && typeof capabilities === 'object'
        && !Array.isArray(capabilities)
        && Reflect.get(capabilities, 'accountData') === true;
}

function awaitWithAbort(
    readiness: Promise<PluginUiHostApiClientBootstrap>,
    signal: AbortSignal | undefined,
): Promise<PluginUiHostApiClientBootstrap> {
    if (!signal) return readiness;
    if (signal.aborted) {
        return Promise.reject(new PluginUiHostApiClientError(
            'ui_host_bootstrap_aborted',
            'The hosted plugin UI bootstrap was cancelled before the host became ready.',
        ));
    }
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new PluginUiHostApiClientError(
            'ui_host_bootstrap_aborted',
            'The hosted plugin UI bootstrap was cancelled before the host became ready.',
        ));
        signal.addEventListener('abort', onAbort, { once: true });
        readiness.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

function createHostedWebBootstrapController(
    realm: HostedWebPluginUiClientRealm,
    config: HostedWebBootstrapConfig,
    options: InstallHostedWebPluginUiHostApiClientBootstrapOptions,
): HostedWebBootstrapController | null {
    const nativePostMessage = realm.ReactNativeWebView?.postMessage;
    const parent = realm.parent;
    if (typeof nativePostMessage !== 'function' && (!parent || Object.is(parent, realm))) return null;

    let state: HostedWebBootstrapState = 'preBootstrap';
    let identity: PluginUiHostApiWireIdentityV1 | null = null;
    let bootstrap: PluginUiHostApiClientBootstrap | null = null;
    let terminalError: PluginUiHostApiClientError | null = null;
    let sequence = 0;
    let readySequence: number | null = null;
    let readyAcknowledged = false;
    let accountDataCapability = false;
    let createAccountDataTransport: (() => HostedWebAccountDataTransport) | null = null;
    let documentPort: HostedWebMessagePort | null = null;
    const listeners = new Set<(message: unknown) => void>();
    const negotiations = createHostedWebNegotiation();
    const contextSubscriptions = new Map<string, string>();
    const accountDataListeners = new Set<(
        change: PluginHostedWebAccountDataBridgeChangeV1,
    ) => void>();
    const accountDataDisconnectListeners = new Set<() => void>();
    const accountDataPending = new Map<number, PendingAccountDataRequest>();
    let resolveReadiness!: (value: PluginUiHostApiClientBootstrap) => void;
    let rejectReadiness!: (error: PluginUiHostApiClientError) => void;
    const readiness = new Promise<PluginUiHostApiClientBootstrap>((resolve, reject) => {
        resolveReadiness = resolve;
        rejectReadiness = reject;
    });

    const removeListener = () => realm.removeEventListener('message', handleMessage);
    let removeExternalLinkCarrier: () => void = () => {};
    const presentationLifetime = new AbortController();
    let presentationObserver: InstanceType<NonNullable<HostedWebPluginUiClientRealm['ResizeObserver']>> | null = null;
    const removeCallerPresentation = () => {
        presentationLifetime.abort();
        presentationObserver?.disconnect();
        presentationObserver = null;
    };
    const sendEnvelope = (envelope: PluginHostedWebBridgeEnvelopeV1): void => {
        if (typeof nativePostMessage === 'function') {
            Reflect.apply(nativePostMessage, realm.ReactNativeWebView, [JSON.stringify(envelope)]);
            return;
        }
        if (documentPort) {
            documentPort.postMessage(envelope);
            return;
        }
        parent?.postMessage(envelope, config.hostOrigin);
    };
    const deliver = (wire: PluginUiHostApiWireEnvelopeV1, requestSequence?: number): void => {
        const expected = identity;
        if (!expected || !pluginUiHostApiWireIdentitiesEqual(expected, wire.identity)) return;
        if (wire.kind === 'negotiated') {
            if (!negotiations.deliver(wire, requestSequence)) {
                fail('invalid_negotiation', 'The hosted plugin UI received an uncorrelated negotiation reply.');
            }
            return;
        }
        if (wire.kind === 'error' && wire.method === 'watchContext') {
            for (const [subscriptionId, requestId] of contextSubscriptions) {
                if (requestId === wire.requestId) contextSubscriptions.delete(subscriptionId);
            }
        }
        for (const listener of listeners) {
            const version = negotiations.versionFor(listener);
            if (wire.kind === 'result' && wire.method === 'context') {
                const result = projectPluginUiRenderContextForHostApiVersionV1(wire.result, version);
                listener(result === wire.result ? wire : { ...wire, result });
            } else if (wire.kind === 'subscription' && contextSubscriptions.has(wire.subscriptionId)) {
                const event = projectPluginUiRenderContextForHostApiVersionV1(wire.event, version) ?? wire.event;
                listener(event === wire.event ? wire : { ...wire, event });
            } else {
                listener(wire);
            }
        }
    };
    const disconnectAccountData = (error: PluginUiHostApiClientError): void => {
        for (const pending of [...accountDataPending.values()]) pending.reject(error);
        accountDataPending.clear();
        for (const listener of accountDataDisconnectListeners) listener();
        accountDataListeners.clear();
        accountDataDisconnectListeners.clear();
    };
    const fail = (code: string, message: string): void => {
        if (state === 'disconnected') return;
        const currentIdentity = identity;
        state = 'disconnected';
        contextSubscriptions.clear();
        removeListener();
        removeExternalLinkCarrier();
        removeCallerPresentation();
        documentPort?.close();
        documentPort = null;
        const error = new PluginUiHostApiClientError(code, message);
        terminalError = error;
        if (currentIdentity) {
            deliver({
                wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
                kind: 'disconnected',
                identity: currentIdentity,
                reason: code,
            });
        }
        rejectReadiness(error);
        disconnectAccountData(error);
    };
    const disconnectFromHost = (reason: string): void => {
        if (state === 'disconnected') return;
        state = 'disconnected';
        contextSubscriptions.clear();
        removeListener();
        removeExternalLinkCarrier();
        removeCallerPresentation();
        documentPort?.close();
        documentPort = null;
        const error = new PluginUiHostApiClientError(
            'ui_host_bridge_disconnected',
            `The hosted plugin UI bridge was disconnected: ${reason}`,
        );
        terminalError = error;
        rejectReadiness(error);
        disconnectAccountData(error);
    };
    let accountDataTransport: HostedWebAccountDataTransport | undefined;
    const installAccountDataTransport = (): void => {
        const currentBootstrap = bootstrap;
        const createTransport = createAccountDataTransport;
        if (state !== 'bootstrapped'
            || !readyAcknowledged
            || !accountDataCapability
            || !currentBootstrap
            || !createTransport
            || accountDataTransport) return;
        accountDataTransport = createTransport();
    };
    const acceptBootstrap = (payload: PluginHostedWebBridgeBootstrapPayloadV1): void => {
        if (state !== 'readySent') {
            fail('ui_host_bootstrap_invalid', 'The hosted plugin UI received a duplicate bootstrap.');
            return;
        }
        if (!pluginUiHostApiWireIdentitiesEqual(payload.identity, config.identity)) {
            fail('ui_host_bootstrap_invalid', 'The hosted plugin UI bootstrap did not match its bound surface.');
            return;
        }
        identity = payload.identity;
        const transport: PluginUiHostApiClientBootstrap['transport'] = Object.freeze({
            send(message: PluginUiHostApiWireEnvelopeV1) {
                if (state !== 'bootstrapped' || !identity) {
                    throw new PluginUiHostApiClientError(
                        'ui_host_bootstrap_invalid',
                        'The hosted plugin UI transport is no longer current.',
                    );
                }
                const wire = PluginUiHostApiWireEnvelopeV1Schema.parse(message);
                if (!pluginUiHostApiWireIdentitiesEqual(identity, wire.identity)) {
                    throw new TypeError('Plugin UI host wire identity does not match the hosted surface.');
                }
                // Subscribe then negotiate is the client transport contract.
                // Equal ranges share work; different SDK generations never
                // receive each other's closed negotiation reply.
                if (wire.kind === 'negotiate' && !negotiations.request(wire)) return;
                if (wire.kind === 'subscribe' && wire.method === 'watchContext') {
                    contextSubscriptions.set(wire.subscriptionId, wire.requestId);
                } else if (wire.kind === 'disposeHostResource') {
                    contextSubscriptions.delete(wire.subscriptionId);
                }
                sequence += 1;
                if (wire.kind === 'negotiate') negotiations.bindSequence(wire.apiRange, sequence);
                sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                    version: 1,
                    identity: config.identity,
                    sequence,
                    kind: 'hostApi',
                    payload: wire,
                }));
            },
            subscribe(listener: (message: unknown) => void) {
                listeners.add(listener);
                negotiations.add(listener);
                let disposed = false;
                return Object.freeze({
                    dispose() {
                        if (disposed) return;
                        disposed = true;
                        listeners.delete(listener);
                        negotiations.remove(listener);
                    },
                });
            },
        });
        createAccountDataTransport = () => Object.freeze({
            request(operation, options) {
                if (state !== 'bootstrapped' || !identity) {
                    return Promise.reject(new PluginUiHostApiClientError(
                        'ui_host_bridge_disconnected',
                        'The hosted Account Data transport is no longer current.',
                    ));
                }
                const parsed = PluginHostedWebAccountDataBridgeOperationV1Schema.safeParse(operation);
                if (!parsed.success) {
                    return Promise.reject(new PluginUiHostApiClientError(
                        'ui_host_bridge_invalid_request',
                        'The hosted Account Data request was invalid.',
                    ));
                }
                if (options?.signal?.aborted) {
                    return Promise.reject(new PluginUiHostApiClientError(
                        'ui_host_bridge_aborted',
                        'The hosted Account Data request was cancelled before dispatch.',
                    ));
                }
                sequence += 1;
                const requestSequence = sequence;
                return new Promise<PluginHostedWebAccountDataBridgeResponseV1>((resolve, reject) => {
                    let abortCleanup: (() => void) | undefined;
                    const pending: PendingAccountDataRequest = {
                        resolve(value) {
                            if (accountDataPending.get(requestSequence) !== pending) return;
                            accountDataPending.delete(requestSequence);
                            abortCleanup?.();
                            resolve(value);
                        },
                        reject(error) {
                            if (accountDataPending.get(requestSequence) !== pending) return;
                            accountDataPending.delete(requestSequence);
                            abortCleanup?.();
                            reject(error);
                        },
                    };
                    const sendCancellation = () => {
                        if (state !== 'bootstrapped') return;
                        sequence += 1;
                        sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                            version: 1,
                            identity: config.identity,
                            sequence,
                            kind: PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1,
                            payload: { kind: 'cancel', requestSequence },
                        }));
                    };
                    const onAbort = () => {
                        if (accountDataPending.get(requestSequence) !== pending) return;
                        accountDataPending.delete(requestSequence);
                        abortCleanup?.();
                        sendCancellation();
                        reject(new PluginUiHostApiClientError(
                            'ui_host_bridge_aborted',
                            'The hosted Account Data request was cancelled.',
                        ));
                    };
                    if (options?.signal) {
                        options.signal.addEventListener('abort', onAbort, { once: true });
                        abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
                    }
                    accountDataPending.set(requestSequence, pending);
                    sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                        version: 1,
                        identity: config.identity,
                        sequence: requestSequence,
                        kind: PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1,
                        payload: { kind: 'request', operation: parsed.data },
                    }));
                });
            },
            subscribe(listener) {
                if (state !== 'bootstrapped') return Object.freeze({ dispose() {} });
                accountDataListeners.add(listener);
                let disposed = false;
                return Object.freeze({
                    dispose() {
                        if (disposed) return;
                        disposed = true;
                        accountDataListeners.delete(listener);
                    },
                });
            },
            subscribeDisconnect(listener) {
                if (state === 'disconnected') {
                    listener();
                    return Object.freeze({ dispose() {} });
                }
                accountDataDisconnectListeners.add(listener);
                let disposed = false;
                return Object.freeze({
                    dispose() {
                        if (disposed) return;
                        disposed = true;
                        accountDataDisconnectListeners.delete(listener);
                    },
                });
            },
        });
        const acceptedBootstrap = asBootstrap(payload, transport, () => accountDataTransport);
        bootstrap = acceptedBootstrap;
        state = 'bootstrapped';
        const installed = Reflect.defineProperty(realm, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: acceptedBootstrap,
        });
        if (!installed) {
            fail('ui_host_bootstrap_invalid', 'The hosted plugin UI bootstrap could not be installed.');
            return;
        }
        installAccountDataTransport();
        resolveReadiness(acceptedBootstrap);
        if (options.callerPresentation) {
            const root = realm.document?.documentElement;
            if (root) {
                let lastHeight: number | undefined;
                const reportHeight = () => {
                    if (state !== 'bootstrapped') return;
                    // scrollHeight on the root is viewport-floored and would
                    // prevent a previously tall auto-height frame shrinking.
                    const height = Math.ceil(Math.max(root.getBoundingClientRect().height, realm.document?.body?.scrollHeight ?? 0));
                    if (!Number.isFinite(height) || height <= 0 || height === lastHeight) return;
                    lastHeight = height;
                    sequence += 1;
                    sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({ version: 1, identity: config.identity, sequence, kind: 'heightChanged', payload: { height } }));
                };
                if (realm.ResizeObserver) {
                    presentationObserver = new realm.ResizeObserver(reportHeight);
                    presentationObserver.observe(root);
                }
                reportHeight();
                void (async () => {
                    const api = await createPluginUiHostApiClientFromTransport({
                        identity: acceptedBootstrap.identity,
                        transport: acceptedBootstrap.transport,
                        signal: presentationLifetime.signal,
                    });
                    const applyContext = (context: Awaited<ReturnType<typeof api.context>>) => {
                        if (state !== 'bootstrapped') return;
                        applyPluginUiThemeCssVariables(context.theme, root);
                        // Unstyled HTML inherits the theme's text colour, so it reads on either paper;
                        // the guest's own styles still win.
                        root.style.setProperty('color', context.theme.colors.text);
                        reportHeight();
                    };
                    applyContext(await api.context());
                    await api.watchContext(applyContext, { signal: presentationLifetime.signal });
                })().catch(() => {
                    if (state !== 'bootstrapped') return;
                    sequence += 1;
                    sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({ version: 1, identity: config.identity, sequence, kind: 'error', payload: { code: 'caller_presentation_failed' } }));
                    fail('caller_presentation_failed', 'The caller HTML presentation could not be established.');
                });
            }
        }
    };
    const handleHostData = (data: unknown): void => {
        const hostMessage = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse(data);
        if (hostMessage.success && hostMessage.data.kind === 'bootstrap') {
            if (!addressesThisSurface(config, hostMessage.data)) return;
            if (hostMessage.data.origin !== config.frameOrigin) {
                fail('ui_host_bootstrap_invalid', 'The hosted plugin UI bootstrap origin did not match the frame origin.');
                return;
            }
            acceptBootstrap(hostMessage.data.payload);
            return;
        }
        const response = PluginHostedWebBridgeResponseEnvelopeV1Schema.safeParse(data);
        if (response.success
            && addressesThisSurface(config, response.data)
            && readySequence !== null
            && response.data.requestSequence === readySequence) {
            readyAcknowledged = true;
            accountDataCapability = response.data.kind === 'ack'
                && readAccountDataCapability(response.data.payload);
            installAccountDataTransport();
            return;
        }
        if (state !== 'bootstrapped') return;
        if (hostMessage.success && hostMessage.data.kind === 'hostApi') {
            if (!addressesThisSurface(config, hostMessage.data)) return;
            deliver(hostMessage.data.payload);
            if (hostMessage.data.payload.kind === 'disconnected') {
                disconnectFromHost(hostMessage.data.payload.reason);
            }
            return;
        }
        if (hostMessage.success && hostMessage.data.kind === PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1) {
            if (!addressesThisSurface(config, hostMessage.data)) return;
            for (const listener of accountDataListeners) listener(hostMessage.data.payload);
            return;
        }
        if (!response.success || !addressesThisSurface(config, response.data)) return;
        const collectionPending = accountDataPending.get(response.data.requestSequence);
        if (collectionPending) {
            if (response.data.kind !== 'result') {
                collectionPending.reject(new PluginUiHostApiClientError(
                    'ui_host_bridge_request_failed',
                    'The host rejected the Account Data request.',
                ));
                return;
            }
            const payload = PluginHostedWebAccountDataBridgeResponseV1Schema.safeParse(response.data.payload);
            if (!payload.success) {
                collectionPending.reject(new PluginUiHostApiClientError(
                    'ui_host_bridge_invalid_response',
                    'The host returned an invalid Account Data response.',
                ));
                return;
            }
            collectionPending.resolve(payload.data);
            return;
        }
        if (response.data.kind !== 'result') {
            if (negotiations.isPending(response.data.requestSequence)) {
                fail('invalid_negotiation', 'The host rejected the plugin UI negotiation.');
            }
            return;
        }
        const wire = PluginUiHostApiWireEnvelopeV1Schema.safeParse(response.data.payload);
        if (wire.success) {
            if (!identity || !pluginUiHostApiWireIdentitiesEqual(identity, wire.data.identity)) return;
            deliver(wire.data, response.data.requestSequence);
        } else if (negotiations.isPending(response.data.requestSequence)) {
            fail('invalid_negotiation', 'The host returned an invalid plugin UI negotiation.');
        }
    };
    const handleMessage = (rawEvent: unknown): void => {
        const event = rawEvent && typeof rawEvent === 'object' ? rawEvent as HostedWebMessageEvent : {};
        if (typeof nativePostMessage !== 'function'
            && (event.source !== parent || event.origin !== config.hostOrigin)) return;
        const data = readMessageData(event);
        handleHostData(data);
    };

    realm.addEventListener('message', handleMessage);
    if (Reflect.get(realm, '__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__') === true
        && realm.document) {
        const handleClick = (rawEvent: unknown): void => {
            if (!rawEvent || typeof rawEvent !== 'object' || state === 'disconnected') return;
            if (Reflect.get(rawEvent, 'defaultPrevented') === true
                || Reflect.get(rawEvent, 'button') !== 0
                || Reflect.get(rawEvent, 'metaKey') === true
                || Reflect.get(rawEvent, 'ctrlKey') === true
                || Reflect.get(rawEvent, 'shiftKey') === true
                || Reflect.get(rawEvent, 'altKey') === true) return;
            const target = Reflect.get(rawEvent, 'target');
            const closest = target && typeof target === 'object' ? Reflect.get(target, 'closest') : null;
            const anchor = typeof closest === 'function' ? Reflect.apply(closest, target, ['a[href]']) : null;
            if (!anchor || typeof anchor !== 'object') return;
            const href = Reflect.get(anchor, 'href');
            let parsed: URL | null = null;
            if (typeof href === 'string') {
                try { parsed = new URL(href); } catch { /* Malformed anchors stay inside this document. */ }
            }
            const externalUrl = parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null;
            const trusted = Reflect.get(rawEvent, 'isTrusted') === true;
            // Native messages have no activation receipt. Preserve the existing
            // WebView gesture-validated navigation handoff instead of sending
            // a bridge request that the host must deny.
            if (trusted && externalUrl !== null && typeof nativePostMessage === 'function') return;
            const preventDefault = Reflect.get(rawEvent, 'preventDefault');
            if (typeof preventDefault === 'function') Reflect.apply(preventDefault, rawEvent, []);
            // Synthetic anchor activation must not replace the live document.
            // Only a genuine browser activation may request an external open.
            if (!trusted || externalUrl === null) return;
            sequence += 1;
            sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                version: 1,
                identity: config.identity,
                sequence,
                kind: 'openExternal',
                payload: { url: externalUrl },
            }));
        };
        realm.document.addEventListener('click', handleClick, true);
        removeExternalLinkCarrier = () => realm.document?.removeEventListener('click', handleClick, true);
    }
    state = 'readySent';
    sequence += 1;
    readySequence = sequence;
    const readyEnvelope = PluginHostedWebBridgeEnvelopeV1Schema.parse({
        version: 1,
        identity: config.identity,
        sequence,
        kind: 'ready',
        payload: { ready: true },
    });
    if (typeof nativePostMessage !== 'function' && config.frameOrigin === 'null') {
        const MessageChannel = realm.MessageChannel;
        if (typeof MessageChannel !== 'function') {
            fail('ui_host_bootstrap_unavailable', 'This browser cannot bind hosted plugin UI traffic to its document.');
            return null;
        }
        const channel = new MessageChannel();
        documentPort = channel.port1;
        documentPort.onmessage = (portEvent) => handleHostData(readMessageData(portEvent));
        documentPort.start();
        removeListener();
        parent?.postMessage(readyEnvelope, config.hostOrigin, [channel.port2]);
    } else {
        sendEnvelope(readyEnvelope);
    }

    return Object.freeze({
        awaitReady(options = {}) {
            if (terminalError) return Promise.reject(terminalError);
            return awaitWithAbort(bootstrap ? Promise.resolve(bootstrap) : readiness, options.signal);
        },
    });
}

/**
 * Begins the strict guest lifecycle for one frame. The host-private client
 * bootstrap is deliberately absent until the verified post-ready envelope lands.
 */
export function installHostedWebPluginUiHostApiClientBootstrap(
    realm: HostedWebPluginUiClientRealm,
    options: InstallHostedWebPluginUiHostApiClientBootstrapOptions = {},
): boolean {
    if (readHostedWebBootstrapController(realm) || Reflect.has(realm, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY)) return false;
    const config = readHostedWebBootstrapConfig(realm);
    if (!config) return false;
    const controller = createHostedWebBootstrapController(realm, config, options);
    if (!controller) return false;
    Object.defineProperty(realm, HOSTED_WEB_GUEST_CONTROLLER_KEY, { value: controller });
    return true;
}

export function awaitHostedWebPluginUiHostApiClientBootstrap(
    realm: HostedWebPluginUiClientRealm,
    options: AwaitHostedWebPluginUiHostApiClientBootstrapOptions = {},
): Promise<PluginUiHostApiClientBootstrap> {
    if (!readHostedWebBootstrapController(realm)) installHostedWebPluginUiHostApiClientBootstrap(realm);
    const controller = readHostedWebBootstrapController(realm);
    if (controller) return controller.awaitReady(options);
    return Promise.reject(new PluginUiHostApiClientError(
        'ui_host_bootstrap_missing',
        'The hosted plugin UI was loaded outside a Happier hosted-web surface.',
    ));
}

export function awaitHostedWebPluginUiHostApiClientBootstrapFromCurrentRealm(
    options: AwaitHostedWebPluginUiHostApiClientBootstrapOptions = {},
): Promise<PluginUiHostApiClientBootstrap> {
    const realm = Reflect.get(globalThis, 'window');
    if (!realm || typeof realm !== 'object') {
        const bootstrap = readPluginUiHostApiClientBootstrap();
        return bootstrap
            ? Promise.resolve(bootstrap)
            : Promise.reject(new PluginUiHostApiClientError(
                'ui_host_bootstrap_missing',
                'The hosted plugin UI was loaded outside a Happier hosted-web surface.',
            ));
    }
    const addEventListener = Reflect.get(realm, 'addEventListener');
    const removeEventListener = Reflect.get(realm, 'removeEventListener');
    if (typeof addEventListener !== 'function' || typeof removeEventListener !== 'function') {
        const bootstrap = readPluginUiHostApiClientBootstrap();
        return bootstrap
            ? Promise.resolve(bootstrap)
            : Promise.reject(new PluginUiHostApiClientError(
                'ui_host_bootstrap_missing',
                'The hosted plugin UI was loaded outside a Happier hosted-web surface.',
            ));
    }
    return awaitHostedWebPluginUiHostApiClientBootstrap(
        realm as HostedWebPluginUiClientRealm,
        options,
    );
}
