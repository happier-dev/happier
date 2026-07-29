import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dropdownMenuSpy = vi.fn();
const resolveWorkspaceFaviconMock = vi.hoisted(() => vi.fn());
const setSessionFolderViewMode = vi.fn();
let platformOs: 'ios' | 'web' = 'ios';
let sessionFolderViewMode: 'off' | 'tree' = 'off';
let sessionFoldersFeatureEnabled = true;
type DropdownTriggerParams = {
    open: boolean;
    toggle: ReturnType<typeof vi.fn>;
    openMenu: ReturnType<typeof vi.fn>;
    closeMenu: ReturnType<typeof vi.fn>;
    selectedItem: unknown;
};

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const triggerParams: DropdownTriggerParams = {
            open: Boolean(props.open),
            toggle: vi.fn(),
            openMenu: vi.fn(),
            closeMenu: vi.fn(),
            selectedItem: null,
        };
        dropdownMenuSpy({ ...props, triggerParams });
        const triggerResult = typeof props.trigger === 'function'
            ? props.trigger(triggerParams)
            : null;
        return React.createElement('DropdownMenu', props, triggerResult);
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/sync/ops/workspaceFavicon', () => ({
    resolveWorkspaceFavicon: resolveWorkspaceFaviconMock,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.folders'
        ? sessionFoldersFeatureEnabled
        : true,
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value[platformOs] ?? value.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                textSecondary: '#666',
                header: { tint: '#000' },
                status: { error: '#f00' },
                overlay: { text: '#fff' },
            },
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: ((key: string) => {
                    if (key === 'sessionFolderViewModeV1') return [sessionFolderViewMode, setSessionFolderViewMode];
                    if (key === 'sessionListOrderingModeV1') return ['custom', vi.fn()];
                    if (key === 'sessionListSectionModeV1') return ['activity', vi.fn()];
                    if (key === 'sessionListActiveGroupingV1') return ['project', vi.fn()];
                    if (key === 'sessionListInactiveGroupingV1') return ['date', vi.fn()];
                    if (key === 'hideInactiveSessions') return [false, vi.fn()];
                    return [null, vi.fn()];
                }) as any,
            },
        });
    },
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function findStyledTextNode(root: any) {
    return root.findAll((node: any) =>
        typeof node.props?.children === 'string'
        && (typeof node.props?.style === 'object' || Array.isArray(node.props?.style))
    )[0] ?? null;
}

function childTreeContainsPressable(node: any): boolean {
    return (
        Array.isArray(node.children)
        && node.children.some((child: any) => (
            child
            && typeof child === 'object'
            && (
                child.type === 'Pressable'
                || childTreeContainsPressable(child)
            )
        ))
    );
}

