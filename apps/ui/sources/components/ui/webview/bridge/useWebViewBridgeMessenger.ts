import React from 'react';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import {
    decodeChunkedEnvelope,
    encodeChunkedEnvelope,
    type WebViewBridgeEnvelopeV1,
    type WebViewBridgeMessageV1,
} from './chunkedBridge';

/**
 * Thin WebView bridge messenger (D8/R-A5).
 *
 * This hook owns ONLY the plumbing that is already identical across every
 * WebView-backed editor surface (CodeMirror, Xterm, TipTap):
 * - chunked encode + post (`chunkedBridge` + the `WebView` ref),
 * - chunked decode + dispatch of incoming messages, and
 * - the one-shot `ready` handshake.
 *
 * It is intentionally NOT a rendering/lifecycle abstraction: `resetKey`,
 * `getValue`, doc seeding, refs, and the `<WebView>` element itself stay in the
 * owning surface. The surface wires `webViewRef` onto its `<WebView>` and routes
 * `onMessage` through {@link WebViewBridgeMessenger.onMessage}.
 */
export type WebViewBridgeMessenger = Readonly<{
    /** Attach to the surface's `<WebView ref=… />`. */
    webViewRef: React.RefObject<WebView | null>;
    /**
     * Encodes `envelope` (chunking when needed) and posts it through the WebView.
     * Returns `false` (without posting) when the WebView ref is not yet attached.
     */
    postEnvelope: (envelope: WebViewBridgeEnvelopeV1) => boolean;
    /** Wire this to `<WebView onMessage={messenger.onMessage} />`. */
    onMessage: (event: WebViewMessageEvent) => void;
    /** Whether the `ready` handshake has fired (mirrors the internal flag). */
    isReady: () => boolean;
}>;

export type UseWebViewBridgeMessengerParams = Readonly<{
    /** Max chunk size for `encodeChunkedEnvelope` (defaults to 64_000 bytes). */
    maxChunkBytes?: number;
    /** Invoked exactly once, on the first `ready` envelope from the editor. */
    onReady?: () => void;
    /**
     * Invoked for every fully-decoded inbound envelope (including `ready`).
     * Surfaces switch on `envelope.type` to handle `docChanged`/`docSnapshot`/etc.
     */
    onEnvelope?: (envelope: WebViewBridgeEnvelopeV1) => void;
    /** Override the message-id generator (tests). Defaults to a random base-36 id. */
    createMessageId?: () => string;
}>;

const DEFAULT_MAX_CHUNK_BYTES = 64_000;

function defaultCreateMessageId(): string {
    return Math.random().toString(36).slice(2);
}

/**
 * Creates a {@link WebViewBridgeMessenger} for a WebView-backed editor surface.
 *
 * The returned object is stable across renders; callbacks are read from the
 * latest render via refs so the surface can pass fresh closures without
 * re-creating the messenger.
 */
export function useWebViewBridgeMessenger(
    params: UseWebViewBridgeMessengerParams = {},
): WebViewBridgeMessenger {
    const webViewRef = React.useRef<WebView | null>(null);
    const readyRef = React.useRef(false);

    const maxChunkBytes =
        typeof params.maxChunkBytes === 'number' ? params.maxChunkBytes : DEFAULT_MAX_CHUNK_BYTES;

    // Keep the latest callbacks/config in refs so the messenger identity is stable.
    const onReadyRef = React.useRef(params.onReady);
    const onEnvelopeRef = React.useRef(params.onEnvelope);
    const createMessageIdRef = React.useRef(params.createMessageId ?? defaultCreateMessageId);
    const maxChunkBytesRef = React.useRef(maxChunkBytes);

    onReadyRef.current = params.onReady;
    onEnvelopeRef.current = params.onEnvelope;
    createMessageIdRef.current = params.createMessageId ?? defaultCreateMessageId;
    maxChunkBytesRef.current = maxChunkBytes;

    const postEnvelope = React.useCallback((envelope: WebViewBridgeEnvelopeV1): boolean => {
        const webView = webViewRef.current;
        if (!webView) {
            return false;
        }
        const messages = encodeChunkedEnvelope({
            envelope,
            maxChunkBytes: maxChunkBytesRef.current,
            messageId: createMessageIdRef.current(),
        });
        for (const message of messages) {
            webView.postMessage(JSON.stringify(message));
        }
        return true;
    }, []);

    const onMessage = React.useCallback((event: WebViewMessageEvent) => {
        const raw = event.nativeEvent.data;
        let parsed: WebViewBridgeMessageV1;
        try {
            parsed = JSON.parse(raw) as WebViewBridgeMessageV1;
        } catch {
            return;
        }

        const decoded = decodeChunkedEnvelope({ message: parsed });
        if (!decoded) {
            return;
        }

        if (decoded.type === 'ready' && !readyRef.current) {
            readyRef.current = true;
            onReadyRef.current?.();
        }

        onEnvelopeRef.current?.(decoded);
    }, []);

    const isReady = React.useCallback(() => readyRef.current, []);

    return React.useMemo<WebViewBridgeMessenger>(
        () => ({ webViewRef, postEnvelope, onMessage, isReady }),
        [postEnvelope, onMessage, isReady],
    );
}
