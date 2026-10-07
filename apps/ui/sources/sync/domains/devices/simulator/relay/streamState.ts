import { MachineLiveStreamReceiptV1Schema, isMachineLiveStreamTerminalReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';
import type { MachineLiveStreamCodecIdV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import type { MachineLiveStreamFrameV1, MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';

import {
    initialLiveStreamPlayerState,
    reduceLiveStreamPlayerState,
    type LiveStreamPlayerState,
} from '@/sync/domains/machines/peer/mediation/stream/player';
import type { LiveStreamViewerCapabilities } from '@/sync/domains/machines/peer/mediation/stream/capabilities';

import { frameToAvccChunks, frameToUrl, resolveFrameCodecId } from '../selectors';
import type { SimulatorPreviewStreamState } from '../types';

/**
 * UI relay-ingestion stream state (finding #36). Wraps the canonical live-stream
 * player reducer (`player.ts`) for the lifecycle/codec machine and overlays the
 * codec-aware per-frame payload (MJPEG data URL vs. H.264 AVCC chunks) decoded by
 * the existing selector helpers, so relay frames reach the starved WebCodecs/MJPEG
 * decoders in `components/stream/*` through one transport (`server_relay`).
 */
export type SimulatorRelayStreamState = Readonly<{
    player: LiveStreamPlayerState;
    streamId?: string;
    avccChunks?: readonly Uint8Array[];
}>;

export type SimulatorRelayIngestionEvent =
    | Readonly<{
        type: 'open';
        sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
        capabilities: LiveStreamViewerCapabilities;
        preferredCodec?: MachineLiveStreamCodecIdV1;
    }>
    | Readonly<{
        type: 'reset_open';
        streamId: string;
        sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
        capabilities: LiveStreamViewerCapabilities;
        preferredCodec?: MachineLiveStreamCodecIdV1;
    }>
    | Readonly<{ type: 'frame'; frame: MachineLiveStreamFrameV1 }>
    | Readonly<{ type: 'frame_decoded'; streamId: string }>
    | Readonly<{ type: 'reconnecting'; reasonCode: string }>
    | Readonly<{ type: 'error'; reasonCode: string; message?: string }>
    | Readonly<{ type: 'stopped'; reasonCode?: string }>;

export function createSimulatorRelayStreamState(streamId?: string): SimulatorRelayStreamState {
    return {
        player: initialLiveStreamPlayerState,
        ...(streamId ? { streamId } : {}),
    };
}

export function reduceSimulatorRelayStreamState(
    state: SimulatorRelayStreamState,
    event: SimulatorRelayIngestionEvent,
): SimulatorRelayStreamState {
    switch (event.type) {
        case 'reset_open':
            return reduceSimulatorRelayStreamState(
                createSimulatorRelayStreamState(event.streamId),
                {
                    type: 'open',
                    sourceCodecs: event.sourceCodecs,
                    capabilities: event.capabilities,
                    ...(event.preferredCodec ? { preferredCodec: event.preferredCodec } : {}),
                },
            );
        case 'open':
            return {
                player: reduceLiveStreamPlayerState(state.player, {
                    type: 'open',
                    sourceCodecs: event.sourceCodecs,
                    capabilities: event.capabilities,
                    ...(event.preferredCodec ? { preferredCodec: event.preferredCodec } : {}),
                }),
                ...(state.streamId ? { streamId: state.streamId } : {}),
            };
        case 'frame': {
            if (state.player.phase === 'error' || state.player.phase === 'stopped') return state;
            const codecId = resolveFrameCodecId(event.frame) ?? state.player.selectedCodec;
            const streamId = event.frame.streamId;
            if (codecId === 'h264.avcc') {
                if (state.player.selectedCodec !== codecId || state.player.activeRenderer !== 'webcodecs') return state;
                const chunks = frameToAvccChunks(event.frame);
                if (!chunks || chunks.length === 0) {
                    return {
                        ...state,
                        player: reduceLiveStreamPlayerState(state.player, {
                            type: 'frame_dropped',
                            count: 1,
                            bufferedBytes: 0,
                            reasonCode: 'avcc_decode_failed',
                        }),
                        streamId,
                    };
                }
                return {
                    // Bytes are decoder input, not proof that a frame was displayed.
                    player: { ...state.player, lastFrameAtMs: event.frame.timestampMs },
                    avccChunks: chunks,
                    streamId,
                };
            }
            const url = frameToUrl(event.frame);
            if (!url) {
                return {
                    ...state,
                    player: reduceLiveStreamPlayerState(state.player, {
                        type: 'frame_dropped',
                        count: 1,
                        bufferedBytes: 0,
                        reasonCode: 'image_decode_failed',
                    }),
                    streamId,
                };
            }
            const resolvedCodec: MachineLiveStreamCodecIdV1 = codecId ?? 'image.mjpeg';
            return {
                player: reduceLiveStreamPlayerState(state.player, {
                    type: 'frame',
                    codecId: resolvedCodec,
                    frameUrl: url,
                    timestampMs: event.frame.timestampMs,
                    bufferedBytes: 0,
                    droppedFrames: 0,
                }),
                streamId,
            };
        }
        case 'frame_decoded':
            return state.streamId === event.streamId
                ? { ...state, player: reduceLiveStreamPlayerState(state.player, { type: 'frame_decoded' }) }
                : state;
        case 'reconnecting':
            return {
                ...state,
                player: reduceLiveStreamPlayerState(state.player, { type: 'reconnecting', reasonCode: event.reasonCode }),
            };
        case 'error':
            return {
                ...state,
                player: reduceLiveStreamPlayerState(state.player, {
                    type: 'error',
                    reasonCode: event.reasonCode,
                    ...(event.message ? { message: event.message } : {}),
                }),
            };
        case 'stopped':
            return {
                ...state,
                player: reduceLiveStreamPlayerState(state.player, {
                    type: 'stopped',
                    ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
                }),
            };
    }
}

export function toSimulatorPreviewStreamState(state: SimulatorRelayStreamState): SimulatorPreviewStreamState {
    const player = state.player;
    return {
        phase: player.phase,
        selectedCodec: player.selectedCodec,
        activeRenderer: player.activeRenderer,
        ...(typeof player.lastFrameUrl === 'string' ? { lastFrameUrl: player.lastFrameUrl } : {}),
        ...(typeof player.lastFrameAtMs === 'number' ? { lastFrameAtMs: player.lastFrameAtMs } : {}),
        decodedFrames: player.decodedFrames,
        droppedFrames: player.droppedFrames,
        bufferedBytes: player.bufferedBytes,
        ...(player.diagnostic ? { diagnostic: player.diagnostic } : {}),
        ...(state.streamId ? { streamId: state.streamId } : {}),
        ...(state.avccChunks && state.avccChunks.length > 0 ? { avccChunks: state.avccChunks } : {}),
    };
}

export function mapSimulatorRelayEnvelopeToIngestionEvent(input: Readonly<{
    envelope: MachineLiveStreamRelayEnvelopeV1;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
}>): SimulatorRelayIngestionEvent | null {
    const { envelope } = input;
    if (envelope.sourceMachineId !== input.sourceMachineId || envelope.targetMachineId !== input.targetMachineId) {
        return null;
    }
    const message = envelope.message;
    switch (message.kind) {
        case 'frame':
            return message.frame.streamId === input.streamId
                ? { type: 'frame', frame: message.frame }
                : null;
        case 'control': {
            if (message.control.streamId !== input.streamId) return null;
            switch (message.control.kind) {
                case 'stop':
                    return {
                        type: 'stopped',
                        ...(message.control.reasonCode ? { reasonCode: message.control.reasonCode } : {}),
                    };
                case 'pause':
                case 'keyframe_required':
                    return { type: 'reconnecting', reasonCode: message.control.reasonCode };
                case 'cap_exceeded':
                case 'grant_refresh_denied':
                    return { type: 'error', reasonCode: message.control.reasonCode };
                default:
                    return null;
            }
        }
        case 'start_response':
            if (message.startResponse.streamId !== input.streamId) return null;
            return message.startResponse.accepted
                ? null
                : { type: 'error', reasonCode: message.startResponse.disabledReason };
        case 'receipt': {
            const parsed = MachineLiveStreamReceiptV1Schema.safeParse(message.receipt);
            if (!parsed.success || parsed.data.streamId !== input.streamId || !isMachineLiveStreamTerminalReceiptV1(parsed.data)) return null;
            return parsed.data.terminalOutcome === 'error'
                ? { type: 'error', reasonCode: parsed.data.reasonCode ?? 'capture_failed' }
                : { type: 'stopped', ...(parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {}) };
        }
        case 'start':
        case 'renew':
        case 'sideband_control':
        case 'metering':
            return null;
    }
}
