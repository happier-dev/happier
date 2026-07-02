import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { buildSessionListRowViewModels } from './sessionListRowViewModels';

function createRenderableSession(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 100,
        updatedAt: 200,
        active: false,
        activeAt: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: {
            name: 'Stable session',
            path: '/repo/stable',
            homeDir: '/repo',
            host: 'test.local',
            machineId: 'machine-a',
        },
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('buildSessionListRowViewModels', () => {
    it('keeps current-session selection derived only from selectedSessionId', () => {
        const firstItem = {
            type: 'session',
            sessionId: 'sess_selected_current',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const secondItem = {
            ...firstItem,
            sessionId: 'sess_not_current',
        } satisfies SessionListIndexItem;

        const rows = buildSessionListRowViewModels({
            listItems: [firstItem, secondItem],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([
                ['server_a:sess_selected_current', createRenderableSession('sess_selected_current')],
                ['server_a:sess_not_current', createRenderableSession('sess_not_current')],
            ]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: 'sess_selected_current',
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows.map((row) => {
            expect(row).not.toBeNull();
            expect(row?.session).not.toBeNull();
            return [row?.session?.id, row?.selected];
        })).toEqual([
            ['sess_selected_current', true],
            ['sess_not_current', false],
        ]);
    });

    it('reuses row view models when a session renderable is structurally unchanged', () => {
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_stability',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const first = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([['server_a:sess_row_vm_stability', session]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });
        const equivalentSession = {
            ...session,
            metadata: session.metadata ? { ...session.metadata } : null,
        };

        const second = buildSessionListRowViewModels({
            listItems: [{ ...item }],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([['server_a:sess_row_vm_stability', equivalentSession]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(second[0]).toBe(first[0]);
    });

    it('derives animated working text for working rows by default', async () => {
        const { t } = await import('@/text');
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_working',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([['server_a:sess_row_vm_working', {
                ...session,
                active: true,
                thinking: true,
                thinkingAt: 900,
            }]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.sessionStatus?.statusText).not.toBe(t('status.working'));
    });

    it('derives static working text for working rows when requested', async () => {
        const { t } = await import('@/text');
        const item = {
            type: 'session',
            sessionId: 'sess_row_vm_static_working',
            serverId: 'server_a',
            storageKind: 'persisted',
            groupKey: 'group-a',
            groupKind: 'date',
        } satisfies SessionListIndexItem;
        const session = createRenderableSession(item.sessionId);
        const rows = buildSessionListRowViewModels({
            listItems: [item],
            reachableSessionDisplayById: new Map(),
            rowRenderableByKey: new Map([['server_a:sess_row_vm_static_working', {
                ...session,
                active: true,
                thinking: true,
                thinkingAt: 900,
            }]]),
            relativeNowMs: 1000,
            runtimeNowMs: 1000,
            workingTextMode: 'static',
            hasMultipleMachines: false,
            pinnedSessionKeys: new Set(),
            sessionTags: {},
            selectedSessionId: null,
            showServerBadge: false,
            showPinnedServerBadge: false,
        });

        expect(rows[0]?.sessionStatus?.state).toBe('thinking');
        expect(rows[0]?.sessionStatus?.statusText).toBe(t('status.working'));
    });
});
