import { describe, expect, it } from 'vitest';

import type { BrowserDiagnosticEventV1 } from '@happier-dev/protocol';

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
        expect(snapshot.diagnostics).toEqual([
            expect.objectContaining({
                code: 'invalid_event',
                status: 'rejected',
            }),
        ]);
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
