import {
    PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1,
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PluginHostedWebBridgeBootstrapEnvelopeV1Schema,
    PluginHostedWebBridgeEnvelopeV1Schema,
    PluginHostedWebBridgeHostMessageEnvelopeV1Schema,
    PluginHostedWebBridgeResponseEnvelopeV1Schema,
    PluginHostedWebAccountDataBridgeOperationV1Schema,
    PluginHostedWebAccountDataBridgeResponseV1Schema,
    PluginUiHostApiWireEnvelopeV1Schema,
    pluginUiHostApiWireIdentitiesEqual,
    readPluginHostedWebBridgeFrameOriginV1,
    type PluginHostedWebAccountDataBridgeChangeV1,
    type PluginHostedWebAccountDataBridgeOperationV1,
    type PluginHostedWebAccountDataBridgeResponseV1,
    type PluginHostedWebBridgeBootstrapPayloadV1,
    type PluginHostedWebBridgeEnvelopeV1,
    type PluginUiHostApiWireEnvelopeV1,
    type PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui/client';

import { PluginUiHostApiClientError } from './clientTransport.js';
import {
    PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY,
    readPluginUiHostApiClientBootstrap,
    type PluginUiHostApiClientBootstrap,
} from './clientBootstrap.js';

type HostedWebMessageEvent = Readonly<{
    data?: unknown;
    origin?: string;
    source?: unknown;
}>;

export interface HostedWebPluginUiClientRealm {
    readonly location?: Readonly<{ href?: string }>;
    readonly parent?: Readonly<{
        postMessage(message: unknown, targetOrigin: string): void;
    }>;
    readonly ReactNativeWebView?: Readonly<{
        postMessage(message: string): void;
    }>;
    addEventListener(type: 'message', listener: (event: unknown) => void): void;
    removeEventListener(type: 'message', listener: (event: unknown) => void): void;
}

export type AwaitHostedWebPluginUiHostApiClientBootstrapOptions = Readonly<{
    signal?: AbortSignal;
}>;

type HostedWebBootstrapConfig = Readonly<{
    pluginId: string;
    contributionId: string;
    surfaceId: string;
    nonce: string;
    frameOrigin: string;
    hostOrigin: string;
}>;

type HostedWebBootstrapState = 'preBootstrap' | 'readySent' | 'bootstrapped' | 'disconnected';

type HostedWebBootstrapController = Readonly<{
    awaitReady(options?: AwaitHostedWebPluginUiHostApiClientBootstrapOptions): Promise<PluginUiHostApiClientBootstrap>;
}>;

const BOOTSTRAP_TIMEOUT_MS = 30_000;
const controllers = new WeakMap<object, HostedWebBootstrapController>();

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

const accountDataTransports = new WeakMap<object, HostedWebAccountDataTransport>();
const hostedWebAccountDataCapabilityKnown = new WeakSet<object>();

/**
 * Internal carrier for `createPluginUiRenderContext`; it is not part of the
 * author-facing `@happier-dev/plugin-sdk/ui/client` export surface.
 */
export function readHostedWebAccountDataTransport(
    bootstrap: PluginUiHostApiClientBootstrap,
): HostedWebAccountDataTransport | undefined {
    return accountDataTransports.get(bootstrap);
}

/**
 * Distinguishes a hosted bootstrap that explicitly has no mounted Data bridge
 * from a non-hosted bootstrap, which must remain available for host injection.
 */
export function isHostedWebAccountDataCapabilityKnown(
    bootstrap: PluginUiHostApiClientBootstrap,
): boolean {
    return hostedWebAccountDataCapabilityKnown.has(bootstrap);
}

function readRequiredQueryValue(url: URL, key: string): string | null {
    const value = url.searchParams.get(key)?.trim();
    return value ? value : null;
}

function readExactHttpOrigin(value: string): string | null {
    try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && parsed.origin === value
            && parsed.origin !== 'null'
            ? value
            : null;
    } catch {
        return null;
    }
}

