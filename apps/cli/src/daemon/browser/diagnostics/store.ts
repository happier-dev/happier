import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { BrowserDiagnosticEventV1Schema, isBrowserDiagnosticLifecycleEvent } from '@happier-dev/protocol/browser/diagnostics/v1';
import type { BrowserDiagnosticEventV1, BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import type { BrowserDiagnosticsCookieExtraInfoV1 } from '@happier-dev/protocol/browser/diagnostics/v1';

export type BrowserDiagnosticsPrivateNetworkRequest = Readonly<{
    requestId: string;
    requestExtraInfo?: readonly BrowserDiagnosticsCookieExtraInfoV1[];
    responseExtraInfo?: readonly BrowserDiagnosticsCookieExtraInfoV1[];
}>;

const DEFAULT_MAX_EVENTS_PER_VIEW = 1_000;
const DEFAULT_MAX_SNAPSHOT_EVENTS = 5_000;
const DEFAULT_MAX_DIAGNOSTICS = 50;

type BrowserDiagnosticsRetainedEvent = Readonly<{
    event: BrowserDiagnosticEventV1;
    revision: number;
}>;

type BrowserDiagnosticsDaemonViewState = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    events: readonly BrowserDiagnosticsRetainedEvent[];
    revision: number;
    evictedEventCount: number;
}>;

type BrowserDiagnosticsDaemonDiagnostic = {
    code: 'invalid_event' | 'stale_navigation';
    status: 'rejected';
    capturedAtMs: number;
};

export type BrowserDiagnosticsDaemonPublishResult =
    | Readonly<{ status: 'accepted' }>
    | Readonly<{ status: 'rejected'; reason: 'invalid_event' | 'stale_navigation' }>;

export type BrowserDiagnosticsDaemonStore = Readonly<{
    publishEvent(event: BrowserDiagnosticEventV1, privateRequest?: BrowserDiagnosticsPrivateNetworkRequest): BrowserDiagnosticsDaemonPublishResult;
    publishRawEvent(event: unknown): BrowserDiagnosticsDaemonPublishResult;
    clearView(input: Readonly<{ browserSessionId: string; viewId: string }>): void;
    clearSession(input: Readonly<{ browserSessionId: string }>): void;
    getSnapshot(): BrowserDiagnosticsSnapshotV1;
    getViewSnapshot(input: Readonly<{ browserSessionId: string; viewId: string; sinceRevision?: number }>): BrowserDiagnosticsSnapshotV1;
    getViewRevision(input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number }>): number;
    subscribeView(input: Readonly<{ browserSessionId: string; viewId: string }>, listener: () => void): () => void;
    getNetworkRequest(input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number; requestId: string }>): BrowserDiagnosticEventV1 | undefined;
    getPrivateNetworkRequest(input: Readonly<{ browserSessionId: string; viewId: string; navigationGeneration: number; requestId: string }>): Readonly<{ event: BrowserDiagnosticEventV1; privateRequest: BrowserDiagnosticsPrivateNetworkRequest }> | undefined;
}>;

function sortEvents(events: readonly BrowserDiagnosticEventV1[]): readonly BrowserDiagnosticEventV1[] {
    return [...events].sort(compareEvents);
}

function compareEvents(a: BrowserDiagnosticEventV1, b: BrowserDiagnosticEventV1): number {
    return a.capturedAtMs - b.capturedAtMs || a.eventId.localeCompare(b.eventId);
}

