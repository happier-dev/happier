import { describe, expect, it } from 'vitest';

import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

it('copies and filters only the changed batch when reading a diagnostics cursor', async () => {
    const { createBrowserDiagnosticsDaemonStore } = await import('./store');
    const view = { browserSessionId: 'cursor-cost', viewId: 'view', navigationGeneration: 1 };
    const measurements = [];
    for (const retained of [10, 100, 1_000]) {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine',
            maxEventsPerView: retained + 1, maxSnapshotEvents: retained + 1 });
        for (let n = 0; n < retained; n++) store.publishEvent(createEvent({ ...view, eventId: `event-${n}`, capturedAtMs: n }));
        const sinceRevision = store.getViewRevision(view);
        store.publishEvent(createEvent({ ...view, eventId: 'new-event', capturedAtMs: retained }));
        let predicateVisits = 0;
        let copiedEvents = 0;
        const filterDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'filter')!;
        const sliceDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'slice')!;
        const filter = Array.prototype.filter;
        const slice = Array.prototype.slice;
        function isRetainedViewEvent(value: unknown): boolean {
            return typeof value === 'object' && value !== null && 'event' in value
                && typeof value.event === 'object' && value.event !== null
                && 'browserSessionId' in value.event && value.event.browserSessionId === view.browserSessionId;
        }
        // Transparent synchronous profiling of collection work; both intrinsics and predicates stay real.
        Object.defineProperty(Array.prototype, 'filter', { ...filterDescriptor,
            value(this: unknown[], predicate: (value: unknown, index: number, array: unknown[]) => unknown, thisArg?: unknown) {
                const count = isRetainedViewEvent(this[0]);
                return filter.call(this, (value, index, array) => {
                    if (count) predicateVisits++;
                    return predicate.call(thisArg, value, index, array);
                });
            },
        });
        Object.defineProperty(Array.prototype, 'slice', { ...sliceDescriptor,
            value(this: unknown[], start?: number, end?: number) {
                const result = slice.call(this, start, end);
                if (isRetainedViewEvent(this[0])) copiedEvents += result.length;
                return result;
            },
        });
        let events: readonly BrowserDiagnosticEventV1[];
        try {
            events = store.getViewSnapshot({ ...view, sinceRevision }).events;
        } finally {
            Object.defineProperty(Array.prototype, 'filter', filterDescriptor);
            Object.defineProperty(Array.prototype, 'slice', sliceDescriptor);
        }
        expect(events.map(event => event.eventId)).toEqual(['new-event']);
        measurements.push({ retained, returnedEvents: events.length, predicateVisits, copiedEvents });
    }
    for (const measurement of measurements) {
        expect(measurement.predicateVisits, JSON.stringify(measurements)).toBeLessThanOrEqual(measurement.returnedEvents);
        expect(measurement.copiedEvents, JSON.stringify(measurements)).toBeLessThanOrEqual(measurement.returnedEvents);
    }
});

it('selects cursor changes within the retained snapshot window across capture-order changes and upserts', async () => {
    const { createBrowserDiagnosticsDaemonStore } = await import('./store');
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', maxEventsPerView: 4, maxSnapshotEvents: 2 });
    const view = { browserSessionId: 'browser_session_1', viewId: 'view_1', navigationGeneration: 1 };
    store.publishEvent(createEvent({ eventId: 'a', capturedAtMs: 30 }));
    const firstRevision = store.getViewRevision(view);
    store.publishEvent(createEvent({ eventId: 'b', capturedAtMs: 10 }));
    store.publishEvent(createEvent({ eventId: 'c', capturedAtMs: 20 }));
    expect(store.getViewSnapshot({ ...view, sinceRevision: firstRevision }).events.map(event => event.eventId)).toEqual(['c']);
    const beforeUpdates = store.getViewRevision(view);
    store.publishEvent(createEvent({ eventId: 'c', capturedAtMs: 40 }));
    store.publishEvent(createEvent({ eventId: 'b', capturedAtMs: 50 }));
    expect(store.getViewSnapshot({ ...view, sinceRevision: beforeUpdates }).events.map(event => event.eventId)).toEqual(['c', 'b']);
    expect(store.getViewSnapshot({ ...view, sinceRevision: store.getViewRevision(view) }).events).toEqual([]);
    expect(store.getViewSnapshot(view).events.map(event => event.eventId)).toEqual(['c', 'b']);
    store.clearView(view);
    expect(store.getViewSnapshot({ ...view, sinceRevision: beforeUpdates }).events).toEqual([]);
});

