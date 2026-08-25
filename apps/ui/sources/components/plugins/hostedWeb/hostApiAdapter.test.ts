import type {
    ComposerSnapshotV1,
    PluginHostedWebCollectionUiQueryBridgeChangeV1,
    PluginHostedWebCollectionUiQueryBridgeOperationV1,
    PluginHostedWebCollectionUiQueryBridgeResponseV1,
    PluginHostedWebBridgeEnvelopeV1,
    PluginUiHostApiRequestEnvelopeV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    PLUGIN_UI_HOST_API_VERSION_V1,
    PluginUiHostApiWireEnvelopeV1Schema,
    PluginUiSelectActionInputResultV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createPluginSurfaceActionHostApi } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { createPluginSurfaceHostApi } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview-web',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalIdentity = {
    pluginId: 'acme.preview',
    pluginVersion: '1.2.3',
    viewId: 'preview-pane',
    generation: '7',
    sessionId: 'session-1',
} as const;

const canonicalSurface = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-web' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'light',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    translations: {},
    targetedContributions: {
        target: {
            pluginId: 'acme.preview',
            immutableGenerationId: 'target-generation-a',
        },
        points: [],
    },
} as const;

function createEnvelope(
    kind: PluginHostedWebBridgeEnvelopeV1['kind'],
    payload: PluginHostedWebBridgeEnvelopeV1['payload'],
): PluginHostedWebBridgeEnvelopeV1 {
    return {
        version: 1,
        pluginId: 'acme.preview',
        contributionId: 'preview-web',
        surfaceId: 'sessionSurface:acme.preview:preview-pane',
        sessionId: 'session-1',
        nonce: 'nonce-1',
        sequence: 7,
        kind,
        payload,
    };
}

