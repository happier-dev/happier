import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AvccWebCodecsRenderer } from '../AvccWebCodecsRenderer.web';
import { decodeChunkedEnvelope, type WebViewBridgeMessageV1 } from '@/components/ui/webview/bridge/chunkedBridge';
import { decodeBase64 } from '@/encryption/base64';

const send = (type: string, payload: unknown = {}) => {
    const bridge = (window as Window & { ReactNativeWebView?: { postMessage: (value: string) => void } }).ReactNativeWebView;
    bridge?.postMessage(JSON.stringify({ v: 1, type, payload }));
};
const root = createRoot(document.getElementById('root')!);
const onDecoded = () => send('decoded');
const onDiagnostic: NonNullable<React.ComponentProps<typeof AvccWebCodecsRenderer>['onDiagnostic']> = (value) => send('diagnostic', value);
const onReconfigured: NonNullable<React.ComponentProps<typeof AvccWebCodecsRenderer>['onReconfigured']> = (value) => send('reconfigured', value);
let stopped = false;
function receive(event: MessageEvent<string>) {
    if (stopped) return;
    let message: WebViewBridgeMessageV1;
    try { message = JSON.parse(event.data); } catch { return; }
    const envelope = decodeChunkedEnvelope({ message });
    if (!envelope) return;
    if (envelope.type === 'stop') {
        stopped = true;
        root.unmount();
        window.removeEventListener('message', receive);
        document.removeEventListener('message', receiveDocument);
    } else if (envelope.type === 'frames') {
        const payload = envelope.payload as { chunks: readonly string[] };
        // A carrier batch must reach the shared renderer before the next batch;
        // React's automatic batching must not discard a decoder description.
        renderFrames(payload.chunks.map((value) => decodeBase64(value)));
    }
}
function receiveDocument(event: Event) {
    event.stopPropagation();
    if (event instanceof MessageEvent) receive(event);
}
function renderFrames(chunks: readonly Uint8Array[]) {
    flushSync(() => root.render(<AvccWebCodecsRenderer chunks={chunks} onDecoded={onDecoded}
        onDiagnostic={onDiagnostic} onReconfigured={onReconfigured}
        style={{ width: '100%', height: '100%' }} testID="native-stream" />));
}
window.addEventListener('message', receive);
document.addEventListener('message', receiveDocument);
send('ready');