function createEvent(overrides: Partial<BrowserDiagnosticEventV1> = {}): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'evt_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 1,
        capturedAtMs: 1_000,
        family: 'network',
        kind: 'network.requestStarted',
        fidelity: 'cdp',
        trusted: true,
        data: {
            method: 'GET',
            url: 'https://example.test/assets/app.js',
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        ...overrides,
    };
}

describe('daemon browser diagnostics store', () => {
    it('retains producer-normalized payloads without traversing their content again', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');
        const { mapSidecarCdpDiagnosticEvent } = await import('../sidecar/diagnostics/mapEvents');
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine' });
        const keys = ['theme', 'workspace', 'filters'];
        let contentVisits = 0;
        for (let ordinal = 1; ordinal <= 3; ordinal++) {
            const event = mapSidecarCdpDiagnosticEvent({
                browserSessionId: 'browser', viewId: 'view', navigationGeneration: 1,
                capturedAtMs: ordinal, eventOrdinal: ordinal,
                event: { kind: 'storage.keyInventory', storageType: 'localStorage', keys: [...keys] },
            });
            const normalizedKeys = event.data.keys;
            if (!Array.isArray(normalizedKeys)) throw new Error('Storage mapper did not produce its key inventory');
            // Transparent profiling of the real mapper output; values and store logic stay real.
            for (const index of keys.keys()) {
                const key = normalizedKeys[index];
                Object.defineProperty(normalizedKeys, index, {
                    get() { contentVisits++; return key; },
                });
            }
            expect(store.publishEvent(event)).toEqual({ status: 'accepted' });
        }
        expect(contentVisits).toBe(0);
        const events = store.getViewSnapshot({ browserSessionId: 'browser', viewId: 'view' }).events;
        expect(events).toHaveLength(3);
        expect(events.map(event => event.data.keys)).toEqual([keys, keys, keys]);
        expect(store.publishRawEvent({ ...events[0], data: { headers: { Authorization: 'Bearer synthetic' } } }))
            .toEqual({ status: 'rejected', reason: 'invalid_event' });
        expect(store.getViewSnapshot({ browserSessionId: 'browser', viewId: 'view' }).events).toHaveLength(3);
    });
    it('retains the latest explanation for each rejection reason without a duplicate-history cutoff', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');
        let now = 0;
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', now: () => ++now });
        store.publishEvent(createEvent({ navigationGeneration: 2 }));
        store.publishEvent(createEvent({ navigationGeneration: 1 }));
        for (let rejected = 0; rejected < 51; rejected++) store.publishRawEvent({ invalid: true });
        expect(store.getSnapshot().diagnostics).toEqual([
            { code: 'stale_navigation', status: 'rejected', capturedAtMs: 1 },
            { code: 'invalid_event', status: 'rejected', capturedAtMs: 52 },
        ]);
    });
    it('marks history omitted by the existing snapshot projection bound', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', maxEventsPerView: 4, maxSnapshotEvents: 2 });
        for (let n = 1; n <= 3; n++) store.publishEvent(createEvent({ eventId: `event_${n}`, capturedAtMs: n }));
        expect(store.getViewSnapshot({ browserSessionId: 'browser_session_1', viewId: 'view_1' }).diagnostics)
            .toContainEqual(expect.objectContaining({ code: 'snapshot_events_omitted', count: 1 }));
    });
    it('retains current quiet-family availability when content history overflows', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', maxEventsPerView: 2 });
        store.publishEvent(createEvent({ eventId: 'console_ready', family: 'console', kind: 'diagnostics.available', data: {}, capturedAtMs: 0 }));
        for (let n = 1; n <= 3; n++) store.publishEvent(createEvent({ eventId: `event_${n}`, capturedAtMs: n }));
        const snapshot = store.getViewSnapshot({ browserSessionId: 'browser_session_1', viewId: 'view_1' });
        expect(snapshot.events).toContainEqual(expect.objectContaining({ family: 'console', kind: 'diagnostics.available' }));
        expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: 'events_evicted', count: 1 }));
    });
    it('reports view-owned history eviction without counting upserts or other views', async () => {
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', maxEventsPerView: 2 });
        for (let n = 1; n <= 3; n++) store.publishEvent(createEvent({ eventId: `event_${n}`, capturedAtMs: n }));
        store.publishEvent(createEvent({ eventId: 'event_3', capturedAtMs: 4 }));
        expect(store.getViewSnapshot({ browserSessionId: 'browser_session_1', viewId: 'view_1' }).diagnostics)
            .toContainEqual(expect.objectContaining({ code: 'events_evicted', count: 1, navigationGeneration: 1 }));
        expect(store.getViewSnapshot({ browserSessionId: 'browser_session_1', viewId: 'other' }).diagnostics).toEqual([]);
        store.publishEvent(createEvent({ eventId: 'new_document', navigationGeneration: 2 }));
        expect(store.getViewSnapshot({ browserSessionId: 'browser_session_1', viewId: 'view_1' }).diagnostics).toEqual([]);
    });
    it('keeps bounded diagnostics snapshots by view without leaking rejected unsafe events', async () => {
        const mod = await import('./store');

        expect(mod?.createBrowserDiagnosticsDaemonStore).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsDaemonStore) return;

        const store = mod.createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 5_000,
            maxEventsPerView: 2,
        });

        expect(store.publishEvent(createEvent({
            eventId: 'evt_1',
            capturedAtMs: 1_000,
            data: { url: 'https://example.test/one.js' },
        }))).toEqual({ status: 'accepted' });
        expect(store.publishEvent(createEvent({
            eventId: 'evt_2',
            capturedAtMs: 2_000,
            data: { url: 'https://example.test/two.js' },
        }))).toEqual({ status: 'accepted' });
        expect(store.publishEvent(createEvent({
            eventId: 'evt_3',
            capturedAtMs: 3_000,
            data: { url: 'https://example.test/three.js' },
        }))).toEqual({ status: 'accepted' });

        expect(store.publishRawEvent({
            ...createEvent({
                eventId: 'evt_unsafe',
                capturedAtMs: 4_000,
            }),
            data: {
                headers: {
                    Authorization: 'Bearer secret',
                },
            },
        })).toEqual({ status: 'rejected', reason: 'invalid_event' });

        const snapshot = store.getSnapshot();
        expect(snapshot).toEqual(expect.objectContaining({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 5_000,
            refreshState: 'idle',
        }));
        expect(snapshot.events.map((event) => event.eventId)).toEqual(['evt_2', 'evt_3']);
        expect(JSON.stringify(snapshot)).not.toContain('Bearer secret');
        expect(snapshot.diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'invalid_event',
                status: 'rejected',
            }),
        ]));
    });

    it('drops stale generation events after a newer navigation for the same view is published', async () => {
        const mod = await import('./store');

        expect(mod?.createBrowserDiagnosticsDaemonStore).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsDaemonStore) return;

        const store = mod.createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 6_000,
        });

        store.publishEvent(createEvent({
            eventId: 'evt_new',
            navigationGeneration: 5,
            capturedAtMs: 5_000,
        }));
        expect(store.publishEvent(createEvent({
            eventId: 'evt_stale',
            navigationGeneration: 4,
            capturedAtMs: 6_000,
        }))).toEqual({ status: 'rejected', reason: 'stale_navigation' });

        expect(store.getSnapshot().events.map((event) => event.eventId)).toEqual(['evt_new']);
    });

    it('clears view and session-scoped diagnostics when browser owners close', async () => {
        const mod = await import('./store');

        expect(mod?.createBrowserDiagnosticsDaemonStore).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsDaemonStore) return;

        const store = mod.createBrowserDiagnosticsDaemonStore({
            machineId: 'machine_1',
            now: () => 7_000,
        });

        expect(store.clearView).toBeTypeOf('function');
        expect(store.clearSession).toBeTypeOf('function');
        if (!store.clearView || !store.clearSession) return;

        store.publishEvent(createEvent({ eventId: 'view_1_event', viewId: 'view_1' }));
        store.publishEvent(createEvent({ eventId: 'view_2_event', viewId: 'view_2' }));
        store.publishEvent(createEvent({
            eventId: 'other_session_event',
            browserSessionId: 'browser_session_2',
            viewId: 'view_3',
        }));

        store.clearView({ browserSessionId: 'browser_session_1', viewId: 'view_1' });
        expect(store.getSnapshot().events.map((event) => event.eventId).sort()).toEqual([
            'other_session_event',
            'view_2_event',
        ]);

        store.clearSession({ browserSessionId: 'browser_session_1' });
        expect(store.getSnapshot().events.map((event) => event.eventId)).toEqual(['other_session_event']);
    });
});
