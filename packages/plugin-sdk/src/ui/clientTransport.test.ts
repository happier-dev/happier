import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginUiExecuteActionRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import {
    type PluginUiHostApiSurfaceContextV1,
    type PluginUiHostApiWireEnvelopeV1,
} from '@happier-dev/protocol/plugins/ui/client';

import {
    PluginUiHostApiClientError,
    createPluginUiHostApiClientFromTransport,
} from './clientTransport.js';
import { isPluginError } from '../errors.js';
import type { PluginReference } from '../identity.js';
import type { ComposerContentHandleV1, SurfaceContext } from './hostApi.js';
import { createSurfaceContextFixture } from './surfaceContext.fixture.js';

const surface: SurfaceContext = createSurfaceContextFixture();

const identity = {
    pluginId: 'com.acme.fixture',
    pluginVersion: '1.0.0',
    viewId: 'review',
    generation: 'generation-2',
    sessionId: 'session-1',
} as const;

const preparedOperation = {
    // Grammar-valid local id: the Protocol contribution-id grammar admits
    // lower-case alphanumerics with `-`/`/` separators, not dots.
    point: { pointId: 'sources', protocol: { id: 'sources', version: 1 } },
    contributor: {
        pluginId: 'happier.scm.github',
        contributionId: 'github',
        immutableGenerationId: 'github-generation-1',
    },
    role: 'prepareReviewWorkspace',
    action: { pluginId: 'happier.scm.github', localId: 'prepare-review-workspace' },
} as const;

const preparedSelection = {
    kind: 'submitted' as const,
    action: preparedOperation.action,
    input: { repository: 'happier-dev/happier' },
    selection: {
        target: { pluginId: identity.pluginId, immutableGenerationId: identity.generation },
        point: preparedOperation.point,
        contributor: preparedOperation.contributor,
    },
    connectedAccount: { kind: 'none' as const },
};

