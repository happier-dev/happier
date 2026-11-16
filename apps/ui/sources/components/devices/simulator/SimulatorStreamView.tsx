import * as React from 'react';
import { ScrollView, View } from 'react-native';
import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type { SimulatorDeviceResourceV1 } from '@happier-dev/protocol/devices/simulator/v1';

import { BrowserFrameStatusCapsule } from '@/components/browser/frame/BrowserFrameStatusCapsule';
import { LiveStreamPlayer, type LiveStreamPlayerDisplayState } from '@/components/stream/LiveStreamPlayer';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { SimulatorUnavailableState } from './SimulatorUnavailableState';
import { simulatorStreamStyles } from './styles';

export type SimulatorStreamViewControls = Readonly<{
    canWatch: boolean;
    canControl: boolean;
    canRequestKeyframe: boolean;
    canSetQuality: boolean;
    supportedInputKinds: readonly MachineLiveStreamControlSidebandV1['kind'][];
}>;

type SimulatorStreamStage = 'unavailable' | 'opening' | 'connecting' | 'restoring' | 'stopped' | 'held' | 'live';

function resolveCaptureReason(resource: SimulatorDeviceResourceV1): string | undefined {
    if (resource.capture.status === 'unavailable') return resource.capture.reasonCode;
    return resource.unavailableReason;
}

/**
 * Which picture state the stage shows, from capture truth and the shared player's phase. Opening the
 * device (no stream yet) and connecting its screen (the stream negotiates) are told apart; a
 * reconnect keeps the last picture, dimmed, instead of dropping to a placeholder.
 */
export function resolveSimulatorStreamStage(input: Readonly<{
    resource: SimulatorDeviceResourceV1;
    playerState: Pick<SimulatorPreviewStreamState, 'phase' | 'lastFrameUrl' | 'avccChunks'>;
    canWatch: boolean;
}>): SimulatorStreamStage {
    if (input.resource.capture.status === 'unavailable' || !input.canWatch) return 'unavailable';
    const hasFrame = typeof input.playerState.lastFrameUrl === 'string' && input.playerState.lastFrameUrl.length > 0;
    // An in-flight WebCodecs decode keeps its renderer mounted to produce the first frame.
    const hasPicture = hasFrame || (input.playerState.avccChunks?.length ?? 0) > 0;
    switch (input.playerState.phase) {
        case 'error':
            return 'unavailable';
        case 'reconnecting':
            return hasPicture ? 'held' : 'restoring';
        case 'stopped':
            return hasPicture ? 'held' : 'stopped';
        case 'idle':
            return hasPicture ? 'live' : 'opening';
        case 'opening':
            return hasPicture ? 'live' : 'connecting';
        default:
            return 'live';
    }
}

function StateStage(props: React.PropsWithChildren<Readonly<{ testID?: string }>>): React.ReactElement {
    return (
        <ScrollView
            style={simulatorStreamStyles.stateStage}
            contentContainerStyle={simulatorStreamStyles.stateStageContent}
            showsVerticalScrollIndicator={false}
            testID={props.testID}
        >
            {props.children}
        </ScrollView>
    );
}

export function SimulatorStreamView(props: Readonly<{
    resource: SimulatorDeviceResourceV1;
    playerState: LiveStreamPlayerDisplayState & Pick<SimulatorPreviewStreamState, 'avccChunks' | 'onFrameDecoded' | 'onDecoderRecoveryRequired' | 'onDecoderFailure'>;
    controls: SimulatorStreamViewControls;
    /** Reopen the stream; offered on a failed or stopped stream, never on a capture setup problem. */
    onRetry?: () => void;
    testID: string;
}>): React.ReactElement {
    const stage = resolveSimulatorStreamStage({
        resource: props.resource,
        playerState: props.playerState,
        canWatch: props.controls.canWatch,
    });
    const captureUnavailable = props.resource.capture.status === 'unavailable';
    const retry = props.onRetry ? { label: t('common.retry'), onPress: props.onRetry } : undefined;

    if (stage === 'unavailable') {
        const reasonCode = captureUnavailable
            ? resolveCaptureReason(props.resource)
            : props.playerState.diagnostic?.reasonCode ?? resolveCaptureReason(props.resource) ?? 'watch_unavailable';
        return (
            <StateStage testID={props.testID}>
                <SimulatorUnavailableState
                    reasonCode={reasonCode}
                    action={captureUnavailable ? undefined : retry}
                    testID={props.testID}
                />
            </StateStage>
        );
    }
    if (stage === 'opening' || stage === 'connecting' || stage === 'restoring') {
        return (
            <StateStage testID={props.testID}>
                <SurfaceStateCard
                    testID={`${props.testID}-connecting`}
                    kind="loading"
                    title={stage === 'opening'
                        ? t('simulatorPreview.viewer.opening', { device: props.resource.displayName })
                        : stage === 'connecting'
                            ? t('simulatorPreview.viewer.connectingVideo')
                            : t('simulatorPreview.status.restoring')}
                />
            </StateStage>
        );
    }
    if (stage === 'stopped') {
        return (
            <StateStage testID={props.testID}>
                <SurfaceStateCard
                    testID={`${props.testID}-stopped`}
                    kind="unavailable"
                    iconName="device-mobile"
                    title={t('streamPlayer.status.stopped')}
                    action={retry}
                />
            </StateStage>
        );
    }
    return (
        <View testID={props.testID} style={simulatorStreamStyles.fill}>
            <LiveStreamPlayer
                // C-STALE: key the player by the selected simulator id so switching the device remounts
                // the decoder and discards the previous device's held frame.
                key={props.resource.simulatorId}
                avcc={props.playerState.avccChunks && props.playerState.avccChunks.length > 0
                    ? { chunks: props.playerState.avccChunks, onDecoded: props.playerState.onFrameDecoded, onRecoveryRequired: props.playerState.onDecoderRecoveryRequired, onFailure: props.playerState.onDecoderFailure }
                    : undefined}
                state={props.playerState}
                statusOwnedByHost
                testID={`${props.testID}-player`}
            />
            {stage === 'held' ? (
                <>
                    <View style={simulatorStreamStyles.heldScrim} testID={`${props.testID}-held-scrim`} />
                    <BrowserFrameStatusCapsule
                        testID={`${props.testID}-held`}
                        text={props.playerState.phase === 'reconnecting'
                            ? t('simulatorPreview.viewer.reconnecting')
                            : t('streamPlayer.status.stopped')}
                        busy={props.playerState.phase === 'reconnecting'}
                        action={props.playerState.phase === 'reconnecting' ? undefined : retry}
                    />
                </>
            ) : null}
        </View>
    );
}
