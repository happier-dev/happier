import type {
    MachineLiveStreamCodecIdV1,
    MachineLiveStreamControlLeaseV1,
    MachineLiveStreamFrameV1,
    SimulatorDeviceResourceV1,
    SimulatorSidebandKindV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol';
import { isBackedSimulatorSidebandKindV1 } from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';

import { projectSimulatorPreviewAvailability } from './availability';
import type { SimulatorPreviewState } from './store';
import {
    simulatorPreviewInputControlKinds,
    type SimulatorPreviewAvailability,
    type SimulatorPreviewControls,
    type SimulatorPreviewDiagnostic,
    type SimulatorPreviewLeaseState,
    type SimulatorPreviewSelectionInput,
    type SimulatorPreviewStreamState,
    type SimulatorPreviewViewModel,
} from './types';

const emptyStreamState: SimulatorPreviewStreamState = {
    phase: 'idle',
    selectedCodec: null,
    activeRenderer: null,
    decodedFrames: 0,
    droppedFrames: 0,
    bufferedBytes: 0,
};

type CodecTaggedFrame = MachineLiveStreamFrameV1 & Readonly<{ codecId?: unknown }>;

function isCaptureAvailable(resource: SimulatorDeviceResourceV1 | null): resource is SimulatorDeviceResourceV1 & {
    capture: Exclude<SimulatorDeviceResourceV1['capture'], { status: 'unavailable' }>;
} {
    return !!resource && resource.capture.status !== 'unavailable' && !resource.unavailableReason;
}

function resolveSourceId(resource: SimulatorDeviceResourceV1 | null, previewState: SimulatorPreviewState | null): string | undefined {
    if (isCaptureAvailable(resource)) return resource.capture.sourceId;
    return previewState?.activeLease?.sourceId;
}

function resolveStreamId(previewState: SimulatorPreviewState | null, stream: SimulatorPreviewStreamState | null): string | undefined {
    return stream?.streamId ?? previewState?.lastFrame?.streamId ?? previewState?.activeLease?.streamId;
}

function isLiveStreamCodecId(value: unknown): value is MachineLiveStreamCodecIdV1 {
    return value === 'image.frame.v1' || value === 'image.mjpeg' || value === 'h264.avcc';
}

export function resolveFrameCodecId(frame: MachineLiveStreamFrameV1): MachineLiveStreamCodecIdV1 | null {
    const codecId = (frame as CodecTaggedFrame).codecId;
    return isLiveStreamCodecId(codecId) ? codecId : null;
}

export function frameToUrl(frame: MachineLiveStreamFrameV1): string | undefined {
    if (resolveFrameCodecId(frame) === 'h264.avcc') return undefined;
    if (!frame.payloadKind.startsWith('image_')) return undefined;
    return `data:image/jpeg;base64,${frame.payloadBase64}`;
}

export function frameToAvccChunks(frame: MachineLiveStreamFrameV1): readonly Uint8Array[] | undefined {
    if (resolveFrameCodecId(frame) !== 'h264.avcc') return undefined;
    try {
        const bytes = decodeBase64(frame.payloadBase64, 'base64');
        if (bytes.byteLength !== frame.payloadSizeBytes) return undefined;
        return [bytes];
    } catch {
        return undefined;
    }
}

function selectCodec(resource: SimulatorDeviceResourceV1 | null, stream: SimulatorPreviewStreamState): MachineLiveStreamCodecIdV1 | null {
    if (stream.selectedCodec) return stream.selectedCodec;
    if (isCaptureAvailable(resource)) return resource.capture.supportedCodecs[0] ?? null;
    return null;
}

function activeRendererForCodec(input: Readonly<{
    codec: MachineLiveStreamCodecIdV1 | null;
    suppliedStream: SimulatorPreviewStreamState | null;
}>): SimulatorPreviewStreamState['activeRenderer'] {
    if (input.suppliedStream?.activeRenderer) return input.suppliedStream.activeRenderer;
    if (input.codec === 'image.mjpeg' || input.codec === 'image.frame.v1') return 'mjpeg';
    if (input.codec === 'h264.avcc') return 'webcodecs';
    return 'fallback';
}

function streamFromPreviewState(input: Readonly<{
    resource: SimulatorDeviceResourceV1 | null;
    previewState: SimulatorPreviewState | null;
    suppliedStream: SimulatorPreviewStreamState | null;
}>): SimulatorPreviewStreamState {
    const supplied = input.suppliedStream;
    if (supplied?.lastFrameUrl || !input.previewState?.lastFrame) {
        return supplied ?? emptyStreamState;
    }

    const lastFrameUrl = frameToUrl(input.previewState.lastFrame);
    const avccChunks = frameToAvccChunks(input.previewState.lastFrame);
    const codec = selectCodec(input.resource, supplied ?? emptyStreamState);
    const phase = input.previewState.phase === 'connected'
        ? 'playing'
        : input.previewState.phase === 'connecting'
            ? 'opening'
            : input.previewState.phase;

    return {
        ...(supplied ?? emptyStreamState),
        phase,
        streamId: input.previewState.lastFrame.streamId,
        selectedCodec: codec,
        activeRenderer: activeRendererForCodec({ codec, suppliedStream: supplied }),
        ...(lastFrameUrl ? { lastFrameUrl } : {}),
        ...(avccChunks ? { avccChunks } : {}),
        lastFrameAtMs: input.previewState.lastFrame.timestampMs,
        decodedFrames: Math.max(1, supplied?.decodedFrames ?? 0),
        droppedFrames: supplied?.droppedFrames ?? 0,
        bufferedBytes: supplied?.bufferedBytes ?? 0,
        ...(input.previewState.reasonCode ? { diagnostic: { reasonCode: input.previewState.reasonCode } } : {}),
    };
}

function selectLease(input: Readonly<{
    resource: SimulatorDeviceResourceV1 | null;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    viewerId: string;
    nowMs: number;
}>): SimulatorPreviewLeaseState {
    const inputAvailable = isCaptureAvailable(input.resource) && input.resource.capture.inputMode !== 'none';
    if (!inputAvailable) return { state: 'none' };
    if (!input.activeLease) return { state: inputAvailable ? 'available' : 'none' };
    if (input.activeLease.expiresAtMs <= input.nowMs) {
        return {
            state: 'expired',
            leaseId: input.activeLease.leaseId,
            holderLabel: input.activeLease.holderId,
            expiresAtMs: input.activeLease.expiresAtMs,
        };
    }
    if (input.activeLease.holderId === input.viewerId) {
        return {
            state: 'held-by-me',
            leaseId: input.activeLease.leaseId,
            expiresAtMs: input.activeLease.expiresAtMs,
        };
    }
    return {
        state: 'held-by-other',
        leaseId: input.activeLease.leaseId,
        holderLabel: input.activeLease.holderId,
        expiresAtMs: input.activeLease.expiresAtMs,
    };
}

function selectControls(input: Readonly<{
    resource: SimulatorDeviceResourceV1 | null;
    lease: SimulatorPreviewLeaseState;
    availability: SimulatorPreviewAvailability;
}>): SimulatorPreviewControls {
    const canWatch = isCaptureAvailable(input.resource) && input.availability.state !== 'unavailable';
    const inputSupported = isCaptureAvailable(input.resource) && input.resource.capture.inputMode !== 'none';
    const canControl = canWatch && inputSupported && input.lease.state === 'held-by-me';
    const streamControls = isCaptureAvailable(input.resource) ? input.resource.capture.streamControls : null;
    return {
        canWatch,
        canControl,
        canRequestKeyframe: canWatch && streamControls?.requestKeyframe === true,
        canRequestSnapshot: canWatch && streamControls?.snapshot === true,
        canSetQuality: canWatch && streamControls?.setQuality === true,
        canSetFps: canWatch && streamControls?.setFps === true,
        canSetScale: canWatch && streamControls?.setScale === true,
        supportedInputKinds: inputSupported
            ? input.resource.capture.supportedInputKinds ?? simulatorPreviewInputControlKinds
            : [],
    };
}

function collectDiagnostics(input: Readonly<{
    availability: SimulatorPreviewAvailability;
    stream: SimulatorPreviewStreamState;
    lease: SimulatorPreviewLeaseState;
    previewState: SimulatorPreviewState | null;
    snapshotDiagnostics?: readonly unknown[];
}>): readonly SimulatorPreviewDiagnostic[] {
    const diagnostics: SimulatorPreviewDiagnostic[] = [];
    const seenReasonCodes = new Set<string>();
    const pushDiagnostic = (diagnostic: SimulatorPreviewDiagnostic): void => {
        if (seenReasonCodes.has(diagnostic.reasonCode)) return;
        seenReasonCodes.add(diagnostic.reasonCode);
        diagnostics.push(diagnostic);
    };
    if (input.availability.reasonCode) {
        pushDiagnostic({
            severity: input.availability.state === 'unavailable' ? 'error' : 'warning',
            kind: 'availability',
            reasonCode: input.availability.reasonCode,
        });
    }
    if (input.stream.diagnostic?.reasonCode && input.stream.diagnostic.reasonCode !== input.availability.reasonCode) {
        pushDiagnostic({
            severity: input.stream.phase === 'error' ? 'error' : 'warning',
            kind: 'stream',
            reasonCode: input.stream.diagnostic.reasonCode,
        });
    }
    if (input.lease.state === 'expired') {
        pushDiagnostic({ severity: 'warning', kind: 'lease', reasonCode: 'lease_expired' });
    } else if (input.lease.state === 'held-by-other') {
        pushDiagnostic({ severity: 'info', kind: 'lease', reasonCode: 'lease_held_by_other' });
    }
    const captureHealth = input.previewState?.sidebandsByKind?.capture_health;
    if (captureHealth?.kind === 'capture_health' && captureHealth.reasonCode && captureHealth.reasonCode !== input.availability.reasonCode) {
        pushDiagnostic({ severity: 'warning', kind: 'sideband', reasonCode: captureHealth.reasonCode });
    }
    for (const diagnostic of input.snapshotDiagnostics ?? []) {
        const projected = projectSnapshotDiagnostic(diagnostic);
        if (projected) pushDiagnostic(projected);
    }
    return diagnostics;
}

function projectSnapshotDiagnostic(value: unknown): SimulatorPreviewDiagnostic | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const reasonCode = (value as { reasonCode?: unknown }).reasonCode;
    if (typeof reasonCode !== 'string' || reasonCode.length === 0) {
        return null;
    }
    const severity = (value as { severity?: unknown }).severity;
    return {
        severity: severity === 'info' || severity === 'warning' || severity === 'error'
            ? severity
            : 'warning',
        kind: 'availability',
        reasonCode,
    };
}

