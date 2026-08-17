import { describe, expect, it } from 'vitest';

import {
    applyCloseDetailsOverlay,
    applyOpenDetailsOverlay,
    applyOpenDetailsTab,
    applyReplaceDetailsTab,
    applySetMaximizedDetailsGroup,
    applySplitDetailsGroup,
    createEmptyPaneDetailsState,
} from './detailsWorkspaceReducer';
import {
    migrateLegacyDetailsWorkspaceState,
    serializeDetailsWorkspaceState,
} from './migrateLegacyDetailsWorkspaceState';

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
    it('preserves the original workspace return state when one full-bleed overlay replaces another', () => {
        const first = applyOpenDetailsOverlay(createEmptyPaneDetailsState(), {
            destination: { pluginId: 'acme.review', localId: 'first' },
        });
        const replacement = applyOpenDetailsOverlay(first, {
            destination: { pluginId: 'acme.review', localId: 'replacement' },
        });

        expect(applyCloseDetailsOverlay(replacement)).toMatchObject({
            isOpen: false,
            overlay: null,
            focusedGroupId: null,
            maximizedGroupId: null,
        });
    });

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

    it('retains a qualified __proto__ tab key as an own persisted tab entry', () => {
        const tabKey = '__proto__';
        const migrated = migrateLegacyDetailsWorkspaceState(JSON.parse(JSON.stringify({
            isOpen: true,
            tabsByKey: {
                [tabKey]: {
                    ...createFileTab('prototype-safe.ts'),
                    key: tabKey,
                },
            },
            tabState: {},
            groupsById: {
                'group:1': {
                    id: 'group:1',
                    tabKeys: [tabKey],
                    activeTabKey: tabKey,
                },
            },
            root: {
                id: 'group:1',
                kind: 'leaf',
                leafKind: 'details-group',
                payload: { groupId: 'group:1' },
            },
            focusedGroupId: 'group:1',
            maximizedGroupId: null,
            nextGroupOrdinal: 2,
        })));

        expect(Object.prototype.hasOwnProperty.call(migrated.tabsByKey, tabKey)).toBe(true);
        expect(Object.keys(migrated.tabsByKey)).toEqual([tabKey]);
        expect(migrated.tabsByKey[tabKey]).toMatchObject({ key: tabKey });
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

    it('keeps only qualified destination identity in a plugin details tab resource', () => {
        const resource = {
            kind: 'pluginDetailsDestination',
            destination: {
                pluginId: 'com.example.viewer',
                localId: 'workspace-file',
            },
            instanceKey: 'file-instance-1',
            // These facts belong to the current mount/handoff. A details
            // workspace can be restored long after either authority expires.
            launchInput: { opaqueFileRef: 'viewer-ref-1' },
            executionOrigin: {
                materializationId: 'materialization-1',
            },
        };
        const expectedResource = {
            kind: 'pluginDetailsDestination',
            destination: {
                pluginId: 'com.example.viewer',
                localId: 'workspace-file',
            },
            instanceKey: 'file-instance-1',
        };
        const tab = {
            key: 'plugin-details:com.example.viewer:workspace-file:file-instance-1',
            kind: 'pluginDetailsDestination',
            title: 'Workspace file viewer',
            resource,
        };

        const opened = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab,
            openAs: 'pinned',
        });
        const openedWithEphemeralTabState = {
            ...opened,
            tabState: {
                [tab.key]: {
                    launchInput: { opaqueFileRef: 'viewer-ref-1' },
                },
            },
        };
        const serialized = serializeDetailsWorkspaceState(openedWithEphemeralTabState);
        expect(serialized.tabsByKey[tab.key]?.resource).toEqual(expectedResource);
        expect(serialized.tabState).toEqual({});

        const restored = migrateLegacyDetailsWorkspaceState({
            ...serialized,
            tabsByKey: {
                [tab.key]: {
                    ...opened.tabsByKey[tab.key],
                    resource,
                },
            },
            tabState: {
                [tab.key]: {
                    launchInput: { opaqueFileRef: 'viewer-ref-1' },
                },
            },
        });
        expect(restored.tabsByKey[tab.key]?.resource).toEqual(expectedResource);
        expect(restored.tabState).toEqual({});
    });

    it('restores the builtin workspace-file tab instead of persisting its selected plugin viewer without custody', () => {
        const builtinTab = {
            key: 'file:README.txt',
            kind: 'workspace-file',
            title: 'README.txt',
            subtitle: null,
            resource: { filePath: 'README.txt' },
            isPinned: false,
            isPreview: true,
        };
        const selectedPluginViewerTab = {
            key: 'plugin-details:plugin.preview:text-viewer',
            kind: 'pluginDetailsDestination',
            title: 'Text preview',
            subtitle: null,
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'plugin.preview', localId: 'text-viewer' },
                // The generic resource is deliberately insufficient to reopen
                // a workspace file: the opaque ref remains launch-local.
                launchInput: { kind: 'workspaceFile', handle: 'opaque-file-ref' },
            },
        };

        const openedBuiltin = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: builtinTab,
            openAs: 'preview',
        });
        const splitWorkspace = applySplitDetailsGroup(openedBuiltin, { axis: 'horizontal' });
        const withNeighborTab = applyOpenDetailsTab(splitWorkspace, {
            tab: createFileTab('src/neighbor.ts'),
            openAs: 'pinned',
        });
        const beforeViewerSelection = applySetMaximizedDetailsGroup(withNeighborTab, 'group:2');
        const selectedPluginViewer = applyReplaceDetailsTab(beforeViewerSelection, {
            tabKey: builtinTab.key,
            tab: selectedPluginViewerTab,
            openAs: 'preview',
            restoreSourceOnRehydrate: true,
        });

        const serialized = serializeDetailsWorkspaceState(selectedPluginViewer);
        expect(serialized.tabsByKey).toEqual({
            [builtinTab.key]: builtinTab,
            'file:src/neighbor.ts': createFileTab('src/neighbor.ts'),
        });
        expect(serialized.groupsById['group:1']?.tabKeys).toEqual([builtinTab.key]);
        expect(serialized.groupsById['group:1']?.activeTabKey).toBe(builtinTab.key);
        expect(serialized.groupsById['group:2']?.tabKeys).toEqual(['file:src/neighbor.ts']);
        expect(serialized.root).toEqual(beforeViewerSelection.root);
        expect(serialized.focusedGroupId).toBe('group:2');
        expect(serialized.maximizedGroupId).toBe('group:2');
        expect(serialized.tabState).toEqual({});
        const serializedJson = JSON.stringify(serialized);
        expect(serializedJson).not.toContain('opaque-file-ref');
        expect(serializedJson).not.toContain('plugin.preview');
        expect(serializedJson).not.toContain('restore-builtin-details-tab-on-rehydrate');

        const restored = migrateLegacyDetailsWorkspaceState(serialized);
        expect(restored.tabsByKey).toEqual({
            [builtinTab.key]: builtinTab,
            'file:src/neighbor.ts': createFileTab('src/neighbor.ts'),
        });
        expect(restored.groupsById['group:1']?.tabKeys).toEqual([builtinTab.key]);
        expect(restored.groupsById['group:2']?.tabKeys).toEqual(['file:src/neighbor.ts']);
        expect(restored.root).toEqual(beforeViewerSelection.root);
        expect(restored.focusedGroupId).toBe('group:2');
        expect(restored.maximizedGroupId).toBe('group:2');
        expect(restored.tabState).toEqual({});
    });

    it('keeps the original builtin rehydration fallback when one selected plugin viewer replaces another', () => {
        const builtinTab = {
            key: 'file:README.txt',
            kind: 'workspace-file',
            title: 'README.txt',
            subtitle: null,
            resource: { filePath: 'README.txt' },
            isPinned: false,
            isPreview: true,
        };
        const firstPluginViewerTab = {
            key: 'plugin-details:plugin.preview:text-viewer',
            kind: 'pluginDetailsDestination',
            title: 'Text preview',
            subtitle: null,
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'plugin.preview', localId: 'text-viewer' },
            },
        };
        const secondPluginViewerTab = {
            key: 'plugin-details:plugin.preview:markdown-viewer',
            kind: 'pluginDetailsDestination',
            title: 'Markdown preview',
            subtitle: null,
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'plugin.preview', localId: 'markdown-viewer' },
            },
        };

        const openedBuiltin = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: builtinTab,
            openAs: 'preview',
        });
        const firstSelectedViewer = applyReplaceDetailsTab(openedBuiltin, {
            tabKey: builtinTab.key,
            tab: firstPluginViewerTab,
            openAs: 'preview',
            restoreSourceOnRehydrate: true,
        });
        const secondSelectedViewer = applyReplaceDetailsTab(firstSelectedViewer, {
            tabKey: firstPluginViewerTab.key,
            tab: secondPluginViewerTab,
            openAs: 'preview',
            restoreSourceOnRehydrate: true,
        });

        const serialized = serializeDetailsWorkspaceState(secondSelectedViewer);
        expect(serialized.tabsByKey).toEqual({ [builtinTab.key]: builtinTab });
        expect(serialized.groupsById['group:1']?.tabKeys).toEqual([builtinTab.key]);
        expect(serialized.tabState).toEqual({});
        expect(JSON.stringify(serialized)).not.toContain('plugin.preview');

        expect(migrateLegacyDetailsWorkspaceState(serialized).tabsByKey).toEqual({
            [builtinTab.key]: builtinTab,
        });

        const returnedToBuiltin = applyReplaceDetailsTab(secondSelectedViewer, {
            tabKey: secondPluginViewerTab.key,
            tab: builtinTab,
            openAs: 'preview',
        });
        expect(returnedToBuiltin.tabState).toEqual({});
    });

    it('drops the one-shot rehydration marker when the selected plugin viewer returns to its builtin tab', () => {
        const builtinTab = createFileTab('README.txt');
        const selectedPluginViewerTab = {
            key: 'plugin-details:plugin.preview:text-viewer',
            kind: 'pluginDetailsDestination',
            title: 'Text preview',
            subtitle: null,
            resource: {
                kind: 'pluginDetailsDestination',
                destination: { pluginId: 'plugin.preview', localId: 'text-viewer' },
            },
        };
        const openedBuiltin = applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab: builtinTab,
            openAs: 'pinned',
        });
        const selectedPluginViewer = applyReplaceDetailsTab(openedBuiltin, {
            tabKey: builtinTab.key,
            tab: selectedPluginViewerTab,
            openAs: 'pinned',
            restoreSourceOnRehydrate: true,
        });

        const returnedToBuiltin = applyReplaceDetailsTab(selectedPluginViewer, {
            tabKey: selectedPluginViewerTab.key,
            tab: builtinTab,
            openAs: 'pinned',
        });

        expect(returnedToBuiltin.tabState).toEqual({});
        const serialized = serializeDetailsWorkspaceState(returnedToBuiltin);
        expect(serialized.tabState).toEqual({});
        expect(serializeDetailsWorkspaceState(migrateLegacyDetailsWorkspaceState(serialized)).tabState).toEqual({});
    });

    it('persists a details overlay as qualified selection only and drops a hostile overlay without discarding retained groups', () => {
        const tab = createFileTab('README.md');
        const opened = applyOpenDetailsOverlay(applyOpenDetailsTab(createEmptyPaneDetailsState(), {
            tab,
            openAs: 'pinned',
        }), {
            destination: {
                pluginId: 'com.example.viewer',
                localId: 'activity-log',
            },
            instanceKey: 'activity:run-1',
        });

        const serialized = serializeDetailsWorkspaceState(opened);
        expect(serialized.overlay).toEqual({
            destination: {
                pluginId: 'com.example.viewer',
                localId: 'activity-log',
            },
            instanceKey: 'activity:run-1',
            returnFocusedGroupId: 'group:1',
            returnMaximizedGroupId: null,
            returnIsOpen: true,
        });

        const restored = migrateLegacyDetailsWorkspaceState({
            ...serialized,
            overlay: {
                ...serialized.overlay,
                // Launch input has no persistence owner: invalidating it drops
                // only the overlay and retains the underlying workspace.
                launchInput: { opaqueReference: 'file:README.md' },
            },
        });

        expect(restored.overlay).toBeNull();
        expect(restored.root).toEqual(serialized.root);
        expect(restored.groupsById['group:1']?.tabKeys).toEqual([tab.key]);
        expect(restored.tabsByKey[tab.key]).toMatchObject({ resource: tab.resource });
    });
});
