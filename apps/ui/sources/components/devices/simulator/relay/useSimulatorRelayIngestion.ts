import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { Platform } from 'react-native';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT, MachineLiveStreamDecodedEnvelopeV1Schema as MachineLiveStreamRelayEnvelopeV1Schema, type MachineLiveStreamCapsV1, type MachineLiveStreamRelayEnvelopeV1, type MachineLiveStreamFrameV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { MachineLiveStreamCodecIdV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import { MachineLiveStreamReceiptV1Schema, type MachineLiveStreamReceiptV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';

import { openMachineLiveStreamRelayClient, renewMachineLiveStreamRelayClient, type MachineLiveStreamRelayClientInput } from '@/sync/domains/machines/peer/mediation/stream/relayClient';
import { resolveLiveStreamViewerCapabilities, type LiveStreamViewerCapabilities } from '@/sync/domains/machines/peer/mediation/stream/capabilities';
import { resolveMachineLiveStreamCodecPreference } from '@/sync/domains/machines/peer/mediation/stream/codecs';
import { resolveBrowserLiveStreamWebCodecsSupport } from '@/sync/domains/machines/peer/mediation/stream/webCodecs';
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
    sourceId?: string;
    sourceOccurrenceId?: string;
    caps: MachineLiveStreamCapsV1;
    sourceCodecs: readonly MachineLiveStreamCodecIdV1[];
    viewerCapabilities?: LiveStreamViewerCapabilities;
    preferredCodec?: MachineLiveStreamCodecIdV1;
    startProduction?: StartProductionMachineLiveStream;
    startDaemonRelay?: StartDaemonRelay;
    timeoutMs?: number;
    /** Source-owned metadata shares this one scoped subscriber, but never enters the image decoder. */
    onMetadataFrame?: (frame: MachineLiveStreamFrameV1) => void;
    /** Source-owned receipt facts share this subscriber without becoming player lifecycle decisions. */
    onReceipt?: (receipt: MachineLiveStreamReceiptV1) => void;
}>;

export type UseSimulatorRelayIngestionResult = Readonly<{
    playerStatesBySimulatorId: Readonly<Record<string, SimulatorPreviewStreamState | undefined>>;
    /** The admitted source/server frame budget; consumers never invent a competing ceiling. */
    negotiatedCaps: MachineLiveStreamCapsV1 | null;
    retry: () => void;
}>;

const EMPTY_PLAYER_STATES: Readonly<Record<string, SimulatorPreviewStreamState | undefined>> = {};

function createStreamIdentityKey(input: Readonly<{
    serverId?: string | null;
    simulatorId: string;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    sourceOccurrenceId?: string;
}>): string {
    return [
        input.serverId ?? '',
        input.simulatorId,
        input.streamId,
        input.sourceMachineId,
        input.targetMachineId,
        input.streamFamily,
        input.sourceId ?? '',
        input.sourceOccurrenceId ?? '',
    ].join('\u0000');
}

function isWebPlatform(): boolean {
    return Platform.OS === 'web';
}

function resolveDefaultViewerCapabilities(): LiveStreamViewerCapabilities {
    // Advertise the same platform support that the actual decoder requires.
    // A browser SDK polyfill does not make the native surface a WebCodecs renderer.
    const web = isWebPlatform();
    return resolveLiveStreamViewerCapabilities({
        platform: web ? 'web' : 'native',
        renderers: {
            mjpeg: true,
            webcodecs: web && resolveBrowserLiveStreamWebCodecsSupport().ok,
            mse: false,
            wasm: false,
            nativeVideo: false,
        },
    });
}

export function useSimulatorRelayIngestion(
    input: UseSimulatorRelayIngestionInput,
): UseSimulatorRelayIngestionResult {
    const presented = useLayoutPresentationActive();
    const enabled = (input.enabled ?? true) && input.transport !== null && presented;
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const [authorization, setAuthorization] = React.useState<Readonly<{ identityKey: string; caps: MachineLiveStreamCapsV1 }> | null>(null);
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

    const openedStreamRef = React.useRef<Readonly<{
        identityKey: string;
        sourceIdentityKey: string;
        transport: SimulatorRelayTransport;
        viewerSocketId: string;
    }> | null>(null);
    // One mounted subscriber may reuse its daemon stream id after hide/show or retry.
    // A late successful start still owes Stop; finish it before activating that id again.
    const previousOpenRef = React.useRef<Promise<void> | null>(null);

    const {
        transport,
        serverId,
        simulatorId,
        sourceMachineId,
        targetMachineId,
        streamId,
        streamFamily,
        sourceId,
        sourceOccurrenceId,
    } = input;
    const streamIdentityKey = createStreamIdentityKey({ serverId, simulatorId, sourceMachineId, targetMachineId, streamId, streamFamily, sourceId, sourceOccurrenceId });
    const sourceIdentityKey = createStreamIdentityKey({ serverId, simulatorId, sourceMachineId, targetMachineId, streamId: '', streamFamily, sourceId, sourceOccurrenceId });
    const viewerSocketId = input.viewerSocketId ?? '';
    const openedStream = openedStreamRef.current;
    // A physical reconnect replaces the socket-bound admission id, not the picture's
    // source. A new logical transport (including a new Account) must start afresh.
    const replacingSocket = Boolean(openedStream?.viewerSocketId
        && openedStream.transport === transport
        && openedStream.sourceIdentityKey === sourceIdentityKey
        && openedStream.viewerSocketId !== viewerSocketId);
    const retainPicture = (openedStream?.transport === transport && openedStream.identityKey === streamIdentityKey) || replacingSocket;

    React.useEffect(() => {
        if (!enabled || !transport) {
            if (replacingSocket && !viewerSocketId) dispatch({ type: 'reconnecting', reasonCode: 'socket_disconnected' });
            return;
        }
        let disposed = false;
        const requestController = new AbortController();
        let ended = false;
        let openSettled = false;
        let renewalTimer: ReturnType<typeof setTimeout> | undefined;
        const clearRenewal = () => {
            if (renewalTimer !== undefined) clearTimeout(renewalTimer);
            renewalTimer = undefined;
        };

        const openEvent: SimulatorRelayIngestionEvent = {
            type: 'open',
            sourceCodecs: latestRef.current.sourceCodecs,
            capabilities: viewerCapabilitiesRef.current,
            ...(latestRef.current.preferredCodec ? { preferredCodec: latestRef.current.preferredCodec } : {}),
        };
        if (retainPicture) {
            // Socket re-established: freeze the last-known-good frame and let the next
            // inbound frame transition back to `playing` (never reset the decoder).
            dispatch({ type: 'reconnecting', streamId, reasonCode: 'stream_reopening' });
        } else {
            dispatch({ ...openEvent, type: 'reset_open', streamId });
        }
        openedStreamRef.current = { identityKey: streamIdentityKey, sourceIdentityKey, transport, viewerSocketId };
        const codec = resolveMachineLiveStreamCodecPreference({
            sourceCodecs: latestRef.current.sourceCodecs,
            viewerCodecs: viewerCapabilitiesRef.current.supportedCodecs,
            ...(latestRef.current.preferredCodec ? { preferredCodec: latestRef.current.preferredCodec } : {}),
        });
        if (!codec.ok) return;

        const controlEnvelope = (
            control: Extract<MachineLiveStreamRelayEnvelopeV1['message'], { kind: 'control' }>['control'],
        ): MachineLiveStreamRelayEnvelopeV1 => ({
            v: 1,
            sourceMachineId,
            targetMachineId,
            ...(viewerSocketId ? { viewerSocketId } : {}),
            message: { kind: 'control', control },
        });
        const stop = () => transport.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, controlEnvelope({
            v: 1, streamId, kind: 'stop', reasonCode: 'viewer_closed',
        }));
        const clientInput: MachineLiveStreamRelayClientInput = {
            serverId, sourceMachineId, targetMachineId, streamId, streamFamily,
            signal: requestController.signal,
            ...(sourceId ? { sourceId } : {}),
            ...(sourceOccurrenceId ? { sourceOccurrenceId } : {}),
            ...(viewerSocketId ? { viewerSocketId } : {}),
            caps: latestRef.current.caps,
            codecId: codec.codecId,
            viewerCodecs: viewerCapabilitiesRef.current.supportedCodecs,
            ...(latestRef.current.startProduction ? { startProduction: latestRef.current.startProduction } : {}),
            ...(latestRef.current.startDaemonRelay ? { startDaemonRelay: latestRef.current.startDaemonRelay } : {}),
            ...(typeof latestRef.current.timeoutMs === 'number' ? { timeoutMs: latestRef.current.timeoutMs } : {}),
        };
        const failRenewal = (reasonCode: string) => {
            if (disposed || ended) return;
            ended = true;
            clearRenewal();
            dispatch({ type: 'error', reasonCode });
            stop();
        };
        const scheduleRenewal = (expiresAtMs: number) => {
            clearRenewal();
            if (disposed || ended) return;
            const remainingMs = expiresAtMs - Date.now();
            if (remainingMs <= 0) { failRenewal('grant_expired'); return; }
            // Renew within the signed lifetime, through the existing grant owner.
            // A fresh grant is not a second capture start. Its exact expiry is
            // acknowledged by grant_expiring and schedules the next renewal.
            renewalTimer = setTimeout(() => {
                renewalTimer = undefined;
                void renewMachineLiveStreamRelayClient(clientInput).then((result) => {
                    if (disposed || ended) return;
                    if (!result.ok) { failRenewal(result.reasonCode); return; }
                    if (result.routeKind !== 'server_relay') { failRenewal('unexpected_route_kind'); return; }
                    transport.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, {
                        v: 1, sourceMachineId, targetMachineId,
                        ...(viewerSocketId ? { viewerSocketId } : {}),
                        message: { kind: 'renew', startRequest: result.startRequest },
                    });
                }).catch(() => failRenewal('grant_refresh_failed'));
            }, remainingMs / 2);
        };

        let unsubscribe = () => {};
        const subscribe = () => transport.onEnvelope((raw) => {
            if (disposed || ended) return;
            const parsed = MachineLiveStreamRelayEnvelopeV1Schema.safeParse(raw);
            if (!parsed.success) return;
            if (parsed.data.sourceMachineId !== sourceMachineId || parsed.data.targetMachineId !== targetMachineId) return;
            if (parsed.data.message.kind === 'control' && parsed.data.message.control.streamId === streamId
                && parsed.data.message.control.kind === 'grant_expiring') {
                scheduleRenewal(parsed.data.message.control.expiresAtMs);
            }
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
            if (parsed.data.message.kind === 'receipt') {
                const receipt = MachineLiveStreamReceiptV1Schema.safeParse(parsed.data.message.receipt);
                if (receipt.success && receipt.data.streamId === streamId) latestRef.current.onReceipt?.(receipt.data);
            }
            const event = mapSimulatorRelayEnvelopeToIngestionEvent({
                envelope: parsed.data,
                sourceMachineId,
                targetMachineId,
                streamId,
            });
            if (parsed.data.message.kind === 'frame' && parsed.data.message.frame.streamId === streamId
                && parsed.data.message.frame.payloadKind === 'metadata') {
                latestRef.current.onMetadataFrame?.(parsed.data.message.frame);
                return;
            }
            if (event) {
                if (event.type === 'error' || event.type === 'stopped') { ended = true; clearRenewal(); }
                dispatch(event);
            }
        });

        const previousOpen = previousOpenRef.current;
        const open = () => openMachineLiveStreamRelayClient({
            ...clientInput,
            onAuthorized: (request) => {
                if (disposed || ended) return;
                setAuthorization({ identityKey: streamIdentityKey, caps: request });
                if (request.authorization) scheduleRenewal(request.authorization.payload.exp);
            },
        });
        const completion = (async () => {
            if (previousOpen) await previousOpen;
            if (disposed) return;
            unsubscribe = subscribe();
            return await open();
        })()
            .then((result) => {
                if (!result) return;
                // Cleanup can precede registration at the source. Stop the exact
                // viewer again when a late successful start becomes reachable.
                if (disposed) { if (result.ok) stop(); return; }
                if (result.ok) return;
                ended = true;
                clearRenewal();
                dispatch({ type: 'error', reasonCode: result.reasonCode });
            })
            .catch(() => {
                if (!disposed) { ended = true; clearRenewal(); dispatch({ type: 'error', reasonCode: 'relay_open_failed' }); }
            })
            .finally(() => {
                openSettled = true;
                if (disposed) unsubscribe();
            });
        previousOpenRef.current = completion;

        return () => {
            disposed = true;
            requestController.abort();
            clearRenewal();
            stop();
            // A late accepted capture needs its own final Stop before the carrier retires.
            if (openSettled) unsubscribe();
        };
    }, [attempt, enabled, transport, serverId, simulatorId, sourceMachineId, targetMachineId, streamId, streamFamily, sourceId, sourceOccurrenceId]);

    const onFrameDecoded = React.useCallback(() => dispatch({ type: 'frame_decoded', streamId }), [streamId]);
    const playerStatesBySimulatorId = React.useMemo<UseSimulatorRelayIngestionResult['playerStatesBySimulatorId']>(() => {
        // A suspended subscriber retains its exact stream's last frame. Never
        // project that frame under a different source while the surface is hidden.
        if (!retainPicture) return EMPTY_PLAYER_STATES;
        return { [simulatorId]: { ...toSimulatorPreviewStreamState(state), onFrameDecoded } };
    }, [retainPicture, streamIdentityKey, simulatorId, state, onFrameDecoded]);

    const negotiatedCaps = enabled && authorization?.identityKey === streamIdentityKey ? authorization.caps : null;
    return React.useMemo(() => ({ playerStatesBySimulatorId, retry, negotiatedCaps }), [playerStatesBySimulatorId, retry, negotiatedCaps]);
}

export type { SimulatorRelayStreamState };