describe('hosted web plugin host API adapter', () => {
    it('negotiates, delivers, and retires an exact Composer observation through the existing host subscription bridge', async () => {
        const postToFrame = vi.fn();
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-composer-watch',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchComposer'],
            },
            handleRequest: async (request) => {
                requests.push(request);
                return null;
            },
            postToFrame,
        });
        const snapshot: ComposerSnapshotV1 = {
            revision: 4,
            ref: { kind: 'session', sessionId: 'session-1' },
            text: 'changed',
            references: [],
            attachments: [],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: true, editable: true, submittable: true, submitting: false, running: false },
        };

        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'negotiated', methods: ['watchComposer'] },
        });

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'subscribe',
                identity: canonicalIdentity,
                requestId: 'watch-composer-request',
                subscriptionId: 'watch-composer-subscription',
                method: 'watchComposer',
                payload: { ref: snapshot.ref },
            }),
            sequence: 8,
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchComposer' },
        });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
            method: 'watchComposer',
            payload: { subscriptionId: 'watch-composer-subscription', ref: snapshot.ref },
        });

        expect(handler.publishComposerSubscriptionEvent({
            subscriptionId: 'watch-composer-subscription',
            snapshot,
        })).toBe(true);
        expect(postToFrame).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'hostToFrame',
            kind: 'hostApi',
            payload: expect.objectContaining({
                kind: 'subscription',
                identity: canonicalIdentity,
                subscriptionId: 'watch-composer-subscription',
                event: snapshot,
            }),
        }));

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'disposeHostResource',
                identity: canonicalIdentity,
                requestId: 'dispose-composer-request',
                subscriptionId: 'watch-composer-subscription',
            }),
            sequence: 9,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 9 });
        expect(requests[1]).toMatchObject({
            method: 'disposeHostResource',
            payload: { subscriptionId: 'watch-composer-subscription' },
        });
        expect(handler.publishComposerSubscriptionEvent({
            subscriptionId: 'watch-composer-subscription',
            snapshot,
        })).toBe(false);
    });

    it('negotiates and retires a Composer input lock through the same generic subscription bridge', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-composer-lock',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['acquireComposerInputLock'],
            },
            handleRequest: async (request) => {
                requests.push(request);
                return null;
            },
            postToFrame: vi.fn(),
        });

        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'negotiated', methods: ['acquireComposerInputLock'] },
        });

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'subscribe',
                identity: canonicalIdentity,
                requestId: 'lock-composer-request',
                subscriptionId: 'lock-composer-subscription',
                method: 'acquireComposerInputLock',
                payload: {
                    ref: { kind: 'session', sessionId: 'session-1' },
                    request: { reason: 'Saving attachment', mode: 'submit' },
                },
            }),
            sequence: 8,
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'acquireComposerInputLock' },
        });
        expect(requests[0]).toMatchObject({
            method: 'acquireComposerInputLock',
            payload: {
                subscriptionId: 'lock-composer-subscription',
                ref: { kind: 'session', sessionId: 'session-1' },
                request: { reason: 'Saving attachment', mode: 'submit' },
            },
        });

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'disposeHostResource',
                identity: canonicalIdentity,
                requestId: 'dispose-composer-lock-request',
                subscriptionId: 'lock-composer-subscription',
            }),
            sequence: 9,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 9 });
        expect(requests[1]).toMatchObject({
            method: 'disposeHostResource',
            payload: { subscriptionId: 'lock-composer-subscription' },
        });
    });

    it('rejects a duplicate hosted subscription id without orphaning the admitted Composer observation', async () => {
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-composer-duplicate',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchComposer'],
            },
            handleRequest: async (request) => {
                requests.push(request);
                if (
                    request.method === 'watchComposer'
                    && requests.filter((item) => item.method === 'watchComposer').length > 1
                ) {
                    return {
                        code: 'invalid_payload',
                        diagnostics: ['duplicate_subscription_id'],
                    };
                }
                return null;
            },
            postToFrame: vi.fn(),
        });

        await handler(createEnvelope('ready', { ready: true }));
        await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }));
        const subscribe = (requestId: string, sequence: number) => handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'subscribe',
                identity: canonicalIdentity,
                requestId,
                subscriptionId: 'shared-composer-subscription',
                method: 'watchComposer',
                payload: { ref: { kind: 'session', sessionId: 'session-1' } },
            }),
            sequence,
        });

        await expect(subscribe('watch-composer-first', 8)).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchComposer' },
        });
        await expect(subscribe('watch-composer-duplicate', 9)).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'error',
                method: 'watchComposer',
                error: { code: 'invalid_payload' },
            },
        });
        expect(requests.filter((request) => request.method === 'watchComposer')).toHaveLength(1);

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'disposeHostResource',
                identity: canonicalIdentity,
                requestId: 'dispose-composer-original',
                subscriptionId: 'shared-composer-subscription',
            }),
            sequence: 10,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 10 });
        expect(requests.filter((request) => request.method === 'disposeHostResource')).toHaveLength(1);
    });

    it('keeps a disposed pending id retired until late admission closes, then admits an isolated successor', async () => {
        let resolveFirstWatch: ((value: PluginUiJsonValueV1) => void) | undefined;
        const firstWatch = new Promise<PluginUiJsonValueV1>((resolve) => {
            resolveFirstWatch = resolve;
        });
        let resolveFirstDisposal: ((value: PluginUiJsonValueV1) => void) | undefined;
        const firstDisposal = new Promise<PluginUiJsonValueV1>((resolve) => {
            resolveFirstDisposal = resolve;
        });
        const requests: PluginUiHostApiRequestEnvelopeV1[] = [];
        let watchCount = 0;
        let disposalCount = 0;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-composer-pending-reuse',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchComposer'],
            },
            handleRequest: async (request) => {
                requests.push(request);
                if (request.method === 'disposeHostResource') {
                    disposalCount += 1;
                    return disposalCount === 1 ? firstDisposal : null;
                }
                if (request.method !== 'watchComposer') return null;
                watchCount += 1;
                return watchCount === 1 ? firstWatch : null;
            },
            postToFrame: vi.fn(),
        });

        await handler(createEnvelope('ready', { ready: true }));
        await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }));
        const subscribe = (requestId: string, sequence: number) => handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'subscribe',
                identity: canonicalIdentity,
                requestId,
                subscriptionId: 'reusable-composer-subscription',
                method: 'watchComposer',
                payload: { ref: { kind: 'session', sessionId: 'session-1' } },
            }),
            sequence,
        });
        const dispose = (requestId: string, sequence: number) => handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'disposeHostResource',
                identity: canonicalIdentity,
                requestId,
                subscriptionId: 'reusable-composer-subscription',
            }),
            sequence,
        });

        const establishing = subscribe('watch-composer-pending', 8);
        await vi.waitFor(() => expect(
            requests.filter((request) => request.method === 'watchComposer'),
        ).toHaveLength(1));

        await expect(subscribe('watch-composer-pending-duplicate', 9)).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        await expect(dispose('dispose-composer-pending', 10)).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 10,
        });
        await expect(subscribe('watch-composer-retired-reuse', 11)).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(requests.filter((request) => request.method === 'watchComposer')).toHaveLength(1);

        resolveFirstWatch?.(null);
        await vi.waitFor(() => expect(
            requests.filter((request) => request.method === 'disposeHostResource'),
        ).toHaveLength(1));
        await expect(subscribe('watch-composer-during-late-cleanup', 12)).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(requests.filter((request) => request.method === 'watchComposer')).toHaveLength(1);

        resolveFirstDisposal?.(null);
        await expect(establishing).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'disconnected', reason: 'stale_surface' },
        });

        await expect(subscribe('watch-composer-successor', 13)).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchComposer' },
        });
        expect(requests.filter((request) => request.method === 'watchComposer')).toHaveLength(2);
        await expect(dispose('dispose-composer-successor', 14)).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 14,
        });
        expect(requests.filter((request) => request.method === 'disposeHostResource')).toHaveLength(2);
    });

    it('retires a late-admitted Resource subscription after the frame bridge disposes', async () => {
        let resolveWatch: ((value: PluginUiJsonValueV1) => void) | undefined;
        const pendingWatch = new Promise<PluginUiJsonValueV1>((resolve) => {
            resolveWatch = resolve;
        });
        const handleRequest = vi.fn((request: PluginUiHostApiRequestEnvelopeV1) => (
            request.method === 'watchResource' ? pendingWatch : null
        ));
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest,
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchResource'],
            },
            postToFrame: vi.fn(),
        });

        await handler(createEnvelope('ready', { ready: true }));
        const establishing = handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-resource-request',
            subscriptionId: 'watch-resource-subscription',
            method: 'watchResource',
            payload: { resource: 'live-status' },
        }));
        await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
            method: 'watchResource',
            payload: expect.objectContaining({ subscriptionId: 'watch-resource-subscription' }),
        })));

        handler.dispose();
        resolveWatch?.(null);
        await expect(establishing).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'disconnected', reason: 'host_api_handler_disposed' },
        });
        await vi.waitFor(() => expect(handleRequest).toHaveBeenCalledWith(expect.objectContaining({
            method: 'disposeHostResource',
            payload: { subscriptionId: 'watch-resource-subscription' },
        })));
    });

    it('sends launch facts and the exact private Composer mount ref only in the strict post-ready bootstrap envelope', async () => {
        const postToFrame = vi.fn();
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-1' });
        const bootstrap = Object.freeze({
            frameOrigin: 'https://preview.happier.test',
            subPath: 'work/ideas.md',
            launchInput: { noteId: 'note-7' },
            composerRef,
        });
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame,
            bootstrap,
        });

        expect(postToFrame).not.toHaveBeenCalled();
        await handler(createEnvelope('ready', { ready: true }));

        expect(postToFrame).toHaveBeenCalledTimes(1);
        expect(postToFrame).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'hostToFrame',
            kind: 'bootstrap',
            origin: 'https://preview.happier.test',
            nonce: 'nonce-1',
            payload: {
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                wireVersion: 1,
                identity: canonicalIdentity,
                subPath: 'work/ideas.md',
                launchInput: { noteId: 'note-7' },
                composerRef,
            },
        }));

        await handler({ ...createEnvelope('ready', { ready: true }), sequence: 8 });
        expect(postToFrame).toHaveBeenCalledTimes(1);
    });

    it('accepts every canonical frame\'s sessionless ready and requires the stamped Session thereafter', async () => {
        const postToFrame = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame,
            bootstrap: { frameOrigin: 'https://artifacts.happier.test' },
        });
        const { sessionId: _sessionId, ...sessionlessReady } = createEnvelope('ready', { ready: true });

        await expect(handler(sessionlessReady)).resolves.toMatchObject({
            kind: 'ack',
            payload: { accepted: true, readyState: 'recorded' },
        });
        expect(postToFrame).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'bootstrap',
            payload: expect.objectContaining({ identity: canonicalIdentity }),
        }));

        await expect(handler({
            ...sessionlessReady,
            sequence: 8,
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });

        await expect(handler({
            ...sessionlessReady,
            kind: 'hostApi',
            sequence: 9,
            payload: {
                wireVersion: 1,
                kind: 'negotiate',
                identity: canonicalIdentity,
                apiRange: '^1.0.0',
            },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    it('rejects canonical host API traffic until the guest-ready bootstrap transition completes', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1',
        }))).resolves.toMatchObject({
            kind: 'error',
            payload: {
                code: 'unavailable',
                diagnostics: ['hosted_web_bootstrap_required'],
            },
        });

        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'negotiated' },
        });
    });

    it('negotiates and routes the canonical SDK wire through the existing hosted-web bridge', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'watchContext', 'executeAction'],
            },
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { actionId: 'opened' };
            },
        });

        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                wireVersion: 1,
                kind: 'negotiated',
                identity: canonicalIdentity,
                methods: ['context', 'executeAction'],
                surface: canonicalSurface,
            },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'request-1',
            method: 'executeAction',
            payload: { action: 'open', input: null },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'result',
                requestId: 'request-1',
                method: 'executeAction',
                result: { actionId: 'opened' },
            },
        });
        expect(seenRequests).toEqual([expect.objectContaining({
            method: 'executeAction',
            payload: { action: 'open', input: null },
        })]);
    });

    it('preserves an Action result whose domain payload happens to carry a host error code', async () => {
        const mountedHostApi = createPluginSurfaceHostApi({
            surfaceContext: surface,
            handlers: {
                executeAction: async () => ({
                    code: 'timeout',
                    outcome: 'domain-success',
                }),
            },
        });
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-domain-result',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: mountedHostApi.installedMethods,
            },
            handleRequest: mountedHostApi.handleRequest,
        });

        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'domain-result',
            method: 'executeAction',
            payload: { action: 'report', input: null },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'result',
                requestId: 'domain-result',
                method: 'executeAction',
                result: {
                    code: 'timeout',
                    outcome: 'domain-success',
                },
            },
        });
    });

    it('advertises selection in the sole 1.0 contract and rejects retired negotiation ranges', async () => {
        const seenRequests: PluginUiHostApiRequestEnvelopeV1[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-selection',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'selectActionInput'],
            },
            handleRequest: async (request) => {
                seenRequests.push(request);
                return { kind: 'cancelled' };
            },
        });
        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1',
        }))).resolves.toMatchObject({
            payload: {
                kind: 'negotiated',
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                methods: ['context', 'selectActionInput'],
            },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '>=1.0.0 <2.0.0',
        }))).resolves.toMatchObject({
            payload: {
                kind: 'negotiated',
                apiVersion: PLUGIN_UI_HOST_API_VERSION_V1,
                methods: ['context', 'selectActionInput'],
            },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^2.0.0',
        }))).resolves.toMatchObject({
            payload: { kind: 'disconnected', reason: 'incompatible_api_version' },
        });
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'selection-current',
            method: 'selectActionInput',
            payload: {
                operation: {
                    point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
                    contributor: {
                        pluginId: 'acme.provider',
                        contributionId: 'github-connection',
                        immutableGenerationId: 'provider-generation-a',
                    },
                    role: 'setup',
                    action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
                },
            },
        }))).resolves.toMatchObject({
            payload: { kind: 'result', method: 'selectActionInput', result: { kind: 'cancelled' } },
        });
        expect(seenRequests).toEqual([expect.objectContaining({
            method: 'selectActionInput',
        })]);
    });

    it('returns the literal Session draft without creating a targeted execute association', async () => {
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const serverStartDraft: PluginUiJsonValueV1 = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
        };
        const inventedSelectedActionInput: PluginUiJsonValueV1 = {
            kind: 'submitted',
            action: targetedOperation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: {
                    pluginId: surface.pluginId,
                    immutableGenerationId: 'target-generation-a',
                },
                point: targetedOperation.point,
                contributor: targetedOperation.contributor,
            },
            connectedAccount: { kind: 'none' },
        };
        const handleRequest = vi.fn(async (request: PluginUiHostApiRequestEnvelopeV1): Promise<PluginUiJsonValueV1> => {
            if (request.method === 'selectActionInput') {
                return { kind: 'serverStartDraft' as const, draft: serverStartDraft };
            }
            return { applied: true };
        });
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-server-start-draft',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'selectActionInput', 'executeAction'],
            },
            handleRequest,
        });
        await handler(createEnvelope('ready', { ready: true }));
        await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'select-server-start-draft',
            method: 'selectActionInput',
            payload: {
                hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
                draft: { directory: '/workspace' },
            },
        }))).resolves.toMatchObject({
            payload: {
                kind: 'result',
                method: 'selectActionInput',
                result: { kind: 'serverStartDraft', draft: serverStartDraft },
            },
        });

        // A guest cannot turn the draft result into an immediate Action. Even
        // an invented targeted carrier is rejected because only the targeted
        // request arm can populate the bridge's private lookup.
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-after-server-start-draft',
            method: 'executeAction',
            payload: { action: targetedOperation.action, input: { repository: 'happier-dev/happier' } },
            targetedOperation,
            selectedActionInput: inventedSelectedActionInput,
        }))).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(handleRequest).toHaveBeenCalledTimes(1);
    });

    it('accepts targeted execution only after selection and forwards the host-owned selected operation', async () => {
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const retainedTargetedOperation = {
            point: {
                pointId: targetedOperation.point.pointId,
                protocol: { ...targetedOperation.point.protocol },
            },
            contributor: { ...targetedOperation.contributor },
            role: targetedOperation.role,
            action: { ...targetedOperation.action },
        } as const;
        const forgedTargetedOperation = {
            ...retainedTargetedOperation,
            contributor: {
                ...retainedTargetedOperation.contributor,
                immutableGenerationId: 'forged-generation',
            },
        } as const;
        const selectedInput = { repository: 'happier-dev/happier' } as const;
        const selectedResult: PluginUiJsonValueV1 = {
            kind: 'submitted',
            action: targetedOperation.action,
            input: selectedInput,
            selection: {
                target: {
                    pluginId: surface.pluginId,
                    immutableGenerationId: 'target-generation-a',
                },
                point: retainedTargetedOperation.point,
                contributor: retainedTargetedOperation.contributor,
            },
            connectedAccount: { kind: 'none' },
        };
        const contributed = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { applied: true } },
        }));
        const mountedHostApi = createPluginSurfaceActionHostApi({
            surfaceContext: surface,
            callerBinding: {
                contributionLocalId: surface.contributionId,
                materializationRef: {
                    machineId: 'machine-1',
                    materializationId: 'materialization-current',
                    pluginId: surface.pluginId,
                },
            },
            contributedAction: {
                machineId: 'machine-1',
                expectedGeneration: '7',
                execute: contributed,
            },
            resolveContributedAction: (identity) => {
                const knownAction = (
                    identity.pluginId === targetedOperation.action.pluginId
                    && (
                        identity.localId === targetedOperation.action.localId
                        || identity.localId === 'other-action'
                    )
                ) || (
                    identity.pluginId === surface.pluginId
                    && identity.localId === 'connection/create'
                );
                return knownAction
                    ? {
                        id: identity.localId,
                        pluginId: identity.pluginId,
                        title: 'Targeted connection action',
                        scopes: ['session'],
                        surfaces: ['ui'],
                        execution: { target: 'daemon' },
                        dangerLevel: 'safe',
                        // The canonical projection executability rule
                        // (`isPluginProjectedActionExecutable`) is `available === true`.
                        // The dispatcher applies it at its single admission moment, so an
                        // admitted Action stub has to state the same fact the daemon does.
                        available: true,
                    }
                    : null;
            },
            selectActionInput: async (): Promise<PluginUiJsonValueV1> => selectedResult,
        });
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-targeted-carrier',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'selectActionInput', 'executeAction'],
            },
            handleRequest: mountedHostApi.handleRequest,
        });
        await handler(createEnvelope('ready', { ready: true }));
        await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-targeted',
            method: 'executeAction',
            payload: { action: targetedOperation.action, input: selectedInput },
            targetedOperation,
            selectedActionInput: selectedResult,
        }))).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(contributed).not.toHaveBeenCalled();

        const selectionResponse = await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'select-targeted',
            method: 'selectActionInput',
            payload: { operation: targetedOperation },
        }));
        expect(selectionResponse).toMatchObject({
            payload: {
                kind: 'result',
                method: 'selectActionInput',
                result: { kind: 'submitted', action: targetedOperation.action, input: selectedInput },
            },
        });

        // `Readonly` is a TypeScript affordance, not a runtime ownership
        // boundary. A hosted guest can mutate the response object it receives,
        // but that must not mutate the host-private selection retained for its
        // immediate executeAction request.
        const selectionWire = PluginUiHostApiWireEnvelopeV1Schema.parse(selectionResponse.payload);
        if (selectionWire.kind !== 'result' || selectionWire.method !== 'selectActionInput') {
            throw new Error('expected a selectActionInput result');
        }
        const selected = PluginUiSelectActionInputResultV1Schema.parse(selectionWire.result);
        if (selected.kind !== 'submitted') throw new Error('expected submitted selection');
        if (!selected.input || typeof selected.input !== 'object' || Array.isArray(selected.input)) {
            throw new Error('expected submitted selection input record');
        }
        const guestSelectedInput = structuredClone(selected);
        // Keep an unmodified guest copy for the later raw relay. The other
        // guest-owned clone below demonstrates that mutating received JSON
        // cannot rewrite the bridge's host-retained selection.
        const relaySelectedInput = structuredClone(guestSelectedInput);
        if (!relaySelectedInput.input
            || typeof relaySelectedInput.input !== 'object'
            || Array.isArray(relaySelectedInput.input)) {
            throw new Error('expected relay selection input record');
        }
        const preservedInput = { ...relaySelectedInput.input };
        const mutableSelectedInput = guestSelectedInput.input as { repository: string };
        mutableSelectedInput.repository = 'mutated-after-selection';
        const mutableRequestedContributor = guestSelectedInput.selection.contributor as {
            immutableGenerationId: string;
        };
        mutableRequestedContributor.immutableGenerationId = 'mutated-after-selection';

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-selected-targeted',
            method: 'executeAction',
            payload: { action: targetedOperation.action, input: preservedInput },
            // The SDK carries this semantic lookup value, but the bridge must
            // forward its retained parsed selection object, not this guest copy.
            targetedOperation: retainedTargetedOperation,
            selectedActionInput: relaySelectedInput,
        }))).resolves.toMatchObject({
            payload: { kind: 'result', result: { applied: true } },
        });
        expect(contributed).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: 'acme.provider/connection/prepare-v1',
            input: { repository: 'happier-dev/happier' },
            expectedContributorImmutableGenerationId: 'provider-generation-a',
        }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-forged-targeted',
            method: 'executeAction',
            payload: { action: targetedOperation.action, input: selectedInput },
            targetedOperation: forgedTargetedOperation,
            selectedActionInput: {
                ...relaySelectedInput,
                selection: {
                    ...relaySelectedInput.selection,
                    contributor: forgedTargetedOperation.contributor,
                },
            },
        }))).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(contributed).toHaveBeenCalledTimes(1);

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-mismatched-targeted',
            method: 'executeAction',
            payload: { action: { pluginId: 'acme.provider', localId: 'other-action' }, input: {} },
            targetedOperation: retainedTargetedOperation,
            selectedActionInput: relaySelectedInput,
        }))).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(contributed).toHaveBeenCalledTimes(1);

        // The transport does not classify outer Action ownership. Its retained
        // selection reaches the one mounted dispatcher, which rejects the
        // foreign Action above yet permits the target-owned management relay.
        const contributedBeforeTerminalRelay = contributed.mock.calls.length;
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'execute-target-owned-relay',
            method: 'executeAction',
            payload: {
                action: { pluginId: surface.pluginId, localId: 'connection/create' },
                input: { providerSetupInput: preservedInput },
            },
            targetedOperation: retainedTargetedOperation,
            selectedActionInput: relaySelectedInput,
            // This is a mounted host-private terminal-execution fact, not
            // public Action data. The bridge must remove the exact retained
            // selection before the target-owned relay reaches its dispatcher.
            consumeSelectedActionInput: true,
        }))).resolves.toMatchObject({
            payload: { kind: 'result', result: { applied: true } },
        });
        expect(contributed).toHaveBeenLastCalledWith('machine-1', expect.objectContaining({
            qualifiedActionId: `${surface.pluginId}/connection/create`,
            input: { providerSetupInput: preservedInput },
            selectedActionInputCarrier: {
                operation: retainedTargetedOperation,
                result: expect.objectContaining({ input: preservedInput }),
            },
        }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'replay-target-owned-relay',
            method: 'executeAction',
            payload: {
                action: { pluginId: surface.pluginId, localId: 'connection/create' },
                input: { providerSetupInput: preservedInput },
            },
            targetedOperation: retainedTargetedOperation,
            selectedActionInput: relaySelectedInput,
        }))).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(contributed).toHaveBeenCalledTimes(contributedBeforeTerminalRelay + 1);
    });

    it('retires exact selections on their own cancellation and before terminal failure or cancellation', async () => {
        const targetedOperation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        let selectionOrdinal = 0;
        let terminalOutcome: 'success' | 'failure' | 'cancelled' = 'success';
        let cancelledTerminalSignal: AbortSignal | undefined;
        let executeDispatches = 0;
        const handleRequest = vi.fn(async (
            request: PluginUiHostApiRequestEnvelopeV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ): Promise<PluginUiJsonValueV1> => {
            if (request.method === 'selectActionInput') {
                selectionOrdinal += 1;
                return {
                    kind: 'submitted',
                    action: targetedOperation.action,
                    input: { repository: `happier-${selectionOrdinal}` },
                    selection: {
                        target: canonicalSurface.targetedContributions.target,
                        point: targetedOperation.point,
                        contributor: targetedOperation.contributor,
                    },
                    connectedAccount: { kind: 'none' },
                };
            }
            if (request.method !== 'executeAction') throw new Error('unexpected_request');
            executeDispatches += 1;
            if (terminalOutcome === 'failure') throw new Error('terminal_dispatch_failed');
            if (terminalOutcome === 'cancelled') {
                return await new Promise((resolve) => {
                    options?.signal?.addEventListener('abort', () => {
                        cancelledTerminalSignal = options.signal;
                        resolve({ cancelled: true });
                    }, { once: true });
                });
            }
            return { applied: true };
        });
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-terminal-selected-settlement',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['selectActionInput', 'executeAction'],
            },
            handleRequest,
        });
        await handler(createEnvelope('ready', { ready: true }));
        await handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }));

        const select = async (requestId: string) => {
            const response = await handler(createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'request',
                identity: canonicalIdentity,
                requestId,
                method: 'selectActionInput',
                payload: { operation: targetedOperation },
            }));
            const wire = PluginUiHostApiWireEnvelopeV1Schema.parse(response.payload);
            if (wire.kind !== 'result' || wire.method !== 'selectActionInput') {
                throw new Error('expected selected Action input result');
            }
            const selected = PluginUiSelectActionInputResultV1Schema.parse(wire.result);
            if (selected.kind !== 'submitted') throw new Error('expected submitted selection');
            return selected;
        };
        const execute = (
            requestId: string,
            selected: Awaited<ReturnType<typeof select>>,
            consume = false,
        ) => {
            const request = {
                wireVersion: 1,
                kind: 'request' as const,
                identity: canonicalIdentity,
                requestId,
                method: 'executeAction' as const,
                payload: {
                    action: { pluginId: surface.pluginId, localId: 'connection/create' },
                    input: { providerSetupInput: selected.input },
                },
                targetedOperation,
                selectedActionInput: selected,
                ...(consume ? { consumeSelectedActionInput: true as const } : {}),
            };
            // The private terminal bit is intentionally newer than the public
            // wire type under RED. This raw guest envelope tests its strict
            // mounted-host boundary, not an author-facing builder.
            return handler(createEnvelope(
                'hostApi',
                request as unknown as PluginHostedWebBridgeEnvelopeV1['payload'],
            ));
        };
        const cancel = (requestId: string) => handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'cancel',
            identity: canonicalIdentity,
            requestId,
        }));

        const superseded = await select('select-superseded');
        const current = await select('select-current');
        await expect(cancel('select-superseded')).resolves.toMatchObject({ kind: 'ack' });
        await expect(execute('execute-current-nonterminal', current)).resolves.toMatchObject({
            payload: { kind: 'result', result: { applied: true } },
        });
        await expect(execute('execute-superseded', superseded)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        // A raw guest cannot reuse the completed selection's correlation id as
        // an execution id, then use a cancel to ambiguously retire it.
        await expect(execute('select-current', current)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(executeDispatches).toBe(1);

        const abandoned = await select('select-abandoned');
        await expect(cancel('select-abandoned')).resolves.toMatchObject({ kind: 'ack' });
        await expect(execute('execute-abandoned', abandoned)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(executeDispatches).toBe(1);

        const failed = await select('select-failed-terminal');
        terminalOutcome = 'failure';
        await expect(execute('execute-failed-terminal', failed, true)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'internal_error' } },
        });
        await expect(execute('replay-failed-terminal', failed)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(executeDispatches).toBe(2);

        const cancelled = await select('select-cancelled-terminal');
        terminalOutcome = 'cancelled';
        const pending = execute('execute-cancelled-terminal', cancelled, true);
        await vi.waitFor(() => expect(executeDispatches).toBe(3));
        await expect(cancel('execute-cancelled-terminal')).resolves.toMatchObject({ kind: 'ack' });
        await expect(pending).resolves.toMatchObject({ kind: 'ack' });
        expect(cancelledTerminalSignal?.aborted).toBe(true);
        await expect(execute('replay-cancelled-terminal', cancelled)).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'invalid_payload' } },
        });
        expect(executeDispatches).toBe(3);
    });

    it('keeps target-scoped context on the sole 1.0 negotiation and rejects retired ranges', async () => {
        const targetedSurface = {
            ...canonicalSurface,
            targetedContributions: {
                target: {
                    pluginId: 'acme.target',
                    immutableGenerationId: 'target-generation-a',
                },
                points: [],
            },
        } as const;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-context-version',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: targetedSurface,
                methods: ['context'],
            },
        });
        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            payload: { kind: 'negotiated', apiVersion: '1.0.0', surface: targetedSurface },
        });
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'context-1.0',
            method: 'context',
        }))).resolves.toMatchObject({
            payload: {
                kind: 'result',
                result: { surface: targetedSurface, activity: { active: false } },
            },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^2.0.0',
        }))).resolves.toMatchObject({
            payload: { kind: 'disconnected', reason: 'incompatible_api_version' },
        });
    });

    it('disconnects stale canonical identities and suppresses a cancelled request result', async () => {
        let settleRequest: ((value: PluginUiJsonValueV1) => void) | undefined;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['executeAction'],
            },
            handleRequest: () => new Promise<PluginUiJsonValueV1>((resolve) => {
                settleRequest = resolve;
            }),
        });

        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: { ...canonicalIdentity, generation: '6' },
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            payload: { kind: 'disconnected', reason: 'stale_surface' },
        });

        const request = handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'request-cancelled',
            method: 'executeAction',
            payload: { action: 'slow', input: null },
        }));
        await vi.waitFor(() => expect(settleRequest).toBeTypeOf('function'));
        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'cancel',
                identity: canonicalIdentity,
                requestId: 'request-cancelled',
            }),
            sequence: 8,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 8 });
        settleRequest?.({ accepted: true });
        await expect(request).resolves.toMatchObject({ kind: 'ack' });

        handler.dispose();
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            payload: { kind: 'disconnected', reason: 'host_api_handler_disposed' },
        });
    });

    it('retires a live Resource subscription through the canonical disposal frame', async () => {
        const handleRequest = vi.fn(async (): Promise<PluginUiJsonValueV1> => null);
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-resource-disposal',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchResource'],
            },
            handleRequest,
            postToFrame: vi.fn(),
        });
        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-resource-request',
            subscriptionId: 'watch-resource-subscription',
            method: 'watchResource',
            payload: { resource: 'live-status' },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchResource' },
        });

        await expect(handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'disposeHostResource',
                identity: canonicalIdentity,
                requestId: 'dispose-resource-request',
                subscriptionId: 'watch-resource-subscription',
            }),
            sequence: 8,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 8 });
        expect(handleRequest).toHaveBeenLastCalledWith(expect.objectContaining({
            method: 'disposeHostResource',
            payload: { subscriptionId: 'watch-resource-subscription' },
        }));
        expect(handler.publishResourceSubscriptionEvent({
            version: 1,
            subscriptionId: 'watch-resource-subscription',
            kind: 'invalidated',
            digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })).toBe(false);
    });

    it('preserves the canonical Resource-watch admission baseline on the established wire result', async () => {
        const admission = {
            subscriptionId: 'watch-resource-subscription',
            digest: `sha256:${'a'.repeat(64)}`,
        } as const;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-resource-admission',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchResource'],
            },
            handleRequest: async (request): Promise<PluginUiJsonValueV1> => (
                request.method === 'watchResource' ? admission : null
            ),
            postToFrame: vi.fn(),
        });
        await handler(createEnvelope('ready', { ready: true }));

        // The browser bridge must remain transport-only: it neither invents a
        // baseline nor drops the canonical one needed by the SDK Resource
        // client to suppress its redundant first convergence read.
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-resource-request',
            subscriptionId: admission.subscriptionId,
            method: 'watchResource',
            payload: { resource: 'live-status' },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'result',
                method: 'watchResource',
                result: admission,
            },
        });
    });

    it('delivers a Resource event published while establishment is still in flight', async () => {
        // The mount's Resource pump starts the moment `owner.open` admits the
        // subscription, so its first invalidation can reach this bridge before
        // the establishment response has been written. Suppressing it here lost
        // the event outright: the SDK client already buffers everything that
        // arrives before its own acknowledgement, so the bridge must forward.
        const admission = {
            subscriptionId: 'watch-resource-subscription',
            digest: `sha256:${'a'.repeat(64)}`,
        } as const;
        const invalidatedDigest = `sha256:${'b'.repeat(64)}` as const;
        const postToFrame = vi.fn();
        let publishedDuringEstablishment: boolean | undefined;
        let handler!: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
        handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-resource-establishment',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchResource'],
            },
            handleRequest: async (request): Promise<PluginUiJsonValueV1> => {
                if (request.method !== 'watchResource') return null;
                publishedDuringEstablishment = handler.publishResourceSubscriptionEvent({
                    version: 1,
                    subscriptionId: admission.subscriptionId,
                    kind: 'invalidated',
                    digest: invalidatedDigest,
                });
                return admission;
            },
            postToFrame,
        });
        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-resource-request',
            subscriptionId: admission.subscriptionId,
            method: 'watchResource',
            payload: { resource: 'live-status' },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchResource', result: admission },
        });

        expect(publishedDuringEstablishment).toBe(true);
        expect(postToFrame.mock.calls.map(([message]) => message.payload)).toContainEqual(
            expect.objectContaining({
                kind: 'subscription',
                subscriptionId: admission.subscriptionId,
                event: expect.objectContaining({ kind: 'invalidated', digest: invalidatedDigest }),
            }),
        );
        // A later event on the promoted subscription still flows.
        expect(handler.publishResourceSubscriptionEvent({
            version: 1,
            subscriptionId: admission.subscriptionId,
            kind: 'invalidated',
            digest: `sha256:${'c'.repeat(64)}`,
        })).toBe(true);
    });

    it('keeps a terminal Resource event published during establishment from failing that establishment', async () => {
        // A watch that terminates before its acknowledgement is still a
        // successful establishment for the guest: the client needs the ack in
        // order to flush the buffered terminal arm to its listener.
        const admission = {
            subscriptionId: 'watch-resource-subscription',
            digest: `sha256:${'a'.repeat(64)}`,
        } as const;
        const postToFrame = vi.fn();
        let handler!: ReturnType<typeof createPluginHostedWebHostApiBridgeHandler>;
        handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-resource-terminal',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['watchResource'],
            },
            handleRequest: async (request): Promise<PluginUiJsonValueV1> => {
                if (request.method !== 'watchResource') return null;
                handler.publishResourceSubscriptionEvent({
                    version: 1,
                    subscriptionId: admission.subscriptionId,
                    kind: 'error',
                    code: 'expired_resource',
                    diagnostics: ['stale_generation'],
                });
                return admission;
            },
            postToFrame,
        });
        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-resource-request',
            subscriptionId: admission.subscriptionId,
            method: 'watchResource',
            payload: { resource: 'live-status' },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchResource', result: admission },
        });
        expect(postToFrame.mock.calls.map(([message]) => message.payload)).toContainEqual(
            expect.objectContaining({
                kind: 'subscription',
                subscriptionId: admission.subscriptionId,
                event: expect.objectContaining({ kind: 'error', code: 'expired_resource' }),
            }),
        );
    });

    it('does not republish a semantically unchanged Context snapshot', async () => {
        const postToFrame = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-context-identity',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'watchContext'],
            },
            postToFrame,
        });
        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-context-request',
            subscriptionId: 'watch-context-subscription',
            method: 'watchContext',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'watchContext' },
        });
        postToFrame.mockClear();

        handler.pushSurfaceContext(structuredClone(canonicalSurface));

        expect(postToFrame).not.toHaveBeenCalled();
    });

    it('updates Context subscribers when a retained mount becomes inactive', async () => {
        const postToFrame = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web-context-activity',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context', 'watchContext'],
                activity: { active: true },
            },
            postToFrame,
        });
        await handler(createEnvelope('ready', { ready: true }));
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'subscribe',
            identity: canonicalIdentity,
            requestId: 'watch-context-activity-request',
            subscriptionId: 'watch-context-activity-subscription',
            method: 'watchContext',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'result',
                method: 'watchContext',
            },
        });
        postToFrame.mockClear();

        handler.pushSurfaceContext(canonicalSurface, { active: false });

        expect(postToFrame).toHaveBeenCalledWith(expect.objectContaining({
            payload: expect.objectContaining({
                kind: 'subscription',
                subscriptionId: 'watch-context-activity-subscription',
                event: {
                    surface: canonicalSurface,
                    activity: { active: false },
                },
            }),
        }));
    });

    it('cancels the in-flight request at the mount, not only its answer', async () => {
        // Suppressing the response left whatever the mount had put in front of
        // the user — a `confirm` dialog — on screen. The caller's withdrawal has
        // to reach the handler for the whole in-flight window.
        let observed: AbortSignal | undefined;
        let settleRequest: ((value: PluginUiJsonValueV1) => void) | undefined;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['confirm'],
            },
            handleRequest: (_request, options) => {
                observed = options?.signal;
                return new Promise<PluginUiJsonValueV1>((resolve) => {
                    settleRequest = resolve;
                });
            },
        });

        await handler(createEnvelope('ready', { ready: true }));

        const request = handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'request-confirm',
            method: 'confirm',
            payload: { message: 'Delete the preview?' },
        }));
        await vi.waitFor(() => expect(settleRequest).toBeTypeOf('function'));
        expect(observed?.aborted).toBe(false);

        await handler({
            ...createEnvelope('hostApi', {
                wireVersion: 1,
                kind: 'cancel',
                identity: canonicalIdentity,
                requestId: 'request-confirm',
            }),
            sequence: 8,
        });

        expect(observed?.aborted).toBe(true);
        settleRequest?.({ confirmed: true });
        await expect(request).resolves.toMatchObject({ kind: 'ack' });
    });

    it('routes Collection UI-query traffic through the ready, current, cancellation-bound hosted bridge', async () => {
        let observedSignal: AbortSignal | undefined;
        let settleOperation: ((value: PluginHostedWebCollectionUiQueryBridgeResponseV1) => void) | undefined;
        let publishChange: ((change: PluginHostedWebCollectionUiQueryBridgeChangeV1) => void) | undefined;
        const handle = vi.fn((
            _operation: PluginHostedWebCollectionUiQueryBridgeOperationV1,
            options?: Readonly<{ signal?: AbortSignal }>,
        ) => {
            observedSignal = options?.signal;
            return new Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>((resolve) => {
                settleOperation = resolve;
            });
        });
        const dispose = vi.fn();
        const postToFrame = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame,
            createCollectionUiQueryBridge: ({ publish }) => {
                publishChange = publish;
                return { handle, dispose };
            },
        });
        const operation = {
            kind: 'open' as const,
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        };
        const response: PluginHostedWebCollectionUiQueryBridgeResponseV1 = {
            kind: 'snapshot',
            queryId: 'query_1',
            snapshot: { status: 'ready', rows: [], hasMore: false },
        };

        // The query bridge is not a bootstrap bypass. It remains unavailable
        // until the same ready transition that establishes the canonical host
        // client has completed.
        await expect(handler(createEnvelope('collectionUiQuery', {
            kind: 'request',
            operation,
        }))).resolves.toMatchObject({
            kind: 'error',
            payload: {
                code: 'unavailable',
                diagnostics: ['hosted_web_bootstrap_required'],
            },
        });
        expect(handle).not.toHaveBeenCalled();

        await handler({ ...createEnvelope('ready', { ready: true }), sequence: 8 });

        const cancelled = handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'request',
                operation,
            }),
            sequence: 9,
        });
        await vi.waitFor(() => expect(settleOperation).toBeTypeOf('function'));
        expect(observedSignal?.aborted).toBe(false);

        await expect(handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'cancel',
                requestSequence: 9,
            }),
            sequence: 10,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 10 });
        expect(observedSignal?.aborted).toBe(true);

        settleOperation?.(response);
        await expect(cancelled).resolves.toMatchObject({ kind: 'ack', requestSequence: 9 });

        const completed = handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'request',
                operation,
            }),
            sequence: 11,
        });
        await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2));
        settleOperation?.(response);
        await expect(completed).resolves.toMatchObject({
            kind: 'result',
            requestSequence: 11,
            payload: response,
        });

        publishChange?.({ kind: 'change', queryId: 'query_1' });
        expect(postToFrame).toHaveBeenLastCalledWith(expect.objectContaining({
            direction: 'hostToFrame',
            kind: 'collectionUiQuery',
            nonce: 'nonce-1',
            payload: { kind: 'change', queryId: 'query_1' },
        }));

        const disposed = handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'request',
                operation,
            }),
            sequence: 12,
        });
        await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(3));
        handler.dispose();
        expect(observedSignal?.aborted).toBe(true);
        expect(dispose).toHaveBeenCalledTimes(1);
        settleOperation?.(response);
        await expect(disposed).resolves.toMatchObject({ kind: 'ack', requestSequence: 12 });
    });

    it('uses the existing ready acknowledgement to advertise whether this mounted bridge can serve Collection UI-query', async () => {
        const withoutData = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame: vi.fn(),
        });
        const withData = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame: vi.fn(),
            createCollectionUiQueryBridge: () => ({
                handle: async () => ({
                    kind: 'closed',
                    queryId: 'query_1',
                }),
                dispose: () => {},
            }),
        });

        await expect(withoutData({ ...createEnvelope('ready', { ready: true }), sequence: 8 }))
            .resolves.toMatchObject({
                kind: 'ack',
                payload: {
                    accepted: true,
                    capabilities: { collectionUiQuery: false },
                },
            });
        await expect(withData({ ...createEnvelope('ready', { ready: true }), sequence: 8 }))
            .resolves.toMatchObject({
                kind: 'ack',
                payload: {
                    accepted: true,
                    capabilities: { collectionUiQuery: true },
                },
            });
    });

    it('delivers terminal disconnect after currentness closes while suppressing a late Collection result', async () => {
        let current = true;
        let observedSignal: AbortSignal | undefined;
        let settleOperation: ((value: PluginHostedWebCollectionUiQueryBridgeResponseV1) => void) | undefined;
        let publishChange: ((change: PluginHostedWebCollectionUiQueryBridgeChangeV1) => void) | undefined;
        const postToFrame = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame,
            isCurrent: () => current,
            createCollectionUiQueryBridge: ({ publish }) => {
                publishChange = publish;
                return {
                    handle: (_operation, options) => new Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>((resolve) => {
                        observedSignal = options?.signal;
                        settleOperation = resolve;
                    }),
                    dispose: () => {},
                };
            },
        });
        const operation: PluginHostedWebCollectionUiQueryBridgeOperationV1 = {
            kind: 'open',
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        };
        const response: PluginHostedWebCollectionUiQueryBridgeResponseV1 = {
            kind: 'snapshot',
            queryId: 'query_1',
            snapshot: { status: 'ready', rows: [], hasMore: false },
        };

        await handler({ ...createEnvelope('ready', { ready: true }), sequence: 8 });
        postToFrame.mockClear();
        const pending = handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'request',
                operation,
            }),
            sequence: 9,
        });
        await vi.waitFor(() => expect(settleOperation).toBeTypeOf('function'));

        current = false;
        publishChange?.({ kind: 'change', queryId: 'query_1' });
        expect(postToFrame).not.toHaveBeenCalled();
        handler.dispose();

        expect(observedSignal?.aborted).toBe(true);
        expect(postToFrame).toHaveBeenCalledWith(expect.objectContaining({
            direction: 'hostToFrame',
            kind: 'hostApi',
            payload: expect.objectContaining({
                kind: 'disconnected',
                reason: 'host_api_handler_disposed',
            }),
        }));

        settleOperation?.(response);
        await expect(pending).resolves.toMatchObject({ kind: 'ack', requestSequence: 9 });
        expect(postToFrame).toHaveBeenCalledTimes(1);
    });

    it('rejects a duplicate Collection outer sequence without replacing the first cancellation owner', async () => {
        let firstSignal: AbortSignal | undefined;
        let settleFirst: ((value: PluginHostedWebCollectionUiQueryBridgeResponseV1) => void) | undefined;
        let callCount = 0;
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['context'],
            },
            postToFrame: vi.fn(),
            createCollectionUiQueryBridge: () => ({
                handle: (_operation, options) => {
                    callCount += 1;
                    if (callCount === 1) {
                        firstSignal = options?.signal;
                        return new Promise<PluginHostedWebCollectionUiQueryBridgeResponseV1>((resolve) => {
                            settleFirst = resolve;
                        });
                    }
                    return Promise.resolve({
                        kind: 'snapshot',
                        queryId: 'query_2',
                        snapshot: { status: 'ready', rows: [], hasMore: false },
                    });
                },
                dispose: () => {},
            }),
        });
        const operation: PluginHostedWebCollectionUiQueryBridgeOperationV1 = {
            kind: 'open',
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        };

        await handler({ ...createEnvelope('ready', { ready: true }), sequence: 8 });
        const first = handler({
            ...createEnvelope('collectionUiQuery', { kind: 'request', operation }),
            sequence: 9,
        });
        await vi.waitFor(() => expect(settleFirst).toBeTypeOf('function'));

        await expect(handler({
            ...createEnvelope('collectionUiQuery', { kind: 'request', operation }),
            sequence: 9,
        })).resolves.toMatchObject({
            kind: 'error',
            payload: {
                code: 'invalid_payload',
                diagnostics: ['hosted_web_duplicate_request_sequence'],
            },
        });
        expect(callCount).toBe(1);
        expect(firstSignal?.aborted).toBe(false);

        await expect(handler({
            ...createEnvelope('collectionUiQuery', {
                kind: 'cancel',
                requestSequence: 9,
            }),
            sequence: 10,
        })).resolves.toMatchObject({ kind: 'ack', requestSequence: 10 });
        expect(firstSignal?.aborted).toBe(true);

        settleFirst?.({
            kind: 'snapshot',
            queryId: 'query_1',
            snapshot: { status: 'ready', rows: [], hasMore: false },
        });
        await expect(first).resolves.toMatchObject({ kind: 'ack', requestSequence: 9 });
    });

    it('acks ready bridge messages with the resolved surface context', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest: vi.fn(),
        });

        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 7,
            payload: {
                accepted: true,
                surface,
            },
        });
    });

    it('types duplicate ready bridge messages without recording a new ready transition', async () => {
        const readyStates: string[] = [];
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest: async () => null,
            onReadyStateChange: (state) => readyStates.push(state.state),
        });

        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            payload: {
                readyState: 'recorded',
            },
        });
        await expect(handler(createEnvelope('ready', { ready: true }))).resolves.toMatchObject({
            kind: 'ack',
            payload: {
                readyState: 'duplicate',
            },
        });
        expect(readyStates).toEqual(['ready']);
    });

    it('returns a typed stale-surface error for ready messages bound to an old surface context', async () => {
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest: vi.fn(),
        });

        await expect(handler({
            ...createEnvelope('ready', { ready: true }),
            sessionId: 'stale-session',
        })).resolves.toMatchObject({
            kind: 'error',
            requestSequence: 7,
            payload: {
                code: 'stale_surface',
            },
        });
    });

    it('acks passive lifecycle bridge messages without dispatching host API requests', async () => {
        const handleRequest = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest,
        });

        await expect(handler(createEnvelope('heightChanged', { height: 320 }))).resolves.toMatchObject({
            kind: 'ack',
            requestSequence: 7,
            payload: { accepted: true },
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('rejects a predecessor direct host-method bridge envelope without bypassing negotiation', async () => {
        const handleRequest = vi.fn(async () => ({ state: 'available' }));
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest,
        });

        await expect(handler(createEnvelope(
            'readResource' as PluginHostedWebBridgeEnvelopeV1['kind'],
            { resource: { kind: 'session' } },
        ))).resolves.toMatchObject({
            kind: 'error',
            requestSequence: 7,
            payload: { code: 'unsupported_method' },
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('EU-5a: carries openSurface launch input to the real mounted host and returns its typed rejection', async () => {
        const { createPluginSurfaceActionHostApi } = await import(
            '@/components/plugins/surfaces/pluginSurfaceActionDispatch'
        );
        const {
            PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
        } = await import('@happier-dev/protocol/plugins/ui');
        const opened: unknown[] = [];
        // The REAL mounted host API, so the bridge is composed with the same
        // parser the React Native transport reaches — nothing here hand-builds
        // the neighbour's contract.
        const hostApi = createPluginSurfaceActionHostApi({
            surfaceContext: surface,
            openSurface: (request) => {
                opened.push(request);
                return { ok: true };
            },
        });
        expect(hostApi.installedMethods).toContain('openSurface');
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest: hostApi.handleRequest,
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: hostApi.installedMethods,
            },
        });

        await handler(createEnvelope('ready', { ready: true }));

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'negotiate',
            identity: canonicalIdentity,
            apiRange: '^1.0.0',
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'negotiated', methods: expect.arrayContaining(['openSurface']) },
        });

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'req-open-1',
            method: 'openSurface',
            payload: {
                destination: { pluginId: 'acme.preview', localId: 'detail' },
                input: { itemId: 'item-7' },
                subPath: '/review//item-7/',
            },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', requestId: 'req-open-1', method: 'openSurface' },
        });
        expect(opened).toEqual([
            {
                destination: { pluginId: 'acme.preview', localId: 'detail' },
                input: { itemId: 'item-7' },
                subPath: 'review/item-7',
            },
        ]);

        // An oversize launch input is refused at the single bounded owner and the
        // refusal reaches the hosted surface as a typed wire error — it is never
        // truncated into a shorter, valid-looking argument.
        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'req-open-2',
            method: 'openSurface',
            payload: {
                destination: { pluginId: 'acme.preview', localId: 'detail' },
                input: { blob: 'x'.repeat(PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1) },
            },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', requestId: 'req-open-2', error: { code: 'invalid_payload' } },
        });
        expect(opened).toHaveLength(1);
    });

    it('rejects the retired predecessor bridge spellings', async () => {
        const handleRequest = vi.fn();
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest,
        });

        for (const retired of ['requestSessionResource', 'requestHostAction', 'copy', 'logDiagnostic', 'openExternal']) {
            await expect(handler(createEnvelope(
                retired as PluginHostedWebBridgeEnvelopeV1['kind'],
                { probe: retired },
            ))).resolves.toMatchObject({
                kind: 'error',
                payload: { code: 'unsupported_method' },
            });
        }
        expect(handleRequest).not.toHaveBeenCalled();
    });

    it('makes a retired bridge handler unavailable before a stale frame listener can dispatch', async () => {
        const handleRequest = vi.fn(async () => ({ accepted: true }));
        const handler = createPluginHostedWebHostApiBridgeHandler({
            surface,
            requestIdPrefix: 'hosted-web',
            bridgeNonce: 'nonce-1',
            handleRequest,
            canonicalHostApi: {
                identity: canonicalIdentity,
                surface: canonicalSurface,
                methods: ['readResource'],
            },
        });

        await handler(createEnvelope('ready', { ready: true }));
        handler.dispose();

        await expect(handler(createEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'request',
            identity: canonicalIdentity,
            requestId: 'retired-request',
            method: 'readResource',
            payload: { resource: { kind: 'session' } },
        }))).resolves.toMatchObject({
            kind: 'result',
            payload: {
                kind: 'disconnected',
                reason: 'host_api_handler_disposed',
            },
        });
        expect(handleRequest).not.toHaveBeenCalled();
    });

});
