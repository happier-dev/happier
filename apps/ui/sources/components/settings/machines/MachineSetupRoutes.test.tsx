import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const isTauriDesktopMock = vi.fn();
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopMock(),
}));

vi.mock('@/components/settings/machines/MachineSetupFlowScreen', () => ({
    MachineSetupFlowScreen: (props: Record<string, unknown>) => React.createElement('MachineSetupFlowScreen', props),
}));

vi.mock('@/components/settings/machines/DesktopOnlySetupNotice', () => ({
    DesktopOnlySetupNotice: (props: Record<string, unknown>) => React.createElement('DesktopOnlySetupNotice', props),
}));

describe('Machines settings routes', () => {
    it('renders the dedicated add-machine route in remote-only mode on desktop', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        const flowScreen = screen.tree.findByType('MachineSetupFlowScreen' as any);
        expect(flowScreen.props.mode).toBe('remoteOnly');
    });

    it('renders the this-computer route with the shared flow in local-only mode on desktop', async () => {
        isTauriDesktopMock.mockReturnValue(true);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        const flowScreen = screen.tree.findByType('MachineSetupFlowScreen' as any);
        expect(flowScreen.props.mode).toBe('localOnly');
    });

    it('renders a desktop-only notice for add-machine route on web', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const AddMachineRoute = (await import('@/app/(app)/settings/machines/add')).default;
        const screen = await renderScreen(React.createElement(AddMachineRoute));

        expect(screen.tree.findByType('DesktopOnlySetupNotice' as any)).toBeTruthy();
    });

    it('renders a desktop-only notice for this-computer route on web', async () => {
        isTauriDesktopMock.mockReturnValue(false);
        const ThisComputerSetupRoute = (await import('@/app/(app)/settings/machines/this-computer')).default;
        const screen = await renderScreen(React.createElement(ThisComputerSetupRoute));

        expect(screen.tree.findByType('DesktopOnlySetupNotice' as any)).toBeTruthy();
    });
});
