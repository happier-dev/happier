import React from 'react';
import { StyleSheet } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_SETTINGS } from '@/components/settings/session/sessionSettings';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dropdownMenuSpy = vi.fn();
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const setSessionFolderViewMode = vi.fn();
const applySettings = vi.hoisted(() => vi.fn());
const setSettingSpy = vi.hoisted(() => vi.fn(async () => true));
let platformOs: 'ios' | 'web' = 'ios';
let sessionFolderViewMode: 'off' | 'tree' = 'off';
let sessionFoldersFeatureEnabled = true;
const featureDecisionScopes = vi.hoisted(() => [] as unknown[]);

// Real storage imports shared UI with direct Expo random consumers. Keep the
// native SDK boundary Node-safe using the repository's real OS-crypto adapters.
vi.mock('expo-crypto', async () => {
    const [randomBytes, uuid] = await Promise.all([
        import('@/platform/cryptoRandom.node'),
        import('@/platform/randomUUID.node'),
    ]);
    return { ...randomBytes, ...uuid };
});

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

// The machine RPC is the boundary; the shared result owner the header observes stays real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

// The declared-setting Action writer is the owner of View option writes (its own tests admit and persist them);
// this test pins which declared setting and value the menu hands it.
vi.mock('@/components/settings/shell/useSettingActionFeedback', () => ({
    useSettingActionFeedback: () => ({ setSetting: setSettingSpy, isCurrent: () => true }),
}));

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettings,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string, scope?: unknown) => {
        if (featureId === 'sessions.folders') featureDecisionScopes.push(scope);
        return featureId === 'sessions.folders' ? sessionFoldersFeatureEnabled : true;
    },
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

