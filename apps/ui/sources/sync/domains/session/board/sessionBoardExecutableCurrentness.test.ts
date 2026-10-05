import { describe, expect, it } from 'vitest';

import { createSessionSurfaceNoteDocumentV1, type SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

import { projectSessionBoard, type SessionBoardSnapshot } from './sessionBoardProjection';
import { resolveSessionBoardExecutableCurrentness } from './sessionBoardExecutableCurrentness';

const EXECUTABLE_ITEM: SessionSurfaceItemV1 = {
    v: 1,
    title: 'Status',
    frame: 'card',
    height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: { kind: 'html', html: '<main>Status</main>' } },
};

const INSTALLED_ITEM: SessionSurfaceItemV1 = {
    ...EXECUTABLE_ITEM,
    source: {
        kind: 'widget',
        instance: { v: 1, id: 'instance-1', definition: { kind: 'installed', surface: { pluginId: 'acme.review', localId: 'status' } }, bindings: {} },
    },
};

function snapshot(overrides: Partial<Pick<SessionBoardSnapshot, 'freshness' | 'reachability' | 'capabilities' | 'incomplete'>> = {}) {
    return projectSessionBoard({
        layout: undefined,
        items: new Map([['item-1', {
            revision: 'revision-g',
            outcome: { status: 'ready' as const, value: EXECUTABLE_ITEM },
        }]]),
        capabilities: overrides.capabilities ?? { readTranscript: true, editSessionRecords: true },
        freshness: overrides.freshness ?? 'fresh',
        reachability: overrides.reachability ?? 'reachable',
        loading: 'idle',
        incomplete: overrides.incomplete ?? false,
    });
}

function installedSnapshot() {
    return projectSessionBoard({
        layout: undefined,
        items: new Map([['item-1', {
            revision: 'revision-g',
            outcome: { status: 'ready' as const, value: INSTALLED_ITEM },
        }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh',
        reachability: 'reachable',
        loading: 'idle',
        incomplete: false,
    });
}

describe('resolveSessionBoardExecutableCurrentness', () => {
    it('admits only an exact current readable record while allowing unrelated pagination to remain incomplete', () => {
        const current = snapshot({ incomplete: true });
        const item = current.itemsById.get('item-1')!;
        expect(resolveSessionBoardExecutableCurrentness(current, item)).toBe('current');

        expect(resolveSessionBoardExecutableCurrentness(
            snapshot({ freshness: 'stale' }),
            item,
        )).toBe('stale');
        expect(resolveSessionBoardExecutableCurrentness(
            snapshot({ reachability: 'offline' }),
            item,
        )).toBe('offline');
        expect(resolveSessionBoardExecutableCurrentness(
            snapshot({ reachability: 'unknown' }),
            item,
        )).toBe('unverified');
        expect(resolveSessionBoardExecutableCurrentness(
            snapshot({ capabilities: { readTranscript: false, editSessionRecords: false } }),
            item,
        )).toBe('unverified');
    });

    it('refuses a projection whose exact record or revision is no longer the current Board item', () => {
        const current = snapshot();
        const item = current.itemsById.get('item-1')!;
        expect(resolveSessionBoardExecutableCurrentness(current, {
            ...item,
            revision: 'revision-f',
        })).toBe('unverified');

        const absent = projectSessionBoard({
            layout: undefined,
            items: new Map(),
            capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'fresh',
            reachability: 'reachable',
            loading: 'idle',
            incomplete: false,
        });
        expect(resolveSessionBoardExecutableCurrentness(absent, item)).toBe('unverified');
    });

    it('does not treat native declarative bytes as executable authority', () => {
        const native = projectSessionBoard({
            layout: undefined,
            items: new Map([['note-1', {
                revision: 'revision-note',
                outcome: {
                    status: 'ready' as const,
                    value: {
                        ...EXECUTABLE_ITEM,
                        source: {
                            kind: 'declarative' as const,
                            document: createSessionSurfaceNoteDocumentV1('Retained note'),
                        },
                    },
                },
            }]]),
            capabilities: { readTranscript: true, editSessionRecords: true },
            freshness: 'stale',
            reachability: 'offline',
            loading: 'idle',
            incomplete: false,
        });
        expect(resolveSessionBoardExecutableCurrentness(native, native.itemsById.get('note-1')!)).toBe('not_executable');
    });

    it.each([
        ['retainedOffline', false, 'offline'],
        ['establishing', false, 'stale'],
        ['unavailable', false, 'unverified'],
        ['current', false, 'unverified'],
    ] as const)(
        'requires the installed-plugin projection itself to be executable: %s',
        (phase, interactionEnabled, expected) => {
            const current = installedSnapshot();
            expect(resolveSessionBoardExecutableCurrentness(current, current.itemsById.get('item-1')!, {
                pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                phase,
                interactionEnabled,
            })).toBe(expected);
        },
    );

    it('accepts an installed item only when both Board bytes and plugin authority are current', () => {
        const current = installedSnapshot();
        expect(resolveSessionBoardExecutableCurrentness(current, current.itemsById.get('item-1')!, {
            pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
            phase: 'current',
            interactionEnabled: true,
        })).toBe('current');
    });
});
