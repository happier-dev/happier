import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountHappierSession } from './index.js';
import type { EmbedOptions } from './index.js';
import { MessageChannel as NativeMessageChannel } from 'node:worker_threads';
import {
  EmbedCredentialResultEnvelopeV1Schema, EmbedFrameToHostEnvelopeV1Schema,
  EmbedHostToFrameEnvelopeV1Schema, EmbedReadyV1Schema,
  type EmbedConfigureV1, type EmbedInitV1, type EmbedOpenV1,
} from '@happier-dev/protocol/embed';

// jsdom has no transferable MessageChannel. Only this browser transport is faked;
// parsing, lifecycle, requested target and credential arbitration stay real.
class Port {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  postMessage = vi.fn();
  start = vi.fn();
  close = vi.fn();
  receive(data: unknown) { this.onmessage?.({ data }); }
}
const channels: { port1: Port; port2: Port }[] = [];
const publicKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const credential = { token: 'hap_v1_test', expiresAt: '2030-01-01T00:00:00.000Z' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function mount(sessionId?: string) {
  const container = document.createElement('div');
  document.body.append(container);
  const getCredential = vi.fn<EmbedOptions['getCredential']>(async () => credential);
  const onStateChange = vi.fn();
  const onSessionCreated = vi.fn();
  const onError = vi.fn();
  const handle = mountHappierSession(container, { happierUrl: 'https://app.happier.dev', sessionId, getCredential, onStateChange, onSessionCreated, onError });
  const frame = container.querySelector('iframe')!;
  const url = new URL(frame.src);
  const identity = { instanceId: url.searchParams.get('i')!, mountNonce: url.searchParams.get('n')! };
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ready = (overrides: Partial<MessageEventInit> = {}, data: unknown = { kind: 'ready', bridgeVersion: 1, identity, embedPublicKey: publicKey }) => window.dispatchEvent(new MessageEvent('message', { data, origin: 'https://app.happier.dev', source: frame.contentWindow, ...overrides }));
  const receive = (payload: unknown, sequence: number) => channels.at(-1)!.port1.receive({ version: 1, identity, sequence, payload });
  return { container, frame, identity, getCredential, onStateChange, onSessionCreated, onError, handle, post, ready, receive };
}

describe('embed host', () => {
  it('keeps a ready created chat and its pending renewal when the host echoes its session id', async () => {
    const m = mount(); m.ready(); await flush();
    m.receive({ kind: 'session.created', sessionId: 'N' }, 1);
    m.receive({ kind: 'state', sessionId: 'N', phase: 'ready' }, 2);
    let resolve!: (value: typeof credential) => void;
    m.getCredential.mockImplementationOnce(() => new Promise((complete) => { resolve = complete; }));
    m.receive({ kind: 'credential.request', sessionId: 'N', embedPublicKey: publicKey, reason: 'expiring' }, 3);
    m.handle.open('N');
    expect(channels[0].port1.postMessage).not.toHaveBeenCalled();
    resolve(credential); await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'result', requestSequence: 3 }));
    m.handle.destroy();
  });
  it('keeps an attributed exchange alive when React feeds the creation fact back as its target', async () => {
    const m = mount(); m.ready(); await flush();
    m.onSessionCreated.mockImplementation(({ sessionId }: { sessionId: string }) => m.handle.open(sessionId));
    m.receive({ kind: 'session.created', sessionId: 'N' }, 1);
    expect(channels[0].port1.postMessage).not.toHaveBeenCalled();
    m.receive({ kind: 'credential.request', sessionId: 'N', embedPublicKey: publicKey, reason: 'created',
      createdByTokenId: '00000000-0000-4000-8000-000000000001' }, 2);
    await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', requestSequence: 2 }));
    m.handle.destroy();
  });
  beforeEach(() => {
    channels.length = 0;
    vi.stubGlobal('MessageChannel', class { port1 = new Port(); port2 = new Port(); constructor() { channels.push(this); } });
  });
  afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('composes the public mount with the real guest over transferred ports and strict producer-consumer schemas', async () => {
    // This composed fixture crosses workspace source roots at runtime, as the
    // server/SDK composed harness does. Keep the package typecheck rooted here;
    // this test-only view describes only the real guest operations it consumes.
    const guestModulePath = '../../../apps/ui/sources/embed/bridge/embedBridgeGuest.ts';
    const { startEmbedBridgeGuest } = await import(guestModulePath) as {
      startEmbedBridgeGuest(input: unknown): {
        readonly parentOrigin: string | null;
        publishState(state: unknown): void;
        publishSessionCreated(sessionId: string): void;
        requestCredential(request: unknown): Promise<unknown>;
        dispose(): void;
      };
    };
    const nativeChannels: NativeMessageChannel[] = [];
    const wire: unknown[] = [];
    vi.stubGlobal('MessageChannel', class {
      constructor() {
        const channel = new NativeMessageChannel();
        nativeChannels.push(channel);
        for (const port of [channel.port1, channel.port2]) {
          const send = port.postMessage.bind(port);
          vi.spyOn(port, 'postMessage').mockImplementation((value) => { wire.push(value); send(value); });
        }
        return channel;
      }
    });
    const m = mount('A');
    let deliver: ((event: MessageEvent) => void) | undefined;
    const initialized: unknown[] = [];
    const opened: unknown[] = [];
    const configured: unknown[] = [];
    // jsdom does not transfer ports between windows. Adapt only that browser
    // boundary; both bridge owners and the asynchronous native ports stay real.
    const parent = {
      postMessage(value: unknown) {
        const ready = EmbedReadyV1Schema.parse(value);
        queueMicrotask(() => m.ready({}, ready));
      },
    };
    m.post.mockImplementation((...args: [unknown, (string | WindowPostMessageOptions)?, Transferable[]?]) => {
      const [value, , transfer = []] = args;
      const envelope = EmbedHostToFrameEnvelopeV1Schema.parse(value);
      queueMicrotask(() => deliver?.({ data: envelope, source: parent, origin: 'https://crm.acme.dev',
        ports: transfer } as unknown as MessageEvent));
    });
    const guest = startEmbedBridgeGuest({ identity: m.identity, embedPublicKey: publicKey,
      window: { parent, addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => { deliver = listener; },
        removeEventListener: () => { deliver = undefined; } },
      events: { onInit: (init: EmbedInitV1) => initialized.push(init), onOpen: (open: EmbedOpenV1) => opened.push(open),
        onConfigure: (configure: EmbedConfigureV1) => configured.push(configure) },
    });
    try {
      await vi.waitFor(() => expect(initialized).toEqual([{ kind: 'init', identity: m.identity, sessionId: 'A', credential }]));
      expect(guest.parentOrigin).toBe('https://crm.acme.dev');
      guest.publishState({ sessionId: 'A', phase: 'ready', activity: 'working' });
      await vi.waitFor(() => expect(m.container.querySelector('[role="status"]')).toBeNull());
      expect(m.onStateChange).toHaveBeenLastCalledWith({ sessionId: 'A', phase: 'ready', activity: 'working' });
      m.handle.update({ ui: { attachments: false }, style: { radius: 'soft' } });
      m.handle.open('B');
      await vi.waitFor(() => {
        expect(configured).toEqual([{ kind: 'configure', ui: { attachments: false }, style: { v: 1, radius: 'soft' } }]);
        expect(opened).toEqual([{ kind: 'open', sessionId: 'B' }]);
      });
      const renewed = { ...credential, token: 'hap_v1_renewed' };
      m.getCredential.mockResolvedValueOnce(renewed);
      await expect(guest.requestCredential({ sessionId: 'B', embedPublicKey: publicKey, reason: 'open' }))
        .resolves.toEqual({ kind: 'credential', credential: renewed });
      guest.publishSessionCreated('B');
      await vi.waitFor(() => expect(m.onSessionCreated).toHaveBeenCalledWith({ sessionId: 'B' }));
      expect(wire.length).toBeGreaterThan(0);
      for (const envelope of wire) {
        const value = envelope as { kind?: string; direction?: string };
        if (value.kind === 'result') expect(EmbedCredentialResultEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
        else if (value.direction === 'hostToFrame') expect(EmbedHostToFrameEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
        else expect(EmbedFrameToHostEnvelopeV1Schema.safeParse(envelope).success).toBe(true);
      }
    } finally {
      guest.dispose(); m.handle.destroy();
      for (const channel of nativeChannels) { channel.port1.close(); channel.port2.close(); }
    }
  });
  it('publishes configuration only when the effective presentation changes', async () => {
    const m = mount('A');
    m.ready();
    await flush();
    const port = channels[0]!.port1;
    port.postMessage.mockClear();
    m.handle.update({ ui: { attachments: false }, style: { radius: 'soft' } });
    m.handle.update({ ui: { attachments: false }, style: { radius: 'soft' } });
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: { kind: 'configure', ui: { attachments: false }, style: { v: 1, radius: 'soft' } },
    }));
    m.handle.update({ title: 'Lead chat' });
    expect(m.frame.title).toBe('Lead chat');
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    m.handle.destroy();
  });
  it('opens a titled, sandboxed new-chat frame without navigating its parent', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = mountHappierSession(container, { happierUrl: 'https://app.happier.dev', getCredential: vi.fn() });
    const frame = container.querySelector('iframe');
    expect(frame?.title).toBe('Chat');
    expect(new URL(frame!.src).pathname).toBe('/embed/new');
    expect(frame?.getAttribute('sandbox')).toContain('allow-popups-to-escape-sandbox');
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    handle.destroy();
  });
  it('preserves the supplied Home selection while building the frame route', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = mountHappierSession(container, {
      happierUrl: 'https://app.happier.dev/?server=https%3A%2F%2Fhome.example&happier_hmr=0',
      getCredential: vi.fn(),
    });
    const frameUrl = new URL(container.querySelector('iframe')!.src);
    expect(frameUrl.pathname).toBe('/embed/new');
    expect(frameUrl.searchParams.get('server')).toBe('https://home.example');
    expect(frameUrl.searchParams.get('happier_hmr')).toBe('0');
    handle.destroy();
  });
  it('restarts initial credential selection for a switch and drops pending results on destruction', async () => {
    const m = mount('A');
    let resolveA!: (value: typeof credential) => void;
    m.getCredential.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    m.ready();
    m.handle.open('B'); await flush();
    expect(m.getCredential).toHaveBeenLastCalledWith({ sessionId: 'B', embedPublicKey: publicKey, reason: 'initial' });
    expect(m.post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: { kind: 'init', identity: m.identity, sessionId: 'B', credential } }), 'https://app.happier.dev', [channels[0].port2]);
    resolveA(credential); await flush();
    expect(m.post).toHaveBeenCalledTimes(1);
    let resolveB!: (value: typeof credential) => void;
    m.getCredential.mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
    m.receive({ kind: 'credential.request', sessionId: 'B', embedPublicKey: publicKey, reason: 'rejected' }, 1);
    m.handle.destroy(); resolveB(credential); await flush();
    expect(channels[0].port1.postMessage).not.toHaveBeenCalled();
  });
  it('reports typed credential failure to the frame without sending malformed credentials', async () => {
    const m = mount('A'); m.ready(); await flush();
    m.getCredential.mockRejectedValueOnce({ code: 'session_key_not_transferable' });
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'rejected' }, 1);
    await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', requestSequence: 1, payload: { code: 'session_key_not_transferable' } }));
    expect(m.onError).toHaveBeenCalledWith('session_key_not_transferable');
    m.handle.destroy();
  });
  it('surfaces an initial credential failure when an existing-session frame is recreated after host reload', async () => {
    const firstLoad = mount('A');
    firstLoad.ready(); await flush();
    firstLoad.receive({ kind: 'state', sessionId: 'A', phase: 'ready' }, 1);
    firstLoad.handle.destroy();

    const reloaded = mount('A');
    reloaded.getCredential.mockRejectedValueOnce(new Error('session_key_not_transferable'));
    reloaded.ready(); await flush();

    const failure = reloaded.container.querySelector('[role="alert"]');
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toBe("This conversation isn't available here.");
    expect(reloaded.frame.style.opacity).toBe('0');
    expect(reloaded.onStateChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'A', phase: 'error', error: 'session_key_not_transferable',
    });
    expect(reloaded.onError).toHaveBeenCalledExactlyOnceWith('session_key_not_transferable');
    reloaded.handle.destroy();
  });
  it('admits only the exact source, origin and identity; delivers init only to the exact origin', async () => {
    const m = mount('A');
    m.ready({ origin: 'https://evil.example' });
    m.ready({ source: window });
    m.ready({}, { kind: 'ready', bridgeVersion: 1, identity: { ...m.identity, mountNonce: 'foreign' }, embedPublicKey: publicKey });
    m.ready({}, { kind: 'ready', bridgeVersion: 1, identity: m.identity, embedPublicKey: publicKey, unexpected: true });
    expect(m.getCredential).not.toHaveBeenCalled();
    m.ready(); await flush();
    expect(m.getCredential).toHaveBeenCalledExactlyOnceWith({ sessionId: 'A', embedPublicKey: publicKey, reason: 'initial' });
    expect(m.post).toHaveBeenCalledWith(expect.objectContaining({ direction: 'hostToFrame', payload: { kind: 'init', identity: m.identity, sessionId: 'A', credential } }), 'https://app.happier.dev', [channels[0].port2]);
    m.receive({ kind: 'state', sessionId: 'A', phase: 'ready', activity: 'idle' }, 1);
    expect(m.container.querySelector('[role="status"]')).toBeNull();
    m.handle.destroy();
  });
  it('deduplicates request sequences and drops credentials superseded by open or destroy', async () => {
    const m = mount('A'); m.ready(); await flush();
    let resolve!: (value: typeof credential) => void;
    m.getCredential.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' }, 2);
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' }, 2);
    expect(m.getCredential).toHaveBeenCalledTimes(2);
    m.handle.open('B'); resolve(credential); await flush();
    expect(channels[0].port1.postMessage.mock.calls.some(([value]) => value.kind === 'result')).toBe(false);
    m.receive({ kind: 'credential.request', sessionId: 'B', embedPublicKey: publicKey, reason: 'open' }, 3);
    await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', requestSequence: 3, payload: credential }));
    m.handle.destroy();
    expect(channels[0].port1.close).toHaveBeenCalled();
    expect(m.container.querySelector('iframe')).toBeNull();
    m.ready(); await flush(); expect(m.getCredential).toHaveBeenCalledTimes(3);
  });
  it('forwards producer creation facts, rejects sequence replay and keeps explicit target through reload', async () => {
    const childTokenId = '00000000-0000-4000-8000-000000000001';
    const m = mount(); m.ready(); await flush();
    expect(m.getCredential).toHaveBeenCalledWith({ embedPublicKey: publicKey, reason: 'initial' });
    m.receive({ kind: 'session.created', sessionId: 'N' }, 1);
    m.receive({ kind: 'session.created', sessionId: 'N' }, 1);
    expect(m.onSessionCreated).toHaveBeenCalledExactlyOnceWith({ sessionId: 'N' });
    m.ready(); await flush();
    expect(m.getCredential).toHaveBeenLastCalledWith({ embedPublicKey: publicKey, reason: 'initial' });
    m.receive({ kind: 'session.created', sessionId: 'N' }, 1);
    expect(m.onSessionCreated).toHaveBeenCalledTimes(2);
    m.receive({ kind: 'credential.request', sessionId: 'N', embedPublicKey: publicKey, reason: 'created', createdByTokenId: childTokenId }, 3);
    await flush();
    expect(m.getCredential).toHaveBeenCalledWith({ sessionId: 'N', embedPublicKey: publicKey, reason: 'created', createdByTokenId: childTokenId });
    m.receive({ kind: 'state', sessionId: 'N', phase: 'ready' }, 4);
    m.ready(); await flush();
    expect(m.getCredential).toHaveBeenLastCalledWith({ sessionId: 'N', embedPublicKey: publicKey, reason: 'initial' });
    m.handle.open('X');
    m.receive({ kind: 'session.created', sessionId: 'Late' }, 1);
    expect(m.onSessionCreated).toHaveBeenLastCalledWith({ sessionId: 'Late' });
    m.ready(); await flush();
    expect(m.getCredential).toHaveBeenLastCalledWith({ sessionId: 'X', embedPublicKey: publicKey, reason: 'initial' });
    m.handle.destroy();
  });
  it('rejects reflected host pushes, foreign identities and malformed state on the port', async () => {
    const m = mount('A'); m.ready(); await flush();
    channels[0].port1.receive({ version: 1, identity: m.identity, sequence: 1, direction: 'hostToFrame', payload: { kind: 'state', sessionId: 'A', phase: 'ready' } });
    channels[0].port1.receive({ version: 1, identity: { ...m.identity, instanceId: 'foreign' }, sequence: 2, payload: { kind: 'state', sessionId: 'A', phase: 'ready' } });
    m.receive({ kind: 'state', sessionId: 'A', phase: 'ready', extra: true }, 3);
    expect(m.onStateChange).not.toHaveBeenCalled();
    m.handle.destroy();
  });
  it('answers only the latest request even when both requests name the same session', async () => {
    const m = mount('A'); m.ready(); await flush();
    let resolveOld!: (value: typeof credential) => void;
    m.getCredential.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' }, 1);
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'rejected' }, 2);
    await flush(); resolveOld(credential); await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestSequence: 2, kind: 'result' }));
    m.getCredential.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' }, 3);
    m.handle.open('B'); resolveOld(credential); await flush();
    expect(channels[0].port1.postMessage.mock.calls.filter(([envelope]) => envelope.kind === 'result')).toHaveLength(1);
    m.handle.destroy();
  });
  it('accepts sequence zero from a restarted guest and ignores higher queued sequences from its retired port', async () => {
    const m = mount('A'); m.ready(); await flush();
    m.receive({ kind: 'state', sessionId: 'A', phase: 'ready' }, 100);
    const queued = channels[0].port1.onmessage;
    const freshPublicKey = 'AQ' + 'A'.repeat(41);
    m.ready({}, { kind: 'ready', bridgeVersion: 1, identity: m.identity, embedPublicKey: freshPublicKey }); await flush();
    expect(channels[0].port1.close).toHaveBeenCalled();
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: freshPublicKey, reason: 'expiring' }, 0);
    await flush();
    expect(channels[1].port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', requestSequence: 0, payload: credential }));
    m.receive({ kind: 'state', sessionId: 'A', phase: 'ready', activity: 'working' }, 1);
    expect(m.onStateChange).toHaveBeenLastCalledWith({ sessionId: 'A', phase: 'ready', activity: 'working' });
    queued?.({ data: { version: 1, identity: m.identity, sequence: 101, payload: { kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' } } });
    expect(m.getCredential).toHaveBeenCalledTimes(3);
    expect(m.post.mock.calls.map(([envelope]) => envelope.sequence)).toEqual([0, 1]);
    m.handle.destroy();
  });
  it('closes both channel ends when the browser cannot transfer the initial port', async () => {
    const m = mount('A');
    m.post.mockImplementationOnce(() => { throw new DOMException('Transfer failed', 'DataCloneError'); });
    m.ready(); await flush();
    expect(channels[0].port1.close).toHaveBeenCalled();
    expect(channels[0].port2.close).toHaveBeenCalled();
    expect(m.onError).toHaveBeenCalledWith('credential_unavailable');
    m.handle.destroy();
  });
  it('projects the exact backend-issued credential without exposing its attribution id to the frame', async () => {
    const m = mount('A');
    m.getCredential.mockResolvedValueOnce({ ...credential, tokenId: '00000000-0000-4000-8000-000000000001' });
    m.ready(); await flush();
    expect(m.post).toHaveBeenCalledWith(expect.objectContaining({ payload: { kind: 'init', identity: m.identity, sessionId: 'A', credential } }), 'https://app.happier.dev', [channels[0].port2]);
    m.getCredential.mockResolvedValueOnce({ ...credential, tokenId: '00000000-0000-4000-8000-000000000002' });
    m.receive({ kind: 'credential.request', sessionId: 'A', embedPublicKey: publicKey, reason: 'expiring' }, 1);
    await flush();
    expect(channels[0].port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'result', payload: credential }));
    m.handle.destroy();
  });
  it('rejects unknown backend result fields rather than stripping arbitrary keys', async () => {
    const m = mount('A');
    // JavaScript backends are untyped at this callback boundary.
    // @ts-expect-error Deliberately exercise an invalid issued-credential result.
    m.getCredential.mockResolvedValueOnce({ ...credential, tokenId: '00000000-0000-4000-8000-000000000001', unexpected: true });
    m.ready(); await flush();
    expect(m.post).not.toHaveBeenCalled();
    expect(m.onError).toHaveBeenCalledWith('credential_unavailable');
    expect(m.onStateChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'A', phase: 'error', error: 'credential_unavailable',
    });
    expect(m.container.querySelector('[role="alert"]')?.textContent).toBe("This conversation isn't available here.");
    m.handle.destroy();
  });
  it('keeps the last good presentation when an update is malformed', async () => {
    const m = mount('A'); m.ready(); await flush();
    m.handle.update({ style: { radius: 'soft' }, title: 'Lead A' });
    // JavaScript consumers can still supply a malformed presentation payload.
    // @ts-expect-error Invalid radius deliberately crosses the public validation boundary.
    m.handle.update({ style: { radius: 'invalid' }, title: 'Ignored' });
    expect(m.frame.title).toBe('Lead A');
    expect(channels[0].port1.postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: { kind: 'configure', style: { v: 1, radius: 'soft' } } }));
    m.handle.destroy();
  });
  it('reports the hosted-web 30-second ready deadline and ignores late pending work on destroy', async () => {
    vi.useFakeTimers();
    const m = mount('A');
    vi.advanceTimersByTime(30_000);
    expect(m.onError).toHaveBeenCalledExactlyOnceWith('frame_unreachable');
    expect(m.container.querySelector('[role="alert"]')?.textContent).toBe("This conversation isn't available here.");
    expect(m.frame.style.opacity).toBe('0');
    m.handle.destroy();
  });
});
