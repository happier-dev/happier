import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

import { buildLocalServiceInventoryRow } from '@/dev/testkit';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';

import {
    isLocalServiceRowAttributedToSession,
    resolveLocalServiceOpenableTarget,
    resolveLocalServicePortLabel,
    selectLocalServiceServiceCounts,
} from './presentation';


function buildLaunchTarget(overrides: Partial<LocalServiceLaunchTarget> = {}): LocalServiceLaunchTarget {
    return {
        id: 'preview:preview-a',
        source: 'registered_preview',
        machineId: 'machine-a',
        title: 'Local preview',
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
    it('counts every detected row and the listening subset', () => {
        expect(selectLocalServiceServiceCounts({
            inventoryRows: [
                buildLocalServiceInventoryRow({ id: 'live-1', state: 'listening' }),
                buildLocalServiceInventoryRow({ id: 'live-2', state: 'listening' }),
                buildLocalServiceInventoryRow({ id: 'stale-1', state: 'stale' }),
                buildLocalServiceInventoryRow({ id: 'gone-1', state: 'gone' }),
            ],
        })).toEqual({ total: 4, running: 2 });
    });

    it('returns zeroed counts for an empty surface', () => {
        expect(selectLocalServiceServiceCounts({ inventoryRows: [] })).toEqual({ total: 0, running: 0 });
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

