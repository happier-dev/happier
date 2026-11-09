import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { SystemTaskJsonObject, SystemTaskResult } from '@happier-dev/protocol/system/tasks/spec';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { publishLocalDaemonStatus } from './localDaemonSharedState';
import { readLocalDaemonStatusData } from './useLocalDaemonControl';
import { ThisComputerServersGroup } from './ThisComputerServersGroup';

installMachinesSettingsCommonModuleMocks();

describe('ThisComputerServersGroup shared inventory states', () => {
    it('keeps readable Homes visible, reports incomplete or failed inventory, and clears the notice after recovery without reading again', async () => {
        const starts: string[] = [];
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) { starts.push(spec.kind); return `task_${starts.length}`; },
                async subscribe() { return () => {}; },
                async cancel() {},
                async respond() {},
            },
        });
        const screen = await renderScreen(<ThisComputerServersGroup runner={runner} />);
        const publish = async (data: SystemTaskJsonObject) => {
            const result = { protocolVersion: 1, taskId: 'status', ok: true, data } satisfies SystemTaskResult;
            await act(async () => publishLocalDaemonStatus(runner, readLocalDaemonStatusData(result)));
        };
        const rows = [{ relayUrl: 'https://work.example.test', state: 'offline', appManaged: true, serviceTargetMode: 'pinned', actions: ['start'] }];

        await publish({ serviceRows: rows, serviceRowsComplete: false });
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.0')).toBeTruthy();
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.incomplete')).toBeTruthy();

        await publish({ serviceRows: [], serviceRowsComplete: false });
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.incomplete')).toBeTruthy();
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.0')).toBeFalsy();

        await publish({});
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.failed')).toBeTruthy();
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.incomplete')).toBeFalsy();

        await publish({ serviceRows: rows, serviceRowsComplete: true });
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.0')).toBeTruthy();
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.failed')).toBeFalsy();
        expect(screen.findHostByTestId('settings.localDaemonControl.servers.incomplete')).toBeFalsy();
        expect(starts).toEqual([]);
    });
});
