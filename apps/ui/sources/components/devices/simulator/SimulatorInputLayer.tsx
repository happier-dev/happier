import * as React from 'react';
import type { MachineLiveStreamControlSidebandV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type { SimulatorOrientationV1, SimulatorPreviewRectV1 } from '@happier-dev/protocol/devices/simulator/inputV1';

import { LiveStreamInputLayer } from '@/components/stream/LiveStreamInputLayer';

import { buildSimulatorPreviewControl } from '@/sync/domains/devices/simulator/control';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { LiveStreamInputGesture } from '@/sync/domains/machines/peer/mediation/stream/inputGesture';

import { simulatorStreamStyles } from './styles';

function resolveSourceAndStream(viewModel: SimulatorPreviewViewModel): Readonly<{ sourceId: string; streamId: string }> | null {
    const sourceId = viewModel.resource?.capture.status === 'unavailable'
        ? viewModel.activeLease?.sourceId
        : viewModel.resource?.capture.sourceId;
    const streamId = viewModel.stream.streamId ?? viewModel.activeLease?.streamId;
    if (!sourceId || !streamId) return null;
    return { sourceId, streamId };
}

function supports(viewModel: SimulatorPreviewViewModel, kind: LiveStreamInputGesture['kind']): boolean {
    return kind !== 'pointer' && kind !== 'wheel' && viewModel.controls.supportedInputKinds.includes(kind);
}

function resourceAllowsInput(viewModel: SimulatorPreviewViewModel): boolean {
    return !!viewModel.resource
        && viewModel.resource.capture.status !== 'unavailable'
        && viewModel.resource.capture.inputMode !== 'none';
}

function canAcceptInput(viewModel: SimulatorPreviewViewModel): boolean {
    return resourceAllowsInput(viewModel)
        && viewModel.controls.canControl
        && viewModel.controls.supportedInputKinds.length > 0;
}

/**
 * The simulator's viewer input: the shared {@link LiveStreamInputLayer} gestures, sent as the
 * simulator's lease-scoped device controls through the central simulator control builder.
 */
export function SimulatorInputLayer(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    viewport?: Readonly<{ width: number; height: number }>;
    content?: SimulatorPreviewRectV1;
    orientation?: SimulatorOrientationV1;
    onSendControl: (control: MachineLiveStreamControlSidebandV1) => void;
    testID: string;
}>): React.ReactElement {
    const { viewModel, onSendControl } = props;
    const sourceAndStream = resolveSourceAndStream(viewModel);
    const supportsKind = React.useCallback(
        (kind: LiveStreamInputGesture['kind']) => supports(viewModel, kind),
        [viewModel],
    );
    const onGesture = React.useCallback((input: Readonly<{
        eventId: string;
        action: Parameters<typeof buildSimulatorPreviewControl>[0]['action'];
    }>) => {
        if (!sourceAndStream) return;
        const result = buildSimulatorPreviewControl({
            streamId: sourceAndStream.streamId,
            sourceId: sourceAndStream.sourceId,
            viewerId: viewModel.viewerId,
            eventId: input.eventId,
            activeLease: viewModel.activeLease,
            action: input.action,
        });
        if (result.ok) onSendControl(result.control);
    }, [onSendControl, sourceAndStream, viewModel]);
    return (
        <LiveStreamInputLayer
            inputAccepted={canAcceptInput(viewModel) && sourceAndStream !== null}
            supports={supportsKind}
            viewport={props.viewport}
            content={props.content}
            orientation={props.orientation}
            onGesture={onGesture}
            style={simulatorStreamStyles.inputLayer}
            testID={props.testID}
        />
    );
}
