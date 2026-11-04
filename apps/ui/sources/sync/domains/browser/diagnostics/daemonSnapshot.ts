import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';

import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';

import {
    fetchBrowserDiagnosticsSnapshotViaMachineRpc,
    fetchBrowserDiagnosticsRequestDetailViaMachineRpc,
    type BrowserDiagnosticsRequestDetailClientInput,
    type BrowserDiagnosticsRequestDetailClientResult,
    type BrowserDiagnosticsSnapshotClientInput,
    type BrowserDiagnosticsSnapshotClientResult,
} from './machineRpc';
import type { BrowserDiagnosticsSnapshotState } from './types';
import type { BrowserDiagnosticsRequestDetailV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

export type BrowserDiagnosticsSnapshotClient = (
    input: BrowserDiagnosticsSnapshotClientInput,
) => Promise<BrowserDiagnosticsSnapshotClientResult>;

export type UseBrowserDiagnosticsDaemonSnapshotInput = Readonly<{
    view: BrowserControlViewState | null;
    enabled?: boolean;
    machineId?: string | null;
    serverId?: string | null;
    snapshotClient?: BrowserDiagnosticsSnapshotClient;
    onEvents: (events: readonly BrowserDiagnosticEventV1[]) => void;
    onSnapshotState?: (state: BrowserDiagnosticsSnapshotState) => void;
}>;

const defaultSnapshotClient: BrowserDiagnosticsSnapshotClient = (input) => (
    fetchBrowserDiagnosticsSnapshotViaMachineRpc(input)
);

type RequestDetailState = BrowserDiagnosticsRequestDetailV1 | Readonly<{ status: 'idle' }> | Readonly<{ status: 'loading' }>
    | Readonly<{ status: 'unavailable'; reason: Extract<BrowserDiagnosticsRequestDetailClientResult, { ok: false }>['reason'] }>;

/** Mount in the selected row's detail leaf. No selection, hidden presentation or closed drawer
 * produces no read. Values remain local to this leaf and never enter the shared event store.
 */
export function useBrowserDiagnosticsRequestDetail(input: Readonly<{
    view: BrowserControlViewState | null;
    selectedRequestId: string | null;
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    detailClient?: (input: BrowserDiagnosticsRequestDetailClientInput) => Promise<BrowserDiagnosticsRequestDetailClientResult>;
}>): RequestDetailState {
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const machineId = resolveBrowserDiagnosticsSnapshotMachineId(input.view, input.machineId);
    const serverId = normalizeId(input.serverId);
    const key = input.view && machineId && input.selectedRequestId && presented && viewed && (input.enabled ?? true)
        ? JSON.stringify([activeViewKey(input.view, machineId), serverId, input.selectedRequestId]) : null;
    const [state, setState] = React.useState<Readonly<{ key: string; value: RequestDetailState }> | null>(null);
    const client = input.detailClient ?? fetchBrowserDiagnosticsRequestDetailViaMachineRpc;
    React.useEffect(() => {
        if (!key || !input.view || !machineId || !input.selectedRequestId) return;
        const controller = new AbortController();
        const view = { browserSessionId: input.view.browserSessionId, viewId: input.view.viewId,
            navigationGeneration: input.view.navigationGeneration };
        void client({ machineId, serverId, view, requestId: input.selectedRequestId, signal: controller.signal })
            .then(result => {
                if (!controller.signal.aborted) setState({ key, value: result.ok ? result.detail : { status: 'unavailable', reason: result.reason } });
            }, () => {
                if (!controller.signal.aborted) setState({ key, value: { status: 'unavailable', reason: 'request_failed' } });
            });
        return () => { controller.abort(); setState(null); };
    }, [key, client]);
    return key ? state?.key === key ? state.value : { status: 'loading' } : { status: 'idle' };
}

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

export function resolveBrowserDiagnosticsSnapshotMachineId(
    view: BrowserControlViewState | null,
    machineId?: string | null,
): string | null {
    if (view?.target.kind === 'localServicePreview') return normalizeId(view.target.machineId);
    return isDaemonAuthoritativeBrowserView(view) ? normalizeId(machineId) : null;
}

function activeViewKey(
    view: BrowserControlViewState | null,
    machineId: string | null,
): string | null {
    if (!view || !machineId) {
        return null;
    }
    return browserViewKey(view, machineId, view.navigationGeneration);
}

function selectSnapshotEventsForView(
    events: readonly BrowserDiagnosticEventV1[],
    view: BrowserControlViewState,
): readonly BrowserDiagnosticEventV1[] {
    return events.filter((event) => (
        event.browserSessionId === view.browserSessionId
        && event.viewId === view.viewId
        && event.navigationGeneration === view.navigationGeneration
    ));
}

export function useBrowserDiagnosticsDaemonSnapshot(
    input: UseBrowserDiagnosticsDaemonSnapshotInput,
): void {
    const presented = useLayoutPresentationActive();
    const viewed = useHostActivelyViewed();
    const enabled = (input.enabled ?? true) && presented && viewed;
    const machineId = resolveBrowserDiagnosticsSnapshotMachineId(input.view, input.machineId);
    const serverId = normalizeId(input.serverId);
    const viewKey = activeViewKey(input.view, machineId);
    const snapshotClient = input.snapshotClient ?? defaultSnapshotClient;
    const snapshotClientRef = React.useRef(snapshotClient);
    const onEventsRef = React.useRef(input.onEvents);
    const onSnapshotStateRef = React.useRef(input.onSnapshotState);
    const viewRef = React.useRef(input.view);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        onEventsRef.current = input.onEvents;
        onSnapshotStateRef.current = input.onSnapshotState;
        viewRef.current = input.view;
    }, [input.onEvents, input.onSnapshotState, input.view, snapshotClient]);

    React.useEffect(() => {
        const view = viewRef.current;
        if (!enabled || !view || !machineId || !viewKey) {
            return undefined;
        }

        let disposed = false;
        let abortController: AbortController | null = null;
        let previousState: BrowserDiagnosticsSnapshotState | undefined;
        const publishState = (connection: BrowserDiagnosticsSnapshotState['connection'], reasonCode?: string,
            evictedEventCount = previousState?.evictedEventCount, omittedEventCount = previousState?.omittedEventCount) => {
            if (disposed || previousState?.connection === connection && previousState.reasonCode === reasonCode
                && previousState.evictedEventCount === evictedEventCount && previousState.omittedEventCount === omittedEventCount) return;
            previousState = { browserSessionId: view.browserSessionId, viewId: view.viewId,
                navigationGeneration: view.navigationGeneration, connection,
                ...(reasonCode ? { reasonCode } : {}), ...(evictedEventCount === undefined ? {} : { evictedEventCount }),
                ...(omittedEventCount === undefined ? {} : { omittedEventCount }) };
            onSnapshotStateRef.current?.(previousState);
        };
        const refresh = async () => {
            abortController?.abort();
            const controller = new AbortController();
            abortController = controller;
            if (!previousState) publishState('connecting');
            const request = { machineId, serverId, signal: controller.signal,
                view: { browserSessionId: view.browserSessionId, viewId: view.viewId,
                    navigationGeneration: view.navigationGeneration } };
            try {
                let result = await snapshotClientRef.current(request);
                while (!disposed && !controller.signal.aborted && result.ok) {
                    const currentView = viewRef.current;
                    if (!currentView || activeViewKey(currentView, machineId) !== viewKey) return;
                    const events = selectSnapshotEventsForView(result.snapshot.events, currentView);
                    if (events.length > 0) onEventsRef.current(events);
                    const diagnostics = result.snapshot.diagnostics;
                    const diagnosticCount = (code: string) => {
                        const loss = diagnostics.find(diagnostic => diagnostic.code === code
                        && diagnostic.browserSessionId === view.browserSessionId && diagnostic.viewId === view.viewId
                        && diagnostic.navigationGeneration === view.navigationGeneration);
                        return typeof loss?.count === 'number' ? loss.count : 0;
                    };
                    publishState(result.snapshot.refreshState === 'error' ? 'disconnected' : 'connected',
                        result.snapshot.refreshState === 'error' ? 'snapshot_failed' : undefined,
                        diagnosticCount('events_evicted'), diagnosticCount('snapshot_events_omitted'));
                    if (result.revision === undefined) return;
                    result = await snapshotClientRef.current({ ...request, sinceRevision: result.revision });
                }
                if (!disposed && !controller.signal.aborted && !result.ok) publishState('disconnected', result.reason);
            } catch {
                if (!disposed && !controller.signal.aborted) publishState('disconnected', 'request_failed');
            }
        };

        void refresh();
        const unsubscribeRecovery = subscribeMachineRpcRecovery({ machineId, serverId }, () => { void refresh(); });

        return () => {
            disposed = true;
            abortController?.abort();
            unsubscribeRecovery();
        };
    }, [enabled, machineId, serverId, viewKey]);
}
