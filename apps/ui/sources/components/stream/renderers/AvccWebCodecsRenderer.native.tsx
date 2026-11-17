import * as React from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useWebViewBridgeMessenger } from '@/components/ui/webview/bridge/useWebViewBridgeMessenger';
import { encodeBase64 } from '@/encryption/base64';
import { createLiveStreamPlayerDiagnostic } from '@/sync/domains/machines/peer/mediation/stream/diagnostics';
import type { LiveStreamPlayerRenderEvent } from '@/sync/domains/machines/peer/mediation/stream/player';
import type { AvccWebCodecsRendererProps } from './AvccWebCodecsRenderer.shared';
import { STREAM_WEBVIEW_SOURCE } from './webview/html';
import { addedAvccChunks } from './avccBatches';

export type { AvccWebCodecsRendererProps };

function Decoder(props: AvccWebCodecsRendererProps & { onProcessLost: () => void }): React.ReactElement {
    const pending = React.useRef<readonly Uint8Array[][]>([]);
    const previous = React.useRef<readonly Uint8Array[]>([]);
    const messenger = useWebViewBridgeMessenger({
        onReady: () => {
            for (const chunks of pending.current) sendFrames(chunks);
            pending.current = [];
        },
        onEnvelope: (event) => {
            if (event.type === 'decoded') props.onDecoded?.();
            if (event.type === 'diagnostic') {
                const payload = event.payload as { reasonCode?: unknown } | null;
                if (typeof payload?.reasonCode === 'string') {
                    const diagnostic = createLiveStreamPlayerDiagnostic({ reasonCode: payload.reasonCode });
                    props.onDiagnostic?.(diagnostic);
                    props.onFailure?.(diagnostic);
                }
            }
            if (event.type === 'reconfigured') props.onReconfigured?.(event.payload as LiveStreamPlayerRenderEvent);
        },
    });
    function sendFrames(chunks: readonly Uint8Array[]) {
        messenger.postEnvelope({ v: 1, type: 'frames', payload: { chunks: chunks.map((chunk) => encodeBase64(chunk)) } });
    }
    React.useEffect(() => {
        const added = addedAvccChunks(previous.current, props.chunks);
        previous.current = props.chunks;
        if (!added.length) return;
        if (messenger.isReady()) sendFrames(added);
        else pending.current = [...pending.current, [...added]];
    }, [props.chunks, messenger]);
    const attach = React.useCallback((node: WebView | null) => {
        // Ref detachment precedes passive cleanup; close while the bridge still exists.
        if (!node) messenger.postEnvelope({ v: 1, type: 'stop', payload: {} });
        messenger.webViewRef.current = node;
    }, [messenger]);
    return <View style={props.style} testID={`${props.testID}-webcodecs-surface`} pointerEvents="none">
        <WebView ref={attach} source={STREAM_WEBVIEW_SOURCE} originWhitelist={['*']}
            style={{ flex: 1, backgroundColor: 'transparent' }} scrollEnabled={false}
            onMessage={messenger.onMessage}
            onContentProcessDidTerminate={props.onProcessLost}
            onRenderProcessGone={props.onProcessLost}
            onError={() => {
                const diagnostic = createLiveStreamPlayerDiagnostic({ reasonCode: 'webcodecs_webview_load_failed' });
                props.onDiagnostic?.(diagnostic);
                props.onFailure?.(diagnostic);
            }}
            testID={`${props.testID}-webview`} />
    </View>;
}

/** Pixels use the web decoder; the native input overlay retains lease-scoped gestures. */
export function AvccWebCodecsRenderer(props: AvccWebCodecsRendererProps): React.ReactElement {
    const [revision, restart] = React.useReducer((value: number) => value + 1, 0);
    const onProcessLost = React.useCallback(() => {
        props.onDiagnostic?.(createLiveStreamPlayerDiagnostic({ reasonCode: 'webcodecs_process_terminated' }));
        restart();
        props.onRecoveryRequired?.();
    }, [props.onDiagnostic, props.onRecoveryRequired]);
    return <Decoder key={revision} {...props} onProcessLost={onProcessLost} />;
}
