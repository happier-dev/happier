import * as React from 'react';
import type { MachineLiveStreamCapsV1, SimulatorDeviceResourceV1 } from '@happier-dev/protocol';

import {
    useSimulatorPreviewSessionSurfaceRuntime,
    type SimulatorPreviewSurfaceRuntime,
    type UseSimulatorPreviewSessionSurfaceRuntimeInput,
} from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
import type { SimulatorPreviewStreamState } from '@/sync/domains/devices/simulator/types';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';

import {
    useSimulatorRelayIngestion,
    type SimulatorRelayTransport,
} from './useSimulatorRelayIngestion';
import {
    DEFAULT_SIMULATOR_LIVE_STREAM_CAPS,
    createSimulatorLiveStreamIdentityResolver,
    type CreateSimulatorLiveStreamId,
} from './liveStreamIdentity';

/**
 * Composition (Phase 8.1b): joins the canonical simulator preview runtime with the
 * production relay-ingestion hook so live `server_relay` frames reach the previously
 * starved WebCodecs/MJPEG decoders.
 *
 * Flow:
 *   runtime (resources + selection) → derive stream identity → relay ingestion →
 *   `playerStatesBySimulatorId` passed straight back into the runtime view-model build.
 *
 * The runtime owns the daemon snapshot, so the stream identity can only be derived from its
 * output. Crucially, the runtime's `resources`/`selectedSimulatorId` are computed from the
 * feature/daemon snapshot and do NOT depend on `playerStatesBySimulatorId` (see
 * `useSimulatorPreviewRuntime.ts` — the `resources` memo excludes player frames). So feeding
 * ingestion frames back into the runtime does not churn the stream identity, and there is no
 * render→setState mirror (L0-1): ingestion's own `useReducer` is the single source of frame
 * state, and the runtime view-model derives from it during render. Identity is read from a
 * ref-stable snapshot of the runtime's resources/selection (updated in an effect) so a new
 * frame never re-triggers the relay open-effect. When no relay socket is supplied, ingestion
 * stays disabled and behavior is identical to calling the runtime directly (additive). When a
 * relay socket is present but lacks the per-tab socket id required for the signed relay grant,
 * the surface fails closed with a visible stream error instead of opening a wrong-room relay.
 */
export type UseSimulatorPreviewLiveSurfaceInput = Readonly<{
    runtime: UseSimulatorPreviewSessionSurfaceRuntimeInput;
    relay?: Readonly<{
        socket: ServerScopedMachineLiveStreamRelaySocket | null;
        enabled?: boolean;
        caps?: MachineLiveStreamCapsV1;
        createStreamId?: CreateSimulatorLiveStreamId;
    }>;
}>;

const EMPTY_RESOURCES: readonly SimulatorDeviceResourceV1[] = [];

function normalizeRelaySocketId(value: unknown): string {
    return String(value ?? '').trim();
}

function createViewerSocketUnavailablePlayerStates(input: Readonly<{
    relayEnabled: boolean;
    socket: ServerScopedMachineLiveStreamRelaySocket | null;
    resources: readonly SimulatorDeviceResourceV1[];
    selectedSimulatorId: string | null;
}>): Readonly<Record<string, SimulatorPreviewStreamState | undefined>> | null {
    if (!input.relayEnabled || !input.socket || normalizeRelaySocketId(input.socket.socketId)) {
        return null;
    }

    const selectedSimulatorId = normalizeRelaySocketId(input.selectedSimulatorId);
    if (!selectedSimulatorId) return null;

    const resource = input.resources.find((candidate) => candidate.simulatorId === selectedSimulatorId);
    if (!resource || resource.unavailableReason || resource.capture.status === 'unavailable') {
        return null;
    }

    const streamState: SimulatorPreviewStreamState = {
        phase: 'error',
        selectedCodec: resource.capture.supportedCodecs[0] ?? null,
        activeRenderer: null,
        decodedFrames: 0,
        droppedFrames: 0,
        bufferedBytes: 0,
        diagnostic: { reasonCode: 'viewer_unreachable' },
    };

    return { [selectedSimulatorId]: streamState };
}

