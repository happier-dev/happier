import * as React from 'react';
import { View } from 'react-native';

import type { LiveStreamPlayerDiagnostic } from '@/sync/domains/machines/peer/mediation/stream/diagnostics';
import {
    reduceLiveStreamPlayerDisplayState,
    type LiveStreamPlayerDisplayState,
    type LiveStreamPlayerEvent,
    type LiveStreamPlayerRenderEvent,
} from '@/sync/domains/machines/peer/mediation/stream/player';

import { StreamDiagnosticsOverlay } from './StreamDiagnosticsOverlay';
import { StreamFallbackRenderer } from './StreamFallbackRenderer';
import { StreamQualityControls } from './StreamQualityControls';
import { AvccWebCodecsRenderer, type AvccWebCodecsRendererProps } from './renderers/AvccWebCodecsRenderer';
import { MjpegImageRenderer } from './renderers/MjpegImageRenderer';
import { streamPlayerStyles } from './styles';

export type { LiveStreamPlayerDisplayState };

const DEFAULT_WEB_CODECS_STARTUP_TIMEOUT_MS = 3_000;

const WEB_CODECS_FATAL_DIAGNOSTIC_REASON_CODES = new Set([
    'webcodecs_unavailable',
    'webcodecs_decoder_unavailable',
    'webcodecs_chunk_unavailable',
    'webcodecs_configure_failed',
    'webcodecs_decode_failed',
]);

function rendererDiagnosticToPlayerEvent(diagnostic: LiveStreamPlayerDiagnostic): LiveStreamPlayerEvent | null {
    if (diagnostic.reasonCode === 'decoder_startup_timeout') {
        return { type: 'startup_timeout', reasonCode: diagnostic.reasonCode };
    }
    if (WEB_CODECS_FATAL_DIAGNOSTIC_REASON_CODES.has(diagnostic.reasonCode)) {
        return { type: 'error', reasonCode: diagnostic.reasonCode };
    }
    return null;
}

export function LiveStreamPlayer(props: Readonly<{
    state: LiveStreamPlayerDisplayState;
    avcc?: Omit<AvccWebCodecsRendererProps, 'style' | 'testID'>;
    controls?: Readonly<{
        canRequestKeyframe: boolean;
        canSetQuality: boolean;
    }>;
    onRequestKeyframe?: () => void;
    onLowerQuality?: () => void;
    testID: string;
}>): React.ReactElement {
    const [rendererState, setRendererState] = React.useState<Readonly<{
        baseState: LiveStreamPlayerDisplayState;
        state: LiveStreamPlayerDisplayState;
    }> | null>(null);
    const applyRendererEvent = React.useCallback((event: LiveStreamPlayerEvent) => {
        setRendererState((current) => {
            const currentState = current?.baseState === props.state ? current.state : props.state;
            return {
                baseState: props.state,
                state: reduceLiveStreamPlayerDisplayState(currentState, event),
            };
        });
    }, [props.state]);

    const state = rendererState?.baseState === props.state ? rendererState.state : props.state;
    const avccOnDiagnostic = props.avcc?.onDiagnostic;
    const avccOnReconfigured = props.avcc?.onReconfigured;
    const avccOnStartupTimeout = props.avcc?.onStartupTimeout;
    const handleRendererDiagnostic = React.useCallback((diagnostic: LiveStreamPlayerDiagnostic) => {
        const event = rendererDiagnosticToPlayerEvent(diagnostic);
        if (event) applyRendererEvent(event);
        avccOnDiagnostic?.(diagnostic);
    }, [applyRendererEvent, avccOnDiagnostic]);
    const handleRendererStartupTimeout = React.useCallback((diagnostic: LiveStreamPlayerDiagnostic) => {
        applyRendererEvent({ type: 'startup_timeout', reasonCode: diagnostic.reasonCode });
        avccOnStartupTimeout?.(diagnostic);
    }, [applyRendererEvent, avccOnStartupTimeout]);
    const handleRendererReconfigured = React.useCallback((event: LiveStreamPlayerRenderEvent) => {
        applyRendererEvent({
            type: 'decoder_reconfigured',
            ...(typeof event.width === 'number' ? { width: event.width } : {}),
            ...(typeof event.height === 'number' ? { height: event.height } : {}),
            ...(event.orientation ? { orientation: event.orientation } : {}),
        });
        avccOnReconfigured?.(event);
    }, [applyRendererEvent, avccOnReconfigured]);

    const rendererUnavailable = state.diagnostic?.reasonCode === 'h264_renderer_unavailable'
        || state.diagnostic?.reasonCode === 'webcodecs_renderer_unavailable';
    const canRenderLiveCodecSurface = state.phase !== 'error'
        && state.phase !== 'stopped'
        && !rendererUnavailable;
    const hasFrame = typeof state.lastFrameUrl === 'string' && state.lastFrameUrl.length > 0;
    const hasImageFrame = hasFrame && (
        state.activeRenderer === 'mjpeg'
        || state.selectedCodec === 'image.mjpeg'
        || state.selectedCodec === 'image.frame.v1'
    );
    const hasWebCodecsInput = canRenderLiveCodecSurface
        && state.activeRenderer === 'webcodecs'
        && state.selectedCodec === 'h264.avcc'
        && props.avcc !== undefined;
    const waitingForFirstRenderableFrame = !hasFrame && (
        state.phase === 'opening'
        || state.phase === 'playing'
    );
    const showFallback = !hasImageFrame && !hasWebCodecsInput && !waitingForFirstRenderableFrame;
    const preservingLastFrame = hasImageFrame && (
        state.phase === 'reconnecting'
        || state.phase === 'error'
        || state.phase === 'stopped'
    );
    const controls = props.controls ?? {
        canRequestKeyframe: false,
        canSetQuality: false,
    };

    return (
        <View testID={props.testID} style={streamPlayerStyles.root}>
            <View style={streamPlayerStyles.surface}>
                {hasImageFrame ? (
                    <MjpegImageRenderer
                        frameUrl={state.lastFrameUrl ?? ''}
                        style={streamPlayerStyles.frame}
                        testID={`${props.testID}-frame`}
                    />
                ) : hasWebCodecsInput && props.avcc ? (
                    <AvccWebCodecsRenderer
                        {...props.avcc}
                        onDiagnostic={handleRendererDiagnostic}
                        onReconfigured={handleRendererReconfigured}
                        onStartupTimeout={handleRendererStartupTimeout}
                        startupTimeoutMs={props.avcc.startupTimeoutMs ?? DEFAULT_WEB_CODECS_STARTUP_TIMEOUT_MS}
                        style={streamPlayerStyles.frame}
                        testID={props.testID}
                    />
                ) : showFallback ? (
                    <StreamFallbackRenderer
                        reasonCode={state.diagnostic?.reasonCode}
                        testID={props.testID}
                    />
                ) : (
                    <StreamFallbackRenderer
                        kind="loading"
                        reasonCode={state.phase === 'opening' ? undefined : state.diagnostic?.reasonCode}
                        testID={props.testID}
                    />
                )}
                {state.phase !== 'idle' ? (
                    <StreamDiagnosticsOverlay
                        phase={state.phase}
                        preservingLastFrame={preservingLastFrame}
                        reasonCode={state.diagnostic?.reasonCode}
                        testID={props.testID}
                    />
                ) : null}
            </View>
            <StreamQualityControls
                canRequestKeyframe={controls.canRequestKeyframe}
                canSetQuality={controls.canSetQuality}
                onLowerQuality={props.onLowerQuality}
                onRequestKeyframe={props.onRequestKeyframe}
                testID={props.testID}
            />
        </View>
    );
}
