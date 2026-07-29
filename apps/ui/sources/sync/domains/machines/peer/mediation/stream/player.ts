import type { MachineLiveStreamCodecIdV1, SimulatorOrientationV1 } from '@happier-dev/protocol';

import { resolveMachineLiveStreamCodecPreference } from './codecs';
import type { LiveStreamRendererKind, LiveStreamViewerCapabilities } from './capabilities';
import { createLiveStreamPlayerDiagnostic, type LiveStreamPlayerDiagnostic } from './diagnostics';

export type LiveStreamPlayerPhase = 'idle' | 'opening' | 'playing' | 'degraded' | 'reconnecting' | 'error' | 'stopped';

export type LiveStreamPlayerRenderEvent = Readonly<{
    type: 'decoderReconfigured';
    width?: number;
    height?: number;
    orientation?: SimulatorOrientationV1;
}>;

export type LiveStreamPlayerState = Readonly<{
    phase: LiveStreamPlayerPhase;
    selectedCodec: MachineLiveStreamCodecIdV1 | null;
    activeRenderer: LiveStreamRendererKind | null;
    lastFrameUrl?: string;
    lastFrameAtMs?: number;
    decodedFrames: number;
    droppedFrames: number;
    bufferedBytes: number;
    diagnostic?: LiveStreamPlayerDiagnostic;
    renderEvent?: LiveStreamPlayerRenderEvent;
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    capabilities: LiveStreamViewerCapabilities | null;
    requiresKeyframe: boolean;
}>;

export type LiveStreamPlayerDisplayState = Pick<
    LiveStreamPlayerState,
    | 'phase'
    | 'selectedCodec'
    | 'activeRenderer'
    | 'lastFrameUrl'
    | 'lastFrameAtMs'
    | 'decodedFrames'
    | 'droppedFrames'
    | 'bufferedBytes'
    | 'diagnostic'
    | 'renderEvent'
>;

export type LiveStreamPlayerEvent =
    | Readonly<{
        type: 'open';
        sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
        preferredCodec?: MachineLiveStreamCodecIdV1;
        capabilities: LiveStreamViewerCapabilities;
    }>
    | Readonly<{
        type: 'frame';
        codecId: MachineLiveStreamCodecIdV1;
        frameUrl: string;
        timestampMs: number;
        bufferedBytes: number;
        droppedFrames: number;
    }>
    | Readonly<{ type: 'frame_dropped'; count: number; bufferedBytes: number; reasonCode: string }>
    | Readonly<{ type: 'startup_timeout'; reasonCode: string }>
    | Readonly<{ type: 'decoder_reconfigured'; width?: number; height?: number; orientation?: SimulatorOrientationV1 }>
    | Readonly<{ type: 'reconnecting'; reasonCode: string }>
    | Readonly<{ type: 'error'; reasonCode: string; message?: string }>
    | Readonly<{ type: 'stopped'; reasonCode?: string }>;

export const initialLiveStreamPlayerState: LiveStreamPlayerState = {
    phase: 'idle',
    selectedCodec: null,
    activeRenderer: null,
    decodedFrames: 0,
    droppedFrames: 0,
    bufferedBytes: 0,
    sourceCodecs: [],
    capabilities: null,
    requiresKeyframe: false,
};

function displayCapabilitiesForState(state: LiveStreamPlayerDisplayState): LiveStreamViewerCapabilities | null {
    if (state.selectedCodec === null || state.activeRenderer === null) return null;
    return {
        platform: 'web',
        renderers: [state.activeRenderer],
        supportedCodecs: [state.selectedCodec],
        degradedReasonCodes: [],
    };
}

function displayStateToPlayerState(state: LiveStreamPlayerDisplayState): LiveStreamPlayerState {
    return {
        phase: state.phase,
        selectedCodec: state.selectedCodec,
        activeRenderer: state.activeRenderer,
        ...(typeof state.lastFrameUrl === 'string' ? { lastFrameUrl: state.lastFrameUrl } : {}),
        ...(typeof state.lastFrameAtMs === 'number' ? { lastFrameAtMs: state.lastFrameAtMs } : {}),
        decodedFrames: state.decodedFrames,
        droppedFrames: state.droppedFrames,
        bufferedBytes: state.bufferedBytes,
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        ...(state.renderEvent ? { renderEvent: state.renderEvent } : {}),
        sourceCodecs: state.selectedCodec ? [state.selectedCodec] : [],
        capabilities: displayCapabilitiesForState(state),
        requiresKeyframe: false,
    };
}