export function useSimulatorPreviewLiveSurface(
    input: UseSimulatorPreviewLiveSurfaceInput,
): SimulatorPreviewSurfaceRuntime {
    // Bounded re-derivation trigger for the stream identity. Bumped ONLY when the runtime's
    // structural facts (resources/selection) change — never per frame — so the identity memo
    // recomputes for real topology changes but stays stable across frame ingestion.
    const [runtimeFactsVersion, setRuntimeFactsVersion] = React.useState(0);
    const bumpRuntimeFactsVersion = React.useCallback(() => {
        setRuntimeFactsVersion((value) => value + 1);
    }, []);

    const socket = input.relay?.socket ?? null;
    const relayEnabled = (input.relay?.enabled ?? true) && socket !== null;
    const identityResolverRef = React.useRef(createSimulatorLiveStreamIdentityResolver());

    const transport = React.useMemo<SimulatorRelayTransport | null>(() => {
        if (!socket) return null;
        return {
            send: (_event, envelope) => socket.sendEnvelope(envelope),
            onEnvelope: (listener) => socket.onEnvelope(listener),
        };
    }, [socket]);

    // Ref-stable snapshot of the runtime's resources/selection (L0-1/L0-2). The runtime's
    // `resources`/`selectedSimulatorId` do NOT depend on player frames, so reading them from a
    // ref (updated in an effect after the runtime renders) lets ingestion derive a stable
    // stream identity without a render→setState frame mirror. A new frame re-renders via
    // ingestion's reducer and flows straight into the runtime view-model — never re-opening the
    // relay socket.
    const runtimeFactsRef = React.useRef<Readonly<{
        resources: readonly SimulatorDeviceResourceV1[];
        selectedSimulatorId: string | null;
    }>>({ resources: [], selectedSimulatorId: null });

    const identity = React.useMemo(() => identityResolverRef.current({
        resources: runtimeFactsRef.current.resources,
        selectedSimulatorId: runtimeFactsRef.current.selectedSimulatorId,
        sourceMachineId: socket?.machineId,
        // The relay target machine is the capture daemon itself (it both captures the simulator
        // and owns the target relay room for a locally-hosted stream). The viewer is a per-tab
        // user-scoped socket identified by `viewerId` + `viewerSocketId` — NEVER `scopeUserId`
        // misused as a machine id (C4). The old surface faked `targetMachineId: scopeUserId`,
        // which routed frames to a room the viewer never joined.
        targetMachineId: socket?.machineId,
        viewerId: socket?.viewerId,
        viewerSocketId: socket?.socketId,
        ...(input.relay?.caps ? { caps: input.relay.caps } : {}),
        ...(input.relay?.createStreamId ? { createStreamId: input.relay.createStreamId } : {}),
        // Re-derive when the underlying runtime facts version changes (effect-bumped below) or
        // when the socket/caps identity changes. The resolver itself is null-stable so an
        // unchanged signature returns the same reference.
    }), [
        runtimeFactsVersion,
        socket?.machineId,
        socket?.viewerId,
        socket?.socketId,
        input.relay?.caps,
        input.relay?.createStreamId,
    ]);

    const ingestion = useSimulatorRelayIngestion({
        enabled: relayEnabled && identity !== null,
        transport,
        serverId: input.runtime.serverId,
        sourceMachineId: identity?.sourceMachineId ?? '',
        targetMachineId: identity?.targetMachineId ?? '',
        // Per-tab viewer socket id (W1-C-2): thread the resolved identity's socket id so the relay
        // open mints a tab-scoped grant and the server delivers frames to exactly this tab.
        viewerSocketId: identity?.viewerSocketId ?? '',
        simulatorId: identity?.simulatorId ?? '',
        streamId: identity?.streamId ?? '',
        streamFamily: identity?.streamFamily ?? '',
        caps: identity?.caps ?? DEFAULT_SIMULATOR_LIVE_STREAM_CAPS,
        sourceCodecs: identity?.sourceCodecs ?? [],
    });

    const viewerSocketUnavailablePlayerStates = React.useMemo(() => createViewerSocketUnavailablePlayerStates({
        relayEnabled,
        socket,
        resources: runtimeFactsRef.current.resources,
        selectedSimulatorId: runtimeFactsRef.current.selectedSimulatorId,
    }), [
        relayEnabled,
        socket,
        socket?.socketId,
        runtimeFactsVersion,
    ]);

    // Single source of frame state is ingestion's reducer — passed straight into the runtime
    // view-model build (no useState mirror). The runtime memoizes the view-model on
    // `playerStatesBySimulatorId`, so a new frame re-renders the decoders exactly once.
    const runtime = useSimulatorPreviewSessionSurfaceRuntime({
        ...input.runtime,
        playerStatesBySimulatorId:
            viewerSocketUnavailablePlayerStates
            ?? input.runtime.playerStatesBySimulatorId
            ?? ingestion.playerStatesBySimulatorId,
    });

    // Publish the runtime's resources/selection into the ref + bump the version ONLY when the
    // structural facts actually change, so identity re-derivation is bounded (not per render).
    const nextResources = runtime.resources ?? EMPTY_RESOURCES;
    const nextSelectedSimulatorId = runtime.selectedSimulatorId ?? null;
    React.useEffect(() => {
        const current = runtimeFactsRef.current;
        if (current.resources === nextResources && current.selectedSimulatorId === nextSelectedSimulatorId) {
            return;
        }
        runtimeFactsRef.current = {
            resources: nextResources,
            selectedSimulatorId: nextSelectedSimulatorId,
        };
        bumpRuntimeFactsVersion();
    }, [nextResources, nextSelectedSimulatorId, bumpRuntimeFactsVersion]);

    return runtime;
}
