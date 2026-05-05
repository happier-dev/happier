import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { DoctorSnapshot } from '@happier-dev/protocol';

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'machine.runtimeSummary' && params) {
                return `summary:${String(params.cliVersion ?? '')}:${String(params.daemonVersion ?? '')}:${String(params.daemonRing ?? '')}:${String(params.installationCount ?? '')}:${String(params.serviceCount ?? '')}:${String(params.warningCount ?? '')}`;
            }
            if (key === 'machine.backgroundServiceModes.defaultFollowing') return 'default background service';
            if (key === 'machine.backgroundServiceModes.legacyPinned') return 'legacy pinned background service';
            if (key === 'machine.backgroundServiceModes.generic') return 'background service';
            return key;
        },
    });
});

describe('MachineDoctorRuntimeInventorySection', () => {
    it('renders a summary plus installations, services, and warnings', async () => {
        const { MachineDoctorRuntimeInventorySection } = await import('./MachineDoctorRuntimeInventorySection');

        const snapshot: DoctorSnapshot = {
            capturedAt: '2026-04-07T10:11:12.000Z',
            server: {
                activeServerId: 'cloud',
                serverUrl: 'https://api.happier.dev',
                publicServerUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
            },
            accountId: 'acct_1',
            settings: {
                activeServerId: 'cloud',
                servers: [],
                knownAccountIds: ['acct_1'],
            },
            daemonStatus: {
                server: {
                    activeServerId: 'cloud',
                    serverUrl: 'https://api.happier.dev',
                    localServerUrl: 'http://127.0.0.1:3005',
                    publicServerUrl: 'https://api.happier.dev',
                    webappUrl: 'https://app.happier.dev',
                    comparableKey: 'https://api.happier.dev',
                },
                daemon: {
                    running: true,
                    pid: 1234,
                    httpPort: 3005,
                    startedWithCliVersion: '1.2.0',
                    startedWithPublicReleaseChannel: 'stable',
                },
                service: { installed: true, running: true },
                auth: {
                    authenticated: true,
                    machineRegistered: true,
                    machineId: 'machine_1',
                    needsAuth: false,
                    accountId: 'acct_1',
                },
            },
            installations: {
                happier: {
                    activeInvocation: {
                        path: '/opt/happier/bin/happier',
                        realPath: '/opt/happier/bin/happier',
                        invokerName: 'happier',
                        ring: 'preview',
                        version: '1.2.3',
                        installationId: 'managed:preview:/opt/happier/cli-preview/current',
                    },
                    installations: [
                        {
                            id: 'managed:preview:/opt/happier/cli-preview/current',
                            source: 'firstPartyManaged',
                            components: ['happier-cli', 'happier-daemon'],
                            ring: 'preview',
                            version: '1.2.3',
                            path: '/opt/happier/cli-preview/current',
                            realPath: '/opt/happier/cli-preview/current',
                            shimName: 'hprev',
                            onPath: true,
                            managedRoot: '/opt/happier/cli-preview',
                        },
                        {
                            id: 'pathBinary:/usr/local/bin/happier',
                            source: 'pathBinary',
                            components: ['happier-cli', 'happier-daemon'],
                            ring: 'stable',
                            version: '1.0.0',
                            path: '/usr/local/bin/happier',
                            realPath: '/usr/local/bin/happier',
                            shimName: 'happier',
                            onPath: true,
                            managedRoot: null,
                        },
                    ],
                },
            },
            services: {
                happier: {
                    services: [
                        {
                            id: 'daemon:com.happier.cli.daemon.preview.cloud',
                            serviceType: 'daemon',
                            platform: 'darwin',
                            backend: 'launchd',
                            label: 'com.happier.cli.daemon.preview.cloud',
                            verification: 'verified',
                            targetMode: 'default-following',
                            ring: 'preview',
                            instanceId: 'cloud',
                            scope: 'user',
                            definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.cloud.plist',
                            executablePath: '/opt/happier/cli-preview/current/happier',
                            serverUrl: 'https://relay.preview.example.test',
                            publicServerUrl: 'https://relay.preview.example.test',
                            installed: true,
                            running: true,
                        },
                        {
                            id: 'stack-service:dev.happier.stack.dev-built',
                            serviceType: 'stack-service',
                            platform: 'darwin',
                            backend: 'launchd',
                            label: 'dev.happier.stack.dev-built',
                            verification: 'verified',
                            ring: null,
                            instanceId: 'dev-built',
                            scope: 'user',
                            definitionPath: '/Users/tester/Library/LaunchAgents/dev.happier.stack.dev-built.plist',
                            executablePath: '/opt/happier-stack/bin/hstack',
                            installed: true,
                            running: false,
                        },
                    ],
                },
            },
            repairSummary: {
                schemaVersion: 1,
                status: 'needs_attention',
                findingCounts: {
                    total: 2,
                    warning: 1,
                    error: 1,
                    actionable: 1,
                },
                findingKinds: ['background_service_not_running'],
            },
            localRelays: {
                relays: [
                    {
                        id: 'local-relay-preview',
                        releaseChannel: 'preview',
                        relayUrl: 'http://127.0.0.1:3025',
                        version: '1.2.3-preview.1',
                        installed: true,
                        running: true,
                        healthy: true,
                        serviceEnabled: true,
                        port: 3025,
                        installRoot: '/opt/happier/relay-preview',
                    },
                ],
            },
            warnings: [
                {
                    code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                    severity: 'warning',
                    message: 'Multiple Happier CLI installations were detected on PATH.',
                    repairCommands: ['happier doctor --json'],
                },
            ],
        };

        const screen = await renderScreen(React.createElement(MachineDoctorRuntimeInventorySection, {
            snapshotState: { status: 'ready', snapshot, cachedAt: 123, source: 'rpc' },
            mode: 'details',
        }));
        const text = screen.getTextContent();

        expect(screen.findByTestId('machine-runtime-inventory-cli')).toBeTruthy();
        expect(screen.findByTestId('machine-runtime-inventory-daemon')).toBeTruthy();
        expect(screen.findByTestId('machine-runtime-inventory-summary')).toBeTruthy();
        expect(screen.findByTestId('machine-runtime-inventory-repair-summary')).toBeTruthy();
        expect(screen.findByTestId('machine-runtime-inventory-local-relays')).toBeTruthy();
        expect(text).toContain('machine.runtimeInventory');
        expect(text).toContain('summary:1.2.3:1.2.0:stable:1:2:1');
        expect(text).toContain('machine.doctorRepairSummary');
        expect(text).toContain('machine.doctorRepairFindingsSummary');
        expect(text).toContain('machine.localRelays');
        expect(text).toContain('local-relay-preview');
        expect(text).toContain('machine.cliVersion');
        expect(text).toContain('/opt/happier/bin/happier');
        expect(text).toContain('com.happier.cli.daemon.preview.cloud');
        expect(text).toContain('default background service');
        expect(text).toContain('https://relay.preview.example.test');
        expect(text).toContain('dev.happier.stack.dev-built');
        expect(text).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    });

    it('matches Windows service executables to installation roots when deriving the service version', async () => {
        const { MachineDoctorRuntimeInventorySection } = await import('./MachineDoctorRuntimeInventorySection');

        const snapshot: DoctorSnapshot = {
            capturedAt: '2026-04-07T10:11:12.000Z',
            server: {
                activeServerId: 'cloud',
                serverUrl: 'https://api.happier.dev',
                publicServerUrl: 'https://api.happier.dev',
                webappUrl: 'https://app.happier.dev',
            },
            accountId: 'acct_1',
            settings: {
                activeServerId: 'cloud',
                servers: [],
                knownAccountIds: ['acct_1'],
            },
            daemonStatus: {
                server: {
                    activeServerId: 'cloud',
                    serverUrl: 'https://api.happier.dev',
                    localServerUrl: null,
                    publicServerUrl: 'https://api.happier.dev',
                    webappUrl: 'https://app.happier.dev',
                    comparableKey: 'https://api.happier.dev',
                },
                daemon: {
                    running: true,
                    pid: 1234,
                    httpPort: 3005,
                    startedWithCliVersion: '2.3.4',
                    startedWithPublicReleaseChannel: 'preview',
                },
                service: { installed: true, running: true },
                auth: {
                    authenticated: true,
                    machineRegistered: true,
                    machineId: 'machine_1',
                    needsAuth: false,
                    accountId: 'acct_1',
                },
            },
            installations: {
                happier: {
                    activeInvocation: {
                        path: 'C:\\Program Files\\Happier\\bin\\hprev.cmd',
                        realPath: 'C:\\Program Files\\Happier\\bin\\hprev.cmd',
                        invokerName: 'hprev',
                        ring: 'preview',
                        version: 'active-cli',
                        installationId: 'managed:preview:C:\\Program Files\\Happier\\cli-preview\\current',
                    },
                    installations: [
                        {
                            id: 'managed:preview:C:\\Program Files\\Happier\\cli-preview\\current',
                            source: 'firstPartyManaged',
                            components: ['happier-cli', 'happier-daemon'],
                            ring: 'preview',
                            version: '2.3.4',
                            path: 'C:\\Program Files\\Happier\\cli-preview\\current',
                            realPath: 'C:\\Program Files\\Happier\\cli-preview\\current',
                            shimName: 'hprev',
                            onPath: true,
                            managedRoot: 'C:\\Program Files\\Happier\\cli-preview',
                        },
                    ],
                },
            },
            services: {
                happier: {
                    services: [
                        {
                            id: 'daemon:happier-preview',
                            serviceType: 'daemon',
                            platform: 'win32',
                            backend: 'schtasks-user',
                            label: 'Happier Preview',
                            verification: 'verified',
                            ring: 'preview',
                            instanceId: 'machine-1',
                            scope: 'user',
                            definitionPath: 'C:\\Users\\tester\\AppData\\Roaming\\Happier\\daemon.ps1',
                            executablePath: 'c:\\program files\\happier\\CLI-Preview\\current\\happier.exe',
                            installed: true,
                            running: true,
                        },
                    ],
                },
            },
        };

        const screen = await renderScreen(React.createElement(MachineDoctorRuntimeInventorySection, {
            snapshotState: { status: 'ready', snapshot, cachedAt: 123, source: 'rpc' },
            mode: 'details',
        }));

        expect(screen.getTextContent()).toContain(
            'c:/program files/happier/CLI-Preview/current/happier.exe 2.3.4',
        );
    });
});