function playerStateToDisplayState(state: LiveStreamPlayerState): LiveStreamPlayerDisplayState {
    return {
        phase: state.phase,
        selectedCodec: state.selectedCodec,
        activeRenderer: state.activeRenderer,
        ...(typeof state.lastFrameUrl === 'string' ? { lastFrameUrl: state.lastFrameUrl } : {}),
        ...(typeof state.lastFrameAtMs === 'number' ? { lastFrameAtMs: state.lastFrameAtMs } : {}),
        decodedFrames: state.decodedFrames,
        droppedFrames: state.droppedFrames,
        bufferedBytes: state.bufferedBytes,
        ...(state.diagnostic ? { diagnostic: state.diagnostic } : {}),
        ...(state.renderEvent ? { renderEvent: state.renderEvent } : {}),
    };
}

export function reduceLiveStreamPlayerDisplayState(
    state: LiveStreamPlayerDisplayState,
    event: LiveStreamPlayerEvent,
): LiveStreamPlayerDisplayState {
    return playerStateToDisplayState(reduceLiveStreamPlayerState(displayStateToPlayerState(state), event));
}

function clearFrameState(state: LiveStreamPlayerState): Omit<LiveStreamPlayerState, 'lastFrameUrl' | 'lastFrameAtMs'> {
    const { lastFrameUrl: _lastFrameUrl, lastFrameAtMs: _lastFrameAtMs, ...rest } = state;
    return rest;
}

function hasRenderer(capabilities: LiveStreamViewerCapabilities, renderer: LiveStreamRendererKind): boolean {
    return capabilities.renderers.includes(renderer);
}

function hasCodec(capabilities: LiveStreamViewerCapabilities, codecId: MachineLiveStreamCodecIdV1): boolean {
    return capabilities.supportedCodecs.includes(codecId);
}

function selectRendererForCodec(
    codecId: MachineLiveStreamCodecIdV1,
    capabilities: LiveStreamViewerCapabilities,
): Readonly<{ renderer: LiveStreamRendererKind; diagnostic?: LiveStreamPlayerDiagnostic }> {
    if (codecId === 'image.mjpeg' || codecId === 'image.frame.v1') {
        return hasRenderer(capabilities, 'mjpeg')
            ? { renderer: 'mjpeg' }
            : {
                renderer: 'fallback',
                diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: 'mjpeg_renderer_unavailable' }),
            };
    }

    if (codecId === 'h264.avcc') {
        if (hasRenderer(capabilities, 'webcodecs')) return { renderer: 'webcodecs' };
        if (hasRenderer(capabilities, 'mse')) return { renderer: 'mse' };
        if (hasRenderer(capabilities, 'wasm')) return { renderer: 'wasm' };
        if (hasRenderer(capabilities, 'native-video')) return { renderer: 'native-video' };
        return {
            renderer: 'fallback',
            diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: 'h264_renderer_unavailable' }),
        };
    }

    return {
        renderer: 'fallback',
        diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: 'unsupported_codec' }),
    };
}

function resolveFallbackImageCodec(state: LiveStreamPlayerState): MachineLiveStreamCodecIdV1 | null {
    if (state.capabilities === null || !hasRenderer(state.capabilities, 'mjpeg')) return null;
    const candidates: readonly MachineLiveStreamCodecIdV1[] = ['image.mjpeg', 'image.frame.v1'];
    return candidates.find((codecId) => (
        state.sourceCodecs.includes(codecId) && state.capabilities !== null && hasCodec(state.capabilities, codecId)
    )) ?? null;
}

function shouldRetainDegradedDiagnostic(reasonCode: string | undefined): boolean {
    return reasonCode === 'preferred_codec_unavailable'
        || reasonCode === 'h264_renderer_unavailable'
        || reasonCode === 'decoder_startup_timeout'
        || reasonCode === 'slow_consumer';
}

