import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
    PluginHostedWebAccountDataBridgeOperationV1,
    PluginUiHostApiWireEnvelopeV1,
    PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginHostedWebBridgeEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui/hostedWebBridge';
import { PLUGIN_UI_HOST_API_VERSION_V1, PluginUiHostApiWireEnvelopeV1Schema } from '@happier-dev/protocol/plugins/ui/client';

import {
    awaitHostedWebPluginUiHostApiClientBootstrap,
    installHostedWebPluginUiHostApiClientBootstrap,
    readHostedWebAccountDataTransport,
    type HostedWebPluginUiClientRealm,
} from './hostedWebClientBootstrap.js';
import { createSurfaceContextFixture } from './surfaceContext.fixture.js';

// Load the second real SDK graph during collection. Cold graph loading is
// setup, rather than part of the timed guest-lifecycle behavior below.
vi.resetModules();
const authoredBootstrap = await import('./hostedWebClientBootstrap.js');
const authoredClient = await import('./client.js');

const identity = { instanceId: 'mount-1', mountNonce: 'nonce-1' } as const;

function createRealm(
    hrefSuffix = '',
    frameHref = 'https://plugin.test/panel',
) {
    const listeners = new Set<(event: unknown) => void>();
    const posted: Array<{ message: unknown; targetOrigin: string; transfer?: readonly unknown[] }> = [];
    const parent = {
        postMessage(message: unknown, targetOrigin: string, transfer?: readonly unknown[]) {
            posted.push({ message, targetOrigin, ...(transfer ? { transfer } : {}) });
        },
    };
    const realm: HostedWebPluginUiClientRealm = {
        location: {
            href: `${frameHref}?happierBridgeNonce=nonce-1`
                + '&happierInstanceId=mount-1'
                + ''
                + '&happierHostOrigin=https%3A%2F%2Fhost.test'
                + hrefSuffix,
        },
        parent,
        addEventListener(type, listener) {
            if (type === 'message') listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === 'message') listeners.delete(listener);
        },
    };
    return {
        realm,
        parent,
        posted,
        dispatch(event: unknown) {
            for (const listener of listeners) listener(event);
        },
        listenerCount: () => listeners.size,
    };
}

function installDocumentChannel(realm: HostedWebPluginUiClientRealm) {
    const guestPort = {
        onmessage: null as ((event: { data?: unknown }) => void) | null,
        postMessage: vi.fn(), start: vi.fn(), close: vi.fn(),
    };
    const hostPort = {
        onmessage: null as ((event: { data?: unknown }) => void) | null,
        postMessage: vi.fn(), start: vi.fn(), close: vi.fn(),
    };
    guestPort.postMessage.mockImplementation((data) => hostPort.onmessage?.({ data }));
    hostPort.postMessage.mockImplementation((data) => guestPort.onmessage?.({ data }));
    Object.defineProperty(realm, 'MessageChannel', {
        value: class FakeMessageChannel { readonly port1 = guestPort; readonly port2 = hostPort; },
    });
    return { guestPort, hostPort };
}

function bootstrapMessage(overrides: Readonly<Record<string, unknown>> = {}) {
    return { identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, direction: 'hostToFrame', sequence: 1, origin: 'https://plugin.test', kind: 'bootstrap', payload: {
            apiVersion: '1.0.0',
            wireVersion: 1,
            identity,
            subPath: 'work/ideas.md',
            launchInput: { noteId: 'note-7' },
        }, ...overrides };
}

function readyAcknowledgementMessage(input: Readonly<{
    accountData?: boolean;
}> = {}) {
    return { identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, sequence: 2, requestSequence: 1, kind: 'ack', payload: {
            accepted: true,
            ...(input.accountData === undefined
                ? {}
                : { capabilities: { accountData: input.accountData } }),
        } };
}

