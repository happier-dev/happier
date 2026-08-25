import { afterEach, describe, expect, it } from 'vitest';

import type { PluginUiHostApiWireEnvelopeV1 } from '@happier-dev/protocol/plugins/ui';

import { createPluginUiHostApiClient, createPluginUiRenderContext } from './client.js';
import { PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, type PluginUiHostApiClientBootstrap } from './clientBootstrap.js';
import type { HostedWebPluginUiClientRealm } from './hostedWebClientBootstrap.js';
import { createSurfaceContextFixture } from './surfaceContext.fixture.js';

const surface = createSurfaceContextFixture({
    mount: {
        kind: 'destination',
        destination: { pluginId: 'com.acme.fixture', localId: 'settings' },
        container: 'settingsPage',
    },
    target: { kind: 'app' },
    locale: 'en',
    colorScheme: 'light',
});
const identity = { pluginId: 'com.acme.fixture', pluginVersion: '1.0.0', viewId: 'settings', generation: 'g1' } as const;
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

describe('hosted-web plugin UI public client factory', () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY);
        if (originalWindowDescriptor) {
            Reflect.defineProperty(globalThis, 'window', originalWindowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, 'window');
        }
    });

    it('constructs the domain API through the host-private bootstrap and canonical wire negotiation', async () => {
        let listener: ((message: unknown) => void) | undefined;
        const sent: PluginUiHostApiWireEnvelopeV1[] = [];
        const bootstrap: PluginUiHostApiClientBootstrap = {
            identity,
            transport: {
                subscribe(next) { listener = next; return { dispose: () => { listener = undefined; } }; },
                send(message) {
                    sent.push(message);
                    if (message.kind === 'negotiate') listener?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                    if (message.kind === 'request' && message.method === 'context') listener?.({
                        wireVersion: 1, kind: 'result', identity,
                        requestId: message.requestId, method: message.method,
                        result: { surface, activity: { active: true } },
                    });
                },
            },
        };
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, bootstrap);

        const api = await createPluginUiHostApiClient();
        expect(api.version().wireVersion).toBe(1);
        await expect(api.context()).resolves.toEqual(surface);
        expect(sent).toEqual([
            expect.objectContaining({ kind: 'negotiate', identity }),
            expect.objectContaining({ kind: 'request', method: 'context', identity }),
        ]);
    });

    it('awaits a post-ready bootstrap before constructing the public API', async () => {
        const listeners = new Set<(event: unknown) => void>();
        const posted: unknown[] = [];
        const parent = {
            postMessage(message: unknown) {
                posted.push(message);
                const envelope = message as Readonly<{ sequence?: number; kind?: string; payload?: Readonly<Record<string, unknown>> }>;
                if (envelope.kind !== 'hostApi' || typeof envelope.sequence !== 'number') return;
                const payload = envelope.payload;
                if (payload?.kind === 'negotiate') {
                    dispatch({
                        version: 1,
                        pluginId: identity.pluginId,
                        contributionId: 'settings-web',
                        surfaceId: 'settings-surface',
                        nonce: 'nonce-1',
                        sequence: envelope.sequence,
                        requestSequence: envelope.sequence,
                        kind: 'result',
                        payload: {
                            wireVersion: 1,
                            kind: 'negotiated',
                            identity,
                            apiVersion: '1.0.0',
                            methods: ['context'],
                            surface,
                        },
                    });
                }
                if (payload?.kind === 'request' && payload.method === 'context'
                    && typeof payload.requestId === 'string') {
                    dispatch({
                        version: 1,
                        pluginId: identity.pluginId,
                        contributionId: 'settings-web',
                        surfaceId: 'settings-surface',
                        nonce: 'nonce-1',
                        sequence: envelope.sequence,
                        requestSequence: envelope.sequence,
                        kind: 'result',
                        payload: {
                            wireVersion: 1,
                            kind: 'result',
                            identity,
                            requestId: payload.requestId,
                            method: 'context',
                            result: { surface, activity: { active: true } },
                        },
                    });
                }
            },
        };
        const realm: HostedWebPluginUiClientRealm = {
            location: {
                href: 'https://plugin.test/settings?happierBridgeNonce=nonce-1'
                    + '&happierPluginId=com.acme.fixture&happierContributionId=settings-web'
                    + '&happierSurfaceId=settings-surface&happierHostOrigin=https%3A%2F%2Fhost.test',
            },
            parent,
            addEventListener(type, listener) {
                if (type === 'message') listeners.add(listener);
            },
            removeEventListener(type, listener) {
                if (type === 'message') listeners.delete(listener);
            },
        };
        const dispatch = (data: unknown) => {
            for (const listener of listeners) listener({ source: parent, origin: 'https://host.test', data });
        };
        Reflect.set(globalThis, 'window', realm);

        const apiPromise = createPluginUiHostApiClient();
        expect(posted).toEqual([expect.objectContaining({ kind: 'ready', nonce: 'nonce-1' })]);

        dispatch({
            version: 1,
            direction: 'hostToFrame',
            pluginId: identity.pluginId,
            contributionId: 'settings-web',
            surfaceId: 'settings-surface',
            nonce: 'nonce-1',
            sequence: 1,
            origin: 'https://plugin.test',
            kind: 'bootstrap',
            payload: { apiVersion: '1.0.0', wireVersion: 1, identity },
        });
        dispatch({
            version: 1,
            pluginId: identity.pluginId,
            contributionId: 'settings-web',
            surfaceId: 'settings-surface',
            nonce: 'nonce-1',
            sequence: 2,
            requestSequence: 1,
            kind: 'ack',
            // An older/no-Data host still returns this existing ready
            // acknowledgement, but has no capability to lend the guest.
            payload: { accepted: true },
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(posted).toHaveLength(2);
        const api = await apiPromise;
        expect(api.version().wireVersion).toBe(1);
        expect(posted.filter((message) => (message as { kind?: string }).kind === 'hostApi')).toHaveLength(1);

        const context = await createPluginUiRenderContext();
        expect(Reflect.get(
            context,
            Symbol.for('happier.pluginUi.privateHostedWebCollectionUiQueryTransport.v1'),
        )).toEqual({ kind: 'unavailable' });
    });

    it('fails explicitly when loaded outside a Happier hosted-web surface', async () => {
        await expect(createPluginUiHostApiClient()).rejects.toMatchObject({ code: 'ui_host_bootstrap_missing' });
    });

    it('fails with the same typed bootstrap error for a malformed host-private adapter', async () => {
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, { identity: {}, transport: {} });
        await expect(createPluginUiHostApiClient()).rejects.toMatchObject({ code: 'ui_host_bootstrap_missing' });
    });
    it('hands a hosted-web surface the same RenderContext facts a mounted RN surface gets (EU-8)', async () => {
        // EU-5a/EU-5b could not deliver `launchInput`/`subPath` to a hosted-web
        // destination at all: `RenderContext` was produced only for the RN/RNW
        // mount, and the hosted-web author received a bare host API.
        let listener: ((message: unknown) => void) | undefined;
        const bootstrap: PluginUiHostApiClientBootstrap = {
            identity,
            launchInput: { noteId: 'note-7' },
            subPath: 'work/ideas.md',
            transport: {
                subscribe(next) { listener = next; return { dispose: () => { listener = undefined; } }; },
                send(message) {
                    if (message.kind === 'negotiate') listener?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context', 'notify'], surface,
                    });
                    if (message.kind === 'request' && message.method === 'context') listener?.({
                        wireVersion: 1, kind: 'result', identity,
                        requestId: message.requestId, method: message.method,
                        result: { surface, activity: { active: true } },
                    });
                    // The host retires the surface while the author is mid-call.
                    if (message.kind === 'request' && message.method !== 'context') listener?.({
                        wireVersion: 1, kind: 'disconnected', identity, reason: 'host_api_handler_disposed',
                    });
                },
            },
        };
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, bootstrap);

        const context = await createPluginUiRenderContext();

        expect(context.plugin).toEqual({ id: 'com.acme.fixture', version: '1.0.0' });
        expect(context.surface.mount).toEqual(surface.mount);
        expect('view' in context).toBe(false);
        expect(context.surface).toEqual(surface);
        expect(context.activity).toEqual({ active: true });
        expect(context.launchInput).toEqual({ noteId: 'note-7' });
        expect(context.subPath).toBe('work/ideas.md');
        expect(context.signal.aborted).toBe(false);

        // §3.12: retirement makes the surface inert, and the render context's
        // own signal is how an author's in-flight work learns that.
        await expect(context.hostApi.notify('hello')).rejects.toBeDefined();
        expect(context.signal.aborted).toBe(true);
    });

    it('carries a hosted Composer mount ref privately without widening RenderContext', async () => {
        let listener: ((message: unknown) => void) | undefined;
        const composerRef = Object.freeze({ kind: 'session' as const, sessionId: 'session-composer' });
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, {
            identity,
            composerRef,
            transport: {
                subscribe(next: (message: unknown) => void) { listener = next; return { dispose: () => { listener = undefined; } }; },
                send(message: PluginUiHostApiWireEnvelopeV1) {
                    if (message.kind === 'negotiate') listener?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                    if (message.kind === 'request' && message.method === 'context') listener?.({
                        wireVersion: 1, kind: 'result', identity,
                        requestId: message.requestId, method: message.method,
                        result: { surface, activity: { active: true } },
                    });
                },
            },
        });

        const context = await createPluginUiRenderContext();

        expect(Reflect.get(
            context,
            Symbol.for('happier.pluginUi.privateMountedComposerRef.v1'),
        )).toEqual(composerRef);
        expect(context).not.toHaveProperty('composerRef');
    });

    it('omits absent launch facts rather than substituting a default', async () => {
        // "opened without input" and "opened with an explicit undefined" must
        // stay distinguishable to an author reading the key.
        let listener: ((message: unknown) => void) | undefined;
        Reflect.set(globalThis, PLUGIN_UI_HOST_API_CLIENT_BOOTSTRAP_KEY, {
            identity,
            transport: {
                subscribe(next: (message: unknown) => void) { listener = next; return { dispose: () => { listener = undefined; } }; },
                send(message: PluginUiHostApiWireEnvelopeV1) {
                    if (message.kind === 'negotiate') listener?.({
                        wireVersion: 1, kind: 'negotiated', identity, apiVersion: '1.0.0',
                        methods: ['context'], surface,
                    });
                    if (message.kind === 'request' && message.method === 'context') listener?.({
                        wireVersion: 1, kind: 'result', identity,
                        requestId: message.requestId, method: message.method,
                        result: { surface, activity: { active: true } },
                    });
                },
            },
        } satisfies PluginUiHostApiClientBootstrap);

        const context = await createPluginUiRenderContext();

        expect('launchInput' in context).toBe(false);
        expect('subPath' in context).toBe(false);
    });
});
