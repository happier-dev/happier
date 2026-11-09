import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { PluginUiLiveStreamViewingV1Schema } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { DaemonPluginUiCaptureSourceDescriptorV1 } from '@happier-dev/protocol/daemon/pluginCaptureSources';
import type { HappierLiveStreamProps } from '@happier-dev/plugin-ui/presentation';
import { LiveStreamPlayer, type LiveStreamPlayerDisplayState } from '@/components/stream/LiveStreamPlayer';
import { useMachineLiveStreamRelaySocket } from '@/components/stream/useMachineLiveStreamRelaySocket';
import { useMachineLiveStreamId } from '@/components/stream/useMachineLiveStreamId';
import { useSimulatorRelayIngestion, type SimulatorRelayTransport } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import type { PluginSurfaceHostApiV1 } from './createPluginSurfaceHostApi';
import type { BoundPluginSurfaceMountLifetime } from './boundPluginSurfaceController';

const WAITING_STATE: LiveStreamPlayerDisplayState = { phase: 'opening', selectedCodec: null, activeRenderer: null,
    decodedFrames: 0, droppedFrames: 0, bufferedBytes: 0 };
const UNAVAILABLE_STATE: LiveStreamPlayerDisplayState = { ...WAITING_STATE, phase: 'error' };

/** The author receives only a reference consumer; relay/decoder custody stays in this host. */
export function PluginLiveStreamViewer(props: HappierLiveStreamProps & Readonly<{
    hostApi: PluginSurfaceHostApiV1; mountLifetime: BoundPluginSurfaceMountLifetime;
    surface: PluginUiSurfaceContextV1;
    machineId: string | null; serverId: string | null;
    readViewing(subscriptionId: string): DaemonPluginUiCaptureSourceDescriptorV1 | null;
}>) {
    const viewingId = React.useId();
    const requestSequence = React.useRef(0);
    const referenceKey = props.reference.kind === 'host' ? `host:${props.reference.sourceId}`
        : `plugin:${props.reference.source.pluginId}/${props.reference.source.localId}`;
    const [admission, setAdmission] = React.useState<Readonly<{ key: string; source: DaemonPluginUiCaptureSourceDescriptorV1 | null }> | null>(null);
    const source = admission?.key === referenceKey ? admission.source : null;
    const { hostApi, mountLifetime, readViewing } = props;
    React.useEffect(() => {
        const controller = new AbortController();
        const retirement = mountLifetime.onRetire(() => { controller.abort(); setAdmission({ key: referenceKey, source: null }); });
        const subscriptionId = `plugin-stream:${viewingId}`;
        requestSequence.current += 1;
        const request = { version: 1 as const, requestId: `${subscriptionId}:watch:${requestSequence.current}`, surface: props.surface,
            method: 'watchLiveStream' as const, payload: { subscriptionId, reference: props.reference } };
        // The physical mount supplies the same host-stamped surface envelope used by its SDK adapter.
        void Promise.resolve(hostApi.handleRequest(request, { signal: controller.signal })).then(result => {
            if (controller.signal.aborted || !mountLifetime.isCurrent()) return;
            const parsed = PluginUiLiveStreamViewingV1Schema.safeParse(result);
            setAdmission({ key: referenceKey, source: parsed.success ? readViewing(subscriptionId) : null });
        }).catch(() => { if (!controller.signal.aborted) setAdmission({ key: referenceKey, source: null }); });
        return () => {
            controller.abort(); retirement.dispose();
            void hostApi.handleRequest({ ...request, requestId: `${subscriptionId}:dispose`, method: 'disposeHostResource',
                payload: { subscriptionId } });
        };
    }, [hostApi, mountLifetime, readViewing, referenceKey, viewingId, props.surface]);
    const socket = useMachineLiveStreamRelaySocket({ machineId: props.machineId, serverId: props.serverId,
        enabled: Boolean(source && mountLifetime.isCurrent()), disconnectTag: 'plugin-live-stream-disconnect' });
    const transport = React.useMemo<SimulatorRelayTransport | null>(() => socket
        ? { send: (_event, envelope) => socket.sendEnvelope(envelope), onEnvelope: listener => socket.onEnvelope(listener) } : null, [socket]);
    const streamId = useMachineLiveStreamId(source && socket?.socketId ? `plugin-live:${source.sourceOccurrenceId}:${socket.socketId}` : '');
    const ingestion = useSimulatorRelayIngestion({ enabled: Boolean(source && streamId && mountLifetime.isCurrent()), transport,
        serverId: props.serverId, sourceMachineId: socket?.machineId ?? '', targetMachineId: socket?.machineId ?? '',
        viewerSocketId: socket?.socketId, simulatorId: viewingId, streamId, streamFamily: source?.streamFamily ?? '',
        sourceId: source?.sourceId, sourceOccurrenceId: source?.sourceOccurrenceId, caps: {}, sourceCodecs: source?.supportedCodecs ?? [],
    });
    const playerState = ingestion.playerStatesBySimulatorId[viewingId];
    const state = playerState ?? (admission?.key === referenceKey && !source ? UNAVAILABLE_STATE : WAITING_STATE);
    // Portable author styling crosses into the incumbent React Native style boundary here.
    return <View style={props.style as StyleProp<ViewStyle>}><LiveStreamPlayer state={state} testID={props.testID ?? 'plugin-live-stream'}
        {...(playerState?.avccChunks?.length ? { avcc: { chunks: playerState.avccChunks } } : {})} /></View>;
}
