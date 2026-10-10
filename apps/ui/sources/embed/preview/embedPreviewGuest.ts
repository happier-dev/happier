import {
    EmbedHostToFrameEnvelopeV1Schema,
    wireIdentitiesEqual,
    type EmbedConfigureV1,
    type FrameBridgeIdentityV1,
} from '@happier-dev/protocol/embed';

import { buildEmbedPreviewReadyEnvelope } from './embedPreviewConfiguration';

type PostMessageTarget = Readonly<{ postMessage: (message: unknown, targetOrigin: string) => void }>;

export type EmbedPreviewWindow = Readonly<{
    parent: unknown;
    /** Present when the route runs in the app's native WebView (iOS/Android Settings). */
    ReactNativeWebView?: Readonly<{ postMessage: (data: string) => void }>;
    location: Readonly<{ origin: string; ancestorOrigins?: ArrayLike<string> }>;
    addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
    removeEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
}>;

function hasPostMessage(value: unknown): value is PostMessageTarget {
    return typeof value === 'object' && value !== null && typeof (value as { postMessage?: unknown }).postMessage === 'function';
}

function readNativeEnvelope(data: unknown): unknown {
    if (typeof data !== 'string') return null;
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

/**
 * The live preview's side of the bridge (plan 04 §4.10). It takes the same `configure` messages a host
 * page sends an embed, from exactly one sender: Settings on Happier's own origin as its parent frame
 * (web), or the app through its WebView engine's injected host messages (iOS/Android). Once
 * listening it says so with the bridge's `state` message, so Settings answers with the current
 * configuration. It holds no credential and opens no port: there is nothing to request.
 */
export function startEmbedPreviewGuest(input: Readonly<{
    window: EmbedPreviewWindow;
    identity: FrameBridgeIdentityV1;
    onConfigure: (configure: EmbedConfigureV1) => void;
}>): Readonly<{ refused: boolean; admitted: boolean; dispose: () => void }> {
    const ownOrigin = input.window.location.origin;
    const ancestors = input.window.location.ancestorOrigins;
    const refused = ancestors !== undefined && ancestors.length > 0 && ancestors[0] !== ownOrigin;
    const nativeWebView = input.window.ReactNativeWebView;
    let admitted = false;
    let lastSequence = -1;
    const onMessage = (event: MessageEvent) => {
        // The WebView engine delivers host messages as an injected event with no source window and the
        // serialized envelope as data; nothing else in this top-level document produces one.
        const data = nativeWebView && event.source === null
            ? readNativeEnvelope(event.data)
            : event.source === input.window.parent && event.origin === ownOrigin ? event.data : null;
        if (data === null) return;
        const envelope = EmbedHostToFrameEnvelopeV1Schema.safeParse(data);
        if (!envelope.success || envelope.data.payload.kind !== 'configure') return;
        if (!wireIdentitiesEqual(envelope.data.identity, input.identity) || envelope.data.sequence <= lastSequence) return;
        lastSequence = envelope.data.sequence;
        admitted = true;
        input.onConfigure(envelope.data.payload);
    };
    if (!refused) {
        input.window.addEventListener('message', onMessage);
        const ready = buildEmbedPreviewReadyEnvelope(input.identity);
        if (nativeWebView) nativeWebView.postMessage(JSON.stringify(ready));
        else if (input.window.parent !== input.window && hasPostMessage(input.window.parent)) input.window.parent.postMessage(ready, ownOrigin);
    }
    return {
        refused,
        get admitted() { return admitted; },
        dispose: () => input.window.removeEventListener('message', onMessage),
    };
}
