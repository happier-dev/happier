import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dropdownMenuSpy = vi.fn();
let platformOs: 'ios' | 'web' = 'ios';
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

describe('ProjectGroupHeader menu items', () => {
    afterEach(() => {
        standardCleanup();
        dropdownMenuSpy.mockClear();
        platformOs = 'ios';
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

        await act(async () => {
            addButton.props.onPress();
        });

        expect(onCreateSession).toHaveBeenCalledTimes(1);

        await act(async () => {
            rowPressable.props.onHoverIn?.();
        });

        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        expect(rowPressable.findAllByType('Ionicons')[0]?.parent?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 1 })]));
        const menuTrigger = screen.findByProps({ accessibilityLabel: 'common.moreActions' });

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
                onRename={vi.fn()}
                onReset={vi.fn()}
                collapsed={true}
                onToggleCollapse={vi.fn()}
            />,
        );

        expect(collapsedScreen.root.findAllByType('Ionicons')[0]?.parent?.props?.style).toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 1 })]));
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
