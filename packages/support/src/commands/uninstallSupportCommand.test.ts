import { afterEach, describe, expect, it, vi } from 'vitest';

const { applyCliUninstallPlanMock } = vi.hoisted(() => ({
    applyCliUninstallPlanMock: vi.fn(async ({ plan }) => (
        plan.kind === 'npm-global-installation'
            ? {
                removedPaths: [plan.installation.path],
                serviceTargets: [],
                actions: [{
                    command: [plan.command.cmd, ...plan.command.args].join(' '),
                    reason: 'npm-global-installation',
                }],
            }
            : {
                removedPaths: ['/Users/tester/.happier/cli', '/Users/tester/.happier/bin/happier'],
                serviceTargets: [{ id: 'systemd-user:happier-daemon.stable.cloud', label: 'happier-daemon.stable.cloud' }],
            }
    )),
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/cli-common/happierRuntime')>();
    return {
        ...actual,
        applyCliUninstallPlan: applyCliUninstallPlanMock,
    };
});

import { runUninstallSupportCommand } from './uninstallSupportCommand.js';

describe('runUninstallSupportCommand', () => {
    afterEach(() => {
        applyCliUninstallPlanMock.mockClear();
    });

    it('previews direct managed uninstall actions without delegating through an installed CLI', async () => {
        const result = await runUninstallSupportCommand(
            { json: true, yes: false, dryRun: false, keepService: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hdev',
                    currentReleaseChannel: 'publicdev',
                    installations: {
                        activeInvocation: {
                            path: '/Users/tester/.happier/bin/hdev',
                            realPath: '/Users/tester/.happier/cli-dev/current/happier',
                            invokerName: 'hdev',
                            ring: 'publicdev',
                            version: '0.2.0-dev',
                            installationId: 'managed:publicdev:/Users/tester/.happier/cli-dev/current',
                        },
                        installations: [{
                            id: 'managed:publicdev:/Users/tester/.happier/cli-dev/current',
                            source: 'firstPartyManaged',
                            components: ['happier-cli'],
                            ring: 'publicdev',
                            version: '0.2.0-dev',
                            path: '/Users/tester/.happier/cli-dev/current',
                            realPath: '/Users/tester/.happier/cli-dev/current',
                            shimName: 'hdev',
                            onPath: true,
                            managedRoot: '/Users/tester/.happier/cli-dev',
                        }],
                    },
                    services: [{
                        id: 'systemd-user:happier-daemon.publicdev.cloud',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.publicdev.cloud',
                        verification: 'verified',
                        targetMode: 'default-following',
                        ring: 'publicdev',
                        instanceId: 'cloud',
                        scope: 'user',
                        definitionPath: '/home/tester/.config/systemd/user/happier-daemon.publicdev.cloud.service',
                        executablePath: '/Users/tester/.happier/cli-dev/current/happier',
                        installed: true,
                        running: true,
                    }],
                    warnings: [],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            installation: expect.objectContaining({
                id: 'managed:publicdev:/Users/tester/.happier/cli-dev/current',
                ring: 'publicdev',
            }),
            serviceTargets: [
                { id: 'systemd-user:happier-daemon.publicdev.cloud', label: 'happier-daemon.publicdev.cloud' },
            ],
        });
        expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
    });

    it('executes direct managed uninstall without delegating through an installed CLI', async () => {
        const result = await runUninstallSupportCommand(
            { json: true, yes: true, dryRun: false, keepService: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    installations: {
                        activeInvocation: {
                            path: '/Users/tester/.happier/bin/happier',
                            realPath: '/Users/tester/.happier/cli/current/happier',
                            invokerName: 'happier',
                            ring: 'stable',
                            version: '0.2.0',
                            installationId: 'managed:stable:/Users/tester/.happier/cli/current',
                        },
                        installations: [{
                            id: 'managed:stable:/Users/tester/.happier/cli/current',
                            source: 'firstPartyManaged',
                            components: ['happier-cli'],
                            ring: 'stable',
                            version: '0.2.0',
                            path: '/Users/tester/.happier/cli/current',
                            realPath: '/Users/tester/.happier/cli/current',
                            shimName: 'happier',
                            onPath: true,
                            managedRoot: '/Users/tester/.happier/cli',
                        }],
                    },
                    services: [{
                        id: 'systemd-user:happier-daemon.stable.cloud',
                        serviceType: 'daemon',
                        platform: 'linux',
                        backend: 'systemd-user',
                        label: 'happier-daemon.stable.cloud',
                        verification: 'verified',
                        targetMode: 'default-following',
                        ring: 'stable',
                        instanceId: 'cloud',
                        scope: 'user',
                        definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.service',
                        executablePath: '/Users/tester/.happier/cli/current/happier',
                        installed: true,
                        running: true,
                    }],
                    warnings: [],
                }),
            },
        );

        expect(applyCliUninstallPlanMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            removedPaths: ['/Users/tester/.happier/cli', '/Users/tester/.happier/bin/happier'],
            serviceTargets: [
                { id: 'systemd-user:happier-daemon.stable.cloud', label: 'happier-daemon.stable.cloud' },
            ],
        });
    });

    it('previews npm-global uninstall directly for a selected npm-global CLI installation', async () => {
        const result = await runUninstallSupportCommand(
            { json: true, yes: false, dryRun: false, keepService: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    selectedInstallation: {
                        id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        source: 'npmGlobal',
                        components: ['happier-cli', 'happier-daemon'],
                        ring: 'stable',
                        version: '0.1.0-preview.1771774953.99369',
                        path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        shimName: 'happier',
                        onPath: true,
                        managedRoot: '/opt/homebrew',
                        packageManager: {
                            kind: 'npmGlobal',
                            executablePath: '/opt/homebrew/bin/npm',
                            packageName: '@happier-dev/cli',
                        },
                    },
                    warnings: [],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            installation: {
                id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                source: 'npmGlobal',
                ring: 'stable',
                path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
            },
            actions: [
                { command: '/opt/homebrew/bin/npm uninstall -g @happier-dev/cli', reason: 'npm-global-installation' },
            ],
        });
    });

    it('executes npm-global uninstall directly for a selected npm-global CLI installation', async () => {
        applyCliUninstallPlanMock.mockReset();

        const result = await runUninstallSupportCommand(
            { json: true, yes: true, dryRun: false, keepService: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    selectedInstallation: {
                        id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        source: 'npmGlobal',
                        components: ['happier-cli', 'happier-daemon'],
                        ring: 'stable',
                        version: '0.1.0-preview.1771774953.99369',
                        path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                        shimName: 'happier',
                        onPath: true,
                        managedRoot: '/opt/homebrew',
                        packageManager: {
                            kind: 'npmGlobal',
                            executablePath: '/opt/homebrew/bin/npm',
                            packageName: '@happier-dev/cli',
                        },
                    },
                    warnings: [],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            removedPaths: ['/opt/homebrew/lib/node_modules/@happier-dev/cli'],
            actions: [
                { command: '/opt/homebrew/bin/npm uninstall -g @happier-dev/cli', reason: 'npm-global-installation' },
            ],
        });
        expect(applyCliUninstallPlanMock).toHaveBeenCalledTimes(1);
    });

    it('does not apply uninstall plans that would need root privileges for system-scoped services', async () => {
        const getuidSpy = typeof process.getuid === 'function'
            ? vi.spyOn(process, 'getuid').mockReturnValue(501)
            : null;
        try {
            const result = await runUninstallSupportCommand(
                { json: true, yes: true, dryRun: false, keepService: false },
                {
                    collectMaintenanceContext: async () => ({
                        preferredCliCommand: 'happier',
                        currentReleaseChannel: 'stable',
                        installations: {
                            activeInvocation: {
                                path: '/Users/tester/.happier/bin/happier',
                                realPath: '/Users/tester/.happier/cli/current/happier',
                                invokerName: 'happier',
                                ring: 'stable',
                                version: '0.2.0',
                                installationId: 'managed:stable:/Users/tester/.happier/cli/current',
                            },
                            installations: [{
                                id: 'managed:stable:/Users/tester/.happier/cli/current',
                                source: 'firstPartyManaged',
                                components: ['happier-cli'],
                                ring: 'stable',
                                version: '0.2.0',
                                path: '/Users/tester/.happier/cli/current',
                                realPath: '/Users/tester/.happier/cli/current',
                                shimName: 'happier',
                                onPath: true,
                                managedRoot: '/Users/tester/.happier/cli',
                            }],
                        },
                        services: [{
                            id: 'systemd-system:happier-daemon.stable.cloud',
                            serviceType: 'daemon',
                            platform: 'linux',
                            backend: 'systemd-system',
                            label: 'happier-daemon.stable.cloud',
                            verification: 'verified',
                            targetMode: 'default-following',
                            ring: 'stable',
                            instanceId: 'cloud',
                            scope: 'system',
                            definitionPath: '/etc/systemd/system/happier-daemon.stable.cloud.service',
                            executablePath: '/Users/tester/.happier/cli/current/happier',
                            installed: true,
                            running: true,
                        }],
                        warnings: [],
                    }),
                },
            );

            expect(JSON.parse(result.output)).toEqual({
                ok: false,
                error: 'root_privileges_required',
                manualCommands: ['sudo npx @happier-dev/support uninstall --yes'],
            });
            expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
        } finally {
            getuidSpy?.mockRestore();
        }
    });
});
