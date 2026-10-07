import * as React from 'react';

import type { HappierLiveStreamAvccInput, HappierLiveStreamPlayerDiagnostic, HappierLiveStreamPlayerDisplayState, HappierLiveStreamPlayerHost, HappierLiveStreamPlayerRendererEvent, HappierLiveStreamPlayerRenderEvent } from './liveStreamPlayerTypes.js';

const WEB_CODECS_FATAL_DIAGNOSTIC_REASON_CODES = new Set([
    'webcodecs_unavailable',
    'webcodecs_decoder_unavailable',
    'webcodecs_chunk_unavailable',
    'webcodecs_configure_failed',
    'webcodecs_decode_failed',
]);

function rendererDiagnosticToPlayerEvent(diagnostic: HappierLiveStreamPlayerDiagnostic): HappierLiveStreamPlayerRendererEvent | null {
    if (WEB_CODECS_FATAL_DIAGNOSTIC_REASON_CODES.has(diagnostic.reasonCode)) {
        return { type: 'decoder_error', reasonCode: diagnostic.reasonCode };
    }
    return null;
}

export function HappierLiveStreamPlayer<State extends HappierLiveStreamPlayerDisplayState, Avcc extends HappierLiveStreamAvccInput>(props: Readonly<{
    state: State;
    avcc?: Avcc;
    host: HappierLiveStreamPlayerHost<State, Avcc>;
    /**
     * The surface around the player says the stream's state itself (the browser's status capsule and
     * state cards), so the player draws no status chip of its own: one message per state.
     */
    statusOwnedByHost?: boolean;
    testID: string;
}>): React.ReactElement {
    const [rendererState, setRendererState] = React.useState<Readonly<{
        baseState: State;
        state: State;
    }> | null>(null);
    const applyRendererEvent = React.useCallback((event: HappierLiveStreamPlayerRendererEvent) => {
        setRendererState((current) => {
            const currentState = current?.baseState === props.state ? current.state : props.state;
            return {
                baseState: props.state,
                state: props.host.reduceDisplayState(currentState, event),
            };
        });
    }, [props.state, props.host]);

    const state = rendererState?.baseState === props.state ? rendererState.state : props.state;
    const avccOnDiagnostic = props.avcc?.onDiagnostic;
    const avccOnDecoded = props.avcc?.onDecoded;
    const avccOnReconfigured = props.avcc?.onReconfigured;
    const handleRendererDecoded = React.useCallback(() => {
        if (avccOnDecoded) avccOnDecoded();
        else applyRendererEvent({ type: 'frame_decoded' });
    }, [applyRendererEvent, avccOnDecoded]);
    const handleRendererDiagnostic = React.useCallback((diagnostic: HappierLiveStreamPlayerDiagnostic) => {
        const event = rendererDiagnosticToPlayerEvent(diagnostic);
        if (event) applyRendererEvent(event);
        avccOnDiagnostic?.(diagnostic);
    }, [applyRendererEvent, avccOnDiagnostic]);
    const handleRendererReconfigured = React.useCallback((event: HappierLiveStreamPlayerRenderEvent) => {
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

    return <>{props.host.renderRoot(props.host.renderSurface(<>
                {hasImageFrame ? props.host.renderImage({
                    frameUrl: state.lastFrameUrl ?? '', testID: `${props.testID}-frame`,
                }) : hasWebCodecsInput && props.avcc ? props.host.renderAvcc({
                    ...props.avcc,
                    onDiagnostic: handleRendererDiagnostic,
                    onDecoded: handleRendererDecoded,
                    onReconfigured: handleRendererReconfigured,
                    testID: props.testID,
                }) : showFallback ? props.host.renderFallback({
                    reasonCode: state.diagnostic?.reasonCode, testID: props.testID,
                }) : props.host.renderFallback({
                    kind: 'loading', reasonCode: state.phase === 'opening' ? undefined : state.diagnostic?.reasonCode,
                    testID: props.testID,
                })}
                {state.phase !== 'idle' && props.statusOwnedByHost !== true ? props.host.renderDiagnostics({
                    phase: state.phase, preservingLastFrame, reasonCode: state.diagnostic?.reasonCode, testID: props.testID,
                }) : null}
            </>), { testID: props.testID })}</>;
}
