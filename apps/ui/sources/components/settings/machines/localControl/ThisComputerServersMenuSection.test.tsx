import * as React from 'react';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, findTestInstanceByTypeWithProps } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { ThisComputerServersMenuSection } from './ThisComputerServersMenuSection';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

describe('ThisComputerServersMenuSection (connection popover, R15 d, R13C-F4)', () => {
    const row = (relayUrl: string, state: string) => ({ relayUrl, state, appManaged: true, serviceTargetMode: 'pinned', actions: [] });

    function runnerWithNoReads() {
        const starts: string[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    starts.push((spec as { kind: string }).kind);
                    return `task_${starts.length}`;
                },
                async subscribe() { return () => {}; },
                async cancel() {},
                async respond() {},
            },
        });
        return { runner, starts };
    }

    async function publish(runner: ReturnType<typeof createSystemTaskRunner>, data: Record<string, unknown>) {
        const { publishLocalDaemonStatus } = await import('./localDaemonSharedState');
        const { readLocalDaemonStatusData } = await import('./useLocalDaemonControl');
        const status = readLocalDaemonStatusData({ protocolVersion: 1, taskId: 'status', ok: true, data } as never);
        await renderer.act(async () => {
            if (status) publishLocalDaemonStatus(runner, status);
        });
    }

    it('lists each Home this computer serves from the shared status, without a read of its own', async () => {
        const { runner, starts } = runnerWithNoReads();
        const onClose = vi.fn();
        const screen = await renderScreen(React.createElement(ThisComputerServersMenuSection, { runner, onClose }));
        // Nothing to show until this computer's status is known.
        expect(findTestInstanceByTypeWithProps(screen, SelectableRow, { testID: 'connection-popover-this-computer-server-0' })).toBeFalsy();

        await publish(runner, {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            daemonServerUrl: 'https://elsewhere.example.test',
            serviceRowsComplete: false,
            serviceRows: [
                row('https://company.example.test', 'connected'),
                row('https://personal.example.test', 'offline'),
                row('https://broken.example.test', 'needs_attention'),
            ],
        });

        const rows = [0, 1, 2].map((index) => findTestInstanceByTypeWithProps(screen, SelectableRow, { testID: `connection-popover-this-computer-server-${index}` }));
        expect(screen.findHostByTestId('connection-popover-this-computer-servers')).not.toBeNull();
        expect(rows.map((entry) => entry?.props.subtitle)).toEqual([
            'machine.thisComputer.servers.connected',
            'machine.thisComputer.servers.offline',
            'machine.thisComputer.servers.attention',
        ]);
        expect(starts).toEqual([]);
        // Some services could not be read (`serviceRowsComplete: false`): the list says so.
        expect(findTestInstanceByTypeWithProps(screen, SelectableRow, { testID: 'connection-popover-this-computer-servers-incomplete' })?.props.title).toBe('settingsDesktop.tray.incomplete');
        rows[1]?.props.onPress();
        // Opens This computer, then closes the popover.
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows nothing when this computer serves no Home', async () => {
        const { runner } = runnerWithNoReads();
        const screen = await renderScreen(React.createElement(ThisComputerServersMenuSection, { runner, onClose: () => {} }));
        await publish(runner, { serviceInstalled: false, daemonRunning: false, needsAuth: false, serviceRowsComplete: true, serviceRows: [] });
        expect(screen.findHostByTestId('connection-popover-this-computer-servers')).toBeNull();
    });

    it('reports a failed inventory read and leads to This computer instead of implying there are no services', async () => {
        const { runner, starts } = runnerWithNoReads();
        const onClose = vi.fn();
        const screen = await renderScreen(<ThisComputerServersMenuSection runner={runner} onClose={onClose} />);
        await publish(runner, {});
        const failure = findTestInstanceByTypeWithProps(screen, SelectableRow, { testID: 'connection-popover-this-computer-servers-failed' });
        expect(failure).toBeTruthy();
        failure?.props.onPress();
        expect(onClose).toHaveBeenCalledOnce();
        expect(starts).toEqual([]);
    });
});
