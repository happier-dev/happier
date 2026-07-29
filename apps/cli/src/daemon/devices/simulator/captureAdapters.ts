import type {
    SimulatorCaptureCapabilitiesV1,
    SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import {
    unavailableMachineLiveStreamCaptureAdapter,
    type MachineLiveStreamCaptureAdapter,
} from '../../peer/mediation/stream';
import {
    createAndroidScrcpyServerCaptureAdapter,
    type AndroidScrcpyServerEnsurer,
    type AndroidScrcpyServerRestarter,
} from './android/capture';
import type { AndroidScrcpyServerEncoderParamsV1 } from './android/server';
import { createSimulatorFrameProducerCaptureAdapter } from './capture/adapter';
import {
    createIosSimulatorHelperFrameProducer,
    type IosSimulatorHelperFrameStreamOpener,
} from './ios/helperFrameProducer';

export type SimulatorCaptureAdapterFactoryOptions = Readonly<{
    android?: Readonly<{
        ensureServer?: AndroidScrcpyServerEnsurer;
        /**
         * Restart capability for encoder reconfiguration (set_quality / request_keyframe /
         * snapshot). When supplied, the adapter uses the server-restart producer.
         */
        restartServer?: AndroidScrcpyServerRestarter;
        initialEncoder?: AndroidScrcpyServerEncoderParamsV1;
        adaptiveBitrate?: boolean;
        maxBufferedBytes?: number;
    }>;
    ios?: Readonly<{
        openStream?: IosSimulatorHelperFrameStreamOpener;
    }>;
}>;

function readAvailableCapture(resource: SimulatorDeviceResourceV1): SimulatorCaptureCapabilitiesV1 | null {
    if (resource.unavailableReason) return null;
    if (resource.capture.status === 'unavailable') return null;
    return resource.capture;
}

export function createSimulatorCaptureAdapterForResource(
    resource: SimulatorDeviceResourceV1,
    options: SimulatorCaptureAdapterFactoryOptions = {},
): MachineLiveStreamCaptureAdapter {
    const capture = readAvailableCapture(resource);
    if (!capture) {
        return unavailableMachineLiveStreamCaptureAdapter;
    }

    if (resource.platform === 'android') {
        if (!capture.supportedCodecs.includes('h264.avcc')) {
            return unavailableMachineLiveStreamCaptureAdapter;
        }
        return createAndroidScrcpyServerCaptureAdapter({
            serial: resource.deviceId,
            sourceId: capture.sourceId,
            ...(options.android?.ensureServer ? { ensureServer: options.android.ensureServer } : {}),
            ...(options.android?.restartServer ? { restartServer: options.android.restartServer } : {}),
            ...(options.android?.initialEncoder ? { initialEncoder: options.android.initialEncoder } : {}),
            ...(options.android?.adaptiveBitrate ? { adaptiveBitrate: options.android.adaptiveBitrate } : {}),
            ...(options.android?.maxBufferedBytes ? { maxBufferedBytes: options.android.maxBufferedBytes } : {}),
        });
    }

    if (resource.platform === 'ios' && options.ios?.openStream) {
        return createSimulatorFrameProducerCaptureAdapter({
            sourceId: capture.sourceId,
            sourceCodecs: capture.supportedCodecs,
            producer: createIosSimulatorHelperFrameProducer({
                openStream: options.ios.openStream,
            }),
        });
    }

    return unavailableMachineLiveStreamCaptureAdapter;
}