function selectDeviceOptions(input: SimulatorPreviewSelectionInput): readonly SimulatorPreviewViewModel['devices'][number][] {
    return input.resources.map((resource) => {
        const previewState = input.previewStatesBySimulatorId?.[resource.simulatorId] ?? null;
        const stream = input.playerStatesBySimulatorId?.[resource.simulatorId] ?? null;
        return {
            simulatorId: resource.simulatorId,
            label: resource.displayName,
            platformLabel: resource.platform,
            selected: resource.simulatorId === input.selectedSimulatorId,
            availability: projectSimulatorPreviewAvailability({
                resource,
                previewState,
                stream,
            }),
        };
    });
}

function selectBackedSidebands(
    sidebandsByKind: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>> | undefined,
): Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>> {
    if (!sidebandsByKind) return {};
    const sidebands: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>> = {};
    for (const [kind, message] of Object.entries(sidebandsByKind)) {
        if (isBackedSimulatorSidebandKindV1(kind)) {
            sidebands[kind] = message as SimulatorSidebandMessageV1;
        }
    }
    return sidebands;
}

export function selectSimulatorPreviewViewModel(input: SimulatorPreviewSelectionInput): SimulatorPreviewViewModel {
    const nowMs = input.nowMs ?? Date.now();
    const selectedResource = input.resources.find((resource) => resource.simulatorId === input.selectedSimulatorId)
        ?? input.resources[0]
        ?? null;
    const selectedSimulatorId = selectedResource?.simulatorId ?? null;
    const previewState = selectedSimulatorId
        ? input.previewStatesBySimulatorId?.[selectedSimulatorId] ?? null
        : null;
    const suppliedStream = selectedSimulatorId
        ? input.playerStatesBySimulatorId?.[selectedSimulatorId] ?? null
        : null;
    const stream = streamFromPreviewState({ resource: selectedResource, previewState, suppliedStream });
    const availability = projectSimulatorPreviewAvailability({
        resource: selectedResource,
        previewState,
        stream,
    });
    const lease = selectLease({
        resource: selectedResource,
        activeLease: previewState?.activeLease ?? null,
        viewerId: input.viewerId,
        nowMs,
    });
    const controls = selectControls({ resource: selectedResource, lease, availability });
    const devices = selectDeviceOptions({
        ...input,
        selectedSimulatorId,
    });
    const sourceId = resolveSourceId(selectedResource, previewState);
    const streamId = resolveStreamId(previewState, stream);

    return {
        kind: selectedResource ? 'selected' : 'empty',
        viewerId: input.viewerId,
        devices,
        selectedSimulatorId,
        resource: selectedResource,
        stream: {
            ...stream,
            ...(streamId ? { streamId } : {}),
        },
        codec: {
            selected: selectCodec(selectedResource, stream),
            ...(stream.diagnostic?.reasonCode ? { fallbackReason: stream.diagnostic.reasonCode } : {}),
        },
        activeLease: previewState?.activeLease ?? null,
        lease,
        controls,
        sidebands: selectBackedSidebands(previewState?.sidebandsByKind),
        availability,
        diagnostics: collectDiagnostics({
            availability,
            stream,
            lease,
            previewState,
            snapshotDiagnostics: input.snapshotDiagnostics,
        }),
    };
}
