import { describe, expect, it, vi } from 'vitest';

const {
    uninstallDiscoveredHappierServiceMock,
    restartDaemonAndWaitMock,
    installDaemonServiceMock,
} = vi.hoisted(() => ({
    uninstallDiscoveredHappierServiceMock: vi.fn(async () => undefined),
    restartDaemonAndWaitMock: vi.fn(async () => true),
    installDaemonServiceMock: vi.fn(async () => undefined),
}));

vi.mock('@/daemon/service/uninstallDiscoveredHappierService', () => ({
    uninstallDiscoveredHappierService: uninstallDiscoveredHappierServiceMock,
}));

vi.mock('@/daemon/restartDaemonAndWait', () => ({
    restartDaemonAndWait: restartDaemonAndWaitMock,
}));

vi.mock('@/daemon/service/installer', () => ({
    installDaemonService: installDaemonServiceMock,
}));

import { applyHappierRuntimeRepairPlan } from './applyHappierRuntimeRepairPlan';

describe('applyHappierRuntimeRepairPlan', () => {
    it('installs a default-following service when the plan requests migration', async () => {
        await applyHappierRuntimeRepairPlan({
            actions: [
                {
                    kind: 'install-default-following-service',
                    command: 'happier service install --yes',
                    mode: 'user',
                    targetServerUrl: 'https://api.happier.dev',
                },
            ],
            manualWarnings: [],
        });

        expect(installDaemonServiceMock).toHaveBeenCalledWith({
            mode: 'user',
            runCommands: true,
            targetMode: 'default-following',
        });
    });

    it('passes default-following target mode through to service uninstall actions', async () => {
        await applyHappierRuntimeRepairPlan({
            actions: [
                {
                    kind: 'uninstall-daemon-services',
                    command: 'happier service repair --yes',
                    services: [
                        {
                            id: 'launchd:com.happier.cli.daemon.default',
                            label: 'com.happier.cli.daemon.default',
                            platform: 'darwin',
                            backend: 'launchd',
                            scope: 'user',
                            targetMode: 'default-following',
                            ring: null,
                            instanceId: null,
                            definitionPath: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
                        },
                    ],
                },
            ],
            manualWarnings: [],
        });

        expect(uninstallDiscoveredHappierServiceMock).toHaveBeenCalledWith(expect.objectContaining({
            platform: 'darwin',
            backend: 'launchd',
            scope: 'user',
            label: 'com.happier.cli.daemon.default',
            definitionPath: '/Users/test/Library/LaunchAgents/com.happier.cli.daemon.default.plist',
            runCommands: true,
        }));
    });
});
