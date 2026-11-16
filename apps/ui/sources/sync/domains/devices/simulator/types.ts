import type {
    MachineLiveStreamCodecIdV1} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';
import type {
    MachineLiveStreamControlLeaseV1,
    MachineLiveStreamControlSidebandV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type {
    SimulatorDeviceResourceV1} from '@happier-dev/protocol/devices/simulator/v1';
import type { SimulatorDeviceHardwareButtonV1 } from '@happier-dev/protocol/devices/simulator/operationsV1';
import type {
    SimulatorSidebandKindV1,
    SimulatorSidebandMessageV1,
} from '@happier-dev/protocol/devices/simulator/sidebandV1';

import type { LiveStreamPlayerState } from '@/sync/domains/machines/peer/mediation/stream';
import type { LiveStreamPlayerDiagnostic } from '@/sync/domains/machines/peer/mediation/stream/diagnostics';

import type { SimulatorPreviewState } from './store';

export type SimulatorPreviewAvailability = Readonly<{
    state: 'available' | 'degraded' | 'unavailable';
    reasonCode?: string;
}>;

export type SimulatorPreviewDeviceOption = Readonly<{
    simulatorId: string;
    label: string;
    platformLabel: string;
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
    /** The hardware buttons the producer advertises for this device, when it accepts button input. */
    hardwareButtons: readonly SimulatorDeviceHardwareButtonV1[];
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
    streamId?: string;
    avccChunks?: readonly Uint8Array[];
    onFrameDecoded?: () => void;
    onDecoderRecoveryRequired?: () => void;
    onDecoderFailure?: (diagnostic: LiveStreamPlayerDiagnostic) => void;
}>;

export type SimulatorPreviewViewModel = Readonly<{
    kind: 'empty' | 'selected';
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