function readHostedWebBootstrapConfig(realm: HostedWebPluginUiClientRealm): HostedWebBootstrapConfig | null {
    const href = realm.location?.href;
    if (typeof href !== 'string' || href.trim() === '') return null;
    let url: URL;
    try {
        url = new URL(href);
    } catch {
        return null;
    }
    const frameOrigin = readPluginHostedWebBridgeFrameOriginV1(url);
    const pluginId = readRequiredQueryValue(url, 'happierPluginId');
    const contributionId = readRequiredQueryValue(url, 'happierContributionId');
    const surfaceId = readRequiredQueryValue(url, 'happierSurfaceId');
    const nonce = readRequiredQueryValue(url, 'happierBridgeNonce');
    const hostOrigin = readExactHttpOrigin(readRequiredQueryValue(url, 'happierHostOrigin') ?? '');
    if (!frameOrigin || !pluginId || !contributionId || !surfaceId || !nonce || !hostOrigin) return null;
    return Object.freeze({
        pluginId,
        contributionId,
        surfaceId,
        nonce,
        frameOrigin,
        hostOrigin,
    });
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
        pluginId: string;
        contributionId: string;
        surfaceId: string;
        sessionId?: string;
        nonce: string;
    }>,
    expectedSessionId: string | undefined,
): boolean {
    return envelope.pluginId === config.pluginId
        && envelope.contributionId === config.contributionId
        && envelope.surfaceId === config.surfaceId
        && (expectedSessionId === undefined || envelope.sessionId === expectedSessionId)
        && envelope.nonce === config.nonce;
}

