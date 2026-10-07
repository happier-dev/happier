import * as React from 'react';
import type { MachineLiveStreamCapsV1, MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol';

import type { BrowserStreamedSurfaceRuntime } from '@/components/browser/adapters/BrowserStreamedTarget';
import { useSimulatorRelayIngestion, type SimulatorRelayTransport } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { useMachineLiveStreamRelaySocket } from '@/components/stream/useMachineLiveStreamRelaySocket';
import { publishComputerStatusFrame } from '@/sync/domains/computer/computerControlClient';

/** The live-stream family and codec W7's native computer source registers (`_CONTRACTS.md`, W7 U3 supplement). */
const SCREEN_STREAM_FAMILY = 'screen';
const SCREEN_CODECS = ['image.frame.v1'] as const;
/** No viewer-proposed ceilings: the registered source and the server grant own the cadence. */
const NO_VIEWER_CAPS: MachineLiveStreamCapsV1 = {};

/**
 * The shared window's live picture: the exact `sourceId` the computer owner returned for the Session's
 * selection, opened under `screen` through the same relay socket and ingestion owners the simulator and
 * the streamed browser use. Viewer input goes back on the same relay as the source's sideband controls;
 * the daemon turns the person's tap or key into a takeover and drains the agent first (W7).
 */
export function useComputerScreenStream(input: Readonly<{
    sessionId: string;
    machineId: string | null;
    serverId: string | null;
    sourceId: string | null;
    machineName: string | null;
    enabled?: boolean;
}>): BrowserStreamedSurfaceRuntime | null {
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() ?? '';
    const sourceId = input.enabled === false ? null : input.sourceId;
    const socket = useMachineLiveStreamRelaySocket({
        machineId,
        serverId,
        enabled: Boolean(sourceId && machineId),
        disconnectTag: 'computer-live-stream-relay-disconnect',
    });
    const transport = React.useMemo<SimulatorRelayTransport | null>(() => (socket
        ? { send: (_event, envelope) => socket.sendEnvelope(envelope), onEnvelope: (listener) => socket.onEnvelope(listener) }
        : null), [socket]);
    const viewerSocketId = socket?.socketId ?? '';
    // Viewer-specific: two devices watching one window get two logical streams over one capture source.
    const streamId = sourceId && socket && viewerSocketId ? `computer-live:${socket.machineId}:${sourceId}:${viewerSocketId}` : '';
    const ingestion = useSimulatorRelayIngestion({
        enabled: Boolean(streamId && transport),
        transport,
        serverId,
        sourceMachineId: socket?.machineId ?? '',
        targetMachineId: socket?.machineId ?? '',
        viewerSocketId,
        simulatorId: sourceId ?? '',
        streamId,
        streamFamily: SCREEN_STREAM_FAMILY,
        ...(sourceId ? { sourceId } : {}),
        caps: NO_VIEWER_CAPS,
        sourceCodecs: SCREEN_CODECS,
        onMetadataFrame: frame => {
            if (sourceId && machineId) publishComputerStatusFrame({ sessionId: input.sessionId, machineId, serverId: input.serverId ?? null }, sourceId, frame);
        },
    });
    const sendControl = React.useMemo(() => {
        if (!socket || !streamId || !sourceId) return null;
        return (control: MachineLiveStreamControlSidebandV1) => socket.sendEnvelope({
            v: 1,
            sourceMachineId: socket.machineId,
            targetMachineId: socket.machineId,
            ...(viewerSocketId ? { viewerSocketId } : {}),
            message: { kind: 'sideband_control', control },
        });
    }, [socket, sourceId, streamId, viewerSocketId]);
    const playerState = sourceId ? ingestion.playerStatesBySimulatorId[sourceId] ?? null : null;
    const machineName = input.machineName ?? null;
    return React.useMemo<BrowserStreamedSurfaceRuntime | null>(() => {
        if (!sourceId) return null;
        return {
            machineName,
            connecting: !socket || !playerState,
            playerState,
            input: sendControl && streamId ? { sourceId, streamId, send: sendControl } : null,
        };
    }, [machineName, playerState, sendControl, socket, sourceId, streamId]);
}
