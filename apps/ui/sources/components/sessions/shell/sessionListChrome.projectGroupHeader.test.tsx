import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const dropdownMenuSpy = vi.fn();
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
            Platform: { OS: 'ios' },
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

describe('ProjectGroupHeader menu items', () => {
    afterEach(() => {
        standardCleanup();
        dropdownMenuSpy.mockClear();
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
});