describe('plugin UI domain client transport adapter', () => {
    afterEach(() => vi.useRealTimers());

    it('forwards openNewSession as one strict flat request', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const controller = new AbortController();
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'open-new-session-request',
            transport: {
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['openNewSession'],
                            surface,
                        });
                    } else if (message.kind === 'request' && message.method === 'openNewSession') {
                        expect(message.payload).toEqual({ prompt: 'Repair CI' });
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: null,
                        });
                    }
                },
            },
        });

        await expect(api.openNewSession(
            { prompt: 'Repair CI' },
            { signal: controller.signal },
        )).resolves.toBeUndefined();
        expect(sent).toContainEqual(expect.objectContaining({
            kind: 'request',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        }));
        await expect(api.openNewSession({ prompt: { text: 'retired' } } as never))
            .rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('uses the shared exact confirmation decoder used by the direct-native carrier', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'confirm-response-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['confirm'], surface,
                    });
                    if (message.kind === 'request' && message.method === 'confirm') receive?.({
                        wireVersion: 1, kind: 'result', identity, requestId: message.requestId,
                        method: message.method, result: { confirmed: true, extra: 'drift' },
                    });
                },
            },
        });

        await expect(api.confirm('Delete the preview?')).rejects.toMatchObject({
            code: 'invalid_payload', message: 'confirm_response_invalid',
        });
    });

    it('terminally carries the exact prepared-workspace selection and rejects incomplete requests', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'open-prepared-session-request',
            transport: {
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['openNewSession'],
                            surface,
                        });
                    } else if (message.kind === 'request') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: null,
                        });
                    }
                },
            },
        });

        await expect(api.openNewSession({ checkoutIntent: 'preparedReviewWorkspace' }))
            .rejects.toMatchObject({ code: 'invalid_payload' });
        await expect(api.openNewSession(
            { checkoutIntent: 'preparedReviewWorkspace' },
            {
                preparedReviewWorkspace: {
                    operation: preparedOperation,
                    result: preparedSelection,
                },
            },
        )).resolves.toBeUndefined();
        expect(sent).toContainEqual(expect.objectContaining({
            kind: 'request',
            method: 'openNewSession',
            targetedOperation: preparedOperation,
            selectedActionInput: preparedSelection,
            consumeSelectedActionInput: true,
        }));
    });

    it('keeps the Protocol surface context mutually assignable through direct and watched reads', async () => {
        const protocolSurface: PluginUiHostApiSurfaceContextV1 = surface;
        const sdkSurface: SurfaceContext = protocolSurface;
        let receive: ((message: unknown) => void) | undefined;
        let requestSequence = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `surface-context-request-${++requestSequence}`,
            createSubscriptionId: () => 'surface-context-subscription',
            transport: {
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
                send(message) {
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'watchContext'],
                            surface: protocolSurface,
                        });
                    }
                    if (message.kind === 'request' && message.method === 'context') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: 'context',
                            result: { surface: protocolSurface, activity: { active: true } },
                        });
                    }
                    if (message.kind === 'subscribe' && message.method === 'watchContext') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: 'watchContext',
                        });
                    }
                },
            },
        });

        const observed: SurfaceContext[] = [];
        const watch = await api.watchContext((context) => observed.push(context));
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: 'surface-context-subscription',
            event: { surface: protocolSurface, activity: { active: true } },
        });

        await expect(api.context()).resolves.toEqual(sdkSurface);
        expect(observed).toEqual([sdkSurface]);
        watch.dispose();
    });

    it('rejects malformed current-UI enrichment before it can disappear at the host boundary', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['publishCurrentUiContext'],
                            surface,
                        });
                    }
                },
            },
        });

        let thrown: unknown;
        try {
            api.publishCurrentUiContext({
                entity: { kind: '', label: 'Review #42' },
            });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(PluginUiHostApiClientError);
        expect(thrown).toMatchObject({ code: 'invalid_payload' });
        expect(sent).toHaveLength(1);
    });

    it('round-trips the flat Composer document methods and retires observations and locks through one disposer', async () => {
        const composer = { kind: 'session', sessionId: 'session-1' } as const;
        const stagedMediaContent = {
            kind: 'stagedMedia',
            handle: {
                v: 1,
                id: 'stage-1',
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                owner: { pluginId: 'com.acme.fixture', localId: 'review' },
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'review.png',
                sizeBytes: 42,
                sha256: 'a'.repeat(64),
            },
        } as const;
        const snapshot = {
            revision: 3,
            ref: composer,
            text: 'Investigate the failure',
            references: [],
            attachments: [{
                v: 1,
                instanceId: 'review-42',
                attachment: { pluginId: 'com.acme.fixture', localId: 'review' },
                key: 'review-42',
                value: { reviewId: '42' },
                presentation: { label: 'Review #42', typeLabel: 'Review' },
                availability: { status: 'ready' },
                content: stagedMediaContent,
            }],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
        } as const;
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `composer-request-${++nextId}`,
            createSubscriptionId: () => `composer-subscription-${++nextId}`,
            transport: {
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: [
                                'activeComposer',
                                'readComposer',
                                'watchComposer',
                                'applyComposer',
                                'focusComposer',
                                'setComposerDecorations',
                                'acquireComposerInputLock',
                            ],
                            surface,
                        });
                        return;
                    }
                    if (message.kind === 'request') {
                        const resultByMethod = {
                            activeComposer: composer,
                            readComposer: { status: 'ready', snapshot },
                            applyComposer: { status: 'applied', revision: 4 },
                            focusComposer: { status: 'focused' },
                            setComposerDecorations: { status: 'set' },
                        } as const;
                        const result = resultByMethod[message.method as keyof typeof resultByMethod];
                        if (result !== undefined) {
                            receive?.({
                                wireVersion: 1,
                                kind: 'result',
                                identity,
                                requestId: message.requestId,
                                method: message.method,
                                result,
                            });
                        }
                    }
                    if (message.kind === 'subscribe') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                        });
                    }
                },
            },
        });

        expect(Reflect.get(api, 'activeComposer')).toEqual(expect.any(Function));
        await expect(api.activeComposer()).resolves.toEqual(composer);
        await expect(api.readComposer(composer)).resolves.toEqual({ status: 'ready', snapshot });

        const observed: unknown[] = [];
        const observation = await api.watchComposer(composer, (next) => observed.push(next));
        const watch = sent.find((message) => message.kind === 'subscribe' && message.method === 'watchComposer');
        expect(watch).toMatchObject({ payload: { ref: composer } });
        if (watch?.kind !== 'subscribe') throw new Error('watchComposer was not established');
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: watch.subscriptionId,
            event: snapshot,
        });
        expect(observed).toEqual([snapshot]);

        await expect(api.applyComposer(composer, {
            expectedRevision: 3,
            operations: [{
                kind: 'attachment.add',
                attachmentLocalId: 'review',
                value: {
                    key: 'review-42',
                    value: { reviewId: '42' },
                    presentation: { label: 'Review #42' },
                },
                content: stagedMediaContent,
            }],
        })).resolves.toEqual({ status: 'applied', revision: 4 });
        await expect(api.focusComposer(composer)).resolves.toEqual({ status: 'focused' });
        await expect(api.setComposerDecorations(composer, 'acme.diagnostics', null))
            .resolves.toEqual({ status: 'set' });

        const lock = await api.acquireComposerInputLock(composer, {
            reason: 'Checking the selected issue',
            mode: 'submit',
        });
        const lockRequest = sent.find((message) => (
            message.kind === 'subscribe' && message.method === 'acquireComposerInputLock'
        ));
        expect(lockRequest).toMatchObject({
            payload: {
                ref: composer,
                request: { reason: 'Checking the selected issue', mode: 'submit' },
            },
        });

        observation.dispose();
        lock.dispose();
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(2);
        expect(sent.filter((message) => message.kind === 'request').map((message) => (
            message.kind === 'request' ? [message.method, message.payload] : null
        ))).toEqual(expect.arrayContaining([
            ['activeComposer', undefined],
            ['readComposer', { ref: composer }],
            ['applyComposer', {
                ref: composer,
                transaction: {
                    expectedRevision: 3,
                    operations: [{
                        kind: 'attachment.add',
                        attachmentLocalId: 'review',
                        value: {
                            key: 'review-42',
                            value: { reviewId: '42' },
                            presentation: { label: 'Review #42' },
                        },
                        content: stagedMediaContent,
                    }],
                },
            }],
            ['focusComposer', { ref: composer }],
            ['setComposerDecorations', {
                ref: composer,
                key: 'acme.diagnostics',
                decorations: null,
            }],
        ]));
    });

    it('uses one negotiated opaque media-content boundary and fails closed on an older host', async () => {
        const composer = { kind: 'session', sessionId: 'session-1' } as const;
        const handle: ComposerContentHandleV1 = {
            v: 1,
            id: 'staged-image-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'com.acme.fixture', localId: 'image' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'hero.png',
            sizeBytes: 2,
            sha256: 'a'.repeat(64),
        };
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: (() => {
                let sequence = 0;
                return () => `media-content-${++sequence}`;
            })(),
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['pickComposerMedia', 'inspectComposerContent', 'releaseComposerContent'],
                            surface,
                        });
                        return;
                    }
                    if (message.kind !== 'request') return;
                    if (message.method === 'pickComposerMedia') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: handle,
                        });
                    }
                    if (message.method === 'inspectComposerContent') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: { offset: 0, bytesBase64: 'iVA=', eof: true },
                        });
                    }
                    if (message.method === 'releaseComposerContent') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                        });
                    }
                },
            },
        });

        await expect(api.pickComposerMedia(composer, {
            attachmentLocalId: 'image',
            kinds: ['image'],
        })).resolves.toEqual(handle);
        await expect(api.inspectComposerContent(handle, { offset: 0, maxBytes: 2 }))
            .resolves.toEqual({ offset: 0, bytes: new Uint8Array([0x89, 0x50]), eof: true });
        await expect(api.releaseComposerContent(handle)).resolves.toBeUndefined();
        expect(sent.filter((message) => message.kind === 'request').map((message) => (
            message.kind === 'request' ? [message.method, message.payload] : null
        ))).toEqual([
            ['pickComposerMedia', { ref: composer, request: { attachmentLocalId: 'image', kinds: ['image'] } }],
            ['inspectComposerContent', { handle, request: { offset: 0, maxBytes: 2 } }],
            ['releaseComposerContent', { handle }],
        ]);

        let oldHostReceive: ((message: unknown) => void) | undefined;
        const oldHostSent: PluginUiHostApiWireEnvelopeV1[] = [];
        const oldHost = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { oldHostReceive = listener; return { dispose: () => undefined }; },
                send(message) {
                    oldHostSent.push(message);
                    if (message.kind === 'negotiate') {
                        oldHostReceive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: [],
                            surface,
                        });
                    }
                },
            },
        });
        await expect(oldHost.pickComposerMedia(composer, {
            attachmentLocalId: 'image',
            kinds: ['image'],
        })).rejects.toMatchObject({ code: 'unsupported_method' });
        expect(oldHostSent.filter((message) => message.kind === 'request')).toHaveLength(0);
    });

    it('negotiates once and exposes the same typed domain API used by injected RN contexts', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const clientPromise = createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'executeAction', 'readResource', 'watchContext', 'watchResource', 'openSurface', 'diagnostic', 'readClipboard', 'writeClipboard', 'openExternalLink'],
                            surface,
                        });
                    }
                    if (message.kind === 'request' && message.method === 'context') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: 'context',
                            result: { surface, activity: { active: true } },
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { receive = undefined; } };
                },
            },
        });

        const api = await clientPromise;
        expect(api.version()).toEqual({
            apiVersion: '1.0.0',
            wireVersion: 1,
            methods: expect.arrayContaining(['executeAction', 'watchContext']),
        });
        expect(api.version().methods).toEqual(
            ['context', 'executeAction', 'readResource', 'watchContext', 'watchResource', 'openSurface', 'diagnostic', 'readClipboard', 'writeClipboard', 'openExternalLink'],
        );
        await expect(api.context()).resolves.toEqual(surface);
        expect(sent[0]).toMatchObject({ kind: 'negotiate', identity });
    });

    it('fails closed when a host omits the direct context result instead of reusing negotiation state', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'missing-context-result',
            transport: {
                send(message) {
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context'],
                            surface,
                        });
                    }
                    if (message.kind === 'request' && message.method === 'context') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: 'context',
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
            },
        });

        await expect(api.context()).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('keeps hosted-web context current after watch updates and final watcher retirement', async () => {
        const initialSurface = createSurfaceContextFixture({ colorScheme: 'light' });
        const darkSurface = createSurfaceContextFixture({
            colorScheme: 'dark',
            accountEncryptionMode: 'plain',
            theme: {
                ...surface.theme,
                colors: { ...surface.theme.colors, canvas: '#111111' },
            },
        });
        const lightSurface = createSurfaceContextFixture({
            colorScheme: 'light',
            accountEncryptionMode: 'e2ee',
            theme: {
                ...surface.theme,
                colors: { ...surface.theme.colors, canvas: '#eeeeee' },
            },
        });
        const hostOnlySurface = createSurfaceContextFixture({
            colorScheme: 'dark',
            accountEncryptionMode: 'plain',
            theme: {
                ...surface.theme,
                colors: { ...surface.theme.colors, canvas: '#050505' },
            },
        });
        let receive: ((message: unknown) => void) | undefined;
        let nextRequestId = 0;
        let nextSubscriptionId = 0;
        let hostSurface = initialSurface;
        let hostActive = true;
        const activities: boolean[] = [];
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            onContextActivity: (activity) => activities.push(activity.active),
            createRequestId: () => `request-${++nextRequestId}`,
            createSubscriptionId: () => `subscription-${++nextSubscriptionId}`,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1,
                        kind: 'negotiated',
                        identity,
                        apiVersion: '1.0.0',
                        methods: ['context', 'watchContext'],
                        surface: hostSurface,
                    });
                    if (message.kind === 'request' && message.method === 'context') receive?.({
                        wireVersion: 1,
                        kind: 'result',
                        identity,
                        requestId: message.requestId,
                        method: 'context',
                        result: { surface: hostSurface, activity: { active: hostActive } },
                    });
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
            },
        });
        const admitLatestContextWatcher = () => {
            const subscribe = sent.filter((message) => message.kind === 'subscribe').at(-1);
            receive?.({
                wireVersion: 1,
                kind: 'result',
                identity,
                requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
                method: 'watchContext',
            });
            return subscribe && 'subscriptionId' in subscribe ? subscribe.subscriptionId : '';
        };

        const firstContexts: SurfaceContext[] = [];
        const secondContexts: SurfaceContext[] = [];
        const firstEstablishing = api.watchContext((context) => firstContexts.push(context));
        const firstSubscriptionId = admitLatestContextWatcher();
        const firstSubscription = await firstEstablishing;
        const secondEstablishing = api.watchContext((context) => secondContexts.push(context));
        const secondSubscriptionId = admitLatestContextWatcher();
        const secondSubscription = await secondEstablishing;

        hostSurface = darkSurface;
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: firstSubscriptionId,
            event: { surface: darkSurface, activity: { active: true } },
        });
        expect(firstContexts).toEqual([darkSurface]);
        await expect(api.context()).resolves.toEqual(darkSurface);

        firstSubscription.dispose();
        hostSurface = lightSurface;
        hostActive = false;
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: firstSubscriptionId,
            event: { surface: lightSurface, activity: { active: false } },
        });
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: secondSubscriptionId,
            event: { surface: lightSurface, activity: { active: false } },
        });

        expect(firstContexts).toEqual([darkSurface]);
        expect(secondContexts).toEqual([lightSurface]);
        await expect(api.context()).resolves.toEqual(lightSurface);
        expect(activities).toEqual([true, true, false, false]);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(1);
        secondSubscription.dispose();
        hostSurface = hostOnlySurface;
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: secondSubscriptionId,
            event: hostOnlySurface,
        });
        expect(secondContexts).toEqual([lightSurface]);
        // The final listener is retired, but the direct context contract still
        // reads the host's current snapshot rather than retaining the prior
        // watch-delivered value indefinitely.
        await expect(api.context()).resolves.toEqual(hostOnlySurface);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(2);
    });

    it('carries selection currentness only from the exact returned Action object into executeAction', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'com.acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'com.acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const targetedSurface = {
            ...surface,
            targetedContributions: {
                target: {
                    pluginId: 'com.acme.fixture',
                    immutableGenerationId: 'target-generation-a',
                },
                points: [{
                    pointId: 'connection',
                    protocols: [{
                        protocol: { id: 'connection', version: 1 },
                        contributions: [{
                            contributor: {
                                pluginId: 'com.acme.provider',
                                contributionId: 'github-connection',
                                immutableGenerationId: 'provider-generation-a',
                            },
                            protocol: { id: 'connection', version: 1 },
                            operations: [operation],
                            surfaces: [],
                        }],
                    }],
                }],
            },
        };
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            apiRange: '^1.0.0',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'selectActionInput', 'executeAction'],
                            surface: targetedSurface,
                        });
                    }
                    if (message.kind === 'request') {
                        queueMicrotask(() => receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: message.method === 'selectActionInput'
                                ? {
                                    kind: 'submitted',
                                    action: operation.action,
                                    input: { repository: 'happier-dev/happier' },
                                    selection: {
                                        target: targetedSurface.targetedContributions.target,
                                        point: operation.point,
                                        contributor: operation.contributor,
                                    },
                                    connectedAccount: { kind: 'none' },
                                }
                                : null,
                        }));
                    }
                },
            },
        });

        const selected = await api.selectActionInput({
            operation,
        });
        if (selected.kind !== 'submitted') throw new Error('expected submitted selection');
        await api.executeAction(selected.action, selected.input);
        const selectedExecute = sent.at(-1);
        expect(selectedExecute).toMatchObject({
            kind: 'request',
            method: 'executeAction',
            payload: { action: operation.action, input: selected.input },
            targetedOperation: operation,
        });

        await api.executeAction({ ...selected.action }, selected.input);
        const reconstructedExecute = sent.at(-1);
        expect(reconstructedExecute).toMatchObject({
            kind: 'request',
            method: 'executeAction',
            payload: { action: operation.action, input: selected.input },
        });
        expect(reconstructedExecute).not.toHaveProperty('targetedOperation');
    });

    it('relays the explicit selected-operation carrier when a different Action consumes it', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'com.acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'com.acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const targetedSurface = {
            ...surface,
            targetedContributions: {
                target: {
                    pluginId: 'com.acme.fixture',
                    immutableGenerationId: 'target-generation-a',
                },
                points: [],
            },
        };
        const accountA = {
            service: { pluginId: 'com.acme.provider', localId: 'github' },
            accountId: 'account-a',
        } as const;
        const accountB = {
            service: { pluginId: 'com.acme.provider', localId: 'github' },
            accountId: 'account-b',
        } as const;
        const selectedResults = [
            {
                kind: 'submitted' as const,
                action: operation.action,
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: targetedSurface.targetedContributions.target,
                    point: operation.point,
                    contributor: operation.contributor,
                },
                connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: accountA },
            },
            {
                kind: 'submitted' as const,
                action: operation.action,
                input: { repository: 'happier-dev/happier' },
                selection: {
                    target: targetedSurface.targetedContributions.target,
                    point: operation.point,
                    contributor: operation.contributor,
                },
                connectedAccount: { kind: 'selected' as const, fieldPath: 'credentialRef', ref: accountB },
            },
        ];
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        let selectionIndex = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['selectActionInput', 'executeAction'],
                            surface: targetedSurface,
                        });
                    }
                    if (message.kind === 'request') {
                        queueMicrotask(() => receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: message.method === 'selectActionInput'
                                ? selectedResults[selectionIndex++]
                                : null,
                        }));
                    }
                },
            },
        });

        const first = await api.selectActionInput({ operation });
        const second = await api.selectActionInput({ operation });
        if (first.kind !== 'submitted' || second.kind !== 'submitted') {
            throw new Error('expected submitted selections');
        }

        // The Channels-style outer action is intentionally different from the
        // selected provider operation. The explicit selection association is
        // what must survive the generic relay; the two results have identical
        // stripped input but different Account refs.
        const outerAction = { pluginId: 'com.acme.channels', localId: 'connection/prepare' } as const;
        const outerInput = {
            providerSetupInput: { repository: 'happier-dev/happier' },
            credentialRef: accountB,
        } as const;
        await api.executeAction(outerAction, outerInput, {
            selectedActionInput: { operation, result: first },
        });
        const firstRelay = sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1);
        expect(firstRelay).toMatchObject({
            kind: 'request',
            method: 'executeAction',
            payload: { action: outerAction, input: outerInput },
            targetedOperation: operation,
            selectedActionInput: selectedResults[0],
        });

        await api.executeAction(outerAction, outerInput, {
            selectedActionInput: { operation, result: second },
        });
        const secondRelay = sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1);
        expect(secondRelay).toMatchObject({
            kind: 'request',
            method: 'executeAction',
            payload: { action: outerAction, input: outerInput },
            targetedOperation: operation,
            selectedActionInput: selectedResults[1],
        });
        expect(secondRelay).not.toMatchObject({ selectedActionInput: selectedResults[0] });

        // JSON identity does not survive hosted execution. The client only
        // carries a schema-valid value; the mounted host decides whether its
        // exact operation/result pair is currently active.
        const deepEqualSecond = structuredClone(second);
        await api.executeAction(outerAction, outerInput, {
            selectedActionInput: { operation, result: deepEqualSecond },
        });
        expect(sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1)).toMatchObject({
            targetedOperation: operation,
            selectedActionInput: selectedResults[1],
        });

        const tampered = {
            ...second,
            connectedAccount: {
                ...second.connectedAccount,
                ref: { ...accountB, accountId: 'account-tampered' },
            },
        };
        await api.executeAction(outerAction, outerInput, {
            selectedActionInput: { operation, result: tampered },
        });
        expect(sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1)).toMatchObject({
            targetedOperation: operation,
            selectedActionInput: tampered,
        });

        // The result does not carry a role. The explicit carrier must preserve
        // the original admitted operation rather than inventing `setup`.
        const sameActionDifferentRole = { ...operation, role: 'validate' } as const;
        await api.executeAction(outerAction, outerInput, {
            selectedActionInput: { operation: sameActionDifferentRole, result: second },
        });
        expect(sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1)).toMatchObject({
            targetedOperation: sameActionDifferentRole,
            selectedActionInput: selectedResults[1],
        });

        const terminalRelayOptions = {
            selectedActionInput: { operation, result: second },
            // This mounted host-private request fact is intentionally not part
            // of PluginUiActionExecutionOptions' public author surface.
            consumeSelectedActionInput: true as const,
        };
        await api.executeAction(outerAction, outerInput, terminalRelayOptions);
        expect(sent.filter((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        )).at(-1)).toMatchObject({
            targetedOperation: operation,
            selectedActionInput: selectedResults[1],
            consumeSelectedActionInput: true,
        });
    });

    it('keeps an exact selection request cancellable after its submitted result settles', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'com.acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'com.acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const targetedSurface = {
            ...surface,
            targetedContributions: {
                target: {
                    pluginId: 'com.acme.fixture',
                    immutableGenerationId: 'target-generation-a',
                },
                points: [],
            },
        };
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const selectionLifetime = new AbortController();
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'selection-lifetime-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['selectActionInput'],
                            surface: targetedSurface,
                        });
                    }
                    if (message.kind === 'request' && message.method === 'selectActionInput') {
                        queueMicrotask(() => receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: 'selectActionInput',
                            result: {
                                kind: 'submitted',
                                action: operation.action,
                                input: { repository: 'happier-dev/happier' },
                                selection: {
                                    target: targetedSurface.targetedContributions.target,
                                    point: operation.point,
                                    contributor: operation.contributor,
                                },
                                connectedAccount: { kind: 'none' },
                            },
                        }));
                    }
                },
            },
        });

        await expect(api.selectActionInput({ operation }, { signal: selectionLifetime.signal }))
            .resolves.toMatchObject({ kind: 'submitted' });
        selectionLifetime.abort('selection_lifetime_retired');
        expect(sent.filter((message) => message.kind === 'cancel')).toEqual([
            expect.objectContaining({ requestId: 'selection-lifetime-request' }),
        ]);
    });

    it('returns the literal no-invoke Session draft without an executable Action', async () => {
        const serverStartDraft = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
        };
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send(message) {
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'selectActionInput'],
                            surface,
                        });
                    }
                    if (message.kind === 'request' && message.method === 'selectActionInput') {
                        queueMicrotask(() => receive?.({
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: message.requestId,
                            method: message.method,
                            result: { kind: 'serverStartDraft', draft: serverStartDraft },
                        }));
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { receive = undefined; } };
                },
            },
        });

        const selected = await api.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            draft: { directory: '/workspace' },
        });
        expect(selected).toEqual({ kind: 'serverStartDraft', draft: serverStartDraft });
        expect('action' in selected).toBe(false);
    });

    it('emits a host ActionSpec through the Protocol mounted-action request grammar', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['executeAction'],
                            surface,
                        });
                    }
                    if (message.kind === 'request') {
                        queueMicrotask(() => {
                            receive?.({
                                wireVersion: 1,
                                kind: 'result',
                                identity,
                                requestId: message.requestId,
                                method: message.method,
                                result: null,
                            });
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { receive = undefined; } };
                },
            },
        });

        await expect(api.executeAction('plugins.reload', { pluginId: identity.pluginId })).resolves.toBeNull();

        const request = sent.find((message) => (
            message.kind === 'request' && message.method === 'executeAction'
        ));
        expect(request).toBeDefined();
        if (!request || request.kind !== 'request') throw new Error('executeAction request was not sent.');
        expect(PluginUiExecuteActionRequestV1Schema.safeParse(request.payload).success).toBe(true);
    });

    it('rejects a malformed structured Action reference before sending any transport request', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['executeAction'],
                            surface,
                        });
                    }
                    if (message.kind === 'request') {
                        queueMicrotask(() => {
                            receive?.({
                                wireVersion: 1,
                                kind: 'result',
                                identity,
                                requestId: message.requestId,
                                method: message.method,
                                result: null,
                            });
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { receive = undefined; } };
                },
            },
        });
        sent.length = 0;
        // Plugin code crosses a runtime boundary; strict Protocol validation
        // must reject this rather than silently projecting it to two fields.
        const malformedAction = {
            pluginId: 'com.acme.fixture',
            localId: 'refresh',
            unexpected: true,
        } as unknown as PluginReference;

        await expect(api.executeAction(malformedAction, null)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        expect(sent).toEqual([]);
    });

    it('accepts an exact destination mount and rejects an invented container', async () => {
        const readMount = async (surfaceContext: unknown) => {
            let receive: ((message: unknown) => void) | undefined;
            const api = await createPluginUiHostApiClientFromTransport({
                identity,
                transport: {
                    send(message) {
                        if (message.kind === 'negotiate') {
                            receive?.({
                                wireVersion: 1,
                                kind: 'negotiated',
                                identity,
                                apiVersion: '1.0.0',
                                methods: ['context'],
                                surface: surfaceContext,
                            });
                        }
                        if (message.kind === 'request' && message.method === 'context') {
                            receive?.({
                                wireVersion: 1,
                                kind: 'result',
                                identity,
                                requestId: message.requestId,
                                method: 'context',
                                result: { surface: surfaceContext, activity: { active: true } },
                            });
                        }
                    },
                    subscribe(listener) {
                        receive = listener;
                        return { dispose: () => { receive = undefined; } };
                    },
                },
            });
            return (await api.context()).mount;
        };

        const destination = surface.mount.kind === 'destination'
            ? surface.mount.destination
            : { pluginId: 'com.acme.fixture', localId: 'details' };
        await expect(readMount({
            ...surface,
            mount: { kind: 'destination', destination, container: 'detailsTab' },
        })).resolves.toEqual({ kind: 'destination', destination, container: 'detailsTab' });
        await expect(readMount({
            ...surface,
            mount: { kind: 'destination', destination, container: 'session.preview' },
        })).rejects.toMatchObject({
            code: 'invalid_payload',
        });
    });

    it('requires the exact Account encryption-mode disclosure in every surface context', async () => {
        const readSurface = async (surfaceContext: unknown) => {
            let receive: ((message: unknown) => void) | undefined;
            const api = await createPluginUiHostApiClientFromTransport({
                identity,
                transport: {
                    send(message) {
                        if (message.kind === 'negotiate') {
                            receive?.({
                                wireVersion: 1,
                                kind: 'negotiated',
                                identity,
                                apiVersion: '1.0.0',
                                methods: ['context'],
                                surface: surfaceContext,
                            });
                        }
                        if (message.kind === 'request' && message.method === 'context') {
                            receive?.({
                                wireVersion: 1,
                                kind: 'result',
                                identity,
                                requestId: message.requestId,
                                method: 'context',
                                result: { surface: surfaceContext, activity: { active: true } },
                            });
                        }
                    },
                    subscribe(listener) {
                        receive = listener;
                        return { dispose: () => { receive = undefined; } };
                    },
                },
            });
            return await api.context();
        };

        await expect(readSurface({
            ...surface,
            accountEncryptionMode: 'plain',
        })).resolves.toMatchObject({ accountEncryptionMode: 'plain' });
        const { accountEncryptionMode: omittedAccountEncryptionMode, ...withoutAccountEncryptionMode } = surface;
        void omittedAccountEncryptionMode;
        await expect(readSurface(withoutAccountEncryptionMode)).rejects.toMatchObject({
            code: 'invalid_payload',
        });
        await expect(readSurface({
            ...surface,
            accountEncryptionMode: 'unknown',
        })).rejects.toMatchObject({
            code: 'invalid_payload',
        });
    });

    it('rejects stale-generation results and makes every operation unavailable after disconnect', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let transportDisposals = 0;
        const apiPromise = createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'request-1',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'executeAction'],
                            surface,
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => { transportDisposals += 1; } };
                },
            },
        });
        const api = await apiPromise;
        const action = api.executeAction('summarize', { selection: 'all' });
        receive?.({
            wireVersion: 1,
            kind: 'result',
            identity: { ...identity, generation: 'generation-1' },
            requestId: 'request-1',
            method: 'executeAction',
            result: null,
        });
        receive?.({ wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' });

        await expect(action).rejects.toMatchObject({ code: 'daemon_offline' });
        await expect(api.context()).rejects.toBeInstanceOf(PluginUiHostApiClientError);
        expect(transportDisposals).toBe(1);
    });

    it('binds subscription events to identity and disposes host subscriptions exactly once', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => 'subscription-1',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context', 'watchContext'],
                            surface,
                        });
                    }
                },
                subscribe(listener) {
                    receive = listener;
                    return { dispose: () => undefined };
                },
            },
        });
        const contexts: SurfaceContext[] = [];
        const establishing = api.watchContext((context) => contexts.push(context));
        const subscribe = sent.find((message) => message.kind === 'subscribe');
        receive?.({
            wireVersion: 1,
            kind: 'result',
            identity,
            requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
            method: 'watchContext',
        });
        const subscription = await establishing;
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity,
            subscriptionId: 'subscription-1',
            event: { surface, activity: { active: true } },
        });
        receive?.({
            wireVersion: 1,
            kind: 'subscription',
            identity: { ...identity, generation: 'old' },
            subscriptionId: 'subscription-1',
            event: { ...surface, locale: 'fr' },
        });
        subscription.dispose();
        subscription.dispose();

        expect(contexts).toEqual([surface]);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(1);
    });

    it('resolves a context subscription only after host admission and delivers updates in order', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => 'subscription-ordered',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context', 'watchContext'], surface,
                    });
                },
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
            },
        });

        const locales: string[] = [];
        let settled = false;
        const establishing = api.watchContext((context) => locales.push(context.locale));
        void establishing.then(() => { settled = true; }, () => { settled = true; });

        // An event that arrives before admission must not be lost, and the
        // establishment promise must not settle until the host acknowledges.
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: 'subscription-ordered',
            event: { surface: { ...surface, locale: 'fr' }, activity: { active: true } },
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(locales).toEqual([]);

        const subscribe = sent.find((message) => message.kind === 'subscribe');
        expect(subscribe).toBeDefined();
        receive?.({
            wireVersion: 1, kind: 'result', identity,
            requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
            method: 'watchContext',
        });
        const subscription = await establishing;
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: 'subscription-ordered',
            event: { surface: { ...surface, locale: 'de' }, activity: { active: true } },
        });

        expect(locales).toEqual(['fr', 'de']);
        subscription.dispose();
    });

    it('rejects a denied establishment with a typed error instead of yielding a disposable', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => 'subscription-denied',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context', 'watchContext'], surface,
                    });
                },
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
            },
        });

        let delivered = 0;
        const establishing = api.watchContext(() => { delivered += 1; });
        const subscribe = sent.find((message) => message.kind === 'subscribe');
        receive?.({
            wireVersion: 1, kind: 'error', identity,
            requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
            method: 'watchContext',
            error: { name: 'PluginError', code: 'denied' },
        });

        await expect(establishing).rejects.toMatchObject({ code: 'denied' });
        // A denied subscription never delivers, and nothing is left registered
        // for the host to have to retire.
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: 'subscription-denied', event: surface,
        });
        expect(delivered).toBe(0);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(0);
    });

    it('retires a late host admission when establishment is abandoned', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const controller = new AbortController();
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => 'subscription-late',
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context', 'watchContext'], surface,
                    });
                },
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
            },
        });

        let delivered = 0;
        const establishing = api.watchContext(() => { delivered += 1; }, { signal: controller.signal });
        controller.abort();
        await expect(establishing).rejects.toMatchObject({ code: 'aborted' });

        const subscribe = sent.find((message) => message.kind === 'subscribe');
        receive?.({
            wireVersion: 1, kind: 'result', identity,
            requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
            method: 'watchContext',
        });
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: 'subscription-late', event: surface,
        });

        expect(delivered).toBe(0);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(1);
    });

    it('terminates a subscription on a malformed event and isolates a listener that throws', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `request-${++nextId}`,
            createSubscriptionId: () => `subscription-${nextId}`,
            transport: {
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context', 'watchContext', 'diagnostic'], surface,
                    });
                },
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
            },
        });

        const admit = () => {
            const subscribe = sent.filter((message) => message.kind === 'subscribe').at(-1);
            receive?.({
                wireVersion: 1, kind: 'result', identity,
                requestId: subscribe && 'requestId' in subscribe ? subscribe.requestId : '',
                method: 'watchContext',
            });
            return subscribe && 'subscriptionId' in subscribe ? subscribe.subscriptionId : '';
        };

        let throwingDeliveries = 0;
        const throwing = api.watchContext(() => {
            throwingDeliveries += 1;
            throw new Error('author listener failed');
        });
        const throwingId = admit();
        await throwing;
        expect(() => receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: throwingId, event: { surface, activity: { active: true } },
        })).not.toThrow();
        expect(throwingDeliveries).toBe(1);
        // The listener failure is isolated: the subscription stays live.
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: throwingId, event: { surface, activity: { active: true } },
        });
        expect(throwingDeliveries).toBe(2);

        let malformedDeliveries = 0;
        const malformed = api.watchContext(() => { malformedDeliveries += 1; });
        const malformedId = admit();
        await malformed;
        expect(() => receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: malformedId, event: { ...surface, unexpected: true },
        })).not.toThrow();
        expect(malformedDeliveries).toBe(0);
        // A malformed event terminates THAT subscription: a following valid
        // event is not delivered, and the host was told to retire it.
        receive?.({
            wireVersion: 1, kind: 'subscription', identity,
            subscriptionId: malformedId, event: { surface, activity: { active: true } },
        });
        expect(malformedDeliveries).toBe(0);
        expect(sent.filter((message) => message.kind === 'disposeHostResource')).toHaveLength(1);
    });

    it('fails boundedly when the host never completes negotiation', async () => {
        vi.useFakeTimers();
        const pending = createPluginUiHostApiClientFromTransport({
            identity,
            negotiationTimeoutMs: 25,
            transport: {
                send: () => undefined,
                subscribe: () => ({ dispose: () => undefined }),
            },
        });
        const error = pending.catch((cause: unknown) => cause);
        await vi.advanceTimersByTimeAsync(25);
        await expect(error).resolves.toMatchObject({ code: 'negotiation_timeout' });
    });

    it('handles a sticky disconnect replayed during transport subscription', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                send: () => undefined,
                subscribe(listener) {
                    listener({ wireVersion: 1, kind: 'disconnected', identity, reason: 'already_offline' });
                    return { dispose: () => undefined };
                },
            },
        })).rejects.toMatchObject({ code: 'already_offline' });
    });

    it('fails closed when an injected request-id generator repeats an in-flight id', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'repeated',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const first = api.executeAction('first', null);
        const second = api.executeAction('second', null);
        await expect(second).rejects.toMatchObject({ code: 'duplicate_request_id' });
        expect(sent.filter((message) => message.kind === 'request')).toHaveLength(1);
        receive?.({ wireVersion: 1, kind: 'result', identity, requestId: 'repeated', method: 'executeAction', result: null });
        await expect(first).resolves.toBeNull();
    });

    it('never reuses a settled request id that a late response could target', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'settled-id',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const first = api.executeAction('first', null);
        receive?.({ wireVersion: 1, kind: 'result', identity, requestId: 'settled-id', method: 'executeAction', result: null });
        await expect(first).resolves.toBeNull();
        await expect(api.executeAction('second', null)).rejects.toMatchObject({ code: 'duplicate_request_id' });
        expect(sent.filter((message) => message.kind === 'request')).toHaveLength(1);
    });

    it('rejects unknown and malformed optional surface context fields during negotiation', async () => {
        let transportDisposals = 0;
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => listener({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'],
                        surface: { ...surface, session: { id: 42 }, ambientCredential: 'secret' },
                    }));
                    return { dispose: () => { transportDisposals += 1; } };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'invalid_payload' });
        expect(transportDisposals).toBe(1);
    });

    it('never abandons a human-held operation on the handshake deadline', async () => {
        vi.useFakeTimers();
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            negotiationTimeoutMs: 25,
            createRequestId: () => 'human-held-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['selectActionInput'], surface,
                    });
                },
            },
        });
        const settlements: string[] = [];
        const selection = api.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
        }).then(
            () => 'resolved',
            (error: unknown) => `rejected:${(error as { code?: string }).code ?? 'unknown'}`,
        );
        void selection.then((label) => { settlements.push(label); });
        // A person reading and filling the form takes far longer than any
        // handshake budget. The host still owns the answer.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(settlements).toEqual([]);
        expect(sent.map((message) => message.kind)).toEqual(['negotiate', 'request']);
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'human-held-request',
            method: 'selectActionInput', result: { kind: 'cancelled' },
        });
        await expect(selection).resolves.toBe('resolved');
    });

    it('forwards cancellation for an in-flight domain operation before rejecting locally', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const controller = new AbortController();
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'cancelled-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('slow-action', null, { signal: controller.signal });
        controller.abort();
        await expect(operation).rejects.toMatchObject({ code: 'aborted' });
        expect(sent.map((message) => message.kind)).toEqual(['negotiate', 'request', 'cancel']);
    });

    // The hosted-web carrier settles caller withdrawal promptly for EVERY
    // method — this matrix pins that policy across the settlement families
    // (an outward navigation, an Action execution, a Composer transaction, a
    // decision, a read, and an outward effect), mirroring the direct RN
    // carrier's matrix so neither carrier can regress to a per-method
    // allowlist. Probes are named here but classified by the canonical
    // outward-effect owner on the RN side; this client has no per-method
    // settlement policy to duplicate.
    it.each([
        {
            method: 'openNewSession',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.openNewSession({ prompt: 'Repair CI' }, { signal }),
        },
        {
            method: 'executeAction',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.executeAction('slow-action', null, { signal }),
        },
        {
            method: 'applyComposer',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.applyComposer(
                    { kind: 'session', sessionId: 'session-1' },
                    { expectedRevision: 3, operations: [{ kind: 'text.clear' }] },
                    { signal },
                ),
        },
        {
            method: 'confirm',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.confirm('Delete the preview?', { signal }),
        },
        {
            method: 'readResource',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.readResource('plugin.preview.resource', { signal }),
        },
        {
            method: 'openSurface',
            invoke: (api: Awaited<ReturnType<typeof createPluginUiHostApiClientFromTransport>>, signal: AbortSignal) =>
                api.openSurface('plugin.preview.details', undefined, { signal }),
        },
    ] as const)('cancels a parked $method at caller withdrawal and ignores the late host answer', async ({ method, invoke }) => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const controller = new AbortController();
        let requestSequence = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `withdrawal-${method}-${++requestSequence}`,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                            methods: ['openNewSession', 'executeAction', 'applyComposer', 'confirm', 'readResource', 'openSurface'],
                            surface,
                        });
                    }
                },
            },
        });

        const operation = invoke(api, controller.signal);
        controller.abort();
        await expect(operation).rejects.toMatchObject({ code: 'aborted' });

        // Withdrawal is forwarded to the host beside the prompt local
        // settlement, and a host answer that arrives after it is inert.
        expect(sent.filter((message) => message.kind === 'cancel')).toHaveLength(1);
        const requestEnvelope = sent.find((message) => message.kind === 'request' && message.method === method);
        expect(requestEnvelope).toBeDefined();
        if (requestEnvelope?.kind !== 'request') throw new Error('request envelope missing');
        receive?.({
            wireVersion: 1, kind: 'result', identity,
            requestId: requestEnvelope.requestId,
            method,
            result: null,
        });
        await expect(operation).rejects.toMatchObject({ code: 'aborted' });
    });

    it('preserves shared PluginError details, remediation, and diagnostics from the wire', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'error-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('restricted-action', null);
        receive?.({
            wireVersion: 1,
            kind: 'error',
            identity,
            requestId: 'error-request',
            method: 'executeAction',
            error: {
                name: 'PluginError',
                code: 'permission_denied',
                retryable: false,
                details: { permission: 'clipboard' },
                remediation: { kind: 'openSettings', path: 'plugins.permissions' },
                diagnostics: [{ code: 'permission_denied', severity: 'warning', message: 'Permission is required.' }],
            },
        });

        const failure = await operation.catch((error: unknown) => error);

        expect(isPluginError(failure)).toBe(true);
        expect(failure).toMatchObject({
            name: 'PluginError',
            code: 'permission_denied',
            retryable: false,
            details: { permission: 'clipboard' },
            remediation: { kind: 'openSettings', path: 'plugins.permissions' },
            diagnostics: [{ code: 'permission_denied', severity: 'warning' }],
            data: {
                name: 'PluginError',
                code: 'permission_denied',
                retryable: false,
                details: { permission: 'clipboard' },
                remediation: { kind: 'openSettings', path: 'plugins.permissions' },
                diagnostics: [{ code: 'permission_denied', severity: 'warning' }],
            },
        });
    });

    it('does not correlate an error response to a request for a different method', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'mismatched-error-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['executeAction', 'readClipboard'], surface,
                    });
                },
            },
        });
        const operation = api.executeAction('action', null);
        receive?.({
            wireVersion: 1,
            kind: 'error',
            identity,
            requestId: 'mismatched-error-request',
            method: 'readClipboard',
            error: { name: 'PluginError', code: 'clipboard_denied' },
        });

        await expect(operation).rejects.toMatchObject({ code: 'invalid_response_method' });
    });

    it('throws typed unavailability for subscriptions instead of returning a silent no-op', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                },
            },
        });
        await expect(api.watchContext(() => undefined)).rejects.toMatchObject({ code: 'unsupported_method' });
        receive?.({ wireVersion: 1, kind: 'disconnected', identity, reason: 'daemon_offline' });
        await expect(api.watchContext(() => undefined)).rejects.toMatchObject({ code: 'ui_host_unavailable' });
    });

    it('qualifies bare destinations to the caller and preserves explicit cross-plugin destinations for the host registry', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                            methods: ['openSurface'], surface,
                        });
                        return;
                    }
                    if (message.kind === 'request') {
                        receive?.({
                            wireVersion: 1, kind: 'result', identity,
                            requestId: message.requestId, method: message.method, result: null,
                        });
                    }
                },
            },
        });

        await api.openSurface('detail', { itemId: 'item-7' }, {
            subPath: 'nested/detail',
            instanceKey: 'detail-7',
        });
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'openSurface',
            payload: {
                destination: { pluginId: identity.pluginId, localId: 'detail' },
                input: { itemId: 'item-7' },
                subPath: 'nested/detail',
                instanceKey: 'detail-7',
            },
        });

        await api.openSurface({ pluginId: 'com.acme.other', localId: 'detail' });
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'openSurface',
            payload: { destination: { pluginId: 'com.acme.other', localId: 'detail' } },
        });

        await api.openSurface({ pluginId: identity.pluginId, localId: 'same-plugin-detail' });
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'openSurface',
            payload: { destination: { pluginId: identity.pluginId, localId: 'same-plugin-detail' } },
        });

        // Absent input must not be sent as an explicit key: the host distinguishes
        // "opened without input" from an author-supplied value, and a fabricated
        // `input: null` would erase that distinction (EU-5a).
        await api.openSurface('detail');
        const withoutInput = sent.at(-1) as Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' }>;
        expect(withoutInput.payload).toEqual({
            destination: { pluginId: identity.pluginId, localId: 'detail' },
        });
        expect(withoutInput.payload).not.toHaveProperty('input');
    });

    it('replaces the page location through the host and renders the location the host settled on', async () => {
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                            methods: ['replacePageLocation'], surface,
                        });
                        return;
                    }
                    if (message.kind === 'request') {
                        receive?.({
                            wireVersion: 1, kind: 'result', identity,
                            requestId: message.requestId, method: message.method,
                            // The host settles on its own canonical location, which
                            // is deliberately NOT the string the caller sent.
                            result: { subPath: 'entries/7' },
                        });
                    }
                },
            },
        });

        await expect(api.replacePageLocation('/entries/7/', { backLocation: '/entries/' }))
            .resolves.toEqual({ subPath: 'entries/7' });
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'replacePageLocation',
            payload: { subPath: 'entries/7', backLocation: 'entries' },
        });

        // No declared Back step must not be sent as an explicit key: the host
        // distinguishes "this location has no Back step" from a nominated one.
        await api.replacePageLocation('');
        const withoutBack = sent.at(-1) as Extract<PluginUiHostApiWireEnvelopeV1, { kind: 'request' }>;
        expect(withoutBack.payload).toEqual({ subPath: '' });
        expect(withoutBack.payload).not.toHaveProperty('backLocation');

        // A location the page could never navigate to is refused before it
        // reaches the host, so an escape attempt never becomes a route.
        await expect(api.replacePageLocation('../escape')).rejects.toMatchObject({ code: 'invalid_payload' });
        await expect(api.replacePageLocation('ok', { backLocation: '../escape' }))
            .rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('refuses a page-location settlement the host did not answer with a canonical location', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') {
                        receive?.({
                            wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                            methods: ['replacePageLocation'], surface,
                        });
                        return;
                    }
                    if (message.kind === 'request') {
                        receive?.({
                            wireVersion: 1, kind: 'result', identity,
                            requestId: message.requestId, method: message.method, result: null,
                        });
                    }
                },
            },
        });

        await expect(api.replacePageLocation('a')).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('does not expose the negotiated surface snapshot as an unadvertised context method', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: [], surface,
                    });
                },
            },
        });

        await expect(api.context()).rejects.toMatchObject({ code: 'unsupported_method' });
    });

    it('rejects a negotiated domain API major that the client cannot implement', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => listener({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '2.0.0',
                        methods: ['context'], surface,
                    }));
                    return { dispose: () => undefined };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'incompatible_api_version' });
    });

    it('fails closed when a transport tries to renegotiate the same generation', async () => {
        await expect(createPluginUiHostApiClientFromTransport({
            identity,
            transport: {
                subscribe(listener) {
                    queueMicrotask(() => {
                        listener({ wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: ['context'], surface });
                        listener({ wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0', methods: ['context'], surface: { ...surface, locale: 'fr' } });
                    });
                    return { dispose: () => undefined };
                },
                send: () => undefined,
            },
        })).rejects.toMatchObject({ code: 'invalid_negotiation' });
    });

    it('transports only an opaque openable-content ref and strictly decodes bounded stat/read results', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let requestNumber = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const ref = { kind: 'workspaceFile', handle: 'mount_ABC-123' } as const;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `openable-${++requestNumber}`,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['statOpenableContent', 'readOpenableContent'], surface,
                    });
                },
            },
        });

        const stat = api.statOpenableContent(ref);
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'statOpenableContent',
            payload: { ref },
        });
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'openable-1', method: 'statOpenableContent',
            result: {
                status: 'ready', contentClass: 'text', mimeType: 'text/markdown', extension: '.md',
                sizeBytes: 12, revision: 'revision-1',
            },
        });
        await expect(stat).resolves.toEqual({
            status: 'ready', contentClass: 'text', mimeType: 'text/markdown', extension: '.md',
            sizeBytes: 12, revision: 'revision-1',
        });

        const read = api.readOpenableContent({ ref, expectedRevision: 'revision-1' });
        expect(sent.at(-1)).toMatchObject({
            kind: 'request',
            method: 'readOpenableContent',
            payload: { ref, expectedRevision: 'revision-1' },
        });
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'openable-2', method: 'readOpenableContent',
            result: {
                status: 'ready', revision: 'revision-1', content: { kind: 'utf8', text: 'hello world' },
            },
        });
        await expect(read).resolves.toEqual({
            status: 'ready', revision: 'revision-1', content: { kind: 'utf8', text: 'hello world' },
        });

        const malformed = api.readOpenableContent({ ref, expectedRevision: 'revision-1' });
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'openable-3', method: 'readOpenableContent',
            result: {
                status: 'ready', revision: 'revision-1', content: { kind: 'utf8', text: 'hello world' },
                absolutePath: '/private/workspace/notes.md',
            },
        });
        await expect(malformed).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('rejects malformed resource bytes instead of silently decoding corrupted base64', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => 'resource-request',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['readResource'], surface,
                    });
                },
            },
        });
        const resource = api.readResource('logo');
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'resource-request', method: 'readResource',
            result: { contentType: 'image/png', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: '***' },
        });
        await expect(resource).rejects.toMatchObject({ code: 'invalid_payload' });
    });

    it('retains only an exact resource-watch admission digest from the host acknowledgement', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let requestNumber = 0;
        let subscriptionNumber = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `resource-watch-request-${++requestNumber}`,
            createSubscriptionId: () => `resource-watch-subscription-${++subscriptionNumber}`,
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1,
                        kind: 'negotiated',
                        identity,
                        apiVersion: '1.0.0',
                        methods: ['watchResource'],
                        surface,
                    });
                },
            },
        });

        const establish = async (resultFor: (subscriptionId: string) => unknown) => {
            const establishing = api.watchResource('live-status', () => undefined);
            const request = sent.filter((message) => (
                message.kind === 'subscribe' && message.method === 'watchResource'
            )).at(-1);
            if (!request || request.kind !== 'subscribe') {
                throw new Error('watchResource was not established');
            }
            receive?.({
                wireVersion: 1,
                kind: 'result',
                identity,
                requestId: request.requestId,
                method: request.method,
                result: resultFor(request.subscriptionId),
            });
            return await establishing;
        };

        const digest = `sha256:${'a'.repeat(64)}`;
        const admitted = await establish((subscriptionId) => ({ subscriptionId, digest }));
        expect(admitted).toMatchObject({ admittedDigest: digest });

        // A host result is only a baseline for the subscription it actually
        // admitted. Keeping either of these would let an unrelated/malformed
        // acknowledgement suppress the Resource store's required resync.
        const mismatched = await establish(() => ({ subscriptionId: 'another-watch', digest }));
        expect(mismatched).not.toHaveProperty('admittedDigest');
        const malformed = await establish((subscriptionId) => ({ subscriptionId, digest: 'not-a-digest' }));
        expect(malformed).not.toHaveProperty('admittedDigest');

        admitted.dispose();
        mismatched.dispose();
        malformed.dispose();
    });

    it('rejects unknown resource result and event fields at the domain boundary', async () => {
        let receive: ((message: unknown) => void) | undefined;
        let nextId = 0;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `strict-resource-${++nextId}`,
            createSubscriptionId: () => 'strict-resource-subscription',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    // This mount installed `readResource` only, which is what
                    // makes the `unsupported_method` control below decisive.
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['readResource'], surface,
                    });
                },
            },
        });
        const resource = api.readResource('logo');
        receive?.({
            wireVersion: 1, kind: 'result', identity, requestId: 'strict-resource-1', method: 'readResource',
            result: { contentType: 'image/png', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: '', ambientCredential: 'secret' },
        });
        await expect(resource).rejects.toMatchObject({ code: 'invalid_payload' });

        // EU-4b: `watchResource` is a published member, but a mount that did
        // not install it does not advertise it, so establishing one is rejected
        // as `unsupported_method` and no subscribe envelope is ever sent. The
        // `invalidated` arm's strictness stays owned by the Protocol schema, and
        // malformed-event termination plus listener isolation are proven above
        // through `watchContext`, which shares the one delivery path.
        await expect(api.watchResource('logo', () => undefined))
            .rejects.toMatchObject({ code: 'unsupported_method' });
        expect(sent.filter((message) => message.kind === 'subscribe')).toHaveLength(0);
    });

    it('fails closed when an injected subscription-id generator repeats an active id', async () => {
        let receive: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        let requestNumber = 0;
        const api = await createPluginUiHostApiClientFromTransport({
            identity,
            createRequestId: () => `subscription-request-${++requestNumber}`,
            createSubscriptionId: () => 'repeated-subscription',
            transport: {
                subscribe(listener) { receive = listener; return { dispose: () => undefined }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') receive?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['watchContext'], surface,
                    });
                },
            },
        });
        void api.watchContext(() => undefined).catch(() => undefined);
        await expect(api.watchContext(() => undefined)).rejects.toMatchObject({ code: 'duplicate_subscription_id' });
        expect(sent.filter((message) => message.kind === 'subscribe')).toHaveLength(1);
    });
});
