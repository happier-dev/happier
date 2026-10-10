import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type {
    PluginHostedWebAccountDataBridgeOperationV1,
    PluginUiHostApiWireEnvelopeV1,
    PluginUiHostApiWireIdentityV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    awaitHostedWebPluginUiHostApiClientBootstrap,
    installHostedWebPluginUiHostApiClientBootstrap,
    readHostedWebAccountDataTransport,
    type HostedWebPluginUiClientRealm,
} from './hostedWebClientBootstrap.js';

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
                    surface: { placement: 'settingsPage' },
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
        await bootstrap.transport.send({
            wireVersion: 1,
            kind: 'negotiate',
            identity,
            apiRange: '^1.0.0',
        });
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
                surface: { placement: 'settingsPage' },
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

    it('cancels one waiter without cancelling the frame bootstrap for another consumer', async () => {
        const harness = createRealm();
        const cancellation = new AbortController();
        expect(installHostedWebPluginUiHostApiClientBootstrap(harness.realm)).toBe(true);

        const cancelled = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm, {
            signal: cancellation.signal,
        });
        cancellation.abort();
        await expect(cancelled).rejects.toMatchObject({ code: 'ui_host_bootstrap_aborted' });

        const readiness = awaitHostedWebPluginUiHostApiClientBootstrap(harness.realm);
        harness.dispatch({
            source: harness.parent,
            origin: 'https://host.test',
            data: bootstrapMessage(),
        });
        await expect(readiness).resolves.toMatchObject({ identity });
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
