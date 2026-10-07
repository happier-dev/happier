import {
    EmbedCredentialErrorEnvelopeV1Schema,
    EmbedCredentialResultEnvelopeV1Schema,
    EmbedFrameToHostEnvelopeV1Schema,
    EmbedHostToFrameEnvelopeV1Schema,
    EmbedReadyV1Schema,
    isExactBridgeOriginV1,
    wireIdentitiesEqual,
    type EmbedConfigureV1,
    type EmbedCredentialRequestV1,
    type EmbedCredentialV1,
    type EmbedErrorCodeV1,
    type EmbedInitV1,
    type EmbedOpenV1,
    type EmbedStateV1,
    type FrameBridgeIdentityV1,
} from '@happier-dev/protocol/embed';

/** The frame's window at its platform boundary: the parent it announces to, and `message` events. */
export type EmbedBridgeWindow = Readonly<{
    parent: Readonly<{ postMessage: (message: unknown, targetOrigin: string) => void }>;
    addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
    removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}>;

export type EmbedBridgeGuestEvents = Readonly<{
    /** The host's `init`, once, with the parent origin the browser reported for it (now pinned). */
    onInit?: (init: EmbedInitV1, parentOrigin: string) => void;
    onConfigure?: (configure: EmbedConfigureV1) => void;
    onOpen?: (open: EmbedOpenV1) => void;
}>;

export type EmbedCredentialOutcome =
    | Readonly<{ kind: 'credential'; credential: EmbedCredentialV1 }>
    | Readonly<{ kind: 'error'; code: EmbedErrorCodeV1 }>
    /** The bridge closed or a newer request retired this one before the host answered. */
    | Readonly<{ kind: 'closed' }>;

export type EmbedBridgeGuest = Readonly<{
    /** The origin `init` came from; `null` until then. */
    readonly parentOrigin: string | null;
    /** Asks the host for a credential; settles with its answer, or closes on retirement/disposal. */
    requestCredential: (request: Omit<EmbedCredentialRequestV1, 'kind'>) => Promise<EmbedCredentialOutcome>;
    publishState: (state: Omit<EmbedStateV1, 'kind'>) => void;
    publishSessionCreated: (sessionId: string) => void;
    dispose: () => void;
}>;

/**
 * The frame side of the embed bridge (plan 04 §4.3, §4.4): announce `ready` (public data only), take
 * the host's `init` only from the parent window with this frame's identity and a transferred port,
 * pin that parent origin, and from then on speak only over the port. It is transport: what the frame
 * does with a credential, a style or an `open` belongs to the embed runtime that passes `events`.
 */
export function startEmbedBridgeGuest(input: Readonly<{
    window: EmbedBridgeWindow;
    identity: FrameBridgeIdentityV1;
    embedPublicKey: string;
    events: EmbedBridgeGuestEvents;
}>): EmbedBridgeGuest {
    const { identity, events } = input;
    let parentOrigin: string | null = null;
    let port: MessagePort | null = null;
    let disposed = false;
    let sequence = 0;
    let lastHostSequence = -1;
    let pending: Readonly<{ sequence: number; settle: (outcome: EmbedCredentialOutcome) => void }> | null = null;

    const onPortMessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        const result = EmbedCredentialResultEnvelopeV1Schema.safeParse(data);
        const error = result.success ? null : EmbedCredentialErrorEnvelopeV1Schema.safeParse(data);
        const response = result.success ? result.data : error?.success ? error.data : null;
        if (response) {
            if (!wireIdentitiesEqual(response.identity, identity) || response.sequence <= lastHostSequence) return;
            lastHostSequence = response.sequence;
            if (pending?.sequence !== response.requestSequence) return;
            const settle = pending.settle;
            pending = null;
            settle(response.kind === 'result'
                ? { kind: 'credential', credential: response.payload }
                : { kind: 'error', code: response.payload.code });
            return;
        }
        const push = EmbedHostToFrameEnvelopeV1Schema.safeParse(data);
        if (!push.success || !wireIdentitiesEqual(push.data.identity, identity) || push.data.sequence <= lastHostSequence) return;
        lastHostSequence = push.data.sequence;
        const payload = push.data.payload;
        if (payload.kind === 'configure') events.onConfigure?.(payload);
        else if (payload.kind === 'open') events.onOpen?.(payload);
        // A second `init` over the port is not part of the protocol; the host re-inits only after `ready`.
    };

    const onWindowMessage = (event: MessageEvent) => {
        if (disposed || port || event.source !== (input.window.parent as unknown)) return;
        if (!isExactBridgeOriginV1(event.origin)) return;
        const envelope = EmbedHostToFrameEnvelopeV1Schema.safeParse(event.data);
        if (!envelope.success || envelope.data.payload.kind !== 'init') return;
        const init = envelope.data.payload;
        if (!wireIdentitiesEqual(envelope.data.identity, identity) || !wireIdentitiesEqual(init.identity, identity)) return;
        const transferred = event.ports?.[0];
        if (!transferred || event.ports.length !== 1) return;

        parentOrigin = event.origin;
        lastHostSequence = envelope.data.sequence;
        port = transferred;
        port.onmessage = onPortMessage;
        port.start?.();
        input.window.removeEventListener('message', onWindowMessage);
        events.onInit?.(init, event.origin);
    };

    const send = (payload: unknown) => {
        if (!port || disposed) return null;
        const envelope = EmbedFrameToHostEnvelopeV1Schema.parse({ version: 1, identity, sequence: sequence++, payload });
        port.postMessage(envelope);
        return envelope.sequence;
    };

    input.window.addEventListener('message', onWindowMessage);
    input.window.parent.postMessage(EmbedReadyV1Schema.parse({
        kind: 'ready', bridgeVersion: 1, identity, embedPublicKey: input.embedPublicKey,
    }), '*');

    return {
        get parentOrigin() {
            return parentOrigin;
        },
        requestCredential: (request) => new Promise<EmbedCredentialOutcome>((resolve) => {
            pending?.settle({ kind: 'closed' });
            pending = null;
            const requestSequence = send({ kind: 'credential.request', ...request });
            if (requestSequence === null) {
                resolve({ kind: 'closed' });
                return;
            }
            pending = { sequence: requestSequence, settle: resolve };
        }),
        publishState: (state) => {
            send({ kind: 'state', ...state });
        },
        publishSessionCreated: (sessionId) => {
            send({ kind: 'session.created', sessionId });
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            input.window.removeEventListener('message', onWindowMessage);
            if (port) {
                port.onmessage = null;
                port.close();
                port = null;
            }
            pending?.settle({ kind: 'closed' });
            pending = null;
        },
    };
}
