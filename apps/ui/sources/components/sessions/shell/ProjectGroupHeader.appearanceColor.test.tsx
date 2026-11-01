import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
});
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));
vi.mock('react-native-gesture-handler', () => ({
    GestureDetector: (props: any) => React.createElement('GestureDetector', props, props.children),
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('./useWorkspaceFavicon', () => ({ useWorkspaceFavicon: () => null }));

type ProjectHeaderItem = Extract<SessionListViewItem, { type: 'header' }>;

function createProjectHeader(appearanceColor: SessionAppearanceColor | null): ProjectHeaderItem {
    return {
        type: 'header',
        title: '~/code/happier',
        headerKind: 'project',
        groupKey: 'project:ws1',
        workspaceKey: 'ws1',
        serverId: 'server_a',
        appearanceColor,
    } as ProjectHeaderItem;
}

async function renderHeader(item: ProjectHeaderItem, onSetWorkspaceColor = vi.fn()) {
    const { ProjectGroupHeader } = await import('./ProjectGroupHeader');
    const screen = await renderScreen(
        <ProjectGroupHeader
            item={item}
            hasMultipleMachines={false}
            onRenameWorkspace={vi.fn()}
            onResetWorkspaceName={vi.fn()}
            onCreateSession={vi.fn()}
            onSetWorkspaceColor={onSetWorkspaceColor}
            collapsed={false}
            onToggleCollapse={vi.fn()}
            headerTestId="project-header"
        />,
    );
    return { screen, onSetWorkspaceColor };
}

function findWorkspaceMenu(screen: Awaited<ReturnType<typeof renderHeader>>['screen']) {
    return screen.root.find((node) => String(node.type) === 'DropdownMenu');
}

describe('ProjectGroupHeader colour', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('marks a coloured project with a dot and leaves an uncoloured one plain', async () => {
        const colored = await renderHeader(createProjectHeader({ kind: 'accent', key: 'purple' }));
        expect(colored.screen.findByTestId('session-workspace-color:ws1')).not.toBeNull();
        await colored.screen.unmount();

        const plain = await renderHeader(createProjectHeader(null));
        expect(plain.screen.findByTestId('session-workspace-color:ws1')).toBeNull();
        await plain.screen.unmount();
    });

    it('sets and removes the project colour from the header menu for that project and server', async () => {
        const { screen, onSetWorkspaceColor } = await renderHeader(createProjectHeader({ kind: 'accent', key: 'blue' }));
        const menu = findWorkspaceMenu(screen);
        const colorItem = (menu.props.items as any[]).find((item) => item.submenu?.items.some((entry: any) => entry.swatch));
        expect(colorItem).toBeDefined();
        const submenu = colorItem.submenu.items as any[];
        const swatches = submenu.filter((entry) => entry.swatch && !entry.swatch.empty);
        expect(swatches).toHaveLength(7);
        expect(swatches.filter((entry) => entry.swatch.checked)).toHaveLength(1);

        const purple = swatches[swatches.length - 1];
        const remove = submenu.find((entry) => entry.swatch?.empty);
        await act(async () => {
            await menu.props.onSelect(purple.id);
            await menu.props.onSelect(remove.id);
        });

        expect(onSetWorkspaceColor.mock.calls).toEqual([
            ['ws1', { kind: 'accent', key: 'purple' }, { serverId: 'server_a' }],
            ['ws1', null, { serverId: 'server_a' }],
        ]);
        await screen.unmount();
    });
});
