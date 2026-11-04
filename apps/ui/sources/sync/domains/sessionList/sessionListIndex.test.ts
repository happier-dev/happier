import { describe, expect, it, vi } from 'vitest';
import { buildVisibleSessionNavigationEntries } from '../session/navigation/sessionNavigationOrder';
import { resolveSessionListRowStoreScopeKey } from '@/components/sessions/shell/row/sessionListVisibleRowStoreScopes';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';
import { sessionTagKey } from '@/components/sessions/shell/sessionTagUtils';
import { buildSessionFolderAssignmentKey } from '../session/folders/assignmentKeys';

import type { SessionListRenderableSession } from '../session/listing/sessionListRenderable';
import type { SessionListViewItem } from '../session/listing/sessionListViewData';
import {
    buildSessionListIndexFromViewData,
    areSessionListIndexItemsEqual,
    buildSessionListIndexNodeId,
    resolveSessionListItemOrganizationEligibility,
} from './sessionListIndex';
import type { MachineDisplayRenderable } from '../machines/machineDisplayRenderable';

function makeRenderable(id: string): SessionListRenderableSession {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 0,
        hasUnreadMessages: false,
        keepVisibleWhenInactive: false,
    };
}

describe('buildSessionListIndexFromViewData', () => {
    it('preserves fallback display no-ops and invalidates only the row whose admitted display changed', () => {
        const fallbackGroupDisplay = { groupKey: JSON.stringify(['home', 'machine', '/home/person']), title: 'Home folder' };
        const filed: Extract<SessionListViewItem, { type: 'session' }> = {
            type: 'session', session: makeRenderable('filed'), serverId: 'home', groupKind: 'folder', fallbackGroupDisplay,
        };
        const items: SessionListViewItem[] = [
            filed,
            { type: 'session', session: makeRenderable('unrelated'), serverId: 'home' },
        ];
        const first = buildSessionListIndexFromViewData(items)!;
        const same = buildSessionListIndexFromViewData([{ ...filed, fallbackGroupDisplay: { ...fallbackGroupDisplay } }, items[1]!], first)!;
        expect(same).toBe(first);
        const renamed = buildSessionListIndexFromViewData([{ ...filed, fallbackGroupDisplay: { ...fallbackGroupDisplay, title: 'Other folder' } }, items[1]!], first)!;
        expect(renamed[0]).not.toBe(first[0]);
        expect(renamed[1]).toBe(first[1]);
        const moved = buildSessionListIndexFromViewData([{ ...filed, fallbackGroupDisplay: { ...fallbackGroupDisplay, groupKey: 'other-exact-group' } }, items[1]!], first)!;
        expect(moved[0]).not.toBe(first[0]);
        expect(moved[1]).toBe(first[1]);
    });

    it('keeps mirror identities distinct and reuses each occurrence independently', () => {
        const session = makeRenderable('one');
        const items = [
            { type: 'session' as const, session, serverId: 'home', occurrenceRole: 'needsYou' as const },
            { type: 'session' as const, session, serverId: 'home', occurrenceRole: 'base' as const },
        ];
        const first = buildSessionListIndexFromViewData(items)!;
        expect(new Set(first.map(buildSessionListIndexNodeId)).size).toBe(2);
        expect(buildSessionListIndexFromViewData(items, first)).toBe(first);
        expect(buildSessionListIndexFromViewData([...items].reverse(), first)).toEqual([...first].reverse());
        const changed = buildSessionListIndexFromViewData([
            { ...items[0], pinned: true }, items[1],
        ], first)!;
        expect(changed[0]).not.toBe(first[0]);
        expect(changed[1]).toBe(first[1]);
        expect(changed.map(item => item.type === 'session' && item.sessionId)).toEqual(['one', 'one']);
    });

    it('publishes address keys once and reuses them for unchanged reads and reordered rows', () => {
        const items: SessionListViewItem[] = ['one', 'two'].map(id => ({
            type: 'session', session: makeRenderable(id), serverId: 'home',
        }));
        const first = buildSessionListIndexFromViewData(items)!;
        const encode = vi.spyOn(JSON, 'stringify');
        let addressEncodes: number;
        try {
            for (let index = 0; index < 20; index++) {
                expect(first.map(buildSessionListIndexNodeId)).toEqual(['session:["home","one"]', 'session:["home","two"]']);
                expect(buildVisibleSessionNavigationEntries(first).map(entry => entry.sessionKey)).toEqual([
                    '["home","one"]', '["home","two"]',
                ]);
                expect(first.filter(item => item.type === 'session').map(resolveSessionListRowStoreScopeKey)).toEqual([
                    '["home","one"]', '["home","two"]',
                ]);
                for (const item of first) {
                    if (item.type !== 'session') continue;
                    const key = `["home","${item.sessionId}"]`;
                    expect(treeRowId.session('home', item.sessionId, item.keyParts)).toBe(`["session",${JSON.stringify(key)}]`);
                    expect(sessionTagKey('home', item.sessionId, item.keyParts)).toBe(key);
                    expect(buildSessionFolderAssignmentKey('home', item.sessionId, item.keyParts)).toBe(key);
                }
            }
            expect(buildSessionListIndexFromViewData(items, first)).toBe(first);
            const reordered = buildSessionListIndexFromViewData([...items].reverse(), first)!;
            expect(reordered).toEqual([first[1], first[0]]);
            const changed = buildSessionListIndexFromViewData(items.map(item => ({ ...item, pinned: true })), first)!;
            expect(changed.every(item => item.type === 'session' && item.pinned === true)).toBe(true);
            expect(changed[0]).not.toBe(first[0]);
            addressEncodes = encode.mock.calls.filter(([value]) => Array.isArray(value) && value[0] === 'home').length;
        } finally { encode.mockRestore(); }
        expect(addressEncodes).toBe(0);
        const moved = buildSessionListIndexFromViewData(items.map(item => ({ ...item, serverId: 'other-home' })), first)!;
        expect(moved.map(buildSessionListIndexNodeId)).toEqual([
            'session:["other-home","one"]', 'session:["other-home","two"]',
        ]);
        const rebased = first.map(item => ({ ...item, serverId: 'other-home' }));
        expect(rebased.map(buildSessionListIndexNodeId)).toEqual(moved.map(buildSessionListIndexNodeId));
        expect(buildVisibleSessionNavigationEntries(rebased).map(entry => entry.sessionKey)).toEqual([
            '["other-home","one"]', '["other-home","two"]',
        ]);
        const movedItems = items.map(item => ({ ...item, serverId: 'other-home' }));
        const repaired = buildSessionListIndexFromViewData(movedItems, rebased)!;
        const repairedEncode = vi.spyOn(JSON, 'stringify');
        let repairedAddressEncodes: number;
        try {
            expect(buildSessionListIndexFromViewData(movedItems, repaired)).toBe(repaired);
            expect(repaired.map(buildSessionListIndexNodeId)).toEqual(moved.map(buildSessionListIndexNodeId));
            repairedAddressEncodes = repairedEncode.mock.calls.filter(([value]) => Array.isArray(value)
                && value[0] === 'other-home').length;
        } finally { repairedEncode.mockRestore(); }
        expect(repairedAddressEncodes).toBe(0);
    });

    it('builds stable node ids without relying on item index', () => {
        const sessionNodeId = buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        });
        expect(sessionNodeId).toBe(buildSessionListIndexNodeId({
            type: 'session',
            sessionId: 's1',
            serverId: 'server-a',
        }));

        const headerNodeId = buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        });
        expect(headerNodeId).toBe(buildSessionListIndexNodeId({
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            serverId: 'server-a',
            serverName: 'Server A',
        }));
    });

    it('keeps delimiter-bearing qualified Session node ids distinct', () => {
        const first = buildSessionListIndexNodeId({
            type: 'session',
            serverId: 'https://home.example/a',
            sessionId: 'b:c',
        });
        const second = buildSessionListIndexNodeId({
            type: 'session',
            serverId: 'https://home.example/a:b',
            sessionId: 'c',
        });

        expect(first).not.toBe(second);
    });

    it('keeps delimiter-bearing header node ids distinct', () => {
        // Header ids are React keys and collapsed-state keys. A workspace key or Home id
        // that contains the joining delimiter must not alias two different headers.
        const first = buildSessionListIndexNodeId({
            type: 'header',
            title: 'Workspace',
            headerKind: 'project',
            serverId: 'home-a',
            workspaceKey: 'project|folder:folder-a',
        });
        const second = buildSessionListIndexNodeId({
            type: 'header',
            title: 'Workspace',
            headerKind: 'project',
            serverId: 'home-a',
            workspaceKey: 'project',
            folderId: 'folder-a',
        });

        expect(first).not.toBe(second);
    });

    it('reuses the previous index reference when inputs are semantically identical', () => {
        const session = makeRenderable('s1');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            {
                type: 'session',
                session,
                serverId: 'server-a',
                serverName: 'Server A',
                section: 'active',
                groupKey: 'g1',
                groupKind: 'date',
            },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            { ...viewData[0] },
            { ...(viewData[1] as Extract<SessionListViewItem, { type: 'session' }>) },
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).toBe(first);
    });

    it('reuses unchanged session index items even when the list order changes', () => {
        const s1 = makeRenderable('s1');
        const s2 = makeRenderable('s2');
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'g1' },
            { type: 'session', session: s1, serverId: 'server-a', serverName: 'Server A', groupKey: 'g1', groupKind: 'date' },
            { type: 'session', session: s2, serverId: 'server-a', serverName: 'Server A', groupKey: 'g1', groupKind: 'date' },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            viewData[0],
            viewData[2] as Extract<SessionListViewItem, { type: 'session' }>,
            viewData[1] as Extract<SessionListViewItem, { type: 'session' }>,
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).not.toBeNull();

        const firstS1 = (first ?? []).find((item) => item.type === 'session' && item.sessionId === 's1');
        const secondS1 = (second ?? []).find((item) => item.type === 'session' && item.sessionId === 's1');
        expect(secondS1).toBe(firstS1);
    });

    it('reuses unchanged header index items even when their position changes', () => {
        const viewData: SessionListViewItem[] = [
            { type: 'header', title: 'Today', headerKind: 'date', groupKey: 'day:today', serverId: 'server-a', serverName: 'Server A' },
            { type: 'header', title: 'Earlier', headerKind: 'date', groupKey: 'day:earlier', serverId: 'server-a', serverName: 'Server A' },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first).not.toBeNull();

        const nextViewData: SessionListViewItem[] = [
            viewData[1],
            viewData[0],
        ];

        const second = buildSessionListIndexFromViewData(nextViewData, first);
        expect(second).not.toBeNull();

        const firstHeader = (first ?? []).find((item) => item.type === 'header' && item.title === 'Today');
        const secondHeader = (second ?? []).find((item) => item.type === 'header' && item.title === 'Today');
        expect(secondHeader).toBe(firstHeader);
    });

    it('propagates project header seed session ids and treats changes as semantic updates', () => {
        const viewData: SessionListViewItem[] = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'project:repo',
                seedSessionId: 'newest',
            },
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first?.[0]).toMatchObject({
            type: 'header',
            seedSessionId: 'newest',
        });

        const header = viewData[0] as Extract<SessionListViewItem, { type: 'header' }>;
        const second = buildSessionListIndexFromViewData([
            {
                ...header,
                seedSessionId: 'newer',
            },
        ], first);

        expect(second?.[0]).toMatchObject({
            seedSessionId: 'newer',
        });
        expect(second?.[0]).not.toBe(first?.[0]);
    });

    it('preserves folder header metadata and session depth in stable node ids', () => {
        const session = makeRenderable('s1');
        const viewData: SessionListViewItem[] = [
            {
                type: 'header',
                title: 'Planning',
                headerKind: 'folder',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                serverId: 'server-a',
                folderId: 'folder-a',
                folderDepth: 1,
            } as any,
            {
                type: 'session',
                session,
                serverId: 'server-a',
                groupKey: 'folder:server-a:workspace-a:folder-a',
                groupKind: 'folder',
                folderId: 'folder-a',
                folderDepth: 2,
            } as any,
        ];

        const first = buildSessionListIndexFromViewData(viewData);
        expect(first?.[0]).toMatchObject({
            type: 'header',
            headerKind: 'folder',
            folderId: 'folder-a',
            folderDepth: 1,
        });
        expect(first?.[1]).toMatchObject({
            type: 'session',
            groupKind: 'folder',
            folderId: 'folder-a',
            folderDepth: 2,
        });

        const folderNodeId = buildSessionListIndexNodeId(first![0]!);
        expect(folderNodeId).toContain('folder-a');

        const second = buildSessionListIndexFromViewData(viewData, first);
        expect(second).toBe(first);
    });
});

