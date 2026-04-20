import { describe, expect, it } from 'vitest';

import { createEmptyPaneDetailsState } from './detailsWorkspaceReducer';
import { migrateLegacyDetailsWorkspaceState } from './migrateLegacyDetailsWorkspaceState';

function createFileTab(path: string) {
    return {
        key: `file:${path}`,
        kind: 'file',
        title: path,
        subtitle: null,
        resource: { kind: 'file', path },
        isPinned: true,
        isPreview: false,
    };
}

describe('migrateLegacyDetailsWorkspaceState', () => {
    it('migrates legacy single-stack details into one canonical details group', () => {
        const migrated = migrateLegacyDetailsWorkspaceState({
            isOpen: true,
            tabs: [
                createFileTab('README.md'),
                createFileTab('src/app.ts'),
            ],
            activeTabKey: 'src/app.ts',
            tabState: {
                'src/app.ts': { scrollY: 240 },
            },
        });

        expect(migrated).toMatchObject({
            isOpen: true,
            focusedGroupId: 'group:1',
            maximizedGroupId: null,
            nextGroupOrdinal: 2,
            groupsById: {
                'group:1': {
                    id: 'group:1',
                    tabKeys: ['file:README.md', 'file:src/app.ts'],
                    activeTabKey: 'file:src/app.ts',
                },
            },
            tabsByKey: {
                'file:README.md': expect.objectContaining({ key: 'file:README.md' }),
                'file:src/app.ts': expect.objectContaining({ key: 'file:src/app.ts' }),
            },
            tabState: {
                'src/app.ts': { scrollY: 240 },
            },
        });
        expect(migrated.root).toEqual({
            id: 'group:1',
            kind: 'leaf',
            leafKind: 'details-group',
            payload: { groupId: 'group:1' },
        });
    });

    it('sanitizes canonical persisted details workspaces to the split tree and existing tabs', () => {
        const migrated = migrateLegacyDetailsWorkspaceState({
            isOpen: true,
            tabsByKey: {
                'file:a.ts': createFileTab('a.ts'),
                'file:b.ts': createFileTab('b.ts'),
                'file:orphan.ts': createFileTab('orphan.ts'),
            },
            tabState: {
                'file:a.ts': { scrollY: 100 },
                'file:orphan.ts': { scrollY: 900 },
            },
            groupsById: {
                'group:1': {
                    id: 'group:1',
                    tabKeys: ['file:a.ts', 'file:missing.ts'],
                    activeTabKey: 'file:missing.ts',
                },
                'group:2': {
                    id: 'group:2',
                    tabKeys: ['file:b.ts'],
                    activeTabKey: 'file:b.ts',
                },
                'group:orphan': {
                    id: 'group:orphan',
                    tabKeys: ['file:orphan.ts'],
                    activeTabKey: 'file:orphan.ts',
                },
            },
            root: {
                id: 'split:root',
                kind: 'split',
                axis: 'row',
                ratio: 0.4,
                first: {
                    id: 'group:1',
                    kind: 'leaf',
                    leafKind: 'details-group',
                    payload: { groupId: 'group:1' },
                },
                second: {
                    id: 'group:2',
                    kind: 'leaf',
                    leafKind: 'details-group',
                    payload: { groupId: 'group:2' },
                },
            },
            focusedGroupId: 'group:missing',
            maximizedGroupId: 'group:orphan',
            nextGroupOrdinal: 2,
        });

        expect(migrated).toMatchObject({
            isOpen: true,
            focusedGroupId: 'group:1',
            maximizedGroupId: null,
            nextGroupOrdinal: 3,
            groupsById: {
                'group:1': {
                    id: 'group:1',
                    tabKeys: ['file:a.ts'],
                    activeTabKey: 'file:a.ts',
                },
                'group:2': {
                    id: 'group:2',
                    tabKeys: ['file:b.ts'],
                    activeTabKey: 'file:b.ts',
                },
            },
            tabsByKey: {
                'file:a.ts': expect.objectContaining({ key: 'file:a.ts' }),
                'file:b.ts': expect.objectContaining({ key: 'file:b.ts' }),
            },
            tabState: {
                'file:a.ts': { scrollY: 100 },
            },
        });
        expect(Object.keys(migrated.groupsById)).toEqual(['group:1', 'group:2']);
        expect(Object.keys(migrated.tabsByKey)).toEqual(['file:a.ts', 'file:b.ts']);
        expect(Object.keys(migrated.tabState)).toEqual(['file:a.ts']);
    });

    it('fails closed to an empty details workspace when canonical persisted root is malformed', () => {
        const migrated = migrateLegacyDetailsWorkspaceState({
            isOpen: true,
            tabsByKey: {
                'file:a.ts': createFileTab('a.ts'),
            },
            tabState: {
                'file:a.ts': { scrollY: 100 },
            },
            groupsById: {
                'group:1': {
                    id: 'group:1',
                    tabKeys: ['file:a.ts'],
                    activeTabKey: 'file:a.ts',
                },
            },
            root: {
                kind: 'leaf',
                id: 'group:1',
                leafKind: 'wrong-kind',
                payload: { groupId: 'group:1' },
            },
            focusedGroupId: 'group:1',
            maximizedGroupId: 'group:1',
            nextGroupOrdinal: 7,
        });

        expect(migrated).toEqual({
            ...createEmptyPaneDetailsState(),
            nextGroupOrdinal: 7,
        });
    });
});
