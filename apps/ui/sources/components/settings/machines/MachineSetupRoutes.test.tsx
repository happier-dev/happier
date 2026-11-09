import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('keeps every connection path usable on a phone and opens the chosen SSH form', async () => {
        viewport.width = 390;
        viewport.height = 844;
        isDesktopHostMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));
        // Create-capable phone pages put the connection paths under Connect; otherwise they
        // remain the radio choices above the form. Both preserve every connection action.
        const choiceTestId = (id: string) => screen.findByTestId(`settings.machines.draft.form.connectPath.${id}`)
            ? `settings.machines.draft.form.connectPath.${id}` : `settings.machines.draft.form.path:${id}`;
        for (const id of ['thisComputer', 'ssh', 'anotherComputer']) {
            const choice = screen.findByTestId(choiceTestId(id));
            expect(choice).not.toBeNull();
            expect(choice?.props.disabled).not.toBe(true);
        }
        await screen.pressByTestIdAsync(choiceTestId('ssh'));
        const { readMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
        expect(readMachineAddFlowDraft().path).toBe('ssh');
        expect(screen.findByTestId('settings.machines.draft.form.pane.ssh-sshHostInput')).not.toBeNull();
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
