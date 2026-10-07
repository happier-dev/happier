import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const expoRouterMock = createExpoRouterMock({
    router: {
        push: vi.fn(),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);
// The add-machine choices depend on the platform (browser vs desktop app); these routes are web.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const isDesktopHostMock = vi.fn();
// Only the desktop-host answer this suite steers is replaced. The rest of the platform boundary
// stays real, so a module reached later through this screen's import graph still finds it.
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    isDesktopHost: () => isDesktopHostMock(),
}));

describe('Machines settings routes', () => {
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
