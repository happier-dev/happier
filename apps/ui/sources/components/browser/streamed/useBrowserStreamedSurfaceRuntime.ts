import * as React from 'react';
import { Modal } from '@/modal';
import { t } from '@/text';
import { createRemoteViewerClipboardShortcut } from '@/components/stream/remoteViewerClipboard';
import type {
    BrowserDaemonViewV1} from '@happier-dev/protocol/browser/control/v1';
import type {
    MachineLiveStreamCapsV1} from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type {
    MachineLiveStreamControlSidebandV1} from '@happier-dev/protocol/machines/peer/mediation/stream/controlV1';
import type {
    BrowserEventV1,
} from '@happier-dev/protocol/browser/events/v1';
import { BrowserEventBatchV1Schema } from '@happier-dev/protocol/browser/events/v1';
import type { BrowserInputEventV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '@/encryption/base64';

import { useSimulatorRelayIngestion, type SimulatorRelayTransport } from '@/components/devices/simulator/relay/useSimulatorRelayIngestion';
import { useMachineLiveStreamRelaySocket } from '@/components/stream/useMachineLiveStreamRelaySocket';
import { useMachineLiveStreamId } from '@/components/stream/useMachineLiveStreamId';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { listBrowserDaemonViewsViaMachineRpc, type BrowserDaemonControlDispatchClientResult } from '@/sync/domains/browser/control/machineRpc';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { resolveBrowserDaemonStreamTarget } from '@/sync/domains/browser/store';
import { retainShallow } from '@/sync/domains/state/structuralSharing';
import type { BrowserOpenFirstUse } from '@/sync/domains/browser/firstUse/browserFirstUse';

import type { BrowserStreamedSurfaceRuntime } from '../adapters/BrowserStreamedTarget';
import { BrowserStreamedSurfaceScope } from './BrowserStreamedSurfaceScope';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createBrowserStreamInputRelay, saveBrowserStreamDownload } from './inputRelay';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { applyBrowserDiscoveryEvent, reconcileBrowserDiscovery } from './discovery';