describe('ProjectGroupHeader menu items', () => {
    beforeEach(() => {
        resolveWorkspaceFaviconMock.mockReset();
        resolveWorkspaceFaviconMock.mockResolvedValue({ status: 'missing' });
    });

    afterEach(() => {
        standardCleanup();
        dropdownMenuSpy.mockClear();
        setSessionFolderViewMode.mockClear();
        platformOs = 'ios';
        sessionFolderViewMode = 'off';
        sessionFoldersFeatureEnabled = true;
    });

    it('reuses the same menu item array when rerendered with identical scope values', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');
        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'project:repo',
            workspaceKey: 'legacy_repo',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
        } as const;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={item as any}
                hasMultipleMachines={true}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        const firstMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(firstMenuProps?.items).toBeTruthy();

        await act(async () => {
            screen.tree.update(
                <ProjectGroupHeader
                    item={{
                        ...item,
                        workspaceScopeHint: {
                            serverId: 'server_a',
                            machineId: 'machine_a',
                            rootPath: '/repo',
                        },
                    } as any}
                    hasMultipleMachines={true}
                    displayTitle="Important Repo"
                    hasCustomLabel={true}
                    canOpenProject={true}
                    onOpenProject={vi.fn()}
                    onCreateSession={vi.fn()}
                    onAddFolder={vi.fn()}
                    onRename={vi.fn()}
                    onReset={vi.fn()}
                    collapsed={false}
                    onToggleCollapse={vi.fn()}
                />,
            );
        });

        const secondMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(secondMenuProps?.items).toBe(firstMenuProps?.items);
        expect(secondMenuProps?.placement).toBe('bottom');
        expect(secondMenuProps?.popoverAnchorAlign).toBe('end');
        expect(secondMenuProps?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'openProject' }),
            expect.objectContaining({ id: 'rename' }),
            expect.objectContaining({ id: 'reset' }),
        ]));
    });

    it('exposes a stable project header selector keyed by group key', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:s1:active:project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={false}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        expect(screen.findByProps({ testID: 'session-list-project-header:server:s1:active:project:repo' })).toBeTruthy();
    });

    it('keeps the project-group menu trigger stopPropagation bound to the original event', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');
        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'project:repo',
            workspaceKey: 'legacy_repo',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
        } as const;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={item as any}
                hasMultipleMachines={true}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        const trigger = screen.findByProps({ accessibilityLabel: 'common.moreActions' });
        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as { triggerParams?: DropdownTriggerParams } | undefined;
        const event = {
            nativeEvent: {},
            stopPropagation(this: { nativeEvent?: unknown }) {
                if (!this?.nativeEvent) {
                    throw new Error('stopPropagation lost event binding');
                }
            },
        };

        await act(async () => {
            trigger.props.onPress(event);
        });

        expect(latestMenuProps?.triggerParams?.toggle).toHaveBeenCalledTimes(1);
    });

    it('anchors the ordering menu below the trigger', async () => {
        const { CollapsibleSectionHeader } = await import('./sessionListChrome');

        await renderScreen(
            <CollapsibleSectionHeader
                title="Today"
                collapsed={false}
                onPress={vi.fn()}
                showOrderingMenu={true}
            />,
        );

        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.placement).toBe('bottom');
        expect(latestMenuProps?.popoverAnchorAlign).toBe('end');
    });

    it('keeps the real collapsible header root mounted when measurement activates', async () => {
        const { CollapsibleSectionHeader } = await import('./sessionListChrome');
        const measurementRef = React.createRef<any>();
        const onLayout = vi.fn();
        const screen = await renderScreen(
            <CollapsibleSectionHeader
                title="Needs attention"
                collapsed={false}
                onPress={vi.fn()}
                rootMeasurement={{
                    active: false,
                    ref: measurementRef,
                    onLayout,
                }}
            />,
        );
        const rootBeforeActivation = screen.findByType('Pressable');

        await act(async () => {
            screen.tree.update(
                <CollapsibleSectionHeader
                    title="Needs attention"
                    collapsed={false}
                    onPress={vi.fn()}
                    rootMeasurement={{
                        active: true,
                        ref: measurementRef,
                        onLayout,
                        style: { zIndex: 1 },
                    }}
                />,
            );
        });

        expect(screen.findByType('Pressable')).toBe(rootBeforeActivation);
    });

    it('adds the folder tree toggle to the existing ordering menu', async () => {
        const { CollapsibleSectionHeader } = await import('./sessionListChrome');

        await renderScreen(
            <CollapsibleSectionHeader
                title="Active"
                collapsed={false}
                onPress={vi.fn()}
                showOrderingMenu={true}
            />,
        );

        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'sessionFolderViewModeTree', testID: 'session-folder-view-toggle' }),
        ]));

        latestMenuProps?.onSelect?.('sessionFolderViewModeTree');
        expect(setSessionFolderViewMode).toHaveBeenCalledWith('tree');
    });

    it('routes folder row press, collapse, and menu actions separately', async () => {
        const onFocus = vi.fn();
        const onToggleCollapse = vi.fn();
        const onNewSession = vi.fn();
        const onAddSubfolder = vi.fn();
        const onRename = vi.fn();
        const onDelete = vi.fn();
        const onMove = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();
        const { FolderGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <FolderGroupHeader
                title="Planning"
                depth={1}
                collapsed={false}
                item={{
                    type: 'header',
                    title: 'Planning',
                    headerKind: 'folder',
                    folderId: 'folder_planning',
                    folderDepth: 1,
                    serverId: 'server_a',
                    workspace: {
                        t: 'workspaceRef',
                        serverId: 'server_a',
                        workspaceRefId: 'workspace_a',
                    },
                }}
                onPress={onFocus}
                onToggleCollapse={onToggleCollapse}
                onNewSession={onNewSession}
                onAddSubfolder={onAddSubfolder}
                onRename={onRename}
                onDelete={onDelete}
                onMove={onMove}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />,
        );

        const row = screen.findByProps({ testID: 'session-folder-header-folder_planning' });
        expect(row.props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ paddingLeft: 32 }),
        ]));
        expect(screen.findByProps({ testID: 'session-folder-reorder-handle-folder_planning' })).toBeTruthy();
        const focusButton = screen.findByProps({ testID: 'session-folder-header-folder_planning-focus' });
        await act(async () => {
            focusButton.props.onPress();
        });
        expect(onFocus).toHaveBeenCalledTimes(1);
        expect(onToggleCollapse).not.toHaveBeenCalled();

        const collapseButton = screen.findByProps({ testID: 'session-folder-collapse-folder_planning' });
        await act(async () => {
            collapseButton.props.onPress({ stopPropagation: vi.fn() });
        });
        expect(onToggleCollapse).toHaveBeenCalledTimes(1);

        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'new-session' }),
            expect.objectContaining({ id: 'add-subfolder' }),
            expect.objectContaining({ id: 'move' }),
            expect.objectContaining({ id: 'rename' }),
            expect.objectContaining({ id: 'delete' }),
        ]));

        await act(async () => {
            await latestMenuProps?.onSelect?.('add-subfolder');
            await latestMenuProps?.onSelect?.('move');
            await latestMenuProps?.onSelect?.('rename');
            await latestMenuProps?.onSelect?.('delete');
            await latestMenuProps?.onSelect?.('new-session');
        });
        expect(onAddSubfolder).toHaveBeenCalledTimes(1);
        expect(onMove).toHaveBeenCalledTimes(1);
        expect(onRename).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(onNewSession).toHaveBeenCalledTimes(1);

        expect(focusButton.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveUp' }),
            expect.objectContaining({ name: 'moveDown' }),
            expect.objectContaining({ name: 'moveToFolder' }),
            expect.objectContaining({ name: 'moveToWorkspaceRoot' }),
        ]));

        await act(async () => {
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } });
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } });
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToFolder' } });
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveToWorkspaceRoot' } });
        });
        expect(onMoveUp).toHaveBeenCalledTimes(1);
        expect(onMoveDown).toHaveBeenCalledTimes(1);
        expect(onMove).toHaveBeenCalledTimes(2);
        expect(onMoveToWorkspaceRoot).toHaveBeenCalledTimes(1);
    });

    it('keeps folder drop target registration separate from row-local outline styling', async () => {
        platformOs = 'web';
        const { FolderGroupHeader } = await import('./sessionListChrome');

        const renderHeader = () => (
            <FolderGroupHeader
                title="Planning"
                depth={0}
                collapsed={false}
                item={{
                    type: 'header',
                    title: 'Planning',
                    headerKind: 'folder',
                    folderId: 'folder_planning',
                    folderDepth: 0,
                    serverId: 'server_a',
                    workspace: {
                        t: 'workspaceRef',
                        serverId: 'server_a',
                        workspaceRefId: 'workspace_a',
                    },
                }}
                onPress={vi.fn()}
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />
        );

        const screen = await renderScreen(renderHeader());

        const row = screen.findByTestId('session-folder-header-folder_planning');
        expect(row).not.toBeNull();
        if (!row) throw new Error('expected folder header row');
        expect(flattenStyle(row.props.style).borderWidth).toBeUndefined();

        await act(async () => {
            row.parent?.props.onPointerEnter?.();
        });

        expect(flattenStyle(row.props.style).borderWidth).toBeUndefined();
    });

    it('does not nest folder header pressable controls inside another pressable on web', async () => {
        const { FolderGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <FolderGroupHeader
                title="Planning"
                depth={1}
                collapsed={false}
                item={{
                    type: 'header',
                    title: 'Planning',
                    headerKind: 'folder',
                    folderId: 'folder_planning',
                    folderDepth: 1,
                    serverId: 'server_a',
                    workspace: {
                        t: 'workspaceRef',
                        serverId: 'server_a',
                        workspaceRefId: 'workspace_a',
                    },
                }}
                onPress={vi.fn()}
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                onAddSubfolder={vi.fn()}
                onRename={vi.fn()}
                onDelete={vi.fn()}
            />,
        );

        for (const pressable of screen.findAllByType('Pressable' as never)) {
            expect(childTreeContainsPressable(pressable)).toBe(false);
        }
    });

    it('does not nest project header pressable controls inside another pressable on web', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        for (const pressable of screen.findAllByType('Pressable' as never)) {
            expect(childTreeContainsPressable(pressable)).toBe(false);
        }
    });

    it('renders focused folder breadcrumbs with root and folder targets', async () => {
        const onClear = vi.fn();
        const onSelectFolder = vi.fn();
        const { SessionFolderFocusBreadcrumbs } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <SessionFolderFocusBreadcrumbs
                breadcrumbs={[
                    {
                        id: 'root',
                        name: 'Root',
                        parentId: null,
                        workspace: { t: 'workspaceRef', serverId: 'server_a', workspaceRefId: 'workspace_a' },
                        renderWorkspaceKey: 'workspace_a',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    {
                        id: 'child',
                        name: 'Child',
                        parentId: 'root',
                        workspace: { t: 'workspaceRef', serverId: 'server_a', workspaceRefId: 'workspace_a' },
                        renderWorkspaceKey: 'workspace_a',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ]}
                onClear={onClear}
                onSelectFolder={onSelectFolder}
            />,
        );

        await act(async () => {
            screen.findByProps({ testID: 'session-folder-breadcrumb-root' }).props.onPress();
            screen.findByProps({ testID: 'session-folder-breadcrumb-root' }).props.onPress();
            screen.findByProps({ testID: 'session-folder-breadcrumb-folder-child' }).props.onPress();
        });

        expect(onClear).toHaveBeenCalledTimes(2);
        expect(onSelectFolder).toHaveBeenCalledWith('child');
    });

    it('hides folder actions while the sessions.folders gate is disabled', async () => {
        sessionFoldersFeatureEnabled = false;
        const { CollapsibleSectionHeader, ProjectGroupHeader } = await import('./sessionListChrome');

        await renderScreen(
            <CollapsibleSectionHeader
                title="Active"
                collapsed={false}
                onPress={vi.fn()}
                showOrderingMenu={true}
            />,
        );

        const orderingMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(orderingMenuProps?.items).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'sessionFolderViewModeTree' }),
        ]));

        await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={false}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        const projectMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(projectMenuProps?.items).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'addFolder' }),
        ]));
    });

    it('keeps the project add action visible while hover-only controls appear on demand', async () => {
        platformOs = 'web';
        const onCreateSession = vi.fn();
        const { ProjectGroupHeader } = await import('./sessionListChrome');

        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'project:repo',
            workspaceKey: 'legacy_repo',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
        } as const;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={item as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={onCreateSession}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        const pressables = screen.root.findAllByType('Pressable');
        const rowPressable = pressables[0];
        const addButton = screen.findByProps({ accessibilityLabel: 'machine.launchNewSessionInDirectory' });
        const chevronWrapper = rowPressable.findAllByType('Ionicons')[0]?.parent;

        expect(addButton).toBeTruthy();
        expect(chevronWrapper?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 0 })]));
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(0);
        expect(screen.root.findAllByProps({ testID: 'session-workspace-reorder-handle:project:repo' })).toHaveLength(0);

        await act(async () => {
            addButton.props.onPress();
        });

        expect(onCreateSession).toHaveBeenCalledTimes(1);

        await act(async () => {
            rowPressable.props.onHoverIn?.();
        });

        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        const reorderHandle = screen.root.findAllByProps({ testID: 'session-workspace-reorder-handle:project:repo' })[0];
        expect(reorderHandle).toBeTruthy();
        expect(typeof reorderHandle.props.onHoverIn).toBe('function');
        expect(typeof reorderHandle.props.onHoverOut).toBe('function');
        expect(rowPressable.findAllByType('Ionicons')[0]?.parent?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 1 })]));
        const menuTrigger = screen.findByProps({ accessibilityLabel: 'common.moreActions' });

        await act(async () => {
            reorderHandle.props.onHoverIn?.();
            rowPressable.props.onHoverOut?.();
        });

        expect(screen.root.findAllByProps({ testID: 'session-workspace-reorder-handle:project:repo' })).toHaveLength(1);

        await act(async () => {
            menuTrigger.props.onHoverIn?.();
            rowPressable.props.onHoverOut?.();
        });

        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        expect(screen.findByProps({ accessibilityLabel: 'common.moreActions' })).toBeTruthy();

        await act(async () => {
            menuTrigger.props.onHoverOut?.();
            rowPressable.props.onHoverOut?.();
        });

        expect(rowPressable.findAllByType('Ionicons')[0]?.parent?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 0 })]));

        const collapsedScreen = await renderScreen(
            <ProjectGroupHeader
                item={item as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={true}
                onToggleCollapse={vi.fn()}
            />,
        );

        expect(collapsedScreen.root.findAllByType('Ionicons')[0]?.parent?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 1 })]));
    });

    it('shows detected workspace favicons on project headers when enabled', async () => {
        resolveWorkspaceFaviconMock.mockResolvedValueOnce({
            status: 'found',
            uri: 'data:image/svg+xml;base64,PHN2Zy8+',
            relativePath: 'public/favicon.svg',
        });
        const { ProjectGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                } as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                workspaceFaviconsEnabled={true}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(resolveWorkspaceFaviconMock).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            serverId: 'server_a',
            machineId: 'machine_a',
            workspacePath: '/repo',
        }));
        const images = screen.root.findAllByType('Image' as any);
        expect(images).toHaveLength(1);
        expect(images[0].props.source).toEqual({ uri: 'data:image/svg+xml;base64,PHN2Zy8+' });
        expect(screen.root.findByProps({ testID: 'session-list-workspace-favicon' }).props.style).toEqual(expect.objectContaining({
            width: 16,
            minWidth: 16,
            height: 16,
            flexShrink: 0,
        }));
        expect(images[0].props.style).toEqual(expect.objectContaining({
            width: 16,
            height: 16,
        }));
    });

    it('hides machine subtitles when workspace machine subtitles are disabled', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    subtitle: 'leeroy-mbp',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                } as any}
                hasMultipleMachines={true}
                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                workspaceMachineSubtitlesEnabled={false}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).toContain('Important Repo');
        expect(screen.getTextContent()).not.toContain('leeroy-mbp');
    });

    it('uses the secondary header typography tier for date headers', async () => {
        platformOs = 'web';
        const { CollapsibleSectionHeader, ProjectGroupHeader } = await import('./sessionListChrome');

        const activeScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Active"
                collapsed={false}
                onPress={vi.fn()}
                showOrderingMenu={true}
            />,
        );
        const dateScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Yesterday"
                collapsed={false}
                onPress={vi.fn()}
            />,
        );
        const projectScreen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine_a',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                displayTitle="Important Repo"
                hasCustomLabel={false}
                canOpenProject={false}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );

        const activeTextStyle = flattenStyle(findStyledTextNode(activeScreen.root)?.props?.style);
        const dateTextStyle = flattenStyle(findStyledTextNode(dateScreen.root)?.props?.style);
        const projectTextStyle = flattenStyle(findStyledTextNode(projectScreen.root)?.props?.style);

        expect(Number(activeTextStyle.fontSize)).toBeGreaterThan(Number(dateTextStyle.fontSize));
        expect(dateTextStyle.fontSize).toBe(projectTextStyle.fontSize);
    });
});
