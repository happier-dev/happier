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

const isDesktopHostMock = vi.fn();
vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
}));

describe('Machines settings routes', () => {
    it('renders a setup wizard launcher for add-machine route on desktop', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        const item = screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' });
        expect(item).toBeTruthy();
        expect(item.props.title).toBe('Set up a new machine');
    });

    it('renders a setup wizard launcher for this-computer route on desktop', async () => {
        isDesktopHostMock.mockReturnValue(true);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });

    it('renders a setup wizard launcher for add-machine route on web', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        const item = screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' });
        expect(item).toBeTruthy();
        expect(item.props.title).toBe('Set up a new machine');
    });

    it('renders a setup wizard launcher for this-computer route on web', async () => {
        isDesktopHostMock.mockReturnValue(false);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });
});
