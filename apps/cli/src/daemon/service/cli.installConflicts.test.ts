import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

const {
    discoverHappierServicesMock,
    installDaemonServiceMock,
    resolveDaemonServiceInstallRuntimeTargetMock,
} = vi.hoisted(() => ({
    discoverHappierServicesMock: vi.fn(),
    installDaemonServiceMock: vi.fn(async () => undefined),
    resolveDaemonServiceInstallRuntimeTargetMock: vi.fn(async () => ({
        nodePath: '/managed/node',
        entryPath: '/opt/happier/package-dist/index.mjs',
    })),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
    return {
        ...actual,
        discoverHappierServices: discoverHappierServicesMock,
    };
});

vi.mock('./installer', () => ({
    installDaemonService: installDaemonServiceMock,
    uninstallDaemonService: vi.fn(async () => undefined),
}));

vi.mock('./resolveDaemonServiceInstallRuntimeTarget', () => ({
    resolveDaemonServiceInstallRuntimeTarget: resolveDaemonServiceInstallRuntimeTargetMock,
}));

describe('runDaemonServiceCliCommand install conflict preflight', () => {
    const envKeys = [
        'HAPPIER_DAEMON_SERVICE_PLATFORM',
        'HAPPIER_DAEMON_SERVICE_USER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR',
        'HAPPIER_DAEMON_SERVICE_INSTANCE_ID',
        'HAPPIER_DAEMON_SERVICE_CHANNEL',
        'HAPPIER_INSTALLER_DAEMON_SERVICE_STRATEGY',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);

    afterEach(() => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('fails closed by default when another verified daemon service is already installed', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        });
        discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'systemd-user:happier-daemon.company',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.company',
                    verification: 'verified',
                    ring: 'stable',
                    instanceId: 'company',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.company.service',
                    executablePath: '/home/tester/.happier/cli/current/happier',
                    installed: true,
                    running: true,
                },
            ],
        });

        const output = captureStdoutJsonOutput<{ ok: boolean; error?: string; message?: string }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');
            installDaemonServiceMock.mockRejectedValueOnce(Object.assign(
                new Error('Competing daemon services detected: happier-daemon.company. Re-run with --yes or --replace-existing=ring|all.'),
                {
                    code: 'daemon_service_conflict',
                    conflicts: [
                        { label: 'happier-daemon.company' },
                    ],
                },
            ));
            await runDaemonServiceCliCommand({ argv: ['install', '--json'] });

            expect(output.json()).toEqual(expect.objectContaining({
                ok: false,
                error: 'daemon_service_conflict',
                message: expect.stringContaining('--yes'),
            }));
            expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
            expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
                strategy: undefined,
            }));
        } finally {
            output.restore();
        }
    });

    it('allows explicit add semantics when --yes is provided', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        });
        discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'systemd-user:happier-daemon.company',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.company',
                    verification: 'verified',
                    ring: 'stable',
                    instanceId: 'company',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.company.service',
                    executablePath: '/home/tester/.happier/cli/current/happier',
                    installed: true,
                    running: true,
                },
            ],
        });

        const output = captureStdoutJsonOutput<{ ok: boolean }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');
            await runDaemonServiceCliCommand({ argv: ['install', '--yes', '--json'] });

            expect(output.json().ok).toBe(true);
            expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
            expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
                strategy: 'add',
            }));
        } finally {
            output.restore();
        }
    });

    it('replaces same-ring verified daemon services when requested explicitly', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        });
        discoverHappierServicesMock.mockResolvedValue({
            services: [
                {
                    id: 'systemd-user:happier-daemon.company',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.company',
                    verification: 'verified',
                    ring: 'stable',
                    instanceId: 'company',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.company.service',
                    executablePath: '/home/tester/.happier/cli/current/happier',
                    installed: true,
                    running: true,
                },
                {
                    id: 'systemd-user:happier-daemon.preview.preview1',
                    serviceType: 'daemon',
                    platform: 'linux',
                    backend: 'systemd-user',
                    label: 'happier-daemon.preview.preview1',
                    verification: 'verified',
                    ring: 'preview',
                    instanceId: 'preview1',
                    scope: 'user',
                    definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.preview1.service',
                    executablePath: '/home/tester/.happier/cli-preview/current/happier',
                    installed: true,
                    running: true,
                },
            ],
        });

        const output = captureStdoutJsonOutput<{ ok: boolean }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');
            await runDaemonServiceCliCommand({ argv: ['install', '--replace-existing=ring', '--yes', '--json'] });

            expect(output.json().ok).toBe(true);
            expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
            expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
                strategy: 'replace-ring',
            }));
        } finally {
            output.restore();
        }
    });

    it('passes replace-all to the installer when explicitly requested', async () => {
        envScope.patch({
            HAPPIER_DAEMON_SERVICE_PLATFORM: 'linux',
            HAPPIER_DAEMON_SERVICE_USER_HOME_DIR: '/home/tester',
            HAPPIER_DAEMON_SERVICE_HAPPIER_HOME_DIR: '/home/tester/.happier',
            HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
            HAPPIER_DAEMON_SERVICE_CHANNEL: 'stable',
        });
        discoverHappierServicesMock.mockResolvedValue({ services: [] });

        const output = captureStdoutJsonOutput<{ ok: boolean }>();
        try {
            const { runDaemonServiceCliCommand } = await import('./cli.js');
            await runDaemonServiceCliCommand({ argv: ['install', '--replace-existing=all', '--yes', '--json'] });

            expect(output.json().ok).toBe(true);
            expect(installDaemonServiceMock).toHaveBeenCalledTimes(1);
            expect(installDaemonServiceMock).toHaveBeenCalledWith(expect.objectContaining({
                strategy: 'replace-all',
            }));
        } finally {
            output.restore();
        }
    });
});
