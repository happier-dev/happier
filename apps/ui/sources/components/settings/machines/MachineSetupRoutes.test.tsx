import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { Pressable, StyleSheet } from 'react-native';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);
// The add-machine choices depend on the platform (browser vs desktop app); these routes are web.
const viewport = vi.hoisted(() => ({ width: 800, height: 600, scale: 2, fontScale: 1 }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Dimensions: { get: () => viewport } });
});

const isDesktopHostMock = vi.fn();
// Only the desktop-host answer this suite steers is replaced. The rest of the platform boundary
// stays real, so a module reached later through this screen's import graph still finds it.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => isDesktopHostMock(),
}));

describe('Machines settings routes', () => {
    beforeEach(() => {
        viewport.width = 800;
        viewport.height = 600;
    });

    it('gives every machine-add choice a full phone row rather than squeezing three columns', async () => {
        viewport.width = 390;
        viewport.height = 844;
        isDesktopHostMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));
        const tile = screen.root.findAll(node => node.type === Pressable
            && node.props.testID === 'settings.machines.draft.form.path:thisComputer')[0]!;
        let grid = tile.parent;
        while (grid && typeof grid.props.onLayout !== 'function') grid = grid.parent;
        expect(grid).not.toBeNull();
        await act(async () => {
            grid!.props.onLayout({ nativeEvent: { layout: { width: 354, height: 300, x: 0, y: 0 } } });
        });
        // The native layout boundary supplies the available content width. Check the painted
        // card geometry, not an internal picker prop or a mocked responsive decision.
        for (const id of ['thisComputer', 'ssh', 'anotherComputer']) {
            const choice = screen.root.findAll(node => node.type === Pressable
                && node.props.testID === `settings.machines.draft.form.path:${id}`)[0]!;
            let frame = choice.parent;
            while (frame && StyleSheet.flatten(frame.props.style)?.width === undefined) frame = frame.parent;
            expect(StyleSheet.flatten(frame?.props.style)?.width).toBe(354);
        }
    });

    it('offers this computer and SSH in the add-machine draft on desktop', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeTruthy();
        expect(screen.findByTestId('settings.machines.draft.form.path:thisComputer')).toBeTruthy();
    });

    it('renders a setup wizard launcher for this-computer route on desktop', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });

    it('offers this computer and the SSH setup wizard on the add-machine route on web', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        expect(screen.findByTestId('settings.machines.draft.form.path:thisComputer')).toBeTruthy();
        expect(screen.findByTestId('settings.machines.draft.form.path:ssh')).toBeTruthy();
    });

    it('renders a setup wizard launcher for this-computer route on web', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });
});
