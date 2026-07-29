import type {
    MachineLiveStreamCodecIdV1,
    MachineLiveStreamPayloadKindV1,
} from '@happier-dev/protocol';

import type {
    SimulatorCaptureFrameProducer,
    SimulatorCaptureFrameProducerSession,
    SimulatorCaptureFrameProducerStartInput,
    SimulatorCaptureProducerFrame,
} from '../capture/adapter';
import type { IosSimulatorHelperFrameMessage } from './helperProtocol';

type MaybePromise<T> = T | Promise<T>;

export type IosSimulatorHelperFrameStream = Readonly<{
    stop: () => MaybePromise<void>;
}>;

export type IosSimulatorHelperFrameStreamOpenInput = Readonly<{
    sourceId: string;
    streamId: string;
    codecId: MachineLiveStreamCodecIdV1;
    emitMessage: (message: IosSimulatorHelperFrameMessage) => void;
}>;

export type IosSimulatorHelperFrameStreamOpener = (
    input: IosSimulatorHelperFrameStreamOpenInput,
) => MaybePromise<IosSimulatorHelperFrameStream>;

export type CreateIosSimulatorHelperFrameProducerInput = Readonly<{
    openStream: IosSimulatorHelperFrameStreamOpener;
}>;

function readyFrameFromHelperMessage(
    message: IosSimulatorHelperFrameMessage,
): SimulatorCaptureProducerFrame {
    return {
        codecId: message.codecId,
        frame: {
            v: 1,
            timestampMs: message.timestampMs,
            payloadKind: message.payloadKind as MachineLiveStreamPayloadKindV1,
            payloadEncoding: 'binary_base64',
            payloadBase64: message.payloadBase64,
            payloadSizeBytes: message.payloadSizeBytes,
        },
    };
}

export function createIosSimulatorHelperFrameProducer(
    input: CreateIosSimulatorHelperFrameProducerInput,
): SimulatorCaptureFrameProducer {
    return {
        start: async (startInput: SimulatorCaptureFrameProducerStartInput): Promise<SimulatorCaptureFrameProducerSession> => {
            let stream: IosSimulatorHelperFrameStream | null = null;
            let stopRequested = false;
            let stopInvoked = false;

            const stopOnce = async (): Promise<void> => {
                stopRequested = true;
                if (stopInvoked || !stream) return;
                stopInvoked = true;
                await stream?.stop();
            };

            const failClosed = (reasonCode: string): void => {
                startInput.fail(reasonCode);
                void stopOnce();
            };

            const emitMessage = (message: IosSimulatorHelperFrameMessage): void => {
                if (stopRequested) return;
                if (
                    message.sourceId !== startInput.sourceId
                    || message.streamId !== startInput.streamId
                    || message.codecId !== startInput.negotiatedCodecId
                ) {
                    failClosed('ios_helper_frame_stream_mismatch');
                    return;
                }
                startInput.emitFrame(readyFrameFromHelperMessage(message));
            };

            stream = await input.openStream({
                sourceId: startInput.sourceId,
                streamId: startInput.streamId,
                codecId: startInput.negotiatedCodecId,
                emitMessage,
            });

            if (stopRequested) await stopOnce();

            return {
                stop: stopOnce,
            };
        },
    };
}
