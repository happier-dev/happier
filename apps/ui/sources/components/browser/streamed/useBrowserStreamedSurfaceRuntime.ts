import * as React from 'react';
import type {
    BrowserDaemonViewV1,
    MachineLiveStreamCapsV1,
    MachineLiveStreamControlSidebandV1,
    BrowserEventV1,
} from '@happier-dev/protocol';
import { BrowserEventBatchV1Schema } from '@happier-dev/protocol/browser/events/v1';
import { decodeBase64 } from '@/encryption/base64';

import { useSimulatorRelayIngestion, type SimulatorRelayTransport } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { useMachineLiveStreamRelaySocket } from '@/components/stream/useMachineLiveStreamRelaySocket';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { listBrowserDaemonViewsViaMachineRpc } from '@/sync/domains/browser/control/machineRpc';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveBrowserDaemonStreamTarget } from '@/sync/domains/browser/store';
import { selectBrowserTargetAdapter } from '@/sync/domains/browser/adapters/selection';

import type { BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';

/** The live-stream family every browser capture source registers under (`_CONTRACTS.md`). */
const BROWSER_STREAM_FAMILY = 'browser.streamed';
/** No viewer-proposed ceilings: the registered source and the server grant own the policy. */
const NO_VIEWER_CAPS: MachineLiveStreamCapsV1 = {};

type Discovery =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'discovering' }>
    | Readonly<{ status: 'ready'; view: BrowserDaemonViewV1 | null; machineId: string; serverId: string }>
    | Readonly<{ status: 'failed' }>;

/**
 * The live picture of the agent's browser for one daemon-owned view.
 *
 * It consumes the daemon's contract (W3C) and adds no client-side one: the view's capture source
 * comes from the daemon's session-filtered discovery (`listBrowserDaemonViewsViaMachineRpc`), the
 * stream opens on that exact `sourceId` under `browser.streamed` through the shared relay socket and
 * ingestion owner the simulator uses, and viewer input goes back on the same relay as the source's
 * registered sideband controls (the daemon turns tap/type/scroll into a human takeover). A view
 * without a registered capture source is reported unavailable, never guessed.
 */
