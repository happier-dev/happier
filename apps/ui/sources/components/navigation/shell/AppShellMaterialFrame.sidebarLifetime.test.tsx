/** @vitest-environment jsdom */
import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SessionListHeaderItem } from '@/components/sessions/shell/sessionListHeaderItem';
import { CollapsibleSectionHeader } from '@/components/sessions/shell/sessionListChrome';
import { LruMap } from '@/utils/cache/lruMap';
import { AppShellMaterialFrame } from './AppShellMaterialFrame';

vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () =>
    (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());

const noop = () => {};
const item = { type: 'header', title: 'Working', headerKind: 'working', groupKey: 'working' } as const;
const headerModels = new Map();

function SessionsColumn() {
    const [collapsed, setCollapsed] = React.useState(false);
    const toggle = React.useCallback(() => setCollapsed(value => !value), []);
    return <SessionListHeaderItem item={item} collapsedKeys={{ working: collapsed }}
        projectHeaderViewModelByGroupKey={headerModels}
        onOpenProject={noop} onCreateSessionFromWorkspaceScope={noop} onAddFolderToWorkspace={noop}
        onRenameWorkspace={noop} onResetWorkspaceName={noop} onToggleCollapse={toggle} />;
}

describe('shell sidebar lifetime', () => {
    it('releases mounted header callbacks on every intentional column removal and shell unmount', async () => {
        // Observe the real retention owner without replacing get/set or domain logic.
        const writes = vi.spyOn(LruMap.prototype, 'set');
        const retainedHeaderCallbacks = () => {
            let count = 0;
            for (const cache of new Set(writes.mock.contexts)) {
                if (!(cache instanceof LruMap)) continue;
                const values: Iterable<unknown> = cache.values();
                for (const value of values) {
                    if (typeof value === 'object' && value !== null
                        && 'onToggleCollapse' in value && typeof value.onToggleCollapse === 'function') count++;
                }
            }
            return count;
        };
        const frame = (route: string) => <AppShellMaterialFrame showChrome dragEnabled={false}
            leftOffsetPx={384} sidebarWidth={320} titleStrip={null} rail={<View />}
            column={route.startsWith('/session') || route === '/' ? <SessionsColumn /> : null} peek={null}>
            <View testID={route} />
        </AppShellMaterialFrame>;
        try {
            for (let mount = 0; mount < 2; mount++) {
                const screen = await renderScreen(frame('/session/quiet'));
                try {
                    const sidebar = screen.findHostByTestId('navigation-sidebar');
                    const header = screen.findByType(CollapsibleSectionHeader);
                    await screen.update(frame('/session/another'));
                    expect(screen.findHostByTestId('navigation-sidebar')).toBe(sidebar);
                    expect(screen.findByType(CollapsibleSectionHeader)).toBe(header);
                    // A real header action still reaches its mounted owner.
                    await screen.pressByTestIdAsync('session-list-header:working');
                    expect(screen.findByType(CollapsibleSectionHeader).props.collapsed).toBe(true);
                    for (let cycle = 0; cycle < 3; cycle++) {
                        for (const route of ['/inbox', '/', '/inbox?view=needs_you', '/settings/secrets', '/session/quiet']) {
                            await screen.update(frame(route));
                            if (!route.startsWith('/session') && route !== '/') {
                                expect(screen.findHostByTestId('navigation-sidebar')).toBeNull();
                                expect(retainedHeaderCallbacks(), `mount ${mount}, cycle ${cycle}, ${route}`).toBe(0);
                            }
                        }
                    }
                } finally {
                    await screen.unmount();
                }
                expect(retainedHeaderCallbacks(), `shell unmount ${mount}`).toBe(0);
            }
        } finally {
            writes.mockRestore();
        }
    });
});
