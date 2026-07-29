import * as React from 'react';
import { Platform } from 'react-native';
import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    MachineLiveStreamRelayEnvelopeV1Schema,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamCodecIdV1,
    type MachineLiveStreamRelayEnvelopeV1,
} from '@happier-dev/protocol';

import {
    openMachineLiveStreamRelayClient,
    resolveLiveStreamViewerCapabilities,
    type LiveStreamViewerCapabilities,
} from '@/sync/domains/machines/peer/mediation/stream';
import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';
import {
    createSimulatorRelayStreamState,
    mapSimulatorRelayEnvelopeToIngestionEvent,
    reduceSimulatorRelayStreamState,
    toSimulatorPreviewStreamState,
    type SimulatorRelayIngestionEvent,
    type SimulatorRelayStreamState,
} from '@/sync/domains/devices/simulator/relay/streamState';

type StartProductionMachineLiveStream = NonNullable<
    Parameters<typeof openMachineLiveStreamRelayClient>[0]['startProduction']
>;
type StartDaemonRelay = NonNullable<
    Parameters<typeof openMachineLiveStreamRelayClient>[0]['startDaemonRelay']
>;

/**
 * The relay transport boundary (the only mocked seam in tests). `send` emits a
 * relay envelope on the live-stream socket channel; `onEnvelope` subscribes to
 * inbound envelopes (delivered as raw socket payloads, validated by this hook).
 */
export type SimulatorRelayTransport = Readonly<{
    send: (event: typeof MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope: MachineLiveStreamRelayEnvelopeV1) => void;
    onEnvelope: (listener: (envelope: unknown) => void) => () => void;
}>;

export type UseSimulatorRelayIngestionInput = Readonly<{
    enabled?: boolean;
    transport: SimulatorRelayTransport | null;
    serverId?: string | null;
    sourceMachineId: string;
    targetMachineId: string;
    /**
     * Per-tab viewer socket id (W1-C-2). Threaded into the relay open so the mint binds the grant
     * to this tab and the server delivers frames via `io.to(viewerSocketId)`. Read from the latest
     * input ref inside the open-effect (not an effect dependency) because `streamId` already encodes
     * it (`createDefaultSimulatorLiveStreamId`), so a changed socket id re-opens via the streamId
     * key without a second churn source (L0-2 null-stability).
     */
    viewerSocketId?: string;
    simulatorId: string;
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    viewerCapabilities?: LiveStreamViewerCapabilities;
    preferredCodec?: MachineLiveStreamCodecIdV1;
    startProduction?: StartProductionMachineLiveStream;
    startDaemonRelay?: StartDaemonRelay;
    timeoutMs?: number;
}>;

export type UseSimulatorRelayIngestionResult = Readonly<{
    playerStatesBySimulatorId: Readonly<Record<string, SimulatorPreviewStreamState | undefined>>;
}>;

const EMPTY_PLAYER_STATES: Readonly<Record<string, SimulatorPreviewStreamState | undefined>> = {};

function createStreamIdentityKey(input: Readonly<{
    simulatorId: string;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
}>): string {
    return [
        input.simulatorId,
        input.streamId,
        input.sourceMachineId,
        input.targetMachineId,
        input.streamFamily,
    ].join('\u0000');
}

function hasWebCodecsDecoder(): boolean {
    return typeof globalThis !== 'undefined'
        && typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';
}

function isWebPlatform(): boolean {
    return Platform.OS === 'web';
}

function resolveDefaultViewerCapabilities(): LiveStreamViewerCapabilities {
    // WebCodecs H.264 decode is only real on web/desktop runtimes. The native RN target
    // re-exports the browser adapter and would silently fall back to MJPEG at decode time
    // (SIM-P2-2), so negotiation must be honest: never advertise `webcodecs` off-web, even if
    // a global `VideoDecoder` polyfill happens to exist.
    const web = isWebPlatform();
    return resolveLiveStreamViewerCapabilities({
        platform: web ? 'web' : 'native',
        renderers: {
            mjpeg: true,
            webcodecs: web && hasWebCodecsDecoder(),
            mse: false,
            wasm: false,
            nativeVideo: false,
        },
    });
}