/** The live-stream family every browser capture source registers under (`_CONTRACTS.md`). */
const BROWSER_STREAM_FAMILY = 'browser.streamed';
/** No viewer-proposed ceilings: the registered source and the server grant own the policy. */
const NO_VIEWER_CAPS: MachineLiveStreamCapsV1 = {};
type ViewerMetadata = Pick<NonNullable<BrowserStreamedSurfaceRuntime['input']>, 'viewport' | 'viewerInput' | 'editableTarget' | 'interaction'>;

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
    const {binding: accountBinding} = useServerCredentialAccountScopeBinding(serverId);
    const [discovery, setDiscovery] = React.useState<Discovery>({ status: 'idle' });
    const [attempt, setAttempt] = React.useState(0);
    const [viewerMetadata, setViewerMetadata] = React.useState<Readonly<{
        sourceId: string; streamId: string; value: ViewerMetadata;
    }> | null>(null);
    const inputSequence = React.useRef(0);
    const inputRelayRef = React.useRef<ReturnType<typeof createBrowserStreamInputRelay> | null>(null);
    const discoveryAccountId = accountBinding?.accountId ?? null;
    const discoveryScope = JSON.stringify([discoveryAccountId, serverId, machineId, browserSessionId]);
    const discoveryBaseline = React.useRef<Readonly<{ scope: string; views: readonly BrowserDaemonViewV1[] }> | null>(null);
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
    const reconcileDiscoveredViews = useEventCallback((views: readonly BrowserDaemonViewV1[]) => {
        const previous = discoveryBaseline.current?.scope === discoveryScope ? discoveryBaseline.current.views : undefined;
        const reconciled = reconcileBrowserDiscovery(previous, views);
        discoveryBaseline.current = { scope: discoveryScope, views: reconciled.views };
        for (const event of reconciled.events) onBrowserEventRef.current?.(event);
        setDiscovery(previous => retainShallow(previous, { status: 'ready', machineId, serverId,
            view: reconciled.views.find(candidate => candidate.viewId === viewId
                && resolveBrowserDaemonStreamTarget(candidate) !== null) ?? null }));
    });

    React.useEffect(() => {
        if (!browserSessionId || !machineId || !serverId) {
            setDiscovery({ status: 'idle' });
            return undefined;
        }
        // Discovery's retained snapshot belongs to the resolved Account. Visibility and
        // credential resolution suspend reads without discarding that snapshot.
        if (!discoveryAccountId || input.enabled === false) return undefined;
        const abort = new AbortController();
        setDiscovery(previous => previous.status === 'ready' ? previous : { status: 'discovering' });
        void listBrowserDaemonViewsViaMachineRpc({ machineId, serverId, browserSessionId, signal: abort.signal })
            .then((result) => {
                if (abort.signal.aborted) return;
                if (!result.ok) { setDiscovery({ status: 'failed', reason: result.reason }); return; }
                const views = result.views.filter(candidate => candidate.browserSessionId === browserSessionId);
                reconcileClosedView(views);
                reconcileDiscoveredViews(views);
            });
        return () => abort.abort();
    }, [attempt, browserSessionId, discoveryAccountId, input.enabled, input.refreshKey, machineId, reconcileClosedView, reconcileDiscoveredViews, serverId, viewId]);

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
                if (!batch.success) return;
                if (batch.data.inputResult) inputRelayRef.current?.accept(batch.data.inputResult);
                for (const event of batch.data.events) {
                    if (event.kind === 'viewOpened' && event.browserSessionId === browserSessionId && event.openerViewId === viewId) {
                        // The child event announces adoption. Discovery supplies its registered
                        // capture source and daemon tuple before the workspace opens its tab.
                        setAttempt(current => current + 1);
                        continue;
                    }
                    if (event.browserSessionId === browserSessionId && 'viewId' in event && event.viewId === viewId) {
                        const baseline = discoveryBaseline.current;
                        if (baseline?.scope === discoveryScope) discoveryBaseline.current = {
                            scope: discoveryScope, views: applyBrowserDiscoveryEvent(baseline.views, event),
                        };
                        onBrowserEventRef.current?.(event);
                    }
                }
                if (!sourceId || !streamId) return;
                const resetTarget = batch.data.events.some(event => event.browserSessionId === browserSessionId
                    && 'viewId' in event && event.viewId === viewId
                    && (event.kind === 'navigationStarted' || event.kind === 'navigationCommitted' || event.kind === 'viewClosed'));
                setViewerMetadata(previous => {
                    const current = previous?.sourceId === sourceId && previous.streamId === streamId ? previous.value : null;
                    const viewport = batch.data.viewport ?? current?.viewport ?? null;
                    const viewerInput = batch.data.viewerInput ?? current?.viewerInput ?? null;
                    // Latest-wins: a batch without interaction state leaves the last one standing.
                    const nextInteraction = batch.data.interactionState ?? current?.interaction ?? null;
                    const interaction = current?.interaction && nextInteraction
                        && JSON.stringify(current.interaction) === JSON.stringify(nextInteraction) ? current.interaction : nextInteraction;
                    const editableTarget = resetTarget || !viewerInput?.controlling ? null : batch.data.editableTarget
                        ?? (viewerInput.controlEpoch === current?.viewerInput?.controlEpoch ? current?.editableTarget ?? null : null);
                    const sameViewport = current?.viewport?.width === viewport?.width && current?.viewport?.height === viewport?.height
                        && current?.viewport?.deviceScaleFactor === viewport?.deviceScaleFactor
                        && current?.viewport?.emulation?.kind === viewport?.emulation?.kind
                        && (current?.viewport?.emulation?.kind !== 'preset' || viewport?.emulation?.kind === 'preset'
                            && current.viewport.emulation.presetId === viewport.emulation.presetId);
                    const sameViewer = current?.viewerInput?.controlling === viewerInput?.controlling
                        && current?.viewerInput?.controlEpoch === viewerInput?.controlEpoch;
                    const oldTarget = current?.editableTarget;
                    const sameTarget = oldTarget?.editable === editableTarget?.editable && (!oldTarget?.editable
                        || editableTarget?.editable && oldTarget.inputMode === editableTarget.inputMode
                            && oldTarget.multiline === editableTarget.multiline && oldTarget.secret === editableTarget.secret);
                    if (current && sameViewport && sameViewer && sameTarget && interaction === current.interaction) return previous;
                    return { sourceId, streamId, value: { viewport, viewerInput, editableTarget, interaction } };
                });
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
    const metadata = viewerMetadata?.sourceId === sourceId && viewerMetadata.streamId === streamId ? viewerMetadata.value : null;
    // Human interactions (dialog answers, chosen files, download ranges, viewport) carry the epoch the
    // daemon last projected to this stream; it refuses a stale one, so no epoch means nothing to send.
    const controlEpoch = metadata?.viewerInput?.controlEpoch;
    const inputStopped = playerState?.phase === 'stopped' || playerState?.phase === 'error';
    const inputRelay = React.useMemo(() => {
        if (!sendControl || !sourceId || !streamId || controlEpoch === undefined || input.enabled === false || inputStopped) return null;
        return createBrowserStreamInputRelay({ streamId, nextSequence: () => inputSequence.current++, send: (event, eventId, sequence) => {
            sendControl({ v: 1, kind: 'browser_input', streamId, sourceId, eventId,
                // Spreading a member of the operand union keeps its kind; TS cannot re-narrow the spread.
                controlEpoch, event: { ...event, target: 'page', sequence } as BrowserInputEventV1 });
        } });
    }, [controlEpoch, input.enabled, inputStopped, sendControl, sourceId, streamId]);
    inputRelayRef.current = inputRelay;
    React.useEffect(() => () => inputRelay?.dispose(), [inputRelay]);
    const sendInput = inputRelay?.send;
    const saveDownload = React.useMemo(() => inputRelay ? async (downloadId: string) => {
        const download = metadata?.interaction?.downloads.find(candidate => candidate.downloadId === downloadId);
        if (download?.state !== 'completed') return;
        try { await saveBrowserStreamDownload({ download, request: inputRelay.request,
            maxFrameBytes: ingestion.negotiatedCaps?.maxFrameBytes }); }
        catch { Modal.alert(t('common.error'), t('errors.operationFailed')); }
    } : undefined, [ingestion.negotiatedCaps?.maxFrameBytes, inputRelay, metadata?.interaction]);
    const clipboardShortcut = React.useMemo(() => inputRelay && metadata?.viewerInput?.controlling
        ? createRemoteViewerClipboardShortcut({
            write: async text => { await inputRelay.request({ kind: 'clipboard', action: 'paste', text }); },
            read: async action => {
                const result = await inputRelay.request({ kind: 'clipboard', action });
                if (result?.kind !== 'clipboard') throw new Error('clipboard_unavailable');
                return result.text;
            },
        }) : undefined, [inputRelay, metadata?.viewerInput?.controlling]);
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
                ? { sourceId, streamId, send: sendControl, ...metadata, ...(sendInput ? { sendInput } : {}),
                    saveDownload, clipboardShortcut }
                : null,
        };
    }, [clipboardShortcut, discovery.status, firstUse, firstUseTargetUrl, machineName, metadata, playerState, retry, saveDownload, sendControl, sendInput, socket, sourceId, streamId, unavailableReason, view]);
}
