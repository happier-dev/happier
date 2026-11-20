import * as React from 'react';
import type { MachineLiveStreamCapsV1} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { MachineLiveStreamControlSidebandV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';

import type { BrowserStreamedSurfaceRuntime } from '@/components/browser/adapters/BrowserStreamedTarget';
import { useSimulatorRelayIngestion, type SimulatorRelayTransport, type UseSimulatorRelayIngestionInput } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { useMachineLiveStreamRelaySocket } from '@/components/stream/useMachineLiveStreamRelaySocket';
import { useMachineLiveStreamId } from '@/components/stream/useMachineLiveStreamId';
import type { RemoteViewerClipboardShortcut } from '@happier-dev/plugin-ui/presentation';
import { computerScopeKey, publishComputerStatusFrame, publishComputerStreamInputFailure } from '@/sync/domains/computer/computerControlClient';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ComputerScope } from '@/sync/domains/computer/computerControlClient';

/** The live-stream family and codec W7's native computer source registers (`_CONTRACTS.md`, W7 U3 supplement). */
const SCREEN_STREAM_FAMILY = 'screen';
const SCREEN_CODECS = ['image.frame.v1'] as const;
/** No viewer-proposed ceilings: the registered source and the server grant own the cadence. */
const NO_VIEWER_CAPS: MachineLiveStreamCapsV1 = {};

/** The machine relay's transport ports, shared by the live and local-demo compositions. */
export type ComputerScreenTransport = Readonly<{
    resolveSocket: NonNullable<Parameters<typeof useMachineLiveStreamRelaySocket>[0]['resolveSocket']>;
    openRelay: NonNullable<UseSimulatorRelayIngestionInput['openRelay']>;
}>;

/**
 * The shared window's live picture: the exact `sourceId` the computer owner returned for the Session's
 * selection, opened under `screen` through the same relay socket and ingestion owners the simulator and
 * the streamed browser use. Viewer input goes back on the same relay as the source's sideband controls;
 * the daemon turns the person's tap or key into a takeover and drains the agent first (W7).
 */
export type ComputerScreenStreamInput = Readonly<{
    scope: ComputerScope;
    machineId: string | null;
    serverId: string | null;
    accountLifetime?: ServerAccountScopeLifetime | null;
    sourceId: string | null;
    machineName: string | null;
    enabled?: boolean;
    inputEnabled?: boolean;
    clipboardShortcut?: RemoteViewerClipboardShortcut;
    transport?: ComputerScreenTransport;
}>;

export function useComputerScreenStream(input: ComputerScreenStreamInput): BrowserStreamedSurfaceRuntime | null {
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() || input.accountLifetime?.scope.serverId || '';
    // Like the retained Browser, parking suspends ingestion, not source/socket identity.
    // The shared player's existing last frame then survives the gap between responsive binders.
    const sourceId = input.sourceId;
    const viewerKey = JSON.stringify([input.accountLifetime?.scope.accountId ?? null, computerScopeKey(input.scope)]);
    const inputEnabled = input.enabled !== false && (input.inputEnabled ?? true);
    const socket = useMachineLiveStreamRelaySocket({
        machineId,
        serverId,
        accountLifetime: input.accountLifetime,
        enabled: Boolean(sourceId && machineId),
        disconnectTag: 'computer-live-stream-relay-disconnect',
        resolveSocket: input.transport?.resolveSocket,
    });
    const transport = React.useMemo<SimulatorRelayTransport | null>(() => (socket
        ? { send: (_event, envelope) => socket.sendEnvelope(envelope), onEnvelope: (listener) => socket.onEnvelope(listener) }
        : null), [socket]);
    const viewerSocketId = socket?.socketId ?? '';
    // Viewer-specific: two devices watching one window get two logical streams over one capture source.
    const streamId = useMachineLiveStreamId(sourceId && socket && viewerSocketId ? `computer-live:${socket.machineId}:${sourceId}:${viewerSocketId}` : '');
    const ingestion = useSimulatorRelayIngestion({
        enabled: input.enabled !== false && Boolean(streamId && transport),
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
        openRelay: input.transport?.openRelay,
        onMetadataFrame: frame => {
            if (sourceId && machineId) publishComputerStatusFrame(input.scope, sourceId, frame);
        },
        onReceipt: receipt => {
            if (sourceId && machineId && receipt.terminal === false && receipt.reasonCode) {
                publishComputerStreamInputFailure(input.scope, sourceId, receipt.reasonCode);
            }
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
    const viewerInput = React.useMemo(() => inputEnabled && sendControl && streamId && sourceId
        ? { sourceId, streamId, viewerKey, send: sendControl, clipboardShortcut: input.clipboardShortcut }
        : null, [input.clipboardShortcut, inputEnabled, sendControl, sourceId, streamId, viewerKey]);
    return React.useMemo<BrowserStreamedSurfaceRuntime | null>(() => {
        if (!sourceId) return null;
        return {
            machineName,
            connecting: !socket || !playerState,
            playerState,
            onRetry: ingestion.retry,
            input: viewerInput,
        };
    }, [ingestion.retry, machineName, playerState, socket, sourceId, viewerInput]);
}
