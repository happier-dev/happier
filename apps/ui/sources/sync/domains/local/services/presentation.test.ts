import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { buildLocalServiceInventoryRow } from '@/dev/testkit';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ManagedLocalServiceRow } from '@/sync/domains/local/services/managed/store';

import {
    isLocalServiceRowAttributedToSession,
    partitionLocalServiceRowsBySession,
    rankLocalServiceRows,
    resolveLocalServiceOpenableTarget,
    resolveLocalServicePortLabel,
    selectLocalServiceServiceCounts,
    resolveManagedFactLines,
} from './presentation';

function buildManagedRow(overrides: Partial<ManagedLocalServiceRow> = {}): ManagedLocalServiceRow {
    return {
        id: 'managed-1',
        phase: 'running',
        launchMode: 'detectAfterLaunch',
        supportedActions: [],
        diagnostics: [],
        updatedAt: 1_000,
        ...overrides,
    };
}

function buildLaunchTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
    return {
        id: 'managed:preview',
        source: 'managed_service',
        machineId: 'machine-a',
        title: 'Managed preview',
        confidence: 'medium',
        state: 'available',
        actions: [],
        ...overrides,
    };
}

describe('resolveLocalServicePortLabel', () => {
    it('renders a leading-colon monospace port token', () => {
        expect(resolveLocalServicePortLabel(buildLocalServiceInventoryRow({ port: 5173 }))).toBe(':5173');
    });

    it('renders the port from a launch-target-shaped record when present', () => {
        expect(resolveLocalServicePortLabel({ port: 3000 })).toBe(':3000');
    });

    it('returns null when no positive port is available', () => {
        expect(resolveLocalServicePortLabel({ port: 0 })).toBeNull();
        expect(resolveLocalServicePortLabel({})).toBeNull();
    });
});

describe('selectLocalServiceServiceCounts', () => {
    it('counts total rows and running rows across inventory + managed', () => {
        const counts = selectLocalServiceServiceCounts({
            inventoryRows: [
                buildLocalServiceInventoryRow({ id: 'a', state: 'listening' }),
                buildLocalServiceInventoryRow({ id: 'b', state: 'stale' }),
                buildLocalServiceInventoryRow({ id: 'c', state: 'gone' }),
            ],
            managedRows: [
                buildManagedRow({ id: 'm1', phase: 'running' }),
                buildManagedRow({ id: 'm2', phase: 'stopped' }),
            ],
        });
        expect(counts).toEqual({ total: 5, running: 2 });
    });

    it('treats managed detecting phase as running for the live count', () => {
        const counts = selectLocalServiceServiceCounts({
            inventoryRows: [],
            managedRows: [buildManagedRow({ id: 'm1', phase: 'detecting' })],
        });
        expect(counts).toEqual({ total: 1, running: 1 });
    });

    it('returns zeroed counts for an empty surface', () => {
        expect(selectLocalServiceServiceCounts({ inventoryRows: [], managedRows: [] })).toEqual({ total: 0, running: 0 });
    });
});

describe('resolveManagedFactLines', () => {
    it('renders managed launch metadata as product copy and keeps raw ids out of primary facts', () => {
        const lines = resolveManagedFactLines(buildManagedRow({
            launchMode: 'detectAfterLaunch',
            inventoryId: 'inventory:018f5bcb-2d71-79ef-9f0c-4f822a03e8f4',
        }));
        const text = lines.join('\n');

        expect(text).toContain('localServices.managed.launchModeLabel.detectedAfterStart');
        expect(text).not.toContain('detectAfterLaunch');
        expect(text).not.toContain('018f5bcb-2d71-79ef-9f0c-4f822a03e8f4');
        expect(text).not.toContain('localServices.managed.inventory');
    });
});

describe('rankLocalServiceRows', () => {
    it('sorts listening rows ahead of stale/gone while preserving stable order within a band', () => {
        const rows: readonly LocalServiceInventoryRow[] = [
            buildLocalServiceInventoryRow({ id: 'stale-1', state: 'stale' }),
            buildLocalServiceInventoryRow({ id: 'live-1', state: 'listening' }),
            buildLocalServiceInventoryRow({ id: 'gone-1', state: 'gone' }),
            buildLocalServiceInventoryRow({ id: 'live-2', state: 'listening' }),
        ];
        expect(rankLocalServiceRows(rows).map((row) => row.id)).toEqual(['live-1', 'live-2', 'stale-1', 'gone-1']);
    });

    it('returns the same referential array contents without mutating the input', () => {
        const rows = [
            buildLocalServiceInventoryRow({ id: 'a', state: 'listening' }),
            buildLocalServiceInventoryRow({ id: 'b', state: 'stale' }),
        ];
        const before = [...rows];
        rankLocalServiceRows(rows);
        expect(rows).toEqual(before);
    });
});

