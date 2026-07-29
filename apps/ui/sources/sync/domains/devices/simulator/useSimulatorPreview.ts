import * as React from 'react';
import type {
    MachineLiveStreamControlSidebandV1,
    SimulatorOrientationV1,
    SimulatorSidebandKindV1,
} from '@happier-dev/protocol';
import { isBackedSimulatorSidebandKindV1 } from '@happier-dev/protocol';

import {
    buildSimulatorPreviewControl,
    simulatorPreviewControlActionRequiresLease,
    type SimulatorPreviewControlAction,
} from './control';
import type { SimulatorPreviewApi } from './api';
import { selectSimulatorPreviewViewModel } from './selectors';
import type { SimulatorPreviewSelectionHookInput, SimulatorPreviewViewModel } from './types';

export type SimulatorPreviewActions = Readonly<{
    selectDevice: (simulatorId: string) => void;
    openStream: () => Promise<void>;
    closeStream: () => Promise<void>;
    acquireLease: () => Promise<void>;
    releaseLease: () => Promise<void>;
    renewLease: () => Promise<void>;
    sendControl: (control: MachineLiveStreamControlSidebandV1) => Promise<void>;
    requestSideband: (kind: SimulatorSidebandKindV1) => Promise<void>;
    requestKeyframe: () => Promise<void>;
    requestSnapshot: () => Promise<void>;
    lowerQuality: () => Promise<void>;
    setFps: () => Promise<void>;
    setScale: () => Promise<void>;
    rotateLeft: () => Promise<void>;
    pressHome: () => Promise<void>;
    pressBack: () => Promise<void>;
    pressRecent: () => Promise<void>;
    pressVolumeUp: () => Promise<void>;
    pressVolumeDown: () => Promise<void>;
}>;

export type UseSimulatorPreviewResult = Readonly<{
    viewModel: SimulatorPreviewViewModel;
    actions: SimulatorPreviewActions;
}>;

function createEventId(kind: string): string {
    return `simulator:${kind}:${Date.now()}`;
}

function resolveSourceAndStream(viewModel: SimulatorPreviewViewModel): Readonly<{
    simulatorId: string;
    sourceId: string;
    streamId: string;
}> | null {
    if (!viewModel.resource || !viewModel.selectedSimulatorId) return null;
    const sourceId = viewModel.resource.capture.status === 'unavailable'
        ? viewModel.activeLease?.sourceId
        : viewModel.resource.capture.sourceId;
    const streamId = viewModel.stream.streamId ?? viewModel.activeLease?.streamId;
    if (!sourceId || !streamId) return null;
    return { simulatorId: viewModel.selectedSimulatorId, sourceId, streamId };
}

function resourceAllowsInput(viewModel: SimulatorPreviewViewModel): boolean {
    return !!viewModel.resource
        && viewModel.resource.capture.status !== 'unavailable'
        && viewModel.resource.capture.inputMode !== 'none';
}

function canAcquireInputLease(viewModel: SimulatorPreviewViewModel): boolean {
    return resourceAllowsInput(viewModel) && viewModel.lease.state === 'available';
}

function canSendAction(viewModel: SimulatorPreviewViewModel, action: SimulatorPreviewControlAction): boolean {
    if (!simulatorPreviewControlActionRequiresLease(action)) return viewModel.controls.canWatch;
    return resourceAllowsInput(viewModel)
        && viewModel.controls.canControl
        && viewModel.controls.supportedInputKinds.includes(action.kind);
}

function buildActionControl(viewModel: SimulatorPreviewViewModel, action: SimulatorPreviewControlAction): MachineLiveStreamControlSidebandV1 | null {
    if (!canSendAction(viewModel, action)) return null;
    const sourceAndStream = resolveSourceAndStream(viewModel);
    if (!sourceAndStream) return null;
    const result = buildSimulatorPreviewControl({
        streamId: sourceAndStream.streamId,
        sourceId: sourceAndStream.sourceId,
        viewerId: viewModel.viewerId,
        eventId: createEventId(action.kind),
        activeLease: viewModel.activeLease,
        action,
    });
    return result.ok ? result.control : null;
}

async function sendBuiltControl(input: Readonly<{
    api?: Partial<SimulatorPreviewApi>;
    viewModel: SimulatorPreviewViewModel;
    action: SimulatorPreviewControlAction;
}>): Promise<void> {
    const control = buildActionControl(input.viewModel, input.action);
    if (!control) return;
    await input.api?.sendControl?.({ control });
}

