import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resolveSessionListSessionRowDragPolicy } from '@/sync/domains/session/listing/sessionListLayout';
import { buildSessionListTreeRows } from '../drop-resolution/buildSessionListTreeRows';
import { buildSessionListGroupOrderAfterTreeDrop } from './applyGroupOrderUpdate';
import { buildSessionWorkspaceOrderAfterTreeDrop } from './applyWorkspaceOrderUpdate';

describe('supplemental attention never becomes incidental personal order', () => {
    const key = (sessionId: string) => sessionAddressKey({ serverId: 's1', sessionId });
    const items: SessionListIndexItem[] = [
        { type: 'header', headerKind: 'sessions', groupKey: 'sessions', serverId: 's1', title: 'Sessions' },
        { type: 'header', headerKind: 'project', groupKey: 'own-a', workspaceKey: 'own-a', serverId: 's1', title: 'A' },
        { type: 'session', sessionId: 'a', serverId: 's1', groupKey: 'own-a', groupKind: 'project', reportsParent: true },
        { type: 'session', sessionId: 'outside-child', serverId: 's1', groupKey: 'own-a', groupKind: 'project', supplementalAttention: true, reportsDepth: 1 },
        { type: 'header', headerKind: 'project', groupKey: 'own-b', workspaceKey: 'own-b', serverId: 's1', title: 'B' },
        { type: 'session', sessionId: 'b', serverId: 's1', groupKey: 'own-b', groupKind: 'project' },
        { type: 'header', headerKind: 'project', groupKey: 'outside', workspaceKey: 'outside', serverId: 's1', title: 'Outside' },
        { type: 'session', sessionId: 'outside', serverId: 's1', groupKey: 'outside', groupKind: 'project', supplementalAttention: true },
    ];

    it('captures ordinary sibling order, preserves unseen saved keys, and refuses supplemental reordering', () => {
        const tree = buildSessionListTreeRows({ items });
        const row = [...tree.rowMetadataById.values()].find(row => row.sessionId === 'a')!;
        const outside = [...tree.rowMetadataById.values()].find(row => row.sessionId === 'outside-child')!;
        const currentMap = { 'own-a': [key('unseen'), key('a')] };
        const next = buildSessionListGroupOrderAfterTreeDrop({ tree, movedRowId: row.rowId, containerId: row.containerId, currentMap });
        expect(next?.['own-a']).toEqual([key('a'), key('unseen')]);
        expect(buildSessionListGroupOrderAfterTreeDrop({ tree, movedRowId: outside.rowId, containerId: outside.containerId, currentMap })).toBeNull();
        expect(buildSessionListGroupOrderAfterTreeDrop({ tree, movedRowId: row.rowId, containerId: row.containerId,
            beforeRowId: outside.rowId, currentMap })).toBeNull();
        expect(resolveSessionListSessionRowDragPolicy({ item: items[3] as Extract<SessionListIndexItem, { type: 'session' }>,
            manualSessionOrderingEnabled: true, folderContainmentEnabled: true, layoutV1: 'projects' }))
            .toMatchObject({ canReorderSiblings: false, canMoveBetweenFolders: true, canDrag: true });
    });

    it('excludes outside-only groups while preserving mixed groups and unseen saved group order', () => {
        const tree = buildSessionListTreeRows({ items });
        const groups = [...tree.rowMetadataById.values()].filter(row => row.kind === 'workspace-root');
        const a = groups.find(row => row.item.groupKey === 'own-a')!;
        const b = groups.find(row => row.item.groupKey === 'own-b')!;
        const outside = groups.find(row => row.item.groupKey === 'outside')!;
        const scopeKey = tree.containerMetadataById.get(b.containerId)!.groupKey;
        const currentMap = { [scopeKey]: ['previously-saved-unseen', a.orderKey!, b.orderKey!] };
        const next = buildSessionWorkspaceOrderAfterTreeDrop({ tree, movedRowId: b.rowId, containerId: b.containerId,
            beforeRowId: a.rowId, currentMap });
        expect(next?.[scopeKey]).toEqual(['previously-saved-unseen', b.orderKey, a.orderKey]);
        expect(buildSessionWorkspaceOrderAfterTreeDrop({ tree, movedRowId: outside.rowId, containerId: outside.containerId, currentMap })).toBeNull();
        expect(buildSessionWorkspaceOrderAfterTreeDrop({ tree, movedRowId: b.rowId, containerId: b.containerId,
            beforeRowId: outside.rowId, currentMap })).toBeNull();
    });
});
