import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import {
    createLiveStreamPlayerDiagnostic,
    type LiveStreamPlayerDiagnostic,
} from '@/sync/domains/machines/peer/mediation/stream/diagnostics';
import { demuxMachineLiveStreamAvccPayload } from '@/sync/domains/machines/peer/mediation/stream/frames';
import type { LiveStreamPlayerRenderEvent } from '@/sync/domains/machines/peer/mediation/stream/player';
import {
    createBrowserLiveStreamWebCodecsAdapter,
    type LiveStreamWebCodecsAdapter,
} from '@/sync/domains/machines/peer/mediation/stream/webCodecs';

import { MjpegImageRenderer } from './MjpegImageRenderer';

export type AvccWebCodecsRendererProps = Readonly<{
    /** Complete carrier payloads; each may contain multiple AVCC envelopes. */
    chunks: readonly Uint8Array[];
    adapter?: LiveStreamWebCodecsAdapter;
    onDiagnostic?: (diagnostic: LiveStreamPlayerDiagnostic) => void;
    onDecoded?: () => void;
    onReconfigured?: (event: LiveStreamPlayerRenderEvent) => void;
    style?: StyleProp<ViewStyle>;
    surface?: React.ReactNode;
    testID: string;
}>;

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBytesBase64(bytes: Uint8Array): string {
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index] ?? 0;
        const second = bytes[index + 1] ?? 0;
        const third = bytes[index + 2] ?? 0;
        const value = (first << 16) | (second << 8) | third;
        output += base64Alphabet[(value >> 18) & 63] ?? '';
        output += base64Alphabet[(value >> 12) & 63] ?? '';
        output += index + 1 < bytes.length ? base64Alphabet[(value >> 6) & 63] ?? '' : '=';
        output += index + 2 < bytes.length ? base64Alphabet[value & 63] ?? '' : '=';
    }
    return output;
}

function createJpegDataUrl(bytes: Uint8Array): string {
    return `data:image/jpeg;base64,${encodeBytesBase64(bytes)}`;
}

function sanitizedDiagnostic(reasonCode: string): LiveStreamPlayerDiagnostic {
    return createLiveStreamPlayerDiagnostic({ reasonCode });
}

export function AvccWebCodecsRenderer(props: AvccWebCodecsRendererProps): React.ReactElement {
    const {
        chunks,
        onDiagnostic,
        onDecoded,
        onReconfigured,
        style,
        surface,
        testID,
    } = props;
    const adapter = React.useMemo(
        () => props.adapter ?? createBrowserLiveStreamWebCodecsAdapter(),
        [props.adapter],
    );
    const previousChunksRef = React.useRef<readonly Uint8Array[]>([]);
    const lifetime = React.useMemo(() => ({ active: true }), [adapter]);
    const [seedFrameUrl, setSeedFrameUrl] = React.useState<string | null>(null);

    React.useEffect(() => {
        lifetime.active = true;
        previousChunksRef.current = [];
        return () => { lifetime.active = false; };
    }, [lifetime]);

    React.useEffect(() => {
        return () => {
            adapter.close();
        };
    }, [adapter]);

    React.useEffect(() => {
        const support = adapter.isSupported();
        if (!support.ok) {
            onDiagnostic?.(sanitizedDiagnostic(support.reasonCode));
            return;
        }

        const previous = previousChunksRef.current;
        const isAppend = previous.length <= chunks.length && previous.every((chunk, index) => chunks[index] === chunk);
        const chunksToProcess = isAppend ? chunks.slice(previous.length) : chunks;
        // Relay updates are complete payload batches, not a cumulative array.
        previousChunksRef.current = chunks;
        if (chunksToProcess.length === 0) return;

        const processChunks = async (): Promise<void> => {
            for (const chunkBytes of chunksToProcess) {
                if (!lifetime.active) return;
                const demuxed = demuxMachineLiveStreamAvccPayload(chunkBytes);
                if (demuxed.reasonCode) {
                    onDiagnostic?.(sanitizedDiagnostic(demuxed.reasonCode));
                }

                for (const chunk of demuxed.chunks) {
                    if (!lifetime.active) return;
                    if (chunk.type === 'seed') {
                        setSeedFrameUrl(createJpegDataUrl(chunk.payload));
                        continue;
                    }
                    if (chunk.type === 'description') {
                        try {
                            const reconfiguration = await adapter.configure({ description: chunk.payload });
                            if (!lifetime.active) return;
                            onReconfigured?.({
                                type: 'decoderReconfigured',
                                ...(typeof reconfiguration.width === 'number' ? { width: reconfiguration.width } : {}),
                                ...(typeof reconfiguration.height === 'number' ? { height: reconfiguration.height } : {}),
                                ...(reconfiguration.orientation ? { orientation: reconfiguration.orientation } : {}),
                            });
                        } catch {
                            if (lifetime.active) onDiagnostic?.(sanitizedDiagnostic('webcodecs_configure_failed'));
                        }
                        continue;
                    }
                    if (chunk.type === 'keyframe' || chunk.type === 'delta') {
                        try {
                            await adapter.decode({
                                type: chunk.type,
                                payload: chunk.payload,
                            });
                            if (!lifetime.active) return;
                            onDecoded?.();
                        } catch {
                            if (lifetime.active) onDiagnostic?.(sanitizedDiagnostic('webcodecs_decode_failed'));
                        }
                    }
                }
            }
        };

        void processChunks();
    }, [adapter, chunks, lifetime, onDiagnostic, onDecoded, onReconfigured]);

    return (
        <View style={style} testID={`${testID}-webcodecs-surface`}>
            {surface}
            {seedFrameUrl ? (
                <MjpegImageRenderer
                    frameUrl={seedFrameUrl}
                    testID={`${testID}-seed-frame`}
                />
            ) : null}
        </View>
    );
}
