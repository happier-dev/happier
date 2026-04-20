import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    createOutputBuilderMock,
    applyCliUninstallPlanMock,
    uninstallHappierServiceMock,
} = vi.hoisted(() => ({
    createOutputBuilderMock: vi.fn(),
    applyCliUninstallPlanMock: vi.fn(async ({ plan }) => ({
        removedPaths: [plan.installation.path],
        serviceTargets: [],
        actions: plan.kind === 'npm-global-installation'
            ? [{
                command: [plan.command.cmd, ...plan.command.args].join(' '),
                reason: 'npm-global-installation',
            }]
            : [],
    })),
    uninstallHappierServiceMock: vi.fn(async () => undefined),
}));

vi.mock('@happier-dev/cli-common/output', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/output')>('@happier-dev/cli-common/output');
    return {
        ...actual,
        createOutputBuilder: createOutputBuilderMock,
    };
});

vi.mock('@happier-dev/cli-common/happierRuntime', async () => {
    const actual = await vi.importActual<typeof import('@happier-dev/cli-common/happierRuntime')>('@happier-dev/cli-common/happierRuntime');
    return {
        ...actual,
        applyCliUninstallPlan: applyCliUninstallPlanMock,
        uninstallHappierService: uninstallHappierServiceMock,
    };
});

import { runCleanupSupportCommand } from './cleanupSupportCommand.js';