describe('resolveLocalServiceOpenableTarget', () => {
    it('returns the launch target itself when it carries a browser target and is not unavailable', () => {
        const target = buildLaunchTarget({
            state: 'available',
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-a',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        });
        expect(resolveLocalServiceOpenableTarget(target)).toBe(target);
    });

    it('returns null when the target has no browser target', () => {
        expect(resolveLocalServiceOpenableTarget(buildLaunchTarget({ state: 'available' }))).toBeNull();
    });

    it('returns null for unavailable targets even with a browser target', () => {
        const target = buildLaunchTarget({
            state: 'unavailable',
            unavailableReason: 'preview_unregistered',
            browserTarget: {
                kind: 'localServicePreview',
                targetId: 'preview-a',
                sessionId: 'session-a',
                machineId: 'machine-a',
            },
        });
        expect(resolveLocalServiceOpenableTarget(target)).toBeNull();
    });
});

describe('isLocalServiceRowAttributedToSession', () => {
    it('matches a launch target whose sessionId equals the active session', () => {
        expect(isLocalServiceRowAttributedToSession(buildLaunchTarget({ sessionId: 'session-a' }), 'session-a')).toBe(true);
        expect(isLocalServiceRowAttributedToSession(buildLaunchTarget({ sessionId: 'session-b' }), 'session-a')).toBe(false);
    });

    it('matches an inventory row whose provenance.session.id equals the active session', () => {
        const row = buildLocalServiceInventoryRow({ provenance: { session: { id: 'session-a' } } });
        expect(isLocalServiceRowAttributedToSession(row, 'session-a')).toBe(true);
        expect(isLocalServiceRowAttributedToSession(row, 'session-b')).toBe(false);
    });

    it('is false when the active sessionId is null or the row has no attribution', () => {
        expect(isLocalServiceRowAttributedToSession(buildLaunchTarget({ sessionId: 'session-a' }), null)).toBe(false);
        expect(isLocalServiceRowAttributedToSession(buildLocalServiceInventoryRow({}), 'session-a')).toBe(false);
    });
});

describe('partitionLocalServiceRowsBySession', () => {
    it('places session-attributed rows in thisSession and the rest in workspace, dropping none, running-first within each band', () => {
        const rows: readonly LocalServiceInventoryRow[] = [
            buildLocalServiceInventoryRow({ id: 'other-live', state: 'listening' }),
            buildLocalServiceInventoryRow({ id: 'mine-stale', state: 'stale', provenance: { session: { id: 'session-a' } } }),
            buildLocalServiceInventoryRow({ id: 'mine-live', state: 'listening', provenance: { session: { id: 'session-a' } } }),
            buildLocalServiceInventoryRow({ id: 'other-stale', state: 'stale' }),
        ];
        const partition = partitionLocalServiceRowsBySession(rows, 'session-a');
        expect(partition.thisSession.map((row) => row.id)).toEqual(['mine-live', 'mine-stale']);
        expect(partition.workspace.map((row) => row.id)).toEqual(['other-live', 'other-stale']);
        expect(partition.thisSession.length + partition.workspace.length).toBe(rows.length);
    });

    it('puts everything in workspace when no active session is known', () => {
        const rows: readonly LocalServiceInventoryRow[] = [
            buildLocalServiceInventoryRow({ id: 'a', provenance: { session: { id: 'session-a' } } }),
            buildLocalServiceInventoryRow({ id: 'b' }),
        ];
        const partition = partitionLocalServiceRowsBySession(rows, null);
        expect(partition.thisSession).toEqual([]);
        expect(partition.workspace.map((row) => row.id)).toEqual(['a', 'b']);
    });

    it('partitions launch targets by their sessionId attribution', () => {
        const targets: readonly LocalServiceLaunchTarget[] = [
            buildLaunchTarget({ id: 'mine', sessionId: 'session-a' }),
            buildLaunchTarget({ id: 'theirs', sessionId: 'session-b' }),
        ];
        const partition = partitionLocalServiceRowsBySession(targets, 'session-a');
        expect(partition.thisSession.map((target) => target.id)).toEqual(['mine']);
        expect(partition.workspace.map((target) => target.id)).toEqual(['theirs']);
    });
});