function asBootstrap(
    payload: PluginHostedWebBridgeBootstrapPayloadV1,
    transport: PluginUiHostApiClientBootstrap['transport'],
): PluginUiHostApiClientBootstrap {
    return Object.freeze({
        identity: payload.identity,
        transport,
        ...(payload.launchInput === undefined ? {} : { launchInput: payload.launchInput }),
        ...(payload.subPath === undefined ? {} : { subPath: payload.subPath }),
        ...(payload.composerRef === undefined ? {} : { composerRef: payload.composerRef }),
    });
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
): HostedWebBootstrapController | null {
    const nativePostMessage = realm.ReactNativeWebView?.postMessage;
    const parent = realm.parent;
    if (typeof nativePostMessage !== 'function' && (!parent || Object.is(parent, realm))) return null;

    let state: HostedWebBootstrapState = 'preBootstrap';
    let identity: PluginUiHostApiWireIdentityV1 | null = null;
    // The first ready is nonce-bound and intentionally sessionless. The
    // verified bootstrap becomes the canonical Session identity for every
    // subsequent bridge message.
    let boundSessionId: string | undefined;
    let bootstrap: PluginUiHostApiClientBootstrap | null = null;
    let terminalError: PluginUiHostApiClientError | null = null;
    let sequence = 0;
    let readySequence: number | null = null;
    let readyAcknowledged = false;
    let accountDataCapability = false;
    let createAccountDataTransport: (() => HostedWebAccountDataTransport) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const sentSequences = new Set<number>();
    const listeners = new Set<(message: unknown) => void>();
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
    const clearBootstrapTimeout = () => {
        if (timeout !== null) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    const sendEnvelope = (envelope: PluginHostedWebBridgeEnvelopeV1): void => {
        if (typeof nativePostMessage === 'function') {
            Reflect.apply(nativePostMessage, realm.ReactNativeWebView, [JSON.stringify(envelope)]);
            return;
        }
        parent?.postMessage(envelope, config.hostOrigin);
    };
    const deliver = (wire: PluginUiHostApiWireEnvelopeV1): void => {
        const expected = identity;
        if (!expected || !pluginUiHostApiWireIdentitiesEqual(expected, wire.identity)) return;
        for (const listener of listeners) listener(wire);
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
        clearBootstrapTimeout();
        removeListener();
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
        clearBootstrapTimeout();
        removeListener();
        const error = new PluginUiHostApiClientError(
            'ui_host_bridge_disconnected',
            `The hosted plugin UI bridge was disconnected: ${reason}`,
        );
        terminalError = error;
        rejectReadiness(error);
        disconnectAccountData(error);
    };
    const installAccountDataTransport = (): void => {
        const currentBootstrap = bootstrap;
        const createTransport = createAccountDataTransport;
        if (state !== 'bootstrapped'
            || !readyAcknowledged
            || !accountDataCapability
            || !currentBootstrap
            || !createTransport
            || accountDataTransports.has(currentBootstrap)) return;
        accountDataTransports.set(currentBootstrap, createTransport());
    };
    const acceptBootstrap = (payload: PluginHostedWebBridgeBootstrapPayloadV1): void => {
        if (state !== 'readySent') {
            fail('ui_host_bootstrap_invalid', 'The hosted plugin UI received a duplicate bootstrap.');
            return;
        }
        if (payload.identity.pluginId !== config.pluginId) {
            fail('ui_host_bootstrap_invalid', 'The hosted plugin UI bootstrap did not match its bound surface.');
            return;
        }
        identity = payload.identity;
        boundSessionId = payload.identity.sessionId;
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
                sequence += 1;
                sentSequences.add(sequence);
                sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
                    version: 1,
                    pluginId: config.pluginId,
                    contributionId: config.contributionId,
                    surfaceId: config.surfaceId,
                    ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
                    nonce: config.nonce,
                    sequence,
                    kind: 'hostApi',
                    payload: wire,
                }));
            },
            subscribe(listener: (message: unknown) => void) {
                listeners.add(listener);
                let disposed = false;
                return Object.freeze({
                    dispose() {
                        if (disposed) return;
                        disposed = true;
                        listeners.delete(listener);
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
                            pluginId: config.pluginId,
                            contributionId: config.contributionId,
                            surfaceId: config.surfaceId,
                            ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
                            nonce: config.nonce,
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
                        pluginId: config.pluginId,
                        contributionId: config.contributionId,
                        surfaceId: config.surfaceId,
                        ...(boundSessionId === undefined ? {} : { sessionId: boundSessionId }),
                        nonce: config.nonce,
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
        const acceptedBootstrap = asBootstrap(payload, transport);
        bootstrap = acceptedBootstrap;
        state = 'bootstrapped';
        clearBootstrapTimeout();
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
        hostedWebAccountDataCapabilityKnown.add(acceptedBootstrap);
        installAccountDataTransport();
        resolveReadiness(acceptedBootstrap);
    };
    const handleMessage = (rawEvent: unknown): void => {
        const event = rawEvent && typeof rawEvent === 'object' ? rawEvent as HostedWebMessageEvent : {};
        if (typeof nativePostMessage !== 'function'
            && (event.source !== parent || event.origin !== config.hostOrigin)) return;
        const data = readMessageData(event);
        const hostMessage = PluginHostedWebBridgeHostMessageEnvelopeV1Schema.safeParse(data);
        if (hostMessage.success && hostMessage.data.kind === 'bootstrap') {
            if (!addressesThisSurface(config, hostMessage.data, boundSessionId)) return;
            if (hostMessage.data.origin !== config.frameOrigin) {
                fail('ui_host_bootstrap_invalid', 'The hosted plugin UI bootstrap origin did not match the frame origin.');
                return;
            }
            acceptBootstrap(hostMessage.data.payload);
            return;
        }
        const response = PluginHostedWebBridgeResponseEnvelopeV1Schema.safeParse(data);
        if (response.success
            && addressesThisSurface(config, response.data, boundSessionId)
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
            if (!addressesThisSurface(config, hostMessage.data, boundSessionId)) return;
            deliver(hostMessage.data.payload);
            if (hostMessage.data.payload.kind === 'disconnected') {
                disconnectFromHost(hostMessage.data.payload.reason);
            }
            return;
        }
        if (hostMessage.success && hostMessage.data.kind === PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1) {
            if (!addressesThisSurface(config, hostMessage.data, boundSessionId)) return;
            for (const listener of accountDataListeners) listener(hostMessage.data.payload);
            return;
        }
        if (!response.success || !addressesThisSurface(config, response.data, boundSessionId)) return;
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
        if (!sentSequences.delete(response.data.requestSequence) || response.data.kind !== 'result') return;
        const wire = PluginUiHostApiWireEnvelopeV1Schema.safeParse(response.data.payload);
        if (wire.success) deliver(wire.data);
    };

    realm.addEventListener('message', handleMessage);
    state = 'readySent';
    sequence += 1;
    readySequence = sequence;
    sendEnvelope(PluginHostedWebBridgeEnvelopeV1Schema.parse({
        version: 1,
        pluginId: config.pluginId,
        contributionId: config.contributionId,
        surfaceId: config.surfaceId,
        nonce: config.nonce,
        sequence,
        kind: 'ready',
        payload: { ready: true },
    }));
    timeout = setTimeout(() => {
        fail('ui_host_bootstrap_timeout', 'The hosted plugin UI host did not bootstrap the ready frame in time.');
    }, BOOTSTRAP_TIMEOUT_MS);

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
): boolean {
    if (Reflect.has(realm, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY) || controllers.has(realm)) return false;
    const config = readHostedWebBootstrapConfig(realm);
    if (!config) return false;
    const controller = createHostedWebBootstrapController(realm, config);
    if (!controller) return false;
    controllers.set(realm, controller);
    return true;
}

export function awaitHostedWebPluginUiHostApiClientBootstrap(
    realm: HostedWebPluginUiClientRealm,
    options: AwaitHostedWebPluginUiHostApiClientBootstrapOptions = {},
): Promise<PluginUiHostApiClientBootstrap> {
    if (!controllers.has(realm)) installHostedWebPluginUiHostApiClientBootstrap(realm);
    const controller = controllers.get(realm);
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