// The real presentation layer reads the platform mocks while its module graph
// loads. Configure those first and finish loading before any renderer/test starts.
const { renderScreen, standardCleanup } = await import('@/dev/testkit');
const { HappierPressable } = await import('@happier-dev/plugin-ui/presentation');
const { ProjectGroupHeader, CollapsibleSectionHeader, SessionSectionHeader } = await import('./sessionListChrome');
const { clearWorkspaceFaviconCacheForTests } = await import('@/sync/ops/workspaceFavicon');
const { layoutHitArea, hitAreaOverlap } = await import('@/dev/testkit/harness/hitFrameReach');
const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');

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
        machineRpcWithServerScopeMock.mockReset();
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, found: false });
        clearWorkspaceFaviconCacheForTests();
    });

    afterEach(() => {
        standardCleanup();
        dropdownMenuSpy.mockClear();
        setSessionFolderViewMode.mockClear();
        applySettings.mockClear();
        setSettingSpy.mockClear();
        platformOs = 'ios';
        sessionFolderViewMode = 'off';
        sessionFoldersFeatureEnabled = true;
        featureDecisionScopes.length = 0;
    });

    it('offers New session and Add folder for Chats without workspace rename or project actions', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');
        const onCreateSession = vi.fn();
        const onAddFolder = vi.fn();
        const screen = await renderScreen(<ProjectGroupHeader
            item={{
                type: 'header', title: 'Chats', headerKind: 'project', groupKey: 'chats-menu',
                workspace: { t: 'managedSessions', serverId: 'server-a', machineId: 'machine-a' },
            }}
 displayTitle="Chats" hasCustomLabel={false} canOpenProject={false}
            onCreateSession={onCreateSession} onAddFolder={onAddFolder}
            onOpenProject={vi.fn()} onRename={vi.fn()} onReset={vi.fn()}
            collapsed={false} onToggleCollapse={vi.fn()}
        />);
        const menu = dropdownMenuSpy.mock.calls.at(-1)?.[0];
        expect(menu?.items.map((item: { id: string }) => item.id)).toEqual(['addFolder']);
        await act(async () => { menu.onSelect('addFolder'); });
        expect(onAddFolder).toHaveBeenCalledOnce();
        const create = screen.tree.root.findAll((node) => node.props.accessibilityLabel === 'newSession.title');
        expect(create).not.toHaveLength(0);
        await act(async () => { create[0].props.onPress({ stopPropagation() {} }); });
        expect(onCreateSession).toHaveBeenCalledOnce();
    });

    it('gives the header actions a finger-sized hit area that never overlaps its neighbour or reaches past the column edge', async () => {
        const screen = await renderScreen(
            <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
                <ProjectGroupHeader
                    item={{
                        type: 'header', title: 'Chats', headerKind: 'project', groupKey: 'chats-touch',
                        workspace: { t: 'managedSessions', serverId: 'server-a', machineId: 'machine-a' },
                    }}
 displayTitle="Chats" hasCustomLabel={false} canOpenProject={false}
                    onCreateSession={vi.fn()} onAddFolder={vi.fn()}
                    onOpenProject={vi.fn()} onRename={vi.fn()} onReset={vi.fn()}
                    collapsed={false} onToggleCollapse={vi.fn()}
                />
            </HappierUiPlatformProvider>,
        );
        const host = (label: string) => () => screen.tree.root.findAll(
            (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label && typeof node.props.onLayout === 'function',
        )[0];
        // The glyph buttons draw 18x14, 4 px apart (`groupHeaderActionButton`); each takes half the gap toward its neighbour.
        const menu = await layoutHitArea(host('common.moreActions'), { width: 18, height: 14 });
        const create = await layoutHitArea(host('newSession.title'), { width: 18, height: 14 });
        expect(menu.drawn).toEqual({ width: 18, height: 14 });
        expect(menu.height).toBeGreaterThanOrEqual(24);
        expect(hitAreaOverlap(menu, create, { axis: 'horizontal', gap: 4 })).toBe(0);
        expect(menu.insets.right).toBe(0);
        expect(create.insets.left).toBe(4);
        expect(create.insets.right).toBe(0);
    });

    it('sets and removes the project colour beside Rename and marks a coloured project with a dot', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');
        const onSetColor = vi.fn();
        const item = {
            type: 'header', title: '/repo', headerKind: 'project', groupKey: 'project:repo', projectKey: 'project-repo',
            workspaceKey: 'legacy_repo', workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        } as const;
        const render = (color: { kind: 'accent'; key: 'blue' } | null) => renderScreen(<ProjectGroupHeader
            item={item as any} displayTitle="Repo" hasCustomLabel={false} canOpenProject={false}
            onOpenProject={vi.fn()} onCreateSession={vi.fn()} onAddFolder={vi.fn()} onRename={vi.fn()} onReset={vi.fn()}
            collapsed={false} onToggleCollapse={vi.fn()}
            appearanceColor={color} appearanceServerId="server_a" onSetColor={onSetColor}
        />);

        const plain = await render(null);
        expect(plain.findByTestId('session-workspace-color:project:repo')).toBeNull();
        await plain.unmount();

        const screen = await render({ kind: 'accent', key: 'blue' });
        expect(screen.findByTestId('session-workspace-color:project:repo')).not.toBeNull();
        const menu = dropdownMenuSpy.mock.calls.at(-1)?.[0];
        const ids = (menu.items as Array<{ id: string }>).map((entry) => entry.id);
        const colorIndex = ids.indexOf('workspace-color');
        expect(colorIndex).toBe(ids.indexOf('rename') + 1);
        const submenu = menu.items[colorIndex].submenu.items as any[];
        const swatches = submenu.filter((entry) => entry.swatch && !entry.swatch.empty);
        expect(swatches).toHaveLength(7);
        expect(swatches.filter((entry) => entry.checked)).toHaveLength(1);
        await act(async () => {
            menu.onSelect(swatches.at(-1).id);
            menu.onSelect(submenu.find((entry) => entry.swatch?.empty).id);
            await Promise.resolve();
        });
        expect(onSetColor.mock.calls).toEqual([[{ kind: 'accent', key: 'purple' }], [null]]);
    });

    it('reuses the same menu item array when rerendered with identical scope values', async () => {
        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'project:repo',
            projectKey: 'project-repo',
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

    it('anchors View options below the trigger', async () => {
        const { SessionListViewOptionsButton } = await import('./sessionListChrome');

        const screen = await renderScreen(
            <SessionListViewOptionsButton />,
        );

        let latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.placement).toBe('bottom');
        expect(latestMenuProps?.popoverAnchorAlign).toBe('end');
        // The trigger is the shared IconButton: it announces a menu and whether it is open.
        const trigger = () => screen.root.findAllByProps({ accessibilityLabel: 'sessionsList.viewOptions' })[0];
        expect(trigger()?.props.expanded).toBe(false);
        expect(trigger()?.props.hasPopup).toBe('menu');
        await act(async () => {
            latestMenuProps.onOpenChange(true);
        });
        latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps.open).toBe(true);
        expect(trigger()?.props.expanded).toBe(true);
    });

    it('offers what the list shows and where Needs you and Working sit, written through the shared writer', async () => {
        const { SessionListViewOptionsButton } = await import('./sessionListChrome');

        await renderScreen(
            <SessionListViewOptionsButton />,
        );

        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'layout:projects' }),
            expect.objectContaining({ id: 'layout:recent_activity' }),
            expect.objectContaining({ id: 'attention:both' }),
            expect.objectContaining({ id: 'attention:top' }),
            expect.objectContaining({ id: 'attention:inPlace' }),
        ]));
        expect(latestMenuProps?.items.map((item: { id: string }) => item.id)).not.toContain('folderDisplay');

        latestMenuProps?.onSelect?.('attention:top');
        await vi.waitFor(() => expect(setSettingSpy).toHaveBeenCalledWith(SESSION_SETTINGS.settings.attentionPromotion, 'top'));
    });

    it('offers status words as a row choice written to the one Account setting (P4 statusWords)', async () => {
        const { SessionListViewOptionsButton } = await import('./sessionListChrome');
        await renderScreen(<SessionListViewOptionsButton />);
        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        const item = latestMenuProps?.items.find((entry: { id: string }) => entry.id.startsWith('statusWords:'));
        // Off by default, so choosing it turns words on.
        expect(item).toEqual(expect.objectContaining({ id: 'statusWords:true', checked: false }));
        latestMenuProps?.onSelect?.('statusWords:true');
        await vi.waitFor(() => expect(setSettingSpy).toHaveBeenCalledWith(SESSION_SETTINGS.settings.statusWords, true));
    });

    it('routes section disclosure and offers the section operations, not folder-tree ones (P5 §6)', async () => {
        const onToggleCollapse = vi.fn();
        const onNewSession = vi.fn();
        const onRename = vi.fn();
        const onChangeIcon = vi.fn();
        const onRemove = vi.fn();
        const onArchiveAll = vi.fn();
        const onMove = vi.fn();
        const onMoveToWorkspaceRoot = vi.fn();
        const onMoveUp = vi.fn();
        const onMoveDown = vi.fn();

        const screen = await renderScreen(
            <SessionSectionHeader
                title="Launch 0.3"
                icon="rocket"
                memberCount={4}
                collapsed={false}
                item={{
                    type: 'header',
                    title: 'Launch 0.3',
                    headerKind: 'folder',
                    folderId: 'folder_planning',
                    folderDepth: 0,
                    serverId: 'server_a',
                }}
                onToggleCollapse={onToggleCollapse}
                onNewSession={onNewSession}
                onRename={onRename}
                onChangeIcon={onChangeIcon}
                onRemove={onRemove}
                onArchiveAll={onArchiveAll}
                onMove={onMove}
                onMoveToWorkspaceRoot={onMoveToWorkspaceRoot}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
            />,
        );

        // Sections are flat Account filing: the label sits on the column's text edge, led by its own icon and count.
        const row = screen.findHostByTestId('session-folder-header-folder_planning');
        expect(StyleSheet.flatten(row?.props.style)).toEqual(expect.objectContaining({ paddingLeft: 22 }));
        expect(screen.findAllByProps({ name: 'rocket' }).length).toBeGreaterThan(0);
        expect(screen.getTextContent()).toContain('4');
        const focusButton = screen.findByProps({ testID: 'session-folder-header-folder_planning:open' });
        await act(async () => {
            focusButton.props.onPress();
        });
        expect(onToggleCollapse).toHaveBeenCalledTimes(1);

        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        const ids = (latestMenuProps?.items ?? []).map((item: any) => item.id);
        // Lab `clsections:custom` menu: the edits, then Archive all and Remove under one hairline.
        expect(ids).toEqual(['rename', 'icon', 'new-session', 'archive-all', 'remove']);
        expect(latestMenuProps.items.find((item: any) => item.id === 'archive-all'))
            .toEqual(expect.objectContaining({ category: 'remove', disabled: false }));
        const iconItem = latestMenuProps.items.find((item: any) => item.id === 'icon');
        expect(iconItem.submenu.items).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'icon:rocket', checked: true }),
            expect.objectContaining({ id: 'icon:eye', checked: false }),
        ]));
        expect(latestMenuProps.items.find((item: any) => item.id === 'remove'))
            .toEqual(expect.objectContaining({ subtitle: 'sessionsList.removeSectionDetail' }));

        await act(async () => {
            await latestMenuProps?.onSelect?.('rename');
            await latestMenuProps?.onSelect?.('icon:eye');
            await latestMenuProps?.onSelect?.('remove');
            await latestMenuProps?.onSelect?.('new-session');
            await latestMenuProps?.onSelect?.('archive-all');
        });
        expect(onArchiveAll).toHaveBeenCalledTimes(1);
        expect(onRename).toHaveBeenCalledTimes(1);
        expect(onChangeIcon).toHaveBeenCalledWith('eye');
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(onNewSession).toHaveBeenCalledTimes(1);

        expect(focusButton.props.accessibilityActions).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'moveUp' }),
            expect.objectContaining({ name: 'moveDown' }),
        ]));
        await act(async () => {
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } });
            focusButton.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } });
        });
        expect(onMoveUp).toHaveBeenCalledTimes(1);
        expect(onMoveDown).toHaveBeenCalledTimes(1);
    });

    it('says where sessions go only when the section is proven empty (P5 §4 Sections)', async () => {
        const header = (memberCount: number | undefined) => (
            <SessionSectionHeader
                title="Payments"
                icon={null}
                memberCount={memberCount}
                collapsed={false}
                item={{ type: 'header', title: 'Payments', headerKind: 'folder', folderId: 'folder_pay', folderDepth: 0, serverId: 'server_a' }}
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                onRename={vi.fn()}
                onChangeIcon={vi.fn()}
                onRemove={vi.fn()}
                onArchiveAll={vi.fn()}
            />
        );
        const empty = await renderScreen(header(0));
        expect(empty.getTextContent()).toContain('sessionsList.sectionDropHint');
        // Nothing to archive in a proven-empty section.
        expect((dropdownMenuSpy.mock.calls.at(-1)?.[0] as any).items.find((item: any) => item.id === 'archive-all'))
            .toEqual(expect.objectContaining({ disabled: true }));
        standardCleanup();
        // Unknown membership is not zero: no hint and no count.
        const unknown = await renderScreen(header(undefined));
        expect(unknown.getTextContent()).not.toContain('sessionsList.sectionDropHint');
    });

    it.each([
        { reason: 'account_key_unavailable', label: 'sessionsList.lockedSection' },
        { reason: 'invalid_stored_display', label: 'sessionsList.unavailableSection' },
    ] as const)('renders an unreadable Section state label and separate membership count ($reason)', async ({ reason, label }) => {
        const screen = await renderScreen(
            <SessionSectionHeader
                title=""
                memberCount={23}
                collapsed={false}
                item={{
                    type: 'header',
                    title: '',
                    headerKind: 'folder',
                    folderId: 'private-folder-id',
                    folderDepth: 0,
                    serverId: 'server_a',
                    displayState: {
                        status: 'locked',
                        reason,
                    },
                }}
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                icon={null}
                onRename={vi.fn()}
                onChangeIcon={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        const focusButton = screen.findByProps({
            testID: 'session-folder-header-private-folder-id:open',
        });
        expect(focusButton.props.accessibilityLabel).toBe(
            label,
        );
        expect(screen.getTextContent()).toContain('23');
        expect(screen.getTextContent()).not.toContain('private-folder-id');
        const latestMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(latestMenuProps?.items).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'rename', disabled: true }),
                expect.objectContaining({ id: 'icon', disabled: true }),
            ]),
        );
    });

    it('keeps folder drop target registration separate from row-local outline styling', async () => {
        platformOs = 'web';

        const renderHeader = () => (
            <SessionSectionHeader
                title="Planning"
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
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                icon={null}
                onRename={vi.fn()}
                onChangeIcon={vi.fn()}
                onRemove={vi.fn()}
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

        const screen = await renderScreen(
            <SessionSectionHeader
                title="Planning"
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
                onToggleCollapse={vi.fn()}
                onNewSession={vi.fn()}
                icon={null}
                onRename={vi.fn()}
                onChangeIcon={vi.fn()}
                onRemove={vi.fn()}
            />,
        );

        for (const pressable of screen.findAllByType('Pressable' as never)) {
            expect(childTreeContainsPressable(pressable)).toBe(false);
        }
    });

    it('does not nest project header pressable controls inside another pressable on web', async () => {
        platformOs = 'web';

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

    it('decides project folder actions for the project Home rather than the focused Home', async () => {
        const { ProjectGroupHeader } = await import('./sessionListChrome');
        await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo-b',
                    headerKind: 'project',
                    workspaceScopeHint: { serverId: 'server_b', machineId: 'machine_b', rootPath: '/repo-b' },
                } as any}

                displayTitle="Repo B"
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

        expect(featureDecisionScopes).toContainEqual({ scopeKind: 'spawn', serverId: 'server_b' });
    });

    it('hides folder actions while the sessions.folders gate is disabled', async () => {
        sessionFoldersFeatureEnabled = false;
        const { ProjectGroupHeader, SessionListViewOptionsButton } = await import('./sessionListChrome');

        await renderScreen(
            <SessionListViewOptionsButton />,
        );

        const viewOptionsMenuProps = dropdownMenuSpy.mock.calls.at(-1)?.[0] as any;
        expect(viewOptionsMenuProps?.items?.some((item: { id?: string }) => (
            item.id === 'folderDisplay' || item.id === 'folderSort'
        ))).toBe(false);

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

    it('offers no New session action on a project group in a Runs-only list', async () => {
        platformOs = 'web';
        const item = {
            type: 'header', title: '/repo', headerKind: 'project', groupKey: 'project:repo', workspaceKey: 'legacy_repo',
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        } as const;
        const screen = await renderScreen(
            <ProjectGroupHeader
                item={item as any}

                displayTitle="Important Repo"
                hasCustomLabel={false}
                canOpenProject={true}
                newSessionEnabled={false}
                onOpenProject={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
            />,
        );
        expect(screen.root.findAllByProps({ accessibilityLabel: 'machine.launchNewSessionInDirectory' })).toHaveLength(0);
    });

    it('folds from its label and keeps its own actions beside it, outside the label press', async () => {
        platformOs = 'web';
        const onCreateSession = vi.fn();
        const onToggleCollapse = vi.fn();

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

                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                onOpenProject={vi.fn()}
                onCreateSession={onCreateSession}
                onAddFolder={vi.fn()}
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={false}
                onToggleCollapse={onToggleCollapse}
            />,
        );

        const label = screen.findByProps({ testID: 'session-list-project-header:project:repo:open' });
        expect(label.props.expanded).toBe(true);
        await act(async () => {
            label.props.onPress();
        });
        expect(onToggleCollapse).toHaveBeenCalledTimes(1);

        const addButton = screen.findByProps({ accessibilityLabel: 'machine.launchNewSessionInDirectory' });
        expect(label.findAll((node) => node === addButton)).toHaveLength(0);
        await act(async () => {
            addButton.props.onPress();
        });
        expect(onCreateSession).toHaveBeenCalledTimes(1);
        expect(onToggleCollapse).toHaveBeenCalledTimes(1);
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        // No decorative reorder glyph: the header itself is what a pointer carries.
        expect(screen.root.findAllByProps({ testID: 'session-workspace-reorder-handle:project:repo' })).toHaveLength(0);
    });

    it('shows detected workspace favicons on project headers when enabled', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({
            success: true,
            found: true,
            mimeType: 'image/svg+xml',
            contentBase64: 'PHN2Zy8+',
            sizeBytes: 6,
            relativePath: 'public/favicon.svg',
        });

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

        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server_a',
            machineId: 'machine_a',
            payload: { workspacePath: '/repo' },
        }));
        const images = screen.root.findAllByType('Image' as any);
        expect(images).toHaveLength(1);
        expect(images[0].props.source).toEqual({ uri: 'data:image/svg+xml;base64,PHN2Zy8+' });
        expect(screen.root.findByProps({ testID: 'session-list-workspace-favicon' })).toBeDefined();
    });

    it('asks for the favicon of the accepted baseline only: explicit null and an unreachable baseline fall back (P5 U5)', async () => {
        machineRpcWithServerScopeMock.mockResolvedValue({ success: true, found: true, mimeType: 'image/svg+xml',
            contentBase64: 'PHN2Zy8+', sizeBytes: 6, relativePath: 'favicon.svg' });
        const header = (props: Partial<React.ComponentProps<typeof ProjectGroupHeader>>) => (
            <ProjectGroupHeader
                item={{
                    type: 'header', title: '/repo', headerKind: 'project', groupKey: 'project:repo',
                    // The raw lead scope must never stand in for the accepted baseline.
                    workspaceScopeHint: { serverId: 'server_a', machineId: 'lead_machine', rootPath: '/lead-checkout' },
                    serverId: 'server_a',
                } as any}
 displayTitle="happier" hasCustomLabel={false} canOpenProject={true}
                workspaceFaviconsEnabled={true} onOpenProject={vi.fn()} onCreateSession={vi.fn()} onAddFolder={vi.fn()}
                onRename={vi.fn()} onReset={vi.fn()} collapsed={false} onToggleCollapse={vi.fn()}
                {...props}
            />
        );
        const noBaseline = await renderScreen(header({ faviconSource: null }));
        await act(async () => { await Promise.resolve(); });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
        expect(noBaseline.root.findAllByProps({ testID: 'session-list-workspace-favicon' })).toHaveLength(0);

        await renderScreen(header({
            faviconSource: { serverId: 'server_a', machineId: 'baseline_machine', rootPath: '/repo' }, faviconSourceReachable: false,
        }));
        await act(async () => { await Promise.resolve(); });
        expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();

        await renderScreen(header({ faviconSource: { serverId: 'server_a', machineId: 'baseline_machine', rootPath: '/repo' } }));
        await act(async () => { await Promise.resolve(); });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'baseline_machine', payload: { workspacePath: '/repo' },
        }));
    });

    it('shows the projected offline detail even for a single Machine', async () => {

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

                displayTitle="Important Repo"
                hasCustomLabel={true}
                canOpenProject={true}
                machineDetail={{ name: 'leeroy-mbp', end: 'Offline' }}
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
        expect(screen.getTextContent()).toContain('leeroy-mbp');
        expect(screen.getTextContent()).toContain('· Offline');
    });

});