function appendBoundedEvent(
    view: BrowserDiagnosticsDaemonViewState | undefined,
    event: BrowserDiagnosticEventV1,
    maxEventsPerView: number,
    revision: number,
): BrowserDiagnosticsDaemonViewState {
    const previousEvents = view && event.navigationGeneration === view.navigationGeneration
        ? view.events
        : [];
    const dedupedEvents = previousEvents.filter(({ event: previous }) => previous.eventId !== event.eventId
        && !(isBrowserDiagnosticLifecycleEvent(event) && isBrowserDiagnosticLifecycleEvent(previous) && previous.family === event.family));
    const retained = [...dedupedEvents, { event, revision }];
    const lifecycle = retained.filter(({ event }) => isBrowserDiagnosticLifecycleEvent(event));
    const content = retained.filter(({ event }) => !isBrowserDiagnosticLifecycleEvent(event))
        .sort((a, b) => compareEvents(a.event, b.event));
    const evictedEventCount = (view?.navigationGeneration === event.navigationGeneration ? view.evictedEventCount : 0)
        + Math.max(0, content.length - maxEventsPerView);
    return {
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
        navigationGeneration: event.navigationGeneration,
        revision,
        evictedEventCount,
        events: [...lifecycle, ...content.slice(-maxEventsPerView)].sort((a, b) => compareEvents(a.event, b.event)),
    };
}

