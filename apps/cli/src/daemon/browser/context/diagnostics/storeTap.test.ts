import {
    BrowserDiagnosticEventV1Schema,
    type BrowserDiagnosticEventV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createBrowserDiagnosticsDaemonStore } from '../../diagnostics/store';
import { createBrowserContextDiagnosticsRingBuffer } from './ringBuffer';
import { tapBrowserDiagnosticsStoreIntoRingBuffer } from './storeTap';

const SESSION = 'browser_session_1';
const NAV = 3;

function networkEvent(input: Readonly<{
    viewId: string;
    ordinal: number;
    capturedAtMs: number;
    path?: string;
}>): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: `sidecar_diag_${input.viewId}_${NAV}_${input.ordinal}`,
        browserSessionId: SESSION,
        viewId: input.viewId,
        navigationGeneration: NAV,
        capturedAtMs: input.capturedAtMs,
        family: 'network',
        kind: 'network.requestStarted',
        fidelity: 'cdp',
        trusted: true,
        data: {
            requestId: 'sidecar_request_abc',
            method: 'GET',
            url: { origin: 'https://api.test', path: input.path ?? '/items', queryKeys: [] },
        },
        redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false },
    });
}

function summaryFor(
    ring: ReturnType<typeof createBrowserContextDiagnosticsRingBuffer>,
    viewId: string,
): string {
    return ring.summarize({ browserSessionId: SESSION, viewId, navigationGeneration: NAV, kind: 'browserNetworkSummary' })?.summary ?? '';
}

describe('tapBrowserDiagnosticsStoreIntoRingBuffer', () => {
    it('records accepted events into both the store and the ring buffer', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 10_000 });
        const ring = createBrowserContextDiagnosticsRingBuffer({ now: () => 10_000, windowMs: 60_000 });
        const tapped = tapBrowserDiagnosticsStoreIntoRingBuffer({ store, ringBuffer: ring });

        const result = tapped.publishEvent(networkEvent({ viewId: 'view_1', ordinal: 1, capturedAtMs: 9_900 }));

        expect(result.status).toBe('accepted');
        expect(store.getSnapshot().events).toHaveLength(1);
        expect(summaryFor(ring, 'view_1')).toContain('/items');
    });

    it('clears the closed view from the ring buffer in lockstep with the store', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 10_000 });
        const ring = createBrowserContextDiagnosticsRingBuffer({ now: () => 10_000, windowMs: 60_000 });
        const tapped = tapBrowserDiagnosticsStoreIntoRingBuffer({ store, ringBuffer: ring });

        tapped.publishEvent(networkEvent({ viewId: 'view_1', ordinal: 1, capturedAtMs: 9_900 }));
        tapped.publishEvent(networkEvent({ viewId: 'view_2', ordinal: 1, capturedAtMs: 9_950, path: '/kept' }));

        tapped.clearView({ browserSessionId: SESSION, viewId: 'view_1' });

        // The closed view is pruned from BOTH the store and the ring; the sibling view is untouched.
        expect(summaryFor(ring, 'view_1')).not.toContain('/items');
        expect(summaryFor(ring, 'view_2')).toContain('/kept');
        expect(store.getSnapshot().events.map((event) => event.viewId)).toEqual(['view_2']);
    });

    it('clears the closed/purged session from the ring buffer in lockstep with the store', () => {
        const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1', now: () => 10_000 });
        const ring = createBrowserContextDiagnosticsRingBuffer({ now: () => 10_000, windowMs: 60_000 });
        const tapped = tapBrowserDiagnosticsStoreIntoRingBuffer({ store, ringBuffer: ring });

        tapped.publishEvent(networkEvent({ viewId: 'view_1', ordinal: 1, capturedAtMs: 9_900 }));
        tapped.publishEvent(networkEvent({ viewId: 'view_2', ordinal: 1, capturedAtMs: 9_950, path: '/other' }));

        tapped.clearSession({ browserSessionId: SESSION });

        // Every view for the session is pruned from BOTH the store and the ring.
        expect(summaryFor(ring, 'view_1')).toBe('');
        expect(summaryFor(ring, 'view_2')).toBe('');
        expect(store.getSnapshot().events).toEqual([]);
    });
});
