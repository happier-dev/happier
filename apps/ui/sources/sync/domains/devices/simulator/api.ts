import type {
    MachineLiveStreamControlSidebandV1,
    SimulatorPreviewActionV1,
    SimulatorSidebandKindV1,
} from '@happier-dev/protocol';
import {
    createSimulatorPreviewAcquireLeaseEventV1,
    createSimulatorPreviewCloseStreamEventV1,
    createSimulatorPreviewListDevicesEventV1,
    createSimulatorPreviewOpenStreamEventV1,
    createSimulatorPreviewReleaseLeaseEventV1,
    createSimulatorPreviewRenewLeaseEventV1,
    createSimulatorPreviewRequestKeyframeEventV1,
    createSimulatorPreviewSendControlEventV1,
    createSimulatorPreviewSetQualityEventV1,
    createSimulatorPreviewSidebandRequestEventV1,
    createSimulatorPreviewSnapshotRequestEventV1,
} from '@happier-dev/protocol';

export type SimulatorPreviewApiEvent = SimulatorPreviewActionV1;
type SimulatorSetQualityControl = Extract<MachineLiveStreamControlSidebandV1, { kind: 'set_quality' }>;
type SimulatorRequestKeyframeControl = Extract<MachineLiveStreamControlSidebandV1, { kind: 'request_keyframe' }>;

export type SimulatorPreviewApiDispatch = (event: SimulatorPreviewApiEvent) => void | Promise<void>;

export type SimulatorPreviewApi = Readonly<{
    listDevices: () => Promise<void>;
    openStream: (input: Readonly<{ simulatorId: string; sourceId: string }>) => Promise<void>;
    closeStream: (input: Readonly<{ simulatorId: string; streamId: string }>) => Promise<void>;
    acquireLease: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string; viewerId: string }>) => Promise<void>;
    releaseLease: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string; leaseId: string }>) => Promise<void>;
    renewLease: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string; leaseId: string; viewerId: string }>) => Promise<void>;
    sendControl: (input: Readonly<{ control: MachineLiveStreamControlSidebandV1 }>) => Promise<void>;
    requestSideband: (input: Readonly<{ simulatorId: string; kind: SimulatorSidebandKindV1 }>) => Promise<void>;
    setQuality: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string; control: SimulatorSetQualityControl }>) => Promise<void>;
    requestKeyframe: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string; control: SimulatorRequestKeyframeControl }>) => Promise<void>;
    requestSnapshot: (input: Readonly<{ simulatorId: string; streamId: string; sourceId: string }>) => Promise<void>;
}>;

export function createSimulatorPreviewApi(input: Readonly<{
    dispatch: SimulatorPreviewApiDispatch;
    createEventId?: (kind: string) => string;
}>): SimulatorPreviewApi {
    const dispatch = async (event: SimulatorPreviewApiEvent): Promise<void> => {
        await input.dispatch(event);
    };
    const createEventId = input.createEventId ?? ((kind: string) => `${kind}:${Date.now()}`);

    return {
        listDevices: async () => dispatch(createSimulatorPreviewListDevicesEventV1()),
        openStream: async (event) => dispatch(createSimulatorPreviewOpenStreamEventV1(event)),
        closeStream: async (event) => dispatch(createSimulatorPreviewCloseStreamEventV1(event)),
        acquireLease: async (event) => dispatch(createSimulatorPreviewAcquireLeaseEventV1(event)),
        releaseLease: async (event) => dispatch(createSimulatorPreviewReleaseLeaseEventV1(event)),
        renewLease: async (event) => dispatch(createSimulatorPreviewRenewLeaseEventV1(event)),
        sendControl: async (event) => dispatch(createSimulatorPreviewSendControlEventV1(event)),
        requestSideband: async (event) => dispatch(createSimulatorPreviewSidebandRequestEventV1(event)),
        setQuality: async (event) => dispatch(createSimulatorPreviewSetQualityEventV1(event)),
        requestKeyframe: async (event) => dispatch(createSimulatorPreviewRequestKeyframeEventV1(event)),
        requestSnapshot: async (event) => dispatch(createSimulatorPreviewSnapshotRequestEventV1({
            ...event,
            createEventId,
        })),
    };
}