export function useSimulatorRelayIngestion(
    input: UseSimulatorRelayIngestionInput,
): UseSimulatorRelayIngestionResult {
    const enabled = (input.enabled ?? true) && input.transport !== null;
    const [state, dispatch] = React.useReducer(
        reduceSimulatorRelayStreamState,
        input.streamId,
        createSimulatorRelayStreamState,
    );

    const defaultViewerCapabilities = React.useMemo(resolveDefaultViewerCapabilities, []);

    const latestRef = React.useRef<UseSimulatorRelayIngestionInput>(input);
    latestRef.current = input;
    const viewerCapabilities = input.viewerCapabilities ?? defaultViewerCapabilities;
    const viewerCapabilitiesRef = React.useRef(viewerCapabilities);
    viewerCapabilitiesRef.current = viewerCapabilities;

    const openedStreamIdentityKeyRef = React.useRef<string | null>(null);

    const {
        transport,
        serverId,
        simulatorId,
        sourceMachineId,
        targetMachineId,
        streamId,
        streamFamily,
    } = input;

    React.useEffect(() => {
        if (!enabled || !transport) return;
        let disposed = false;

        const streamIdentityKey = createStreamIdentityKey({
            simulatorId,
            sourceMachineId,
            targetMachineId,
            streamId,
            streamFamily,
        });
        const openEvent: SimulatorRelayIngestionEvent = {
            type: 'open',
            sourceCodecs: latestRef.current.sourceCodecs,
            capabilities: viewerCapabilitiesRef.current,
            ...(latestRef.current.preferredCodec ? { preferredCodec: latestRef.current.preferredCodec } : {}),
        };
        if (openedStreamIdentityKeyRef.current === streamIdentityKey) {
            // Socket re-established: freeze the last-known-good frame and let the next
            // inbound frame transition back to `playing` (never reset the decoder).
            dispatch({ type: 'reconnecting', reasonCode: 'stream_reopening' });
        } else {
            dispatch({ ...openEvent, type: 'reset_open', streamId });
            openedStreamIdentityKeyRef.current = streamIdentityKey;
        }

        const viewerSocketId = latestRef.current.viewerSocketId ?? '';
        const controlEnvelope = (
            control: Extract<MachineLiveStreamRelayEnvelopeV1['message'], { kind: 'control' }>['control'],
        ): MachineLiveStreamRelayEnvelopeV1 => ({
            v: 1,
            sourceMachineId,
            targetMachineId,
            ...(viewerSocketId ? { viewerSocketId } : {}),
            message: { kind: 'control', control },
        });

        const unsubscribe = transport.onEnvelope((raw) => {
            if (disposed) return;
            const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
            if (!parsed.success) return;
            // Viewer-side ack (SIM-P0-2): every delivered frame replenishes the server's bounded
            // in-flight window. The ack is the backpressure signal — without it the relay stops
            // crediting after `maxWindowFrames` frames. Only socket-precise viewers ack (the
            // server authorizes acks against the minted viewerSocketId).
            if (
                viewerSocketId
                && parsed.data.message.kind === 'frame'
                && parsed.data.message.frame.streamId === streamId
            ) {
                transport.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, controlEnvelope({
                    v: 1,
                    streamId,
                    kind: 'ack',
                    nextSequence: parsed.data.message.frame.sequence + 1,
                }));
            }
            const event = mapSimulatorRelayEnvelopeToIngestionEvent({
                envelope: parsed.data,
                sourceMachineId,
                targetMachineId,
                streamId,
            });
            if (event) dispatch(event);
        });

        void openMachineLiveStreamRelayClient({
            serverId,
            sourceMachineId,
            targetMachineId,
            streamId,
            streamFamily,
            ...(viewerSocketId ? { viewerSocketId } : {}),
            caps: latestRef.current.caps,
            ...(latestRef.current.startProduction ? { startProduction: latestRef.current.startProduction } : {}),
            ...(latestRef.current.startDaemonRelay ? { startDaemonRelay: latestRef.current.startDaemonRelay } : {}),
            ...(typeof latestRef.current.timeoutMs === 'number' ? { timeoutMs: latestRef.current.timeoutMs } : {}),
        })
            .then((result) => {
                if (disposed || result.ok) return;
                dispatch({ type: 'error', reasonCode: result.reasonCode });
            })
            .catch(() => {
                if (!disposed) dispatch({ type: 'error', reasonCode: 'relay_open_failed' });
            });

        return () => {
            disposed = true;
            unsubscribe();
            // Stop on unmount (SIM-P1-2): tell the relay to tear the stream down and the daemon
            // to end capture — otherwise the encode keeps running up to maxDurationMs (30 min)
            // after the tab navigates away. Fire-and-forget: the server-side viewer-disconnect
            // teardown is the safety net when the socket is already gone.
            transport.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, controlEnvelope({
                v: 1,
                streamId,
                kind: 'stop',
                reasonCode: 'viewer_closed',
            }));
        };
    }, [enabled, transport, serverId, simulatorId, sourceMachineId, targetMachineId, streamId, streamFamily]);

    const playerStatesBySimulatorId = React.useMemo<UseSimulatorRelayIngestionResult['playerStatesBySimulatorId']>(() => {
        if (!enabled) return EMPTY_PLAYER_STATES;
        return { [simulatorId]: toSimulatorPreviewStreamState(state) };
    }, [enabled, simulatorId, state]);

    return React.useMemo(() => ({ playerStatesBySimulatorId }), [playerStatesBySimulatorId]);
}

export type { SimulatorRelayStreamState };
