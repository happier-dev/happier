import { describe, expect, it } from 'vitest';
import {
    createSyncReliabilityTelemetry,
    installSyncReliabilityTelemetryGlobal,
} from './syncReliabilityTelemetry';
import type { PersistedSyncReliabilityEvent } from '@/sync/domains/state/persistence';

describe('sync reliability telemetry', () => {
    it('records in-memory events and persists critical events through the storage boundary', () => {
        const persisted: PersistedSyncReliabilityEvent[] = [];
        const telemetry = createSyncReliabilityTelemetry({
            now: () => 123,
            randomId: () => 'id-1',
            storage: {
                appendEvent: (event) => {
                    persisted.push(event);
                },
                loadEvents: () => persisted,
            },
        });

        telemetry.record('sync.cursor.advance', { cursor: '10' });
        telemetry.recordCritical('sync.cursor.refused', { cursor: '11', blockedReason: 'unsupported-kind' });

        expect(telemetry.snapshot()).toEqual({
            events: [
                { id: 'id-1', name: 'sync.cursor.advance', atMs: 123, fields: { cursor: '10' } },
                { id: 'id-1', name: 'sync.cursor.refused', atMs: 123, fields: { cursor: '11', blockedReason: 'unsupported-kind' } },
            ],
            persistedEvents: [
                { id: 'id-1', name: 'sync.cursor.refused', atMs: 123, fields: { cursor: '11', blockedReason: 'unsupported-kind' } },
            ],
        });
        expect(persisted).toEqual([
            { id: 'id-1', name: 'sync.cursor.refused', atMs: 123, fields: { cursor: '11', blockedReason: 'unsupported-kind' } },
        ]);
    });

    it('exposes a bounded global QA snapshot', () => {
        const telemetry = createSyncReliabilityTelemetry({
            now: () => 1,
            randomId: () => 'id',
            storage: {
                appendEvent: () => {},
                loadEvents: () => [],
            },
        });

        installSyncReliabilityTelemetryGlobal(telemetry);
        telemetry.record('sync.snapshot.complete');

        const globalApi = (globalThis as unknown as {
            __HAPPIER_SYNC_RELIABILITY__?: { snapshot: () => unknown; reset: () => void };
        }).__HAPPIER_SYNC_RELIABILITY__;

        expect(globalApi?.snapshot()).toEqual({
            events: [{ id: 'id', name: 'sync.snapshot.complete', atMs: 1, fields: {} }],
            persistedEvents: [],
        });
        globalApi?.reset();
        expect(telemetry.snapshot().events).toEqual([]);
    });
});