export function reduceLiveStreamPlayerState(
    state: LiveStreamPlayerState,
    event: LiveStreamPlayerEvent,
): LiveStreamPlayerState {
    switch (event.type) {
        case 'open': {
            const baseState = clearFrameState(state);
            const negotiation = resolveMachineLiveStreamCodecPreference({
                sourceCodecs: event.sourceCodecs,
                viewerCodecs: event.capabilities.supportedCodecs,
                preferredCodec: event.preferredCodec,
            });
            if (!negotiation.ok) {
                return {
                    ...baseState,
                    phase: 'error',
                    selectedCodec: null,
                    activeRenderer: 'fallback',
                    decodedFrames: 0,
                    droppedFrames: 0,
                    bufferedBytes: 0,
                    sourceCodecs: event.sourceCodecs,
                    capabilities: event.capabilities,
                    diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: negotiation.reasonCode }),
                    renderEvent: undefined,
                    requiresKeyframe: false,
                };
            }

            const renderer = selectRendererForCodec(negotiation.codecId, event.capabilities);
            return {
                ...baseState,
                phase: renderer.renderer === 'fallback' ? 'degraded' : 'opening',
                selectedCodec: negotiation.codecId,
                activeRenderer: renderer.renderer,
                sourceCodecs: event.sourceCodecs,
                capabilities: event.capabilities,
                decodedFrames: 0,
                droppedFrames: 0,
                bufferedBytes: 0,
                diagnostic: renderer.diagnostic
                    ?? (negotiation.fallbackReason
                        ? createLiveStreamPlayerDiagnostic({ reasonCode: negotiation.fallbackReason })
                        : undefined),
                renderEvent: undefined,
                requiresKeyframe: false,
            };
        }
        case 'frame': {
            if (state.selectedCodec === null || event.codecId !== state.selectedCodec) {
                return {
                    ...state,
                    phase: 'degraded',
                    droppedFrames: state.droppedFrames + 1 + event.droppedFrames,
                    bufferedBytes: event.bufferedBytes,
                    diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: 'codec_frame_mismatch' }),
                    renderEvent: undefined,
                    requiresKeyframe: true,
                };
            }
            const retainedDiagnostic = shouldRetainDegradedDiagnostic(state.diagnostic?.reasonCode)
                ? state.diagnostic
                : undefined;
            return {
                ...state,
                phase: retainedDiagnostic ? 'degraded' : 'playing',
                lastFrameUrl: event.frameUrl,
                lastFrameAtMs: event.timestampMs,
                decodedFrames: state.decodedFrames + 1,
                droppedFrames: state.droppedFrames + event.droppedFrames,
                bufferedBytes: event.bufferedBytes,
                diagnostic: retainedDiagnostic,
                renderEvent: undefined,
                requiresKeyframe: false,
            };
        }
        case 'frame_dropped':
            return {
                ...state,
                phase: 'degraded',
                droppedFrames: state.droppedFrames + Math.max(0, Math.floor(event.count)),
                bufferedBytes: Math.max(0, Math.floor(event.bufferedBytes)),
                diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: event.reasonCode }),
                renderEvent: undefined,
            };
        case 'startup_timeout':
            if (state.selectedCodec === 'h264.avcc') {
                const fallbackCodec = resolveFallbackImageCodec(state);
                if (fallbackCodec) {
                    const baseState = clearFrameState(state);
                    return {
                        ...baseState,
                        phase: 'degraded',
                        selectedCodec: fallbackCodec,
                        activeRenderer: 'mjpeg',
                        decodedFrames: 0,
                        droppedFrames: 0,
                        bufferedBytes: 0,
                        diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: event.reasonCode }),
                        renderEvent: undefined,
                        requiresKeyframe: true,
                    };
                }
            }
            return {
                ...state,
                phase: 'error',
                diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: event.reasonCode }),
                renderEvent: undefined,
                requiresKeyframe: true,
            };
        case 'decoder_reconfigured':
            return {
                ...state,
                renderEvent: {
                    type: 'decoderReconfigured',
                    ...(typeof event.width === 'number' ? { width: event.width } : {}),
                    ...(typeof event.height === 'number' ? { height: event.height } : {}),
                    ...(event.orientation ? { orientation: event.orientation } : {}),
                },
            };
        case 'reconnecting':
            return {
                ...state,
                phase: 'reconnecting',
                diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: event.reasonCode }),
                renderEvent: undefined,
                requiresKeyframe: true,
            };
        case 'error':
            return {
                ...state,
                phase: 'error',
                diagnostic: createLiveStreamPlayerDiagnostic({
                    reasonCode: event.reasonCode,
                    message: event.message,
                }),
                renderEvent: undefined,
                requiresKeyframe: true,
            };
        case 'stopped':
            return {
                ...state,
                phase: 'stopped',
                ...(event.reasonCode
                    ? { diagnostic: createLiveStreamPlayerDiagnostic({ reasonCode: event.reasonCode }) }
                    : {}),
                renderEvent: undefined,
            };
    }
}