export function useSimulatorPreview(input: SimulatorPreviewSelectionHookInput & Readonly<{
    api?: Partial<SimulatorPreviewApi>;
    renewLeaseThresholdMs?: number;
}>): UseSimulatorPreviewResult {
    // Resolve the clock function once into a ref so the view-model memo + lease effect can read
    // the current time without taking `nowMs` as a render-churning dependency (L0-3).
    const nowMsFn = input.nowMs ?? Date.now;
    const nowMsRef = React.useRef(nowMsFn);
    nowMsRef.current = nowMsFn;
    const [localSelectedSimulatorId, setLocalSelectedSimulatorId] = React.useState<string | null>(
        input.selectedSimulatorId ?? null,
    );

    React.useEffect(() => {
        if (input.selectedSimulatorId !== undefined) {
            setLocalSelectedSimulatorId(input.selectedSimulatorId);
        }
    }, [input.selectedSimulatorId]);

    const viewModel = React.useMemo(() => selectSimulatorPreviewViewModel({
        resources: input.resources,
        selectedSimulatorId: localSelectedSimulatorId,
        viewerId: input.viewerId,
        previewStatesBySimulatorId: input.previewStatesBySimulatorId,
        playerStatesBySimulatorId: input.playerStatesBySimulatorId,
        snapshotDiagnostics: input.snapshotDiagnostics,
        nowMs: nowMsRef.current(),
    }), [
        input.resources,
        localSelectedSimulatorId,
        input.viewerId,
        input.previewStatesBySimulatorId,
        input.playerStatesBySimulatorId,
        input.snapshotDiagnostics,
    ]);

    const sourceAndStream = resolveSourceAndStream(viewModel);
    const renewKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const thresholdMs = input.renewLeaseThresholdMs ?? 15_000;
        if (
            viewModel.lease.state !== 'held-by-me'
            || !viewModel.lease.leaseId
            || typeof viewModel.lease.expiresAtMs !== 'number'
            || !sourceAndStream
            || !input.api?.renewLease
        ) {
            return;
        }
        const nowMs = nowMsRef.current();
        if (viewModel.lease.expiresAtMs - nowMs > thresholdMs) return;
        const renewKey = `${viewModel.lease.leaseId}:${viewModel.lease.expiresAtMs}`;
        if (renewKeyRef.current === renewKey) return;
        renewKeyRef.current = renewKey;
        void input.api.renewLease({
            ...sourceAndStream,
            leaseId: viewModel.lease.leaseId,
            viewerId: viewModel.viewerId,
        });
    }, [input.api, input.renewLeaseThresholdMs, sourceAndStream, viewModel]);

    const actions = React.useMemo<SimulatorPreviewActions>(() => ({
        selectDevice: (simulatorId) => {
            setLocalSelectedSimulatorId(simulatorId);
        },
        openStream: async () => {
            // Server-relayed live capture is opened by `useSimulatorRelayIngestion` via the
            // signed startRequest + machine-RPC path. The old simulator.stream.open RPC is retired.
        },
        closeStream: async () => {
            // Stream teardown is driven by relay stop controls on ingestion cleanup.
        },
        acquireLease: async () => {
            if (!sourceAndStream || !canAcquireInputLease(viewModel)) return;
            await input.api?.acquireLease?.({
                ...sourceAndStream,
                viewerId: viewModel.viewerId,
            });
        },
        releaseLease: async () => {
            if (!sourceAndStream || !viewModel.lease.leaseId) return;
            await input.api?.releaseLease?.({
                ...sourceAndStream,
                leaseId: viewModel.lease.leaseId,
            });
        },
        renewLease: async () => {
            if (!sourceAndStream || !viewModel.lease.leaseId) return;
            await input.api?.renewLease?.({
                ...sourceAndStream,
                leaseId: viewModel.lease.leaseId,
                viewerId: viewModel.viewerId,
            });
        },
        sendControl: async (control) => {
            await input.api?.sendControl?.({ control });
        },
        requestSideband: async (kind) => {
            if (!isBackedSimulatorSidebandKindV1(kind)) return;
            if (!viewModel.selectedSimulatorId) return;
            await input.api?.requestSideband?.({ simulatorId: viewModel.selectedSimulatorId, kind });
        },
        requestKeyframe: async () => {
            if (!viewModel.controls.canRequestKeyframe) return;
            const control = buildActionControl(viewModel, { kind: 'request_keyframe' });
            if (!control || !sourceAndStream) return;
            if (control.kind !== 'request_keyframe') return;
            await input.api?.requestKeyframe?.({ ...sourceAndStream, control });
        },
        requestSnapshot: async () => {
            if (!viewModel.controls.canRequestSnapshot) return;
            if (!sourceAndStream) return;
            await input.api?.requestSnapshot?.(sourceAndStream);
        },
        lowerQuality: async () => {
            if (!viewModel.controls.canSetQuality) return;
            const control = buildActionControl(viewModel, { kind: 'set_quality', maxFramesPerSecond: 15, maxWidth: 720 });
            if (!control || !sourceAndStream) return;
            if (control.kind !== 'set_quality') return;
            await input.api?.setQuality?.({ ...sourceAndStream, control });
        },
        setFps: async () => {
            if (!viewModel.controls.canSetFps) return;
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'set_quality', maxFramesPerSecond: 30 } });
        },
        setScale: async () => {
            if (!viewModel.controls.canSetScale) return;
            await sendBuiltControl({
                api: input.api,
                viewModel,
                action: { kind: 'set_quality', maxWidth: 1080, maxHeight: 1080 },
            });
        },
        rotateLeft: async () => {
            await sendBuiltControl({
                api: input.api,
                viewModel,
                action: { kind: 'orientation', orientation: 'landscapeLeft' satisfies SimulatorOrientationV1 },
            });
        },
        pressHome: async () => {
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'hardware_button', button: 'home' } });
        },
        pressBack: async () => {
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'hardware_button', button: 'back' } });
        },
        pressRecent: async () => {
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'hardware_button', button: 'recents' } });
        },
        pressVolumeUp: async () => {
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'hardware_button', button: 'volumeup' } });
        },
        pressVolumeDown: async () => {
            await sendBuiltControl({ api: input.api, viewModel, action: { kind: 'hardware_button', button: 'volumedown' } });
        },
    }), [input.api, sourceAndStream, viewModel]);

    return { viewModel, actions };
}