export function createBrowserDiagnosticsDaemonStore(input: Readonly<{
    machineId: string;
    now?: () => number;
    maxEventsPerView?: number;
    maxSnapshotEvents?: number;
    maxDiagnostics?: number;
}>): BrowserDiagnosticsDaemonStore {
    const now = input.now ?? (() => Date.now());
    const maxEventsPerView = Math.max(1, Math.floor(input.maxEventsPerView ?? DEFAULT_MAX_EVENTS_PER_VIEW));
    const maxSnapshotEvents = Math.max(1, Math.floor(input.maxSnapshotEvents ?? DEFAULT_MAX_SNAPSHOT_EVENTS));
    const maxDiagnostics = Math.max(0, Math.floor(input.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS));
    const viewsByKey = new Map<string, BrowserDiagnosticsDaemonViewState>();
    // Private CDP bindings/ExtraInfo live exactly as long as their existing ring event. They are
    // never serialized by snapshots; eviction/navigation/clear releases the sole strong event key.
    const privateRequests = new WeakMap<BrowserDiagnosticEventV1, BrowserDiagnosticsPrivateNetworkRequest>();
    let diagnostics: BrowserDiagnosticsDaemonDiagnostic[] = [];
    let revision = 0;
    const listeners = new Set<Readonly<{ key: string; notify: () => void }>>();
    function notifyView(key: string): void {
        for (const listener of listeners) if (listener.key === key) listener.notify();
    }

    function appendDiagnostic(code: BrowserDiagnosticsDaemonDiagnostic['code']): void {
        if (maxDiagnostics <= 0) {
            return;
        }
        diagnostics = [
            ...diagnostics,
            {
                code,
                status: 'rejected' as const,
                capturedAtMs: now(),
            },
        ].slice(-maxDiagnostics);
    }

    function publishRawEvent(rawEvent: unknown, privateRequest?: BrowserDiagnosticsPrivateNetworkRequest): BrowserDiagnosticsDaemonPublishResult {
        const parsed = BrowserDiagnosticEventV1Schema.safeParse(rawEvent);
        if (!parsed.success) {
            appendDiagnostic('invalid_event');
            return { status: 'rejected', reason: 'invalid_event' };
        }

        const event = parsed.data;
        const key = browserViewKey(event);
        const existing = viewsByKey.get(key);
        if (existing && event.navigationGeneration < existing.navigationGeneration) {
            appendDiagnostic('stale_navigation');
            return { status: 'rejected', reason: 'stale_navigation' };
        }

        const previous = existing?.events.find(previous => previous.event.eventId === event.eventId)?.event;
        const previousPrivate = previous ? privateRequests.get(previous) : undefined;
        if (privateRequest) privateRequests.set(event, { ...previousPrivate, ...privateRequest,
            requestExtraInfo: [...previousPrivate?.requestExtraInfo ?? [], ...privateRequest.requestExtraInfo ?? []],
            responseExtraInfo: [...previousPrivate?.responseExtraInfo ?? [], ...privateRequest.responseExtraInfo ?? []],
        });
        else if (previousPrivate) privateRequests.set(event, previousPrivate);
        if (previous && sameStrictJsonValue(previous, event)) {
            const updatedPrivate = privateRequests.get(event);
            if (updatedPrivate) privateRequests.set(previous, updatedPrivate);
            return { status: 'accepted' };
        }
        viewsByKey.set(key, appendBoundedEvent(existing, event, maxEventsPerView, ++revision));
        notifyView(key);
        return { status: 'accepted' };
    }

    function retentionDiagnostics(view: BrowserDiagnosticsDaemonViewState | undefined, omittedEventCount = 0) {
        if (!view) return [];
        const identity = { browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration };
        return [
            ...(view.evictedEventCount > 0 ? [{ ...identity, code: 'events_evicted', count: view.evictedEventCount }] : []),
            ...(omittedEventCount > 0 ? [{ ...identity, code: 'snapshot_events_omitted', count: omittedEventCount }] : []),
        ];
    }

    return {
        publishEvent: publishRawEvent,
        publishRawEvent,
        getNetworkRequest(request) {
            const view = viewsByKey.get(browserViewKey(request));
            return view?.navigationGeneration === request.navigationGeneration
                ? view.events.find(({ event }) => event.family === 'network' && event.data.requestId === request.requestId)?.event : undefined;
        },
        getPrivateNetworkRequest(request) {
            const view = viewsByKey.get(browserViewKey(request));
            const event = view?.navigationGeneration === request.navigationGeneration
                ? view.events.find(({ event }) => event.family === 'network' && event.data.requestId === request.requestId)?.event : undefined;
            const privateRequest = event ? privateRequests.get(event) : undefined;
            return event && privateRequest ? { event, privateRequest } : undefined;
        },
        clearView(input) {
            const key = browserViewKey(input);
            if (viewsByKey.delete(key)) notifyView(key);
        },
        clearSession(input) {
            for (const [key, view] of viewsByKey.entries()) {
                if (view.browserSessionId === input.browserSessionId) {
                    viewsByKey.delete(key);
                    notifyView(key);
                }
            }
        },
        getSnapshot: () => {
            const allEvents = sortEvents([...viewsByKey.values()].flatMap(view => view.events.map(({ event }) => event)));
            const events = allEvents.slice(-maxSnapshotEvents);
            const omitted = allEvents.slice(0, Math.max(0, allEvents.length - maxSnapshotEvents));
            const omittedByView = new Map<string, number>();
            for (const event of omitted) {
                const key = browserViewKey(event);
                omittedByView.set(key, (omittedByView.get(key) ?? 0) + 1);
            }
            return {
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            events,
            diagnostics: [...diagnostics.map((diagnostic) => ({ ...diagnostic })),
                ...[...viewsByKey.values()].flatMap(view => retentionDiagnostics(view, omittedByView.get(browserViewKey(view)) ?? 0))],
            };
        },
        getViewSnapshot(viewInput) {
            const view = viewsByKey.get(browserViewKey(viewInput));
            return {
                v: 1,
                machineId: input.machineId,
                generatedAt: now(),
                refreshState: 'idle',
                // Retained publication revisions are the existing watch cursor's changed facts.
                // Apply the snapshot retention projection before selecting the incremental batch.
                events: (view?.events ?? []).slice(-maxSnapshotEvents)
                    .filter(entry => viewInput.sinceRevision === undefined || entry.revision > viewInput.sinceRevision)
                    .map(({ event }) => event),
                // The runtime-action snapshot is view scoped. Store-level diagnostics do not
                // currently carry view identity, so exposing them here would reintroduce
                // cross-view metadata leakage. The internal machine RPC keeps `getSnapshot()`.
                diagnostics: retentionDiagnostics(view, Math.max(0, (view?.events.length ?? 0) - maxSnapshotEvents)),
            };
        },
        getViewRevision(viewInput) {
            const view = viewsByKey.get(browserViewKey(viewInput));
            return view?.navigationGeneration === viewInput.navigationGeneration ? view.revision : 0;
        },
        subscribeView(viewInput, notify) {
            const listener = { key: browserViewKey(viewInput), notify };
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}
