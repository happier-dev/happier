import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import {
    createLiveStreamPlayerDiagnostic,
    type LiveStreamPlayerDiagnostic,
} from '@/sync/domains/machines/peer/mediation/stream/diagnostics';
import { createMachineLiveStreamAvccDemuxer } from '@/sync/domains/machines/peer/mediation/stream/frames';
import type { LiveStreamPlayerRenderEvent } from '@/sync/domains/machines/peer/mediation/stream/player';
import {
    createBrowserLiveStreamWebCodecsAdapter,
    type LiveStreamWebCodecsAdapter,
} from '@/sync/domains/machines/peer/mediation/stream/webCodecs';

import { MjpegImageRenderer } from './MjpegImageRenderer';

export type AvccWebCodecsRendererProps = Readonly<{
    chunks: readonly Uint8Array[];
    adapter?: LiveStreamWebCodecsAdapter;
    maxBufferedBytes?: number;
    startupTimeoutMs?: number;
    onDiagnostic?: (diagnostic: LiveStreamPlayerDiagnostic) => void;
    onReconfigured?: (event: LiveStreamPlayerRenderEvent) => void;
    onStartupTimeout?: (diagnostic: LiveStreamPlayerDiagnostic) => void;
    style?: StyleProp<ViewStyle>;
    surface?: React.ReactNode;
    testID: string;
}>;

const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

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
        maxBufferedBytes: maxBufferedBytesProp,
        onDiagnostic,
        onReconfigured,
        onStartupTimeout,
        startupTimeoutMs: startupTimeoutMsProp,
        style,
        surface,
        testID,
    } = props;
    const adapter = React.useMemo(
        () => props.adapter ?? createBrowserLiveStreamWebCodecsAdapter(),
        [props.adapter],
    );
    const maxBufferedBytes = Math.max(5, Math.floor(maxBufferedBytesProp ?? DEFAULT_MAX_BUFFERED_BYTES));
    const demuxer = React.useMemo(
        () => createMachineLiveStreamAvccDemuxer({ maxBufferedBytes }),
        [maxBufferedBytes],
    );
    const processedChunkCountRef = React.useRef(0);
    const decodedFrameRef = React.useRef(false);
    const [seedFrameUrl, setSeedFrameUrl] = React.useState<string | null>(null);

    React.useEffect(() => {
        demuxer.reset();
        processedChunkCountRef.current = 0;
        decodedFrameRef.current = false;
    }, [demuxer]);

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

        if (chunks.length < processedChunkCountRef.current) {
            demuxer.reset();
            processedChunkCountRef.current = 0;
        }

        const chunksToProcess = chunks.slice(processedChunkCountRef.current);
        processedChunkCountRef.current = chunks.length;
        if (chunksToProcess.length === 0) return;

        let cancelled = false;
        const processChunks = async (): Promise<void> => {
            for (const chunkBytes of chunksToProcess) {
                const demuxed = demuxer.push(chunkBytes);
                if (demuxed.reasonCode) {
                    onDiagnostic?.(sanitizedDiagnostic(demuxed.reasonCode));
                }

                for (const chunk of demuxed.chunks) {
                    if (cancelled) return;
                    if (chunk.type === 'seed') {
                        setSeedFrameUrl(createJpegDataUrl(chunk.payload));
                        continue;
                    }
                    if (chunk.type === 'description') {
                        try {
                            const reconfiguration = await adapter.configure({ description: chunk.payload });
                            if (cancelled) return;
                            onReconfigured?.({
                                type: 'decoderReconfigured',
                                ...(typeof reconfiguration.width === 'number' ? { width: reconfiguration.width } : {}),
                                ...(typeof reconfiguration.height === 'number' ? { height: reconfiguration.height } : {}),
                                ...(reconfiguration.orientation ? { orientation: reconfiguration.orientation } : {}),
                            });
                        } catch {
                            onDiagnostic?.(sanitizedDiagnostic('webcodecs_configure_failed'));
                        }
                        continue;
                    }
                    if (chunk.type === 'keyframe' || chunk.type === 'delta') {
                        try {
                            await adapter.decode({
                                type: chunk.type,
                                payload: chunk.payload,
                            });
                            decodedFrameRef.current = true;
                        } catch {
                            onDiagnostic?.(sanitizedDiagnostic('webcodecs_decode_failed'));
                        }
                    }
                }
            }
        };

        void processChunks();
        return () => {
            cancelled = true;
        };
    }, [adapter, chunks, demuxer, onDiagnostic, onReconfigured]);

    React.useEffect(() => {
        const startupTimeoutMs = Math.max(0, Math.floor(startupTimeoutMsProp ?? 0));
        if (startupTimeoutMs === 0 || chunks.length === 0 || decodedFrameRef.current) return;

        const timer = setTimeout(() => {
            if (decodedFrameRef.current) return;
            const diagnostic = sanitizedDiagnostic('decoder_startup_timeout');
            onStartupTimeout?.(diagnostic);
            onDiagnostic?.(diagnostic);
        }, startupTimeoutMs);

        return () => {
            clearTimeout(timer);
        };
    }, [chunks.length, onDiagnostic, onStartupTimeout, startupTimeoutMsProp]);

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
