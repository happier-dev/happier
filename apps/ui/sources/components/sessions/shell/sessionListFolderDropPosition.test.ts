import { describe, expect, it } from 'vitest';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { resolveSessionListFolderDropPlacement } from './sessionListFolderDropPosition';

function project(groupKey = 'server:s:active:project:p'): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: 'Project',
        headerKind: 'project',
        groupKey,
    };
}

function folder(id: string, depth: number): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: id,
        headerKind: 'folder',
        groupKey: `server:s:active:project:p:folder:${id}`,
        folderId: id,
        folderDepth: depth,
    };
}

function session(id: string, folderId: string | null, folderDepth: number): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        groupKey: folderId ? `server:s:active:project:p:folder:${folderId}` : 'server:s:active:project:p',
        groupKind: folderId ? 'folder' : 'project',
        folderId,
        folderDepth,
    };
}

describe('resolveSessionListFolderDropPlacement', () => {
    it('moves a nested folder above a root folder when the drop line is above that root folder', () => {
        const items: SessionListIndexItem[] = [
            project(),
            folder('fefg', 0),
            folder('test', 0),
            folder('browser-audit', 1),
            folder('test-3', 1),
        ];

        expect(resolveSessionListFolderDropPlacement({
            items,
            folderId: 'browser-audit',
            positionDelta: -2,
        })).toEqual({
            parentId: null,
            beforeFolderId: 'fefg',
        });
    });

    it('keeps a folder move unresolved when the drop line lands inside its own subtree', () => {
        const items: SessionListIndexItem[] = [
            project(),
            folder('parent', 0),
            folder('child', 1),
            session('inside', 'child', 2),
            folder('sibling', 0),
        ];

        expect(resolveSessionListFolderDropPlacement({
            items,
            folderId: 'parent',
            positionDelta: 1,
        })).toBeNull();
    });
});