export function useBrowserStreamedSurfaceRuntime(input: Readonly<{
    view: BrowserControlViewState | null;
    browserSessionId?: string | null;
    refreshKey?: string;
    enabled?: boolean;
    machineId?: string | null;
    serverId?: string | null;
    machineName?: string | null;
    onBrowserEvent?: (event: BrowserEventV1) => void;
}>): BrowserStreamedSurfaceRuntime | null {
    const view = input.view && isDaemonAuthoritativeBrowserView(input.view) ? input.view : null;
    const machineId = input.machineId?.trim() ?? '';
    const serverId = input.serverId?.trim() ?? '';
    const browserSessionId = view?.browserSessionId ?? input.browserSessionId ?? null;
    const viewId = view?.viewId ?? null;
    const [discovery, setDiscovery] = React.useState<Discovery>({ status: 'idle' });
    const [attempt, setAttempt] = React.useState(0);
    const onBrowserEventRef = React.useRef(input.onBrowserEvent);
    onBrowserEventRef.current = input.onBrowserEvent;

    React.useEffect(() => {
        if (!browserSessionId || !machineId || !serverId) {
            setDiscovery({ status: 'idle' });
            return undefined;
        }
        // Visibility suspends capture consumption, not the retained view/socket.
        if (input.enabled === false) return undefined;
        const abort = new AbortController();
        setDiscovery(previous => previous.status === 'ready' ? previous : { status: 'discovering' });
        void listBrowserDaemonViewsViaMachineRpc({ machineId, serverId, browserSessionId, signal: abort.signal })
            .then((result) => {
                if (abort.signal.aborted) return;
                if (!result.ok) { setDiscovery({ status: 'failed' }); return; }
                const views = result.views.filter(candidate => candidate.browserSessionId === browserSessionId);
                for (const candidate of views) {
                    const target = resolveBrowserDaemonStreamTarget(candidate);
                    if (!target) continue;
                    const selection = selectBrowserTargetAdapter({ target, platform: candidate.platform });
                    if (!selection.ok || selection.outcome !== 'renderEngine') continue;
                    const opened = candidate.events.find(event => event.kind === 'viewOpened');
                    onBrowserEventRef.current?.({ kind: 'viewOpened', eventId: `browser-discovery:${candidate.sourceId}`,
                        occurredAt: opened?.occurredAt ?? Date.now(), browserSessionId: candidate.browserSessionId,
                        viewId: candidate.viewId, target, platform: candidate.platform,
                        adapterKind: selection.adapterKind, engineKind: selection.engineKind,
                        adapterCapabilities: selection.capabilities,
                        ...(opened?.kind === 'viewOpened' && opened.currentUrl ? { currentUrl: opened.currentUrl } : {}) });
                    for (const event of candidate.events) {
                        if (event.kind !== 'viewOpened' && event.browserSessionId === browserSessionId
                            && (!('viewId' in event) || event.viewId === candidate.viewId)) onBrowserEventRef.current?.(event);
                    }
                }
                setDiscovery({ status: 'ready', machineId, serverId, view: views.find(candidate => candidate.viewId === viewId
                    && resolveBrowserDaemonStreamTarget(candidate) !== null) ?? null });
            });
        return () => abort.abort();
    }, [attempt, browserSessionId, input.enabled, input.refreshKey, machineId, serverId, viewId]);

    const discoveredView = discovery.status === 'ready' && discovery.machineId === machineId && discovery.serverId === serverId
        && discovery.view?.browserSessionId === browserSessionId && discovery.view.viewId === viewId
        ? discovery.view : null;
    const captureSource = discoveredView?.captureSource ?? null;
    const sourceId = captureSource ? discoveredView?.sourceId ?? null : null;
    const socket = useMachineLiveStreamRelaySocket({
        machineId,
        serverId,
        enabled: Boolean(sourceId),
        disconnectTag: 'browser-live-stream-relay-disconnect',
    });
    const transport = React.useMemo<SimulatorRelayTransport | null>(() => (socket
        ? {
            send: (_event, envelope) => socket.sendEnvelope(envelope),
            onEnvelope: (listener) => socket.onEnvelope(listener),
        }
        : null), [socket]);
    const viewerSocketId = socket?.socketId ?? '';
    // Viewer-specific: two tabs watching one view get two logical streams over one capture source.
    const streamId = sourceId && socket && viewerSocketId
        ? `browser-live:${socket.machineId}:${sourceId}:${viewerSocketId}`
        : '';
    const ingestion = useSimulatorRelayIngestion({
        enabled: input.enabled !== false && Boolean(streamId && transport),
        transport,
        serverId,
        sourceMachineId: socket?.machineId ?? '',
        targetMachineId: socket?.machineId ?? '',
        viewerSocketId,
        simulatorId: sourceId ?? '',
        streamId,
        streamFamily: BROWSER_STREAM_FAMILY,
        ...(sourceId ? { sourceId } : {}),
        caps: NO_VIEWER_CAPS,
        sourceCodecs: captureSource?.supportedCodecs ?? [],
        onMetadataFrame: frame => {
            try {
                const batch = BrowserEventBatchV1Schema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(frame.payloadBase64, 'base64'))));
                if (batch.success) for (const event of batch.data.events) {
                    if (event.browserSessionId === browserSessionId && 'viewId' in event && event.viewId === viewId) onBrowserEventRef.current?.(event);
                }
            } catch { /* Malformed metadata never changes controller or view state. */ }
        },
    });

    const sendControl = React.useMemo(() => {
        if (!socket || !streamId || !sourceId || captureSource?.inputMode === 'none') return null;
        return (control: MachineLiveStreamControlSidebandV1) => socket.sendEnvelope({
            v: 1,
            sourceMachineId: socket.machineId,
            targetMachineId: socket.machineId,
            ...(viewerSocketId ? { viewerSocketId } : {}),
            message: { kind: 'sideband_control', control },
        });
    }, [captureSource?.inputMode, socket, sourceId, streamId, viewerSocketId]);

    const playerState = sourceId ? ingestion.playerStatesBySimulatorId[sourceId] ?? null : null;
    const retry = React.useCallback(() => setAttempt((current) => current + 1), []);
    const machineName = input.machineName ?? null;

    return React.useMemo<BrowserStreamedSurfaceRuntime | null>(() => {
        if (!view) return null;
        const connecting = discovery.status === 'discovering'
            || (Boolean(sourceId) && (!socket || !playerState));
        return {
            machineName,
            connecting,
            playerState,
            onRetry: retry,
            input: sendControl && sourceId && streamId
                ? { sourceId, streamId, send: sendControl }
                : null,
        };
    }, [discovery.status, machineName, playerState, retry, sendControl, socket, sourceId, streamId, view]);
}