describe('runCleanupSupportCommand', () => {
    function installOutputBuilderMock(): void {
        lines.length = 0;
        createOutputBuilderMock.mockReset();
        createOutputBuilderMock.mockReturnValue({
            line: (value: string) => {
                lines.push(String(value));
            },
            blank: () => {
                lines.push('');
            },
            bullets: (items: readonly string[]) => {
                lines.push(...items.map((item) => `* ${item}`));
            },
            checklist: () => undefined,
            numbered: () => undefined,
            definitionList: (rows: readonly { label: string; value: string }[]) => {
                lines.push(...rows.map((row) => `${row.label}=${row.value}`));
            },
            section: (title: string, build?: (section: any) => void) => {
                lines.push(`[${title}]`);
                build?.({
                    line: (value: string) => {
                        lines.push(String(value));
                    },
                    blank: () => {
                        lines.push('');
                    },
                    bullets: (items: readonly string[]) => {
                        lines.push(...items.map((item) => `* ${item}`));
                    },
                    checklist: () => undefined,
                    numbered: () => undefined,
                    definitionList: (rows: readonly { label: string; value: string }[]) => {
                        lines.push(...rows.map((row) => `${row.label}=${row.value}`));
                    },
                    section: () => undefined,
                    render: () => lines.join('\n'),
                    items: () => [],
                });
            },
            render: () => lines.join('\n'),
            items: () => [],
        });
    }

    const lines: string[] = [];

    afterEach(() => {
        applyCliUninstallPlanMock.mockClear();
        uninstallHappierServiceMock.mockClear();
    });

    it('shows the current background services before the cleanup actions preview', async () => {
        installOutputBuilderMock();
        const result = await runCleanupSupportCommand(
            { json: false, yes: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hdev',
                    currentReleaseChannel: 'preview',
                    services: [
                        {
                            id: 'systemd-user:happier-daemon.preview.cloud',
                            serviceType: 'daemon',
                            platform: 'linux',
                            backend: 'systemd-user',
                            label: 'happier-daemon.preview.cloud',
                            verification: 'verified',
                            targetMode: 'default-following',
                            ring: 'preview',
                            instanceId: 'cloud',
                            scope: 'user',
                            definitionPath: '/home/tester/.config/systemd/user/happier-daemon.preview.cloud.service',
                            executablePath: '/Users/tester/.happier/cli-preview/current/happier',
                            installed: true,
                            running: true,
                            serverUrl: 'https://relay.preview.example.test',
                            publicServerUrl: 'https://relay.preview.example.test',
                        },
                    ],
                    warnings: [
                        {
                            code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
                            title: 'Version mismatch',
                            severity: 'warning',
                            details: ['happier daemon restart'],
                        },
                    ],
                }),
                presentation: {
                    banner: (title, options) => `banner:${title}:${options?.subtitle ?? ''}`,
                    bullets: (items) => items.map((item) => `* ${item}`).join('\n'),
                    checklist: () => '',
                    definitionList: (rows) => rows.map((row) => `${row.label}=${row.value}`).join('\n'),
                    sectionTitle: (title) => `[${title}]`,
                },
            },
        );

        expect(result.output).toContain('[Current background service]');
        expect(result.output).toContain('happier-daemon.preview.cloud');
        expect(result.output).toContain('default background service');
        expect(result.output).toContain('running');
        expect(result.output).toContain('[Actions]');
    });

    it('previews manual follow-up commands using the preferred Happier CLI shim', async () => {
        const result = await runCleanupSupportCommand(
            { json: true, yes: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'hprev',
                    currentReleaseChannel: 'preview',
                    warnings: [
                        {
                            code: 'DAEMON_STARTED_WITH_DIFFERENT_CLI',
                            title: 'Version mismatch',
                            severity: 'warning',
                            details: ['happier daemon restart'],
                        },
                    ],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            actions: [
                { command: 'hprev daemon restart', reason: 'DAEMON_STARTED_WITH_DIFFERENT_CLI' },
            ],
        });
    });

    it('does not delegate service cleanup through the installed CLI when --yes is provided', async () => {
        const result = await runCleanupSupportCommand(
            { json: true, yes: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    services: [
                        {
                            id: 'launchd:com.happier.cli.daemon.cloud',
                            serviceType: 'daemon',
                            platform: 'darwin',
                            backend: 'launchd',
                            label: 'com.happier.cli.daemon.cloud',
                            verification: 'verified',
                            targetMode: 'pinned',
                            ring: 'stable',
                            instanceId: 'cloud',
                            scope: 'user',
                            definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist',
                            executablePath: '/tmp/orphaned/happier',
                            installed: true,
                            running: false,
                            serverUrl: 'https://api.happier.dev',
                            publicServerUrl: 'https://api.happier.dev',
                        },
                    ],
                    warnings: [
                        {
                            code: 'ORPHAN_DAEMON_SERVICE',
                            title: 'Orphan daemon',
                            severity: 'warning',
                            details: ['happier service repair --yes'],
                        },
                    ],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual(expect.objectContaining({
            ok: true,
            executed: true,
            executedActions: ['remove:com.happier.cli.daemon.cloud'],
        }));
        expect(uninstallHappierServiceMock).toHaveBeenCalledTimes(1);
    });

    it('renders a human-readable applied summary when --yes is provided without --json', async () => {
        installOutputBuilderMock();
        const result = await runCleanupSupportCommand(
            { json: false, yes: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    installations: {
                        activeInvocation: null,
                        installations: [
                            {
                                id: 'npmGlobal:/opt/homebrew/bin/happier',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/bin/happier',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 0,
                                managedRoot: '/opt/homebrew',
                                packageManager: null,
                            },
                            {
                                id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                shimName: null,
                                onPath: false,
                                managedRoot: '/opt/homebrew',
                                packageManager: {
                                    kind: 'npmGlobal',
                                    executablePath: '/opt/homebrew/bin/npm',
                                    packageName: '@happier-dev/cli',
                                },
                            },
                            {
                                id: 'managed:stable:/Users/tester/.happier/cli/current',
                                source: 'firstPartyManaged',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '2.0.0',
                                path: '/Users/tester/.happier/cli/current',
                                realPath: '/Users/tester/.happier/cli/current',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 1,
                                managedRoot: '/Users/tester/.happier/cli',
                                packageManager: null,
                            },
                        ],
                    },
                    services: [],
                    warnings: [{
                        code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                        title: 'Multiple installs on PATH',
                        severity: 'warning',
                        details: ['happier doctor --json'],
                    }],
                }),
                presentation: {
                    banner: (title, options) => `banner:${title}:${options?.subtitle ?? ''}`,
                    bullets: (items) => items.map((item) => `* ${item}`).join('\n'),
                    checklist: () => '',
                    definitionList: (rows) => rows.map((row) => `${row.label}=${row.value}`).join('\n'),
                    sectionTitle: (title) => `[${title}]`,
                },
            },
        );

        expect(result.executed).toBe(true);
        expect(result.output).toContain('banner:Support cleanup applied:1 action(s)');
        expect(result.output).toContain('[Applied]');
        expect(result.output).toContain('/Users/tester/.happier/cli/current');
        expect(result.output).not.toContain('"executedActions"');
    });

    it('previews direct PATH-install cleanup actions for duplicate happier shims', async () => {
        const result = await runCleanupSupportCommand(
            { json: true, yes: false },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    installations: {
                        activeInvocation: null,
                        installations: [
                            {
                                id: 'npmGlobal:/opt/homebrew/bin/happier',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/bin/happier',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 0,
                                managedRoot: '/opt/homebrew',
                                packageManager: null,
                            },
                            {
                                id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                shimName: null,
                                onPath: false,
                                managedRoot: '/opt/homebrew',
                                packageManager: {
                                    kind: 'npmGlobal',
                                    executablePath: '/opt/homebrew/bin/npm',
                                    packageName: '@happier-dev/cli',
                                },
                            },
                            {
                                id: 'managed:stable:/Users/tester/.happier/cli/current',
                                source: 'firstPartyManaged',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '2.0.0',
                                path: '/Users/tester/.happier/cli/current',
                                realPath: '/Users/tester/.happier/cli/current',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 1,
                                managedRoot: '/Users/tester/.happier/cli',
                                packageManager: null,
                            },
                        ],
                    },
                    services: [],
                    warnings: [{
                        code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                        title: 'Multiple installs on PATH',
                        severity: 'warning',
                        details: ['happier doctor --json'],
                    }],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: false,
            actions: [
                {
                    command: 'uninstall Happier CLI at /Users/tester/.happier/cli/current',
                    reason: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                },
            ],
        });
        expect(applyCliUninstallPlanMock).not.toHaveBeenCalled();
    });

    it('previews root-required background-service cleanup as manual follow-up when not running as root', async () => {
        const getuidSpy = typeof process.getuid === 'function'
            ? vi.spyOn(process, 'getuid').mockReturnValue(501)
            : null;
        try {
            const result = await runCleanupSupportCommand(
                { json: true, yes: false },
                {
                    collectMaintenanceContext: async () => ({
                        preferredCliCommand: 'happier',
                        currentReleaseChannel: 'stable',
                        services: [
                            {
                                id: 'systemd-user:happier-daemon.stable.cloud.user',
                                serviceType: 'daemon',
                                platform: 'linux',
                                backend: 'systemd-user',
                                label: 'happier-daemon.stable.cloud.user',
                                verification: 'verified',
                                targetMode: 'default-following',
                                ring: 'stable',
                                instanceId: 'cloud-user',
                                scope: 'user',
                                definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.user.service',
                                executablePath: '/opt/happier/bin/happier',
                                installed: true,
                                running: true,
                                happierHomeDir: '/home/tester/.happier',
                                serverUrl: 'https://api.happier.dev',
                                publicServerUrl: 'https://api.happier.dev',
                            },
                            {
                                id: 'systemd-system:happier-daemon.stable.cloud',
                                serviceType: 'daemon',
                                platform: 'linux',
                                backend: 'systemd-system',
                                label: 'happier-daemon.stable.cloud',
                                verification: 'verified',
                                targetMode: 'default-following',
                                ring: 'stable',
                                instanceId: 'cloud-system',
                                scope: 'system',
                                definitionPath: '/etc/systemd/system/happier-daemon.stable.cloud.service',
                                executablePath: '/opt/happier/bin/happier',
                                installed: true,
                                running: true,
                                happierHomeDir: '/home/tester/.happier',
                                serverUrl: 'https://api.happier.dev',
                                publicServerUrl: 'https://api.happier.dev',
                            },
                        ],
                        warnings: [
                            {
                                code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
                                title: 'Duplicate daemon services',
                                severity: 'warning',
                                details: ['happier service repair --yes'],
                            },
                        ],
                    }),
                },
            );

            expect(JSON.parse(result.output)).toEqual({
                ok: true,
                executed: false,
                actions: [
                    {
                        command: 'sudo npx @happier-dev/support cleanup --yes',
                        reason: 'SYSTEM_BACKGROUND_SERVICE_REPAIR_REQUIRES_ROOT',
                    },
                ],
            });
        } finally {
            getuidSpy?.mockRestore();
        }
    });

    it('executes direct PATH-install cleanup actions for duplicate happier shims', async () => {
        const result = await runCleanupSupportCommand(
            { json: true, yes: true },
            {
                collectMaintenanceContext: async () => ({
                    preferredCliCommand: 'happier',
                    currentReleaseChannel: 'stable',
                    installations: {
                        activeInvocation: null,
                        installations: [
                            {
                                id: 'npmGlobal:/opt/homebrew/bin/happier',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/bin/happier',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli/bin/happier.mjs',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 0,
                                managedRoot: '/opt/homebrew',
                                packageManager: null,
                            },
                            {
                                id: 'npmGlobal:/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                source: 'npmGlobal',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                realPath: '/opt/homebrew/lib/node_modules/@happier-dev/cli',
                                shimName: null,
                                onPath: false,
                                managedRoot: '/opt/homebrew',
                                packageManager: {
                                    kind: 'npmGlobal',
                                    executablePath: '/opt/homebrew/bin/npm',
                                    packageName: '@happier-dev/cli',
                                },
                            },
                            {
                                id: 'managed:stable:/Users/tester/.happier/cli/current',
                                source: 'firstPartyManaged',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '2.0.0',
                                path: '/Users/tester/.happier/cli/current',
                                realPath: '/Users/tester/.happier/cli/current',
                                shimName: 'happier',
                                onPath: true,
                                pathOrder: 1,
                                managedRoot: '/Users/tester/.happier/cli',
                                packageManager: null,
                            },
                        ],
                    },
                    services: [],
                    warnings: [{
                        code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                        title: 'Multiple installs on PATH',
                        severity: 'warning',
                        details: ['happier doctor --json'],
                    }],
                }),
            },
        );

        expect(JSON.parse(result.output)).toEqual({
            ok: true,
            executed: true,
            executedActions: ['uninstall:/Users/tester/.happier/cli/current'],
            actions: [],
        });
        expect(applyCliUninstallPlanMock).toHaveBeenCalledTimes(1);
    });

    it('leaves system-scoped background-service cleanup as manual follow-up when not running as root', async () => {
        const getuidSpy = typeof process.getuid === 'function'
            ? vi.spyOn(process, 'getuid').mockReturnValue(501)
            : null;
        try {
            const result = await runCleanupSupportCommand(
                { json: true, yes: true },
                {
                    collectMaintenanceContext: async () => ({
                        preferredCliCommand: 'happier',
                        currentReleaseChannel: 'stable',
                        services: [
                            {
                                id: 'systemd-user:happier-daemon.stable.cloud.user',
                                serviceType: 'daemon',
                                platform: 'linux',
                                backend: 'systemd-user',
                                label: 'happier-daemon.stable.cloud.user',
                                verification: 'verified',
                                targetMode: 'default-following',
                                ring: 'stable',
                                instanceId: 'cloud-user',
                                scope: 'user',
                                definitionPath: '/home/tester/.config/systemd/user/happier-daemon.stable.cloud.user.service',
                                executablePath: '/opt/happier/bin/happier',
                                installed: true,
                                running: true,
                                happierHomeDir: '/home/tester/.happier',
                                serverUrl: 'https://api.happier.dev',
                                publicServerUrl: 'https://api.happier.dev',
                            },
                            {
                                id: 'systemd-system:happier-daemon.stable.cloud',
                                serviceType: 'daemon',
                                platform: 'linux',
                                backend: 'systemd-system',
                                label: 'happier-daemon.stable.cloud',
                                verification: 'verified',
                                targetMode: 'default-following',
                                ring: 'stable',
                                instanceId: 'cloud-system',
                                scope: 'system',
                                definitionPath: '/etc/systemd/system/happier-daemon.stable.cloud.service',
                                executablePath: '/opt/happier/bin/happier',
                                installed: true,
                                running: true,
                                happierHomeDir: '/home/tester/.happier',
                                serverUrl: 'https://api.happier.dev',
                                publicServerUrl: 'https://api.happier.dev',
                            },
                        ],
                        warnings: [
                            {
                                code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE',
                                title: 'Duplicate daemon services',
                                severity: 'warning',
                                details: ['happier service repair --yes'],
                            },
                        ],
                    }),
                },
            );

            expect(JSON.parse(result.output)).toEqual({
                ok: true,
                executed: true,
                executedActions: [],
                actions: [
                    {
                        command: 'sudo npx @happier-dev/support cleanup --yes',
                        reason: 'SYSTEM_BACKGROUND_SERVICE_REPAIR_REQUIRES_ROOT',
                    },
                ],
            });
            expect(uninstallHappierServiceMock).not.toHaveBeenCalled();
        } finally {
            getuidSpy?.mockRestore();
        }
    });
});