describe('hosted-web UI client bootstrap', () => {
    it('projects only semantic 1.0 context presentation, including observed context updates', async () => {
        // The installed generation's strict theme reader rejects statusTint:
        // ownerfix-iteration2-old-context-admission.json pins the real refusal.
        const harness = createRealm();
        installHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({ source: harness.parent, origin: 'https://host.test', data: bootstrapMessage() });
        const { transport } = await awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        const legacy = vi.fn();
        const current = vi.fn();
        const receive = (payload: unknown, requestSequence?: number) => harness.dispatch({
            source: harness.parent, origin: 'https://host.test', data: requestSequence === undefined
                ? { version: 1, identity, direction: 'hostToFrame', sequence: 20, kind: 'hostApi', payload }
                : { version: 1, identity, sequence: 20, requestSequence, kind: 'result', payload },
        });
        for (const [apiVersion, listener] of [['1.0.0', legacy], ['1.1.0', current]] as const) {
            transport.subscribe(listener);
            transport.send({ wireVersion: 1, identity, kind: 'negotiate', apiRange: `^${apiVersion}` });
            const request = PluginHostedWebBridgeEnvelopeV1Schema.parse(harness.posted.at(-1)?.message);
            receive({ wireVersion: 1, identity, kind: 'negotiated', apiVersion, methods: ['context', 'watchContext', 'readResource', 'watchResource'] }, request.sequence);
        }
        const surface = createSurfaceContextFixture({
            mountId: 'retained-mount',
            accountScope: { serverId: 'home-1', accountId: 'account-1' },
            requesterExecutionReady: false,
            machineExecutionReady: true,
        });
        const theme = { ...surface.theme, statusTint: { success: '#111', warning: '#222', attention: '#333', danger: '#444', info: '#555', neutral: '#666' } };
        const snapshot = { surface: { ...surface, theme }, activity: { active: true } };
        const base = { wireVersion: 1, identity } as const;
        transport.send({ ...base, kind: 'subscribe', method: 'watchContext', requestId: 'watch-context', subscriptionId: 'context-events' });
        transport.send({ ...base, kind: 'subscribe', method: 'watchResource', requestId: 'watch-resource', subscriptionId: 'resource-events' });
        receive({ ...base, kind: 'result', method: 'context', requestId: 'context', result: snapshot });
        expect(legacy.mock.lastCall?.[0].result).toEqual({ ...snapshot, surface });
        expect(current.mock.lastCall?.[0].result).toEqual(snapshot);
        receive({ ...base, kind: 'subscription', subscriptionId: 'context-events', event: snapshot });
        expect(legacy.mock.lastCall?.[0].event).toEqual({ ...snapshot, surface });
        expect(current.mock.lastCall?.[0].event).toEqual(snapshot);
        receive({ ...base, kind: 'result', method: 'readResource', requestId: 'resource', result: snapshot });
        expect(legacy.mock.lastCall?.[0].result).toEqual(snapshot);
        receive({ ...base, kind: 'subscription', subscriptionId: 'resource-events', event: snapshot });
        expect(legacy.mock.lastCall?.[0].event).toEqual(snapshot);
        expect(current.mock.lastCall?.[0].event).toEqual(snapshot);
        transport.send({ ...base, kind: 'disposeHostResource', requestId: 'dispose-context', subscriptionId: 'context-events' });
        transport.send({ ...base, kind: 'subscribe', method: 'watchResource', requestId: 'reuse-resource', subscriptionId: 'context-events' });
        receive({ ...base, kind: 'subscription', subscriptionId: 'context-events', event: snapshot });
        expect(legacy.mock.lastCall?.[0].event).toEqual(snapshot);
        transport.send({ ...base, kind: 'subscribe', method: 'watchContext', requestId: 'rejected-context', subscriptionId: 'rejected-events' });
        receive({ ...base, kind: 'error', method: 'watchContext', requestId: 'rejected-context', error: { name: 'PluginError', code: 'unavailable' } });
        transport.send({ ...base, kind: 'subscribe', method: 'watchResource', requestId: 'resource-after-rejection', subscriptionId: 'rejected-events' });
        receive({ ...base, kind: 'subscription', subscriptionId: 'rejected-events', event: snapshot });
        expect(legacy.mock.lastCall?.[0].event).toEqual(snapshot);
        // Projection and delivery themselves never send an additional request.
        expect(harness.posted).toHaveLength(9);
    });

    it.each([false, true])('shares one guest lifecycle across independent SDK copies (Account Data: %s)', async (accountData) => {
        // The realm and ports model browser boundaries; both SDK module graphs
        // and the public RenderContext factory execute their real logic.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_791_719_100_000);
        onTestFinished(() => clock.mockRestore());
        const harness = createRealm('', 'about:srcdoc');
        const surface = createSurfaceContextFixture();
        const properties = new Map<string, string>();
        Object.defineProperty(harness.realm, 'document', { value: {
            documentElement: {
                style: { setProperty: (key: string, value: string) => properties.set(key, value) },
                getBoundingClientRect: () => ({ height: 137 }),
            },
            addEventListener() {}, removeEventListener() {},
        } });
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__', {
            value: { identity, frameOrigin: 'null', hostOrigin: 'https://host.test' },
        });
        const { hostPort } = installDocumentChannel(harness.realm);
        const wireMessages: PluginUiHostApiWireEnvelopeV1[] = [];
        const subscriptions = new Set<string>();
        hostPort.onmessage = ({ data }) => queueMicrotask(() => {
            const envelope = PluginHostedWebBridgeEnvelopeV1Schema.parse(data);
            if (envelope.kind !== 'hostApi') return;
            const wire = PluginUiHostApiWireEnvelopeV1Schema.parse(envelope.payload);
            wireMessages.push(wire);
            if (wire.kind === 'negotiate') hostPort.postMessage({
                version: 1, sequence: envelope.sequence, requestSequence: envelope.sequence, identity, kind: 'result',
                payload: { wireVersion: 1, identity, kind: 'negotiated', apiVersion: PLUGIN_UI_HOST_API_VERSION_V1, methods: ['context', 'watchContext'],  },
            });
            if (wire.kind === 'request' && wire.method === 'context') hostPort.postMessage({
                version: 1, direction: 'hostToFrame', sequence: envelope.sequence, identity, kind: 'hostApi',
                payload: { wireVersion: 1, identity, kind: 'result', requestId: wire.requestId, method: 'context', result: { surface, activity: { active: true } } },
            });
            if (wire.kind === 'subscribe') {
                // The real host refuses duplicate live subscription ids
                // (hostedWebAdapter.ts); a clock tick is not an SDK namespace.
                const duplicate = subscriptions.has(wire.subscriptionId);
                subscriptions.add(wire.subscriptionId);
                hostPort.postMessage({
                    version: 1, direction: 'hostToFrame', sequence: envelope.sequence, identity, kind: 'hostApi',
                    payload: duplicate
                        ? { wireVersion: 1, identity, kind: 'error', requestId: wire.requestId, method: wire.method, error: { name: 'PluginError', code: 'invalid_payload' } }
                        : { wireVersion: 1, identity, kind: 'result', requestId: wire.requestId, method: wire.method },
                });
            }
        });
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm, { callerPresentation: true })).toBe(true);
        expect(authoredBootstrap.installHostedWebPluginUiHostApiClientBootstrap).not.toBe(installHostedWebPluginUiHostApiClientBootstrap);
        const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
        Object.defineProperty(globalThis, 'window', { configurable: true, value: harness.realm });
        onTestFinished(() => {
            if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
            else Reflect.deleteProperty(globalThis, 'window');
        });

        const acceptBootstrap = () => {
            hostPort.postMessage(readyAcknowledgementMessage({ accountData }));
            hostPort.postMessage(bootstrapMessage({ origin: 'null', payload: {
                ...bootstrapMessage().payload, authorPlugin: { id: 'com.acme.fixture', version: '1.0.0' },
            } }));
        };
        // Cover a late authored copy and one attaching while bootstrap is
        // pending, without giving either copy a second ready/port lifecycle.
        if (!accountData) acceptBootstrap();
        expect(authoredBootstrap.installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(false);
        const pendingContext = authoredClient.createPluginUiRenderContext();
        if (accountData) acceptBootstrap();
        await expect(pendingContext).resolves.toMatchObject({ plugin: { id: 'com.acme.fixture', version: '1.0.0' }, surface });
        const context = await pendingContext;
        const bootstrap = await awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        await expect(authoredBootstrap.awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm)).resolves.toBe(bootstrap);
        expect(authoredBootstrap.readHostedWebAccountDataTransport(bootstrap)).toBe(readHostedWebAccountDataTransport(bootstrap));
        expect(Reflect.get(context, Symbol.for('happier.pluginUi.privateHostedWebAccountDataTransport.v1'))).toMatchObject({
            kind: accountData ? 'available' : 'unavailable',
        });
        await expect(context.hostApi.watchContext(() => {})).resolves.toBeDefined();
        const laterContext = await authoredClient.createPluginUiRenderContext();
        expect(laterContext.surface).toEqual(surface);
        clock.mockRestore();
        await vi.waitFor(() => expect(properties.get('--happier-plugin-color-text')).toBe(surface.theme.colors.text));
        expect(wireMessages.filter(message => message.kind === 'negotiate')).toHaveLength(1);
        expect(harness.posted.map(({ message }) => PluginHostedWebBridgeEnvelopeV1Schema.parse(message).kind)).toEqual(['ready']);
        hostPort.postMessage({ version: 1, direction: 'hostToFrame', sequence: 10, identity, kind: 'hostApi', payload: accountData
            ? { wireVersion: 1, identity, kind: 'disconnected', reason: 'retired' }
            : { wireVersion: 1, identity, kind: 'negotiated', apiVersion: '1.0.0', methods: ['context', 'watchContext'],  },
        });
        expect(context.signal.aborted).toBe(true);
        expect(laterContext.signal.aborted).toBe(true);
        await expect(authoredClient.createPluginUiRenderContext()).rejects.toMatchObject({
            code: accountData ? 'ui_host_bridge_disconnected' : 'invalid_negotiation',
        });
        expect(authoredBootstrap.installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(false);
        expect(harness.posted).toHaveLength(1);
    });

    it('caller presentation applies context themes, reports resizing and retires native observers and links', async () => {
        const harness = createRealm();
        const surface = createSurfaceContextFixture();
        const properties = new Map<string, string>();
        const clicks = new Set<(event: unknown) => void>();
        let height = 137;
        let resized = () => {};
        const observer = { observe: vi.fn(), disconnect: vi.fn() };
        Object.defineProperty(harness.realm, 'document', { value: {
            documentElement: { style: { setProperty: (key: string, value: string) => properties.set(key, value) }, getBoundingClientRect: () => ({ height }) },
            body: { get scrollHeight() { return height; } },
            addEventListener: (_type: string, listener: (event: unknown) => void) => clicks.add(listener),
            removeEventListener: (_type: string, listener: (event: unknown) => void) => clicks.delete(listener),
        } });
        Object.defineProperty(harness.realm, 'ResizeObserver', { value: class { constructor(callback: () => void) { resized = callback; } observe = observer.observe; disconnect = observer.disconnect; } });
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__', { value: true });
        const sent: Array<{ kind: string; payload?: unknown }> = [];
        let subscriptionId = '';
        const push = (kind: string, payload: unknown) => harness.dispatch({ data: { version: 1, direction: 'hostToFrame', sequence: 1, identity, kind, ...(kind === 'bootstrap' ? { origin: 'https://plugin.test' } : {}), payload } });
        Object.defineProperty(harness.realm, 'ReactNativeWebView', { value: { postMessage(raw: string) {
            const envelope = JSON.parse(raw); sent.push(envelope);
            queueMicrotask(() => {
                if (envelope.kind === 'ready') { push('bootstrap', bootstrapMessage().payload); return; }
                if (envelope.kind !== 'hostApi') return;
                const wire = envelope.payload;
                if (wire.kind === 'negotiate') harness.dispatch({ data: { version: 1, identity,
                    sequence: envelope.sequence, requestSequence: envelope.sequence, kind: 'result',
                    payload: { wireVersion: 1, identity, kind: 'negotiated', apiVersion: PLUGIN_UI_HOST_API_VERSION_V1, methods: ['context', 'watchContext'] } } });
                else if (wire.kind === 'request' || wire.kind === 'subscribe') {
                    if (wire.kind === 'subscribe') subscriptionId = wire.subscriptionId;
                    push('hostApi', { wireVersion: 1, identity, kind: 'result', requestId: wire.requestId, method: wire.method, ...(wire.method === 'context' ? { result: { surface, activity: { active: true } } } : {}) });
                }
            });
        } } });
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm, { callerPresentation: true })).toBe(true);
        await vi.waitFor(() => expect(properties.get('--happier-plugin-color-text')).toBe('#f0f0f0'));
        // Unstyled caller HTML inherits the theme's text colour rather than the browser's black.
        expect(properties.get('color')).toBe('#f0f0f0');
        await vi.waitFor(() => expect(subscriptionId).not.toBe(''));
        expect(sent).toContainEqual(expect.objectContaining({ kind: 'heightChanged', payload: { height: 137 } }));
        push('hostApi', { wireVersion: 1, identity, kind: 'subscription', subscriptionId, event: { surface: { ...surface, theme: { ...surface.theme, colors: { ...surface.theme.colors, text: '#123456' } } }, activity: { active: true } } });
        expect(properties.get('--happier-plugin-color-text')).toBe('#123456');
        expect(properties.get('color')).toBe('#123456');
        height = 211; resized();
        expect(sent).toContainEqual(expect.objectContaining({ kind: 'heightChanged', payload: { height: 211 } }));
        const preventNativeNavigation = vi.fn();
        for (const listener of clicks) listener({ isTrusted: true, button: 0, target: { closest: () => ({ href: 'https://external.test/read' }) }, preventDefault: preventNativeNavigation });
        // Native WebView navigation owns the real gesture receipt; native JS
        // bridge messages intentionally cannot manufacture that authority.
        expect(preventNativeNavigation).not.toHaveBeenCalled();
        expect(sent.some(message => message.kind === 'openExternal')).toBe(false);
        for (const listener of clicks) listener({ isTrusted: false, button: 0, target: { closest: () => ({ href: 'https://external.test/read' }) }, preventDefault: preventNativeNavigation });
        expect(preventNativeNavigation).toHaveBeenCalledOnce();
        push('hostApi', { wireVersion: 1, identity, kind: 'disconnected', reason: 'retired' });
        expect(observer.disconnect).toHaveBeenCalled();
        expect(clicks.size).toBe(0);
        const before = sent.length; height = 333; resized();
        expect(sent.length).toBe(before);
    });
    it('keeps one document pending beyond the former cutoff and cancels only the abandoned waiter', async () => {
        vi.useFakeTimers();
        onTestFinished(() => { vi.useRealTimers(); });
        const harness = createRealm();
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const cancellation = new AbortController();
        const abandoned = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm, { signal: cancellation.signal });
        const abandonedResult = abandoned.catch((error: unknown) => error);
        const settlements: unknown[] = [];
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        void readiness.then((value) => settlements.push(value), (error: unknown) => settlements.push(error));
        await vi.advanceTimersByTimeAsync(30_001);
        expect(settlements).toEqual([]);
        cancellation.abort();
        await expect(abandonedResult).resolves.toMatchObject({ code: 'ui_host_bootstrap_aborted' });
        harness.dispatch({ source: harness.parent, origin: 'https://host.test', data: bootstrapMessage() });
        harness.dispatch({ source: harness.parent, origin: 'https://host.test', data: readyAcknowledgementMessage() });
        await expect(readiness).resolves.toMatchObject({ identity });
        expect(settlements).toHaveLength(1);
    });

    it('carries only genuine primary-button HTTP(S) anchor activation outside Host API', () => {
        const harness = createRealm('', 'about:srcdoc');
        const clickListeners = new Set<(event: unknown) => void>();
        Object.defineProperty(harness.realm, 'document', {
            value: {
                addEventListener: (_type: 'click', listener: (event: unknown) => void) => clickListeners.add(listener),
                removeEventListener: (_type: 'click', listener: (event: unknown) => void) => clickListeners.delete(listener),
            },
        });
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__', {
            value: {
                identity,
                frameOrigin: 'null',
                hostOrigin: 'https://host.test',
            },
        });
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_EXTERNAL_LINKS_V1__', { value: true });
        const { guestPort } = installDocumentChannel(harness.realm);
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const click = (href: string, isTrusted: boolean) => {
            const preventDefault = vi.fn();
            for (const listener of clickListeners) listener({
                isTrusted,
                defaultPrevented: false,
                button: 0,
                metaKey: false,
                ctrlKey: false,
                shiftKey: false,
                altKey: false,
                preventDefault,
                target: { closest: () => ({ href }) },
            });
            return preventDefault;
        };

        expect(click('https://example.test/docs', true)).toHaveBeenCalledOnce();
        expect(guestPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'openExternal',
            payload: { url: 'https://example.test/docs' },
        }));
        const sentCount = guestPort.postMessage.mock.calls.length;
        expect(click('javascript:alert(1)', true)).toHaveBeenCalledOnce();
        click('data:text/html,hello', true);
        click('https://example.test/synthetic', false);
        expect(guestPort.postMessage).toHaveBeenCalledTimes(sentCount);
        const preventControlDefault = vi.fn();
        for (const listener of clickListeners) listener({
            isTrusted: true, button: 0, target: { closest: () => null }, preventDefault: preventControlDefault,
        });
        expect(preventControlDefault).not.toHaveBeenCalled();
    });

    it('offers the guest-owned document port with ready and retires the WindowProxy listener', async () => {
        const harness = createRealm('', 'about:srcdoc');
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__', {
            value: { identity, frameOrigin: 'null', hostOrigin: 'https://host.test' },
        });
        const { guestPort, hostPort } = installDocumentChannel(harness.realm);
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        expect(harness.listenerCount()).toBe(0);
        expect(guestPort.start).toHaveBeenCalledTimes(1);
        expect(harness.posted[0]?.transfer).toEqual([hostPort]);

        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        hostPort.postMessage(bootstrapMessage({ origin: 'null' }));
        const bootstrap = await readiness;
        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });

        expect(harness.posted).toHaveLength(1);
        expect(guestPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'hostApi',
            identity,
        }));
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: { ...bootstrapMessage(), sequence: 99 },
        });
        expect(guestPort.postMessage).toHaveBeenCalledTimes(1);
    });

    it('bootstraps a by-value HTML frame through the same opaque ready handshake', async () => {
        const harness = createRealm('', 'about:srcdoc');
        const opaqueIdentity = { instanceId: 'html-mount', mountNonce: 'html-nonce' };
        Object.defineProperty(harness.realm, '__HAPPIER_UI_FRAME_BOOTSTRAP_V1__', {
            value: { identity: opaqueIdentity, frameOrigin: 'null', hostOrigin: 'https://host.test' },
        });
        const { guestPort, hostPort } = installDocumentChannel(harness.realm);
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        expect(harness.posted[0]?.message).toEqual({
            version: 1, identity: opaqueIdentity, sequence: 1, kind: 'ready', payload: { ready: true },
        });
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        hostPort.postMessage({
            version: 1, identity: opaqueIdentity, direction: 'hostToFrame', sequence: 1,
            origin: 'null', kind: 'bootstrap',
            payload: { apiVersion: '1.0.0', wireVersion: 1, identity: opaqueIdentity, launchInput: { value: '</script>' } },
        });
        const bootstrap = await readiness;
        expect(bootstrap.identity).toEqual(opaqueIdentity);
        expect(bootstrap.launchInput).toEqual({ value: '</script>' });
        expect(bootstrap.authorPlugin).toBeUndefined();
        await bootstrap.transport.send({ wireVersion: 1, identity: opaqueIdentity, kind: 'negotiate', apiRange: '^1' });
        expect(guestPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({ identity: opaqueIdentity, kind: 'hostApi' }));
    });
    it('keeps Session identity out of the bridge and ignores a legacy frame query', async () => {
        const harness = createRealm(
            '&happierSessionId=stale-session',
            'https://artifacts.happier.test/capability/',
        );

        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        expect(harness.posted[0]?.targetOrigin).toBe('https://host.test');
        expect(harness.posted[0]?.message).toMatchObject({ kind: 'ready' });
        expect(harness.posted[0]?.message).not.toHaveProperty('sessionId');

        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage({ origin: 'https://artifacts.happier.test' }),
        });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: readyAcknowledgementMessage(),
        });
        const bootstrap = await readiness;

        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });
        expect(harness.posted.at(-1)).toEqual({
            targetOrigin: 'https://host.test',
            message: expect.objectContaining({
                kind: 'hostApi',
                identity,
                payload: expect.objectContaining({ identity }),
            }),
        });
    });

    it('sends ready before exposing one post-ready, nonce-bound canonical transport', async () => {
        const harness = createRealm();

        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        expect(harness.posted).toEqual([{
            targetOrigin: 'https://host.test',
            message: expect.objectContaining({ identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, kind: 'ready' }),
        }]);

        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: readyAcknowledgementMessage({ accountData: true }),
        });
        const bootstrap = await readiness;
        expect(bootstrap.identity).toEqual(identity);
        expect(bootstrap.subPath).toBe('work/ideas.md');
        expect(bootstrap.launchInput).toEqual({ noteId: 'note-7' });

        const received = vi.fn();
        const subscription = bootstrap.transport.subscribe(received);
        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });
        expect(harness.posted).toHaveLength(2);
        expect(harness.posted[1]).toEqual({
            targetOrigin: 'https://host.test',
            message: expect.objectContaining({
                kind: 'hostApi',
                identity,
                payload: expect.objectContaining({ kind: 'negotiate', identity }),
            }),
        });

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: { identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, sequence: 2, requestSequence: 2, kind: 'result', payload: {
                    wireVersion: 1,
                    kind: 'negotiated',
                    identity,
                    apiVersion: '1.0.0',
                    methods: ['context'],
                } },
        });
        expect(received).toHaveBeenCalledWith(expect.objectContaining({ kind: 'negotiated', identity }));

        subscription.dispose();
    });

    it('addresses the bootstrapped mount by its whole wire identity in both directions', async () => {
        const harness = createRealm();
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: readyAcknowledgementMessage(),
        });
        const bootstrap = await readiness;

        const received = vi.fn();
        const subscription = bootstrap.transport.subscribe(received);
        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });
        const staleAnswerSequence = (harness.posted.at(-1)?.message as Readonly<{ sequence: number }>).sequence;
        const currentAnswerSequence = (harness.posted.at(-1)?.message as Readonly<{ sequence: number }>).sequence;

        // Outer correlation still matches, but an inner answer from a retired
        // document must not settle a request in its replacement.
        const supersededIdentity = { ...identity, mountNonce: 'nonce-2' } as const satisfies PluginUiHostApiWireIdentityV1;
        const negotiated = (
            wireIdentity: PluginUiHostApiWireIdentityV1,
            requestSequence: number,
        ) => ({ identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, sequence: requestSequence + 10, requestSequence, kind: 'result', payload: {
                wireVersion: 1,
                kind: 'negotiated',
                identity: wireIdentity,
                apiVersion: '1.0.0',
                methods: ['context'],
            } });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: negotiated(supersededIdentity, staleAnswerSequence),
        });
        expect(received).not.toHaveBeenCalled();

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: negotiated(identity, currentAnswerSequence),
        });
        expect(received).toHaveBeenCalledTimes(1);
        expect(received).toHaveBeenCalledWith(expect.objectContaining({ kind: 'negotiated', identity }));

        const postedBeforeStaleSend = harness.posted.length;
        expect(() => bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity: supersededIdentity,
            apiRange: '^1.0.0',
        })).toThrow('Plugin UI host wire identity does not match the hosted surface.');
        expect(harness.posted).toHaveLength(postedBeforeStaleSend);

        subscription.dispose();
    });

    it('routes Collection UI-query requests, cancellation, and content-free wakeups through the one bootstrap controller', async () => {
        const harness = createRealm();
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: readyAcknowledgementMessage({ accountData: true }),
        });
        const bootstrap = await readiness;
        const transport = readHostedWebAccountDataTransport(bootstrap);
        expect(transport).toBeDefined();
        if (!transport) throw new Error('Hosted Collection UI-query transport was not installed.');
        expect(harness.listenerCount()).toBe(1);

        const receivedChanges = vi.fn();
        const changes = transport.subscribe(receivedChanges);
        const operation: PluginHostedWebAccountDataBridgeOperationV1 = {
            kind: 'open',
            collectionId: 'tasks',
            uiQueryId: 'open',
            parameters: { status: 'open' },
        };
        const opened = transport.request(operation);
        const requestEnvelope = harness.posted.at(-1)?.message as Readonly<{
            sequence: number;
            kind: string;
            payload: unknown;
        }>;
        expect(requestEnvelope).toMatchObject({
            kind: 'accountData',
            payload: { kind: 'request', operation },
        });

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: { identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, sequence: requestEnvelope.sequence, requestSequence: requestEnvelope.sequence, kind: 'result', payload: {
                    kind: 'snapshot',
                    queryId: 'query_1',
                    snapshot: { status: 'ready', rows: [], hasMore: false },
                } },
        });
        await expect(opened).resolves.toEqual({
            kind: 'snapshot',
            queryId: 'query_1',
            snapshot: { status: 'ready', rows: [], hasMore: false },
        });

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: { identity: { instanceId: 'mount-1', mountNonce: 'nonce-1' }, version: 1, direction: 'hostToFrame', sequence: 3, kind: 'accountData', payload: { kind: 'change', queryId: 'query_1' } },
        });
        expect(receivedChanges).toHaveBeenCalledWith({ kind: 'change', queryId: 'query_1' });

        const cancellation = new AbortController();
        const cancelled = transport.request({ kind: 'page', queryId: 'query_1' }, {
            signal: cancellation.signal,
        });
        const cancelledRequest = harness.posted.at(-1)?.message as Readonly<{ sequence: number }>;
        cancellation.abort();
        expect(harness.posted.at(-1)?.message).toMatchObject({
            kind: 'accountData',
            payload: { kind: 'cancel', requestSequence: cancelledRequest.sequence },
        });
        await expect(cancelled).rejects.toMatchObject({ code: 'ui_host_bridge_aborted' });
        changes.dispose();
        expect(harness.listenerCount()).toBe(1);
    });

    it('withholds Collection UI-query transport when the existing ready acknowledgement has no mounted capability', async () => {
        const harness = createRealm();
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        const bootstrap = await readiness;

        // Older/no-Data hosts still acknowledge ready on the incumbent wire.
        // Their absence of this optional capability must leave no private
        // transport for a query to send into a frame that would drop it.
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: readyAcknowledgementMessage(),
        });

        expect(readHostedWebAccountDataTransport(bootstrap)).toBeUndefined();
        expect(harness.listenerCount()).toBe(1);
    });

    it('rejects a second bootstrap instead of replacing a live frame bootstrap', async () => {
        const harness = createRealm();
        const composerRef = { kind: 'session' as const, sessionId: 'composer-session' };
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const initialReadiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage({
                payload: {
                    apiVersion: '1.0.0',
                    wireVersion: 1,
                    identity,
                    subPath: 'work/ideas.md',
                    launchInput: { noteId: 'note-7' },
                    composerRef,
                },
            }),
        });
        const initial = await initialReadiness;

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage({
                sequence: 2,
                payload: {
                    apiVersion: '1.0.0',
                    wireVersion: 1,
                    identity,
                    subPath: 'work/ideas.md',
                    launchInput: { filter: 'open' },
                    composerRef,
                },
            }),
        });

        await expect(awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm))
            .rejects.toMatchObject({ code: 'ui_host_bootstrap_invalid' });
        expect(initial.launchInput).toEqual({ noteId: 'note-7' });
        expect(initial.composerRef).toEqual(composerRef);
    });

    it('ignores URL launch values and rejects duplicate, wrong-origin, and stale bootstraps', async () => {
        const harness = createRealm('&happierSubPath=leaked&happierLaunchInput=%7B%22secret%22%3Atrue%7D');
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);

        harness.dispatch({
            source: harness.parent,
            origin: 'https://evil.test',
            data: bootstrapMessage(),
        });
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage({ identity: { ...identity, mountNonce: 'stale-nonce' } }),
        });

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage({
                payload: {
                    apiVersion: '1.0.0',
                    wireVersion: 1,
                    identity,
                },
            }),
        });
        const bootstrap = await readiness;
        expect('subPath' in bootstrap).toBe(false);
        expect('launchInput' in bootstrap).toBe(false);

        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        await expect(awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm)).rejects.toMatchObject({
            code: 'ui_host_bootstrap_invalid',
        });
        expect(() => bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        } satisfies PluginUiHostApiWireEnvelopeV1)).toThrow();
    });

    it('uses the same strict ready/bootstrap lifecycle over the native WebView boundary', async () => {
        const harness = createRealm();
        const postMessage = vi.fn();
        const realm: HostedWebPluginUiClientRealm = {
            ...harness.realm,
            parent: undefined,
            ReactNativeWebView: { postMessage },
        };

        expect(installHostedWebPluginUiHostApiClientBootstrap(realm)).toBe(true);
        expect(JSON.parse(String(postMessage.mock.calls[0]?.[0]))).toMatchObject({ kind: 'ready' });
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(realm);
        harness.dispatch({ data: JSON.stringify(bootstrapMessage()) });
        const bootstrap = await readiness;
        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });
        expect(JSON.parse(String(postMessage.mock.calls[1]?.[0]))).toMatchObject({ kind: 'hostApi' });
        expect(harness.listenerCount()).toBe(1);
    });

    it('uses the token-scoped iOS custom-scheme frame address without widening host origins', async () => {
        const frameOrigin = 'happier-hosted-artifact://hpa_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const harness = createRealm('', `${frameOrigin}/index.html`);
        const postMessage = vi.fn();
        const realm: HostedWebPluginUiClientRealm = {
            ...harness.realm,
            parent: undefined,
            ReactNativeWebView: { postMessage },
        };

        expect(installHostedWebPluginUiHostApiClientBootstrap(realm)).toBe(true);
        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(realm);
        harness.dispatch({ data: JSON.stringify(bootstrapMessage({ origin: frameOrigin })) });
        await expect(readiness).resolves.toMatchObject({ identity });
        expect(JSON.parse(String(postMessage.mock.calls[0]?.[0]))).toMatchObject({
            kind: 'ready',
            identity,
        });
    });
});
