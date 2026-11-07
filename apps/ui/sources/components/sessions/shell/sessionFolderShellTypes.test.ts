import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { buildSessionListIndexFromViewData } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { buildSessionListTreeRows } from './drop-resolution/buildSessionListTreeRows';
import { treeRowId } from './drop-resolution/treeRowId';
import { filterSessionListItemsByFocusedFolder, type SessionFolderHeaderItem } from './sessionFolderShellTypes';

describe('focused session folders', () => {
    it('retains the containing repository heading for a linked checkout folder and its tree rows', () => {
        const workspace = { t: 'workspaceScope', serverId: 'server-a', machineId: 'machine-a', rootPath: '/worktrees/topic' } as const;
        const folder: SessionFolderHeaderItem = {
            type: 'header', headerKind: 'folder', title: 'Linked folder', folderId: 'linked', parentFolderId: null,
            depth: 0, sessionCount: 1, groupKey: 'linked-folder', workspace, serverId: 'server-a',
        };
        const heading: SessionListViewItem = { type: 'header', headerKind: 'project', title: 'Repo',
            groupKey: 'repository', workspaceScopeHint: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/repo' } };
        const row: SessionListViewItem = { type: 'session', session: createSessionFixture({ id: 'linked-session' }),
            serverId: 'server-a', folderId: 'linked', folderDepth: 1, workspace };
        const filtered = filterSessionListItemsByFocusedFolder([
            { type: 'header', headerKind: 'active', title: 'Active' }, heading, folder, row,
        ], 'linked');
        expect(filtered).toContain(heading);
        const tree = buildSessionListTreeRows({ items: buildSessionListIndexFromViewData(filtered) ?? [] });
        expect(tree.rowMetadataById.get(treeRowId.folder('linked'))?.workspace).toEqual(workspace);
        expect(tree.rowMetadataById.has(treeRowId.session('server-a', 'linked-session'))).toBe(true);
    });
});
