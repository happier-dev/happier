import * as React from 'react';
import { View } from 'react-native';

import { LiveStreamPlayer, type LiveStreamPlayerDisplayState } from '@/components/stream/LiveStreamPlayer';
import { StreamStatusDot, resolveStreamStatusDotVariant } from '@/components/stream/StreamStatusDot';
import { Text } from '@/components/ui/text/Text';
import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';
import type {
    MachineLiveStreamControlSidebandV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type {
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol/devices/simulator/v1';

import { SimulatorConnectingState } from './SimulatorConnectingState';
import { SimulatorUnavailableState } from './SimulatorUnavailableState';
import { simulatorStreamStyles } from './styles';

const CONNECTING_PHASES: ReadonlySet<LiveStreamPlayerDisplayState['phase']> = new Set([
    'opening',
    'reconnecting',
    'idle',
]);

export type SimulatorStreamViewControls = Readonly<{
    canWatch: boolean;
    canControl: boolean;
    canRequestKeyframe: boolean;
    canSetQuality: boolean;
    supportedInputKinds: readonly MachineLiveStreamControlSidebandV1['kind'][];
}>;

function resolveCaptureReason(resource: SimulatorDeviceResourceV1): string | undefined {
    if (resource.capture.status === 'unavailable') return resource.capture.reasonCode;
    return resource.unavailableReason;
}

export function SimulatorStreamView(props: Readonly<{
    resource: SimulatorDeviceResourceV1;
    playerState: LiveStreamPlayerDisplayState & Pick<SimulatorPreviewStreamState, 'avccChunks' | 'onFrameDecoded'>;
    controls: SimulatorStreamViewControls;
    testID: string;
}>): React.ReactElement {
    const captureReason = resolveCaptureReason(props.resource);
    const captureUnavailable = props.resource.capture.status === 'unavailable';
    const showUnavailable = captureUnavailable || !props.controls.canWatch;
    const unavailableReason = captureUnavailable
        ? captureReason
        : props.playerState.diagnostic?.reasonCode ?? captureReason ?? 'watch_unavailable';

    // Connecting/restoring skeleton: the stream is watchable but has not produced
    // a renderable frame yet and is in a transitional phase. We never skeleton over
    // a preserved frame, and we never replace an in-flight WebCodecs decode (its
    // renderer must stay mounted to produce the first frame), so the player still
    // owns the H.264 startup window. This is the no-frame-yet MJPEG/idle case.
    const hasFrame = typeof props.playerState.lastFrameUrl === 'string'
        && props.playerState.lastFrameUrl.length > 0;
    const hasWebCodecsInput = (props.playerState.avccChunks?.length ?? 0) > 0;
    const showConnecting = !showUnavailable
        && !hasFrame
        && !hasWebCodecsInput
        && CONNECTING_PHASES.has(props.playerState.phase);
    const connectingMode = props.playerState.phase === 'reconnecting' ? 'restoring' : 'connecting';

    return (
        <View testID={props.testID} style={simulatorStreamStyles.root}>
            <View style={simulatorStreamStyles.header}>
                <View style={simulatorStreamStyles.headerTitleRow}>
                    <StreamStatusDot
                        variant={resolveStreamStatusDotVariant(
                            props.playerState.phase,
                            props.playerState.diagnostic?.reasonCode,
                        )}
                        testID={`${props.testID}-header-dot`}
                    />
                    <Text style={simulatorStreamStyles.titleText} testID={`${props.testID}-title`}>
                        {props.resource.displayName}
                    </Text>
                </View>
            </View>
            <View style={simulatorStreamStyles.body}>
                {showUnavailable ? (
                    <SimulatorUnavailableState
                        reasonCode={unavailableReason}
                        testID={props.testID}
                    />
                ) : showConnecting ? (
                    <SimulatorConnectingState
                        mode={connectingMode}
                        testID={props.testID}
                    />
                ) : (
                    <LiveStreamPlayer
                        // C-STALE: key the player by the selected simulator id so switching the
                        // device remounts the decoder and discards the previous device's held
                        // frame. Without this, `LiveStreamPlayer`'s internal renderer state (last
                        // decoded frame / WebCodecs buffer) would survive a device switch and a
                        // stale frame from the previous simulator could be shown before the new
                        // device produces its first frame.
                        key={props.resource.simulatorId}
                        avcc={props.playerState.avccChunks && props.playerState.avccChunks.length > 0
                            ? { chunks: props.playerState.avccChunks, onDecoded: props.playerState.onFrameDecoded }
                            : undefined}
                        state={props.playerState}
                        testID={`${props.testID}-player`}
                    />
                )}
            </View>
        </View>
    );
}
