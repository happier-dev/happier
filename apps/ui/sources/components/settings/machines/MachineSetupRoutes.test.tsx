import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const expoRouterMock = vi.hoisted(() => {
    const push = vi.fn();
    const router = { push };
    return {
        spies: { push },
        module: {
            useRouter: () => router,
        },
    };
});

vi.mock('expo-router', () => expoRouterMock.module);

const isTauriDesktopMock = vi.fn();
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

describe('Machines settings routes', () => {
    it('renders a setup wizard launcher for add-machine route on desktop', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });

    it('renders a setup wizard launcher for this-computer route on desktop', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });

    it('renders a setup wizard launcher for add-machine route on web', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });

    it('renders a setup wizard launcher for this-computer route on web', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByProps({ testID: 'settings.machineSetup.openSetupWizard' })).toBeTruthy();
    });
});
