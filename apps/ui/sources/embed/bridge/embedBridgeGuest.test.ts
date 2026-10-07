import { afterEach, describe, expect, it, vi } from 'vitest';

import { startEmbedBridgeGuest, type EmbedBridgeWindow } from './embedBridgeGuest';

const identity = { instanceId: 'inst-1', mountNonce: 'nonce-1' };
const HOST_ORIGIN = 'https://crm.acme.dev';
/** A canonical base64url 32-byte public key (the frame's in-memory X25519 key). */
const PUBLIC_KEY = 'A'.repeat(43);
const credential = { token: 'hap_v1_child', expiresAt: '2026-10-01T10:00:00.000Z' };

type Listener = (event: MessageEvent) => void;

/** The frame's window at its platform boundary: `parent.postMessage` and `message` events. */
function createFrameWindow() {
    const listeners = new Set<Listener>();
    const parent = { postMessage: vi.fn() };
    const frameWindow: EmbedBridgeWindow = {
        parent,
        addEventListener: (_type, listener) => { listeners.add(listener); },
        removeEventListener: (_type, listener) => { listeners.delete(listener); },
    };
    const deliver = (event: Partial<MessageEvent>) => {
        for (const listener of [...listeners]) listener(event as MessageEvent);
    };
    return { frameWindow, parent, deliver, listenerCount: () => listeners.size };
}

function initEnvelope(overrides: Record<string, unknown> = {}) {
    return {
        version: 1, identity, sequence: 0, direction: 'hostToFrame',
        payload: { kind: 'init', identity, sessionId: 'session-a', credential, ...overrides },
    };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

const channels: MessageChannel[] = [];
afterEach(() => {
    for (const channel of channels.splice(0)) {
        channel.port1.close();
        channel.port2.close();
    }
});

function openChannel() {
    const channel = new MessageChannel();
    channels.push(channel);
    return channel;
}

describe('embed bridge guest', () => {
    it('announces itself to the parent with public data only', () => {
        const frame = createFrameWindow();

        startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: {} });

        expect(frame.parent.postMessage).toHaveBeenCalledWith(
            { kind: 'ready', bridgeVersion: 1, identity, embedPublicKey: PUBLIC_KEY },
            '*',
        );
    });

    it('accepts init only from its parent with its own identity, then pins the parent origin', () => {
        const frame = createFrameWindow();
        const onInit = vi.fn();
        const guest = startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: { onInit } });

        frame.deliver({ source: {} as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [openChannel().port2] });
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: { ...initEnvelope(), identity: { instanceId: 'other', mountNonce: 'nonce-1' } }, ports: [openChannel().port2] });
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [] });
        expect(onInit).not.toHaveBeenCalled();
        expect(guest.parentOrigin).toBeNull();

        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [openChannel().port2] });

        expect(onInit).toHaveBeenCalledTimes(1);
        expect(onInit.mock.calls[0]?.[0]).toMatchObject({ kind: 'init', sessionId: 'session-a', credential });
        expect(guest.parentOrigin).toBe(HOST_ORIGIN);
        // Everything after init goes over the transferred port; the window listener is gone.
        expect(frame.listenerCount()).toBe(0);
    });

    it('takes configure and open from the port, ignoring malformed and out-of-order messages', async () => {
        const frame = createFrameWindow();
        const onConfigure = vi.fn();
        const onOpen = vi.fn();
        startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: { onConfigure, onOpen } });
        const channel = openChannel();
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [channel.port2] });

        channel.port1.postMessage({ version: 1, identity, sequence: 1, direction: 'hostToFrame', payload: { kind: 'configure', style: { v: 1, radius: 'round' } } });
        channel.port1.postMessage({ version: 1, identity, sequence: 2, direction: 'hostToFrame', payload: { kind: 'configure', css: 'body{}' } });
        channel.port1.postMessage({ version: 1, identity: { instanceId: 'x', mountNonce: 'y' }, sequence: 3, direction: 'hostToFrame', payload: { kind: 'open', sessionId: 'session-z' } });
        channel.port1.postMessage({ version: 1, identity, sequence: 4, direction: 'hostToFrame', payload: { kind: 'open', sessionId: 'session-b' } });
        channel.port1.postMessage({ version: 1, identity, sequence: 1, direction: 'hostToFrame', payload: { kind: 'open', sessionId: 'session-old' } });
        await flush();

        expect(onConfigure).toHaveBeenCalledTimes(1);
        expect(onConfigure.mock.calls[0]?.[0]).toMatchObject({ kind: 'configure', style: { radius: 'round' } });
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(onOpen.mock.calls[0]?.[0]).toEqual({ kind: 'open', sessionId: 'session-b' });
    });

    it('correlates credential results by request sequence and sends state over the port', async () => {
        const frame = createFrameWindow();
        const guest = startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: {} });
        const channel = openChannel();
        const sent: unknown[] = [];
        channel.port1.onmessage = (event) => { sent.push(event.data); };
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [channel.port2] });

        const outcome = guest.requestCredential({ sessionId: 'session-a', embedPublicKey: PUBLIC_KEY, reason: 'expiring' });
        guest.publishState({ sessionId: 'session-a', phase: 'ready', activity: 'working' });
        await flush();

        const request = sent[0] as { sequence: number; payload: { kind: string } };
        expect(request.payload.kind).toBe('credential.request');
        expect(sent[1]).toMatchObject({ identity, payload: { kind: 'state', sessionId: 'session-a', phase: 'ready', activity: 'working' } });

        channel.port1.postMessage({ version: 1, identity, sequence: 5, requestSequence: request.sequence + 100, kind: 'result', payload: credential });
        channel.port1.postMessage({ version: 1, identity, sequence: 6, requestSequence: request.sequence, kind: 'result', payload: { ...credential, token: 'hap_v1_fresh' } });

        await expect(outcome).resolves.toEqual({ kind: 'credential', credential: { ...credential, token: 'hap_v1_fresh' } });
    });

    it('settles outstanding requests and closes the port on dispose', async () => {
        const frame = createFrameWindow();
        const guest = startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: {} });
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [openChannel().port2] });

        const outcome = guest.requestCredential({ sessionId: 'session-a', embedPublicKey: PUBLIC_KEY, reason: 'expiring' });
        guest.dispose();

        await expect(outcome).resolves.toEqual({ kind: 'closed' });
    });

    it('retires a superseded credential request without waiting for the host to answer it', async () => {
        const frame = createFrameWindow();
        const guest = startEmbedBridgeGuest({ window: frame.frameWindow, identity, embedPublicKey: PUBLIC_KEY, events: {} });
        frame.deliver({ source: frame.parent as unknown as Window, origin: HOST_ORIGIN, data: initEnvelope(), ports: [openChannel().port2] });
        let retired: unknown;
        const first = guest.requestCredential({ sessionId: 'session-a', embedPublicKey: PUBLIC_KEY, reason: 'expiring' });
        void first.then((outcome) => { retired = outcome; });
        guest.requestCredential({ sessionId: 'session-b', embedPublicKey: PUBLIC_KEY, reason: 'open' });
        try {
            // The host intentionally drops the old callback result after open(B). Its promise
            // must settle locally so repeated switches cannot retain abandoned requests.
            await Promise.resolve();
            expect(retired).toEqual({ kind: 'closed' });
        } finally {
            guest.dispose();
        }
    });
});