describe('resolveSessionListItemOrganizationEligibility', () => {
    const workspace = {
        t: 'workspaceScope' as const,
        serverId: 'server-a',
        machineId: 'machine-a',
        rootPath: '/repo',
    };

    it.each(['persisted', 'direct'] as const)(
        'gives %s sessions the same folder eligibility in a mixed list',
        (storageKind) => {
            expect(resolveSessionListItemOrganizationEligibility({
                type: 'session',
                sessionId: `${storageKind}-session`,
                serverId: 'server-a',
                storageKind,
                workspace,
            }, {
                foldersFeatureEnabled: true,
            })).toMatchObject({
                canUseSessionFolders: true,
                reason: 'eligible',
                storageKind,
            });
        },
    );

    it('fails closed when the folders feature bit is absent', () => {
        expect(resolveSessionListItemOrganizationEligibility({
            type: 'session',
            sessionId: 'external-session',
            serverId: 'server-a',
            storageKind: 'direct',
            workspace,
        }, {
            foldersFeatureEnabled: false,
        })).toMatchObject({
            canUseSessionFolders: false,
            reason: 'feature-disabled',
        });
    });

    it('fails closed for session rows without a Home scope', () => {
        expect(resolveSessionListItemOrganizationEligibility({
            type: 'session',
            sessionId: 'unscoped-session',
            storageKind: 'persisted',
        }, {
            foldersFeatureEnabled: true,
        })).toMatchObject({
            canUseSessionFolders: false,
            reason: 'scope-unavailable',
        });
    });

    it('admits Account sections without a workspace and refuses a foreign Home', () => {
        const item = {
            type: 'session' as const,
            sessionId: 'mixed-view-session',
            serverId: 'server-a',
            storageKind: 'direct' as const,
        };

        expect(resolveSessionListItemOrganizationEligibility(item, {
            foldersFeatureEnabled: true,
            destinationServerId: 'server-a',
        })).toMatchObject({
            canUseSessionFolders: true,
            reason: 'eligible',
        });
        expect(resolveSessionListItemOrganizationEligibility(item, {
            foldersFeatureEnabled: true,
            destinationServerId: 'server-b',
        })).toMatchObject({
            canUseSessionFolders: false,
            reason: 'destination-scope-mismatch',
        });
    });
});

describe('areSessionListIndexItemsEqual machine presence clocks', () => {
    const machine: MachineDisplayRenderable = {
        id: 'machine-a', updatedAt: 10, active: true, activeAt: 10, metadataVersion: 1,
        metadata: { displayName: 'Studio', host: 'studio', homeDir: '/home/a' },
    };
    const header = (value: MachineDisplayRenderable) => ({
        type: 'header' as const, title: 'Project', headerKind: 'project' as const, groupKey: 'g', machine: value,
    });

    it('keeps a header equal when only heartbeat clocks of its machine advance', () => {
        expect(areSessionListIndexItemsEqual(header(machine), header({ ...machine, updatedAt: 20, activeAt: 20 }))).toBe(true);
    });

    it('still changes a header when a displayed machine fact changes', () => {
        expect(areSessionListIndexItemsEqual(header(machine), header({ ...machine, active: false }))).toBe(false);
        expect(areSessionListIndexItemsEqual(header(machine), header({ ...machine, metadata: { ...machine.metadata, platform: 'darwin' } }))).toBe(false);
    });
});
