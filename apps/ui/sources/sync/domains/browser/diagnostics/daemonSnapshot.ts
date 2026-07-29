import * as React from 'react';

import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import {
    fetchBrowserDiagnosticsSnapshotViaMachineRpc,
    type BrowserDiagnosticsSnapshotClientInput,
    type BrowserDiagnosticsSnapshotClientResult,
} from './machineRpc';

const DEFAULT_REFRESH_INTERVAL_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;

export type BrowserDiagnosticsSnapshotClient = (
    input: BrowserDiagnosticsSnapshotClientInput,
) => Promise<BrowserDiagnosticsSnapshotClientResult>;

export type UseBrowserDiagnosticsDaemonSnapshotInput = Readonly<{
    view: BrowserControlViewState | null;
    enabled?: boolean;
    serverId?: string | null;
    refreshIntervalMs?: number | null;
    snapshotClient?: BrowserDiagnosticsSnapshotClient;
    onEvents: (events: readonly BrowserDiagnosticEventV1[]) => void;
}>;

const defaultSnapshotClient: BrowserDiagnosticsSnapshotClient = (input) => (
    fetchBrowserDiagnosticsSnapshotViaMachineRpc(input)
);

function normalizeId(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

function resolveRefreshIntervalMs(value: number | null | undefined): number | null {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'number') {
        return DEFAULT_REFRESH_INTERVAL_MS;
    }
    if (!Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.max(MIN_REFRESH_INTERVAL_MS, Math.floor(value));
}

function resolveMachineId(view: BrowserControlViewState | null): string | null {
    if (view?.target.kind !== 'localServicePreview') {
        return null;
    }
    return normalizeId(view.target.machineId);
}

function activeViewKey(
    view: BrowserControlViewState | null,
    machineId: string | null,
): string | null {
    if (!view || !machineId) {
        return null;
    }
    return [
        machineId,
        view.browserSessionId,
        view.viewId,
        String(view.navigationGeneration),
    ].join('\u0000');
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
    const enabled = input.enabled ?? true;
    const machineId = resolveMachineId(input.view);
    const serverId = normalizeId(input.serverId);
    const refreshIntervalMs = resolveRefreshIntervalMs(input.refreshIntervalMs);
    const viewKey = activeViewKey(input.view, machineId);
    const snapshotClient = input.snapshotClient ?? defaultSnapshotClient;
    const snapshotClientRef = React.useRef(snapshotClient);
    const onEventsRef = React.useRef(input.onEvents);
    const viewRef = React.useRef(input.view);

    React.useEffect(() => {
        snapshotClientRef.current = snapshotClient;
        onEventsRef.current = input.onEvents;
        viewRef.current = input.view;
    }, [input.onEvents, input.view, snapshotClient]);

    React.useEffect(() => {
        const view = input.view;
        if (!enabled || !view || !machineId || !viewKey) {
            return undefined;
        }

        let disposed = false;
        let inFlight = false;
        const abortController = typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;

        const refresh = async () => {
            if (disposed || inFlight) {
                return;
            }
            inFlight = true;
            try {
                const result = await snapshotClientRef.current({
                    machineId,
                    serverId,
                    signal: abortController?.signal,
                });
                if (disposed || !result.ok) {
                    return;
                }
                const currentView = viewRef.current;
                if (
                    !currentView
                    || activeViewKey(currentView, machineId) !== viewKey
                ) {
                    return;
                }
                const events = selectSnapshotEventsForView(result.snapshot.events, currentView);
                if (events.length > 0) {
                    onEventsRef.current(events);
                }
            } catch {
                // Snapshot refresh is supplemental diagnostics only; failures must not disturb local collectors.
            } finally {
                inFlight = false;
            }
        };

        void refresh();
        const intervalId = refreshIntervalMs
            ? setInterval(() => {
                void refresh();
            }, refreshIntervalMs)
            : null;

        return () => {
            disposed = true;
            abortController?.abort();
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [enabled, input.view, machineId, refreshIntervalMs, serverId, viewKey]);
}
