import { describe, expect, it, vi } from 'vitest';

import type { HappierService } from '@happier-dev/cli-common/happierRuntime';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';

import {
    resolveInstalledDefaultFollowingDaemonServiceModes,
    runDefaultFollowingBackgroundServiceRestartFollowUp,
    runDefaultFollowingBackgroundServiceServerChangeFollowUp,
} from './backgroundServiceFollowUp';

function createServiceInventoryEntry(overrides: Partial<HappierService> = {}): HappierService {
    return {
        id: 'svc-default',
        serviceType: 'daemon',
        verification: 'verified',
        installed: true,
        running: true,
        scope: 'user',
        ring: null,
        instanceId: null,
        definitionPath: '/tmp/happier-daemon.default.service',
        executablePath: '/tmp/happier',
        platform: 'linux',
        backend: 'systemd-user',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
        ...overrides,
    };
}

function createDaemonServiceListEntry(overrides: Partial<DaemonServiceListEntry> = {}): DaemonServiceListEntry {
    return {
        serverId: 'default',
        name: 'Default background service',
        installed: true,
        path: '/tmp/happier-daemon.default.service',
        platform: 'linux',
        releaseChannel: 'stable',
        label: 'happier-daemon.default',
        targetMode: 'default-following',
        ...overrides,
    };
}

describe('server background service follow-up helpers', () => {
    it('restarts a default-following background service after an authenticated interactive server change', async () => {
        const promptInput = vi.fn(async () => 'y');
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput,
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            hasCredentials: true,
            log: vi.fn(),
            services: [createDaemonServiceListEntry()],
        });

        expect(promptInput).toHaveBeenCalledWith(
            'Restart the background service so it now follows https://b.example.test? [Y/n]: ',
        );
        expect(runCliAction).toHaveBeenCalledWith(['service', 'restart']);
    });

    it('logs auth + restart guidance when authentication is declined', async () => {
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput: async () => 'n',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            hasCredentials: false,
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(output.join('\n')).toContain('Background service was not restarted');
        expect(output.join('\n')).toContain('happier auth login');
        expect(output.join('\n')).toContain('happier service restart');
    });

    it('logs manual restart guidance in non-interactive mode', async () => {
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            hasCredentials: true,
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(output.join('\n')).toContain('happier service restart');
        expect(output.join('\n')).toContain('https://b.example.test');
    });

    it('renders system-mode restart commands for system inventory entries', async () => {
        const output: string[] = [];
        const services: HappierService[] = [
            createServiceInventoryEntry({
                backend: 'systemd-system',
                scope: 'system',
                definitionPath: '/etc/systemd/system/happier-daemon.default.service',
            }),
        ];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            hasCredentials: true,
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry({
                path: '/etc/systemd/system/happier-daemon.default.service',
            })],
        });

        expect(resolveInstalledDefaultFollowingDaemonServiceModes(services)).toEqual(['system']);
        expect(output.join('\n')).toContain('happier service restart --mode system');
    });

    it('prefers explicit daemon service list entry mode over path heuristics', async () => {
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            hasCredentials: true,
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry({
                mode: 'system',
                path: '/tmp/happier-daemon.default.service',
            })],
        });

        expect(resolveInstalledDefaultFollowingDaemonServiceModes([
            createDaemonServiceListEntry({
                mode: 'system',
                path: '/tmp/happier-daemon.default.service',
            }),
        ])).toEqual(['system']);
        expect(output.join('\n')).toContain('happier service restart --mode system');
    });

    it('fails closed with repair guidance when duplicate user and system default-following services exist', async () => {
        const output: string[] = [];
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput: async () => 'y',
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            hasCredentials: true,
            log: (message) => output.push(message),
            services: [
                createDaemonServiceListEntry({ path: '/tmp/happier-daemon.default.service' }),
                createDaemonServiceListEntry({ path: '/etc/systemd/system/happier-daemon.default.service' }),
            ],
        });

        expect(runCliAction).not.toHaveBeenCalled();
        expect(output.join('\n')).toContain('Multiple default-following background services are installed');
        expect(output.join('\n')).toContain('happier service repair --yes');
    });

    it('warns instead of failing when restart follow-up execution fails after the primary action already applied', async () => {
        const output: string[] = [];

        await expect(runDefaultFollowingBackgroundServiceRestartFollowUp({
            interactive: true,
            promptInput: async () => 'y',
            runCliAction: async () => {
                throw new Error('restart failed');
            },
            subject: 'https://b.example.test',
            modes: ['user'],
            log: (message) => output.push(message),
        })).resolves.toBe(false);

        expect(output.join('\n')).toContain('Background service follow-up failed');
        expect(output.join('\n')).toContain('happier service restart');
    });
});
