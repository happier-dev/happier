import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticsSnapshotV1,
} from '@happier-dev/protocol';

const DEFAULT_MAX_EVENTS_PER_VIEW = 1_000;
const DEFAULT_MAX_SNAPSHOT_EVENTS = 5_000;
const DEFAULT_MAX_DIAGNOSTICS = 50;

type BrowserDiagnosticsDaemonViewState = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    events: readonly BrowserDiagnosticEventV1[];
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
    publishEvent(event: BrowserDiagnosticEventV1): BrowserDiagnosticsDaemonPublishResult;
    publishRawEvent(event: unknown): BrowserDiagnosticsDaemonPublishResult;
    clearView(input: Readonly<{ browserSessionId: string; viewId: string }>): void;
    clearSession(input: Readonly<{ browserSessionId: string }>): void;
    getSnapshot(): BrowserDiagnosticsSnapshotV1;
    getViewSnapshot(input: Readonly<{ browserSessionId: string; viewId: string }>): BrowserDiagnosticsSnapshotV1;
}>;

function browserDiagnosticsViewKey(event: Pick<BrowserDiagnosticEventV1, 'browserSessionId' | 'viewId'>): string {
    return `${event.browserSessionId}\u0000${event.viewId}`;
}

function sortEvents(events: readonly BrowserDiagnosticEventV1[]): readonly BrowserDiagnosticEventV1[] {
    return [...events].sort((a, b) => a.capturedAtMs - b.capturedAtMs || a.eventId.localeCompare(b.eventId));
}

function appendBoundedEvent(
    view: BrowserDiagnosticsDaemonViewState | undefined,
    event: BrowserDiagnosticEventV1,
    maxEventsPerView: number,
): BrowserDiagnosticsDaemonViewState {
    const previousEvents = view && event.navigationGeneration === view.navigationGeneration
        ? view.events
        : [];
    const dedupedEvents = previousEvents.filter((previous) => previous.eventId !== event.eventId);
    return {
        browserSessionId: event.browserSessionId,
        viewId: event.viewId,
        navigationGeneration: event.navigationGeneration,
        events: sortEvents([...dedupedEvents, event]).slice(-maxEventsPerView),
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
    let diagnostics: BrowserDiagnosticsDaemonDiagnostic[] = [];

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

    function publishRawEvent(rawEvent: unknown): BrowserDiagnosticsDaemonPublishResult {
        const parsed = BrowserDiagnosticEventV1Schema.safeParse(rawEvent);
        if (!parsed.success) {
            appendDiagnostic('invalid_event');
            return { status: 'rejected', reason: 'invalid_event' };
        }

        const event = parsed.data;
        const key = browserDiagnosticsViewKey(event);
        const existing = viewsByKey.get(key);
        if (existing && event.navigationGeneration < existing.navigationGeneration) {
            appendDiagnostic('stale_navigation');
            return { status: 'rejected', reason: 'stale_navigation' };
        }

        viewsByKey.set(key, appendBoundedEvent(existing, event, maxEventsPerView));
        return { status: 'accepted' };
    }

    return {
        publishEvent: publishRawEvent,
        publishRawEvent,
        clearView(input) {
            viewsByKey.delete(browserDiagnosticsViewKey(input));
        },
        clearSession(input) {
            for (const [key, view] of viewsByKey.entries()) {
                if (view.browserSessionId === input.browserSessionId) {
                    viewsByKey.delete(key);
                }
            }
        },
        getSnapshot: () => ({
            v: 1,
            machineId: input.machineId,
            generatedAt: now(),
            refreshState: 'idle',
            events: sortEvents([...viewsByKey.values()].flatMap((view) => view.events)).slice(-maxSnapshotEvents),
            diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
        }),
        getViewSnapshot(viewInput) {
            const view = viewsByKey.get(browserDiagnosticsViewKey(viewInput));
            return {
                v: 1,
                machineId: input.machineId,
                generatedAt: now(),
                refreshState: 'idle',
                events: sortEvents(view?.events ?? []).slice(-maxSnapshotEvents),
                // The runtime-action snapshot is view scoped. Store-level diagnostics do not
                // currently carry view identity, so exposing them here would reintroduce
                // cross-view metadata leakage. The internal machine RPC keeps `getSnapshot()`.
                diagnostics: [],
            };
        },
    };
}
