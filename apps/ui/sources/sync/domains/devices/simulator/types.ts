import type {
    MachineLiveStreamCodecIdV1} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import type {
    MachineLiveStreamControlLeaseV1,
    MachineLiveStreamControlSidebandV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type {
    SimulatorDeviceResourceV1} from '@happier-dev/protocol/devices/simulator/v1';
import type {
    SimulatorDeviceHardwareButtonV1,
    SimulatorDeviceOperationKindV1,
    SimulatorDeviceOperationV1,
} from '@happier-dev/protocol/devices/simulator/operationsV1';
import type {
    SimulatorSidebandKindV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol/devices/simulator/sidebandV1';

import type { LiveStreamPlayerState } from '@/sync/domains/machines/peer/mediation/stream';
import type { LiveStreamPlayerDiagnostic } from '@/sync/domains/machines/peer/mediation/stream/diagnostics';

import type { SimulatorPreviewState } from './store';
import type { SimulatorPreviewDaemonState } from './runtimeState';

export type SimulatorPreviewAvailability = Readonly<{
    state: 'available' | 'degraded' | 'unavailable';
    reasonCode?: string;
}>;

/** A device operation addressed by kind and its own fields; the target device supplies platform and id. */
export type SimulatorDeviceOperationRequest = SimulatorDeviceOperationV1 extends infer Operation
    ? Operation extends unknown ? Omit<Operation, 'platform' | 'deviceId'> : never
    : never;

export type SimulatorPreviewDeviceOption = Readonly<{
    simulatorId: string;
    label: string;
    platformLabel: string;
    /** The producer's lifecycle state; a stopped device is offered for boot, not for preview. */
    state: 'running' | 'stopped' | 'unavailable';
    canBoot: boolean;
    selected: boolean;
    availability: SimulatorPreviewAvailability;
}>;

export type SimulatorPreviewLeaseState = Readonly<{
    state: 'none' | 'available' | 'held-by-me' | 'held-by-other' | 'expired';
    leaseId?: string;
    holderLabel?: string;
    expiresAtMs?: number;
}>;

export type SimulatorPreviewControls = Readonly<{
    canWatch: boolean;
    canControl: boolean;
    canRequestKeyframe: boolean;
    canSetQuality: boolean;
    canSetFps: boolean;
    canSetScale: boolean;
    supportedInputKinds: readonly MachineLiveStreamControlSidebandV1['kind'][];
    /** The hardware buttons the producer advertises, when the device takes the hardware operation. */
    hardwareButtons: readonly SimulatorDeviceHardwareButtonV1[];
    /** Device operations (Actions) the selected device advertises. */
    deviceOperations: readonly SimulatorDeviceOperationKindV1[];
}>;

export type SimulatorPreviewDiagnostic = Readonly<{
    severity: 'info' | 'warning' | 'error';
    reasonCode: string;
    kind?: 'availability' | 'stream' | 'lease' | 'sideband';
}>;

export type SimulatorPreviewStreamState = Pick<
    LiveStreamPlayerState,
    | 'phase'
    | 'selectedCodec'
    | 'activeRenderer'
    | 'lastFrameUrl'
    | 'lastFrameAtMs'
    | 'decodedFrames'
    | 'droppedFrames'
    | 'bufferedBytes'
    | 'diagnostic'
> & Readonly<{
    sidebands?: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>>;
    streamId?: string;
    avccChunks?: readonly Uint8Array[];
    onFrameDecoded?: () => void;
    onDecoderRecoveryRequired?: () => void;
    onDecoderFailure?: (diagnostic: LiveStreamPlayerDiagnostic) => void;
}>;

export type SimulatorPreviewViewModel = Readonly<{
    kind: 'loading' | 'unavailable' | 'empty' | 'selected';
    viewerId: string;
    devices: readonly SimulatorPreviewDeviceOption[];
    selectedSimulatorId: string | null;
    resource: SimulatorDeviceResourceV1 | null;
    stream: SimulatorPreviewStreamState;
    codec: Readonly<{ selected: MachineLiveStreamCodecIdV1 | null; fallbackReason?: string }>;
    activeLease: MachineLiveStreamControlLeaseV1 | null;
    lease: SimulatorPreviewLeaseState;
    controls: SimulatorPreviewControls;
    sidebands: Partial<Record<SimulatorSidebandKindV1, SimulatorSidebandMessageV1>>;
    availability: SimulatorPreviewAvailability;
    diagnostics: readonly SimulatorPreviewDiagnostic[];
}>;

export type SimulatorPreviewSelectionInput = Readonly<{
    /** The selected daemon's existing snapshot lifecycle, when discovery owns the inventory. */
    snapshotState?: Pick<SimulatorPreviewDaemonState, 'resources' | 'refreshState'>;
    resources: readonly SimulatorDeviceResourceV1[];
    selectedSimulatorId?: string | null;
    viewerId: string;
    previewStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewState | undefined>>;
    playerStatesBySimulatorId?: Readonly<Record<string, SimulatorPreviewStreamState | undefined>>;
    snapshotDiagnostics?: readonly unknown[];
    nowMs?: number;
}>;

/**
 * Hook-facing selection input (L0-3): the clock is a *function* so callers can thread a stable
 * reference and the hook resolves `Date.now()` inside its memo/effect rather than on every
 * render. The pure selector (`selectSimulatorPreviewViewModel`) keeps a resolved `number`.
 */
export type SimulatorPreviewSelectionHookInput = Omit<SimulatorPreviewSelectionInput, 'nowMs'> & Readonly<{
    nowMs?: () => number;
}>;
