import * as React from 'react';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
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
import { useMachineLiveStreamId } from '@/components/stream/useMachineLiveStreamId';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { listBrowserDaemonViewsViaMachineRpc, type BrowserDaemonControlDispatchClientResult } from '@/sync/domains/browser/control/machineRpc';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveBrowserDaemonStreamTarget } from '@/sync/domains/browser/store';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserOpenFirstUse } from '@/sync/domains/browser/firstUse/browserFirstUse';

import type { BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';
import { BrowserStreamedSurfaceScope } from './BrowserStreamedSurfaceScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/** The live-stream family every browser capture source registers under (`_CONTRACTS.md`). */
const BROWSER_STREAM_FAMILY = 'browser.streamed';
/** No viewer-proposed ceilings: the registered source and the server grant own the policy. */
const NO_VIEWER_CAPS: MachineLiveStreamCapsV1 = {};

/** The retained picture owns the frame subscription; shell imports stay presentation-only. */
export function BrowserStreamedSurfaceRuntimeHost(props: Readonly<{
    input: Parameters<typeof useBrowserStreamedSurfaceRuntime>[0];
    children: React.ReactNode;
}>): React.ReactElement {
    const presented = useLayoutPresentationActive();
    const runtime = useBrowserStreamedSurfaceRuntime({ ...props.input,
        enabled: props.input.enabled !== false && presented });
    return React.createElement(BrowserStreamedSurfaceScope, { runtime, children: props.children });
}

type Discovery =
    | Readonly<{ status: 'idle' }>
    | Readonly<{ status: 'discovering' }>
    | Readonly<{ status: 'ready'; view: BrowserDaemonViewV1 | null; machineId: string; serverId: string }>
    | Readonly<{ status: 'failed'; reason: Extract<BrowserDaemonControlDispatchClientResult, { ok: false }>['reason'] }>;

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
    /** The Session's latest Machine-targeted open, read from the typed Action operation owner. */
    firstUse?: BrowserOpenFirstUse | null;
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
    const discoveredView = discovery.status === 'ready' && discovery.machineId === machineId && discovery.serverId === serverId
        && discovery.view?.browserSessionId === browserSessionId && discovery.view.viewId === viewId
        ? discovery.view : null;
    const reconcileClosedView = useEventCallback((views: readonly BrowserDaemonViewV1[]) => {
        // A seed may precede native creation. Only removal of a previously discovered native view
        // proves closure; a missing capture source alone does not.
        if (discoveredView && !views.some(candidate => candidate.viewId === discoveredView.viewId)) {
            onBrowserEventRef.current?.({ kind: 'viewClosed', eventId: `browser-discovery-closed:${discoveredView.sourceId}`,
                occurredAt: Date.now(), browserSessionId: discoveredView.browserSessionId, viewId: discoveredView.viewId });
        }
    });

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
                if (!result.ok) { setDiscovery({ status: 'failed', reason: result.reason }); return; }
                const views = result.views.filter(candidate => candidate.browserSessionId === browserSessionId);
                reconcileClosedView(views);
                for (const candidate of views) {
                    const target = resolveBrowserDaemonStreamTarget(candidate);
                    if (!target) continue;
                    // Discovery already identifies the daemon's semantic owner. The viewer uses a
                    // stream target for display, but must retain Chromium's capture/Action route.
                    const adapterCapabilities = buildBrowserAdapterCapabilities({
                        adapterKind: candidate.adapterKind,
                        supportedTargetKinds: [target.kind],
                        supportedRenderEngines: ['streamedSurface'],
                    });
                    const opened = candidate.events.find(event => event.kind === 'viewOpened');
                    onBrowserEventRef.current?.({ kind: 'viewOpened', eventId: `browser-discovery:${candidate.sourceId}`,
                        occurredAt: opened?.occurredAt ?? Date.now(), browserSessionId: candidate.browserSessionId,
                        viewId: candidate.viewId, target, platform: candidate.platform,
                        adapterKind: candidate.adapterKind, engineKind: 'streamedSurface',
                        adapterCapabilities,
                        ...(opened?.kind === 'viewOpened' && opened.openerViewId ? { openerViewId: opened.openerViewId } : {}),
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
    }, [attempt, browserSessionId, input.enabled, input.refreshKey, machineId, reconcileClosedView, serverId, viewId]);

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
    const streamId = useMachineLiveStreamId(sourceId && socket && viewerSocketId
        ? `browser-live:${socket.machineId}:${sourceId}:${viewerSocketId}`
        : '');
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
        onReceipt: receipt => {
            // A terminal capture is not proof of a closed native view. Reconcile once through
            // discovery, which projects a confirmed removal into the existing workspace close path.
            if (receipt.terminal && receipt.reasonCode === 'capture_source_unavailable') setAttempt(current => current + 1);
        },
        onMetadataFrame: frame => {
            try {
                const batch = BrowserEventBatchV1Schema.safeParse(JSON.parse(new TextDecoder().decode(decodeBase64(frame.payloadBase64, 'base64'))));
                if (batch.success) for (const event of batch.data.events) {
                    if (event.kind === 'viewOpened' && event.browserSessionId === browserSessionId && event.openerViewId === viewId) {
                        // The child event announces adoption. Discovery supplies its registered
                        // capture source and daemon tuple before the workspace opens its tab.
                        setAttempt(current => current + 1);
                        continue;
                    }
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
    const unavailableReason = discovery.status === 'failed' ? discovery.reason : undefined;
    // An open that went through has its page discovered next: that wait is still Connecting, and it
    // ends as soon as discovery settles, whether or not it found the page.
    const firstUseKind = input.firstUse?.kind;
    // An open still in flight past provisioning is Connecting for as long as its operation runs.
    const firstUse = firstUseKind === 'dispatched'
        ? (discovery.status === 'discovering' || discovery.status === 'idle' ? 'opening' as const : undefined)
        : firstUseKind === 'connecting' ? 'opening' as const : firstUseKind;
    const firstUseTargetUrl = firstUse === 'preparing' || firstUse === 'opening' ? input.firstUse?.targetUrl : undefined;

    return React.useMemo<BrowserStreamedSurfaceRuntime | null>(() => {
        // Before any view exists the empty Session Browser still explains what keeps the agent's
        // browser from opening: the typed first-use state of its open, or the one prerequisite
        // discovery names. Any other discovery failure stays quiet.
        if (!view) return firstUse || unavailableReason === 'managed_package_missing'
            ? { machineName, playerState: null, ...(unavailableReason === 'managed_package_missing' ? { unavailableReason } : {}),
                ...(firstUse ? { firstUse } : {}), ...(firstUseTargetUrl ? { firstUseTargetUrl } : {}), onRetry: retry }
            : null;
        const connecting = discovery.status === 'discovering'
            || (Boolean(sourceId) && (!socket || !playerState));
        return {
            machineName,
            connecting,
            ...(unavailableReason ? { unavailableReason } : {}),
            playerState,
            onRetry: retry,
            input: sendControl && sourceId && streamId
                ? { sourceId, streamId, send: sendControl }
                : null,
        };
    }, [discovery.status, firstUse, firstUseTargetUrl, machineName, playerState, retry, sendControl, socket, sourceId, streamId, unavailableReason, view]);
}
