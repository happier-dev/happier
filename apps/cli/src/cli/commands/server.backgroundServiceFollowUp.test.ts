import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HappierService } from '@happier-dev/cli-common/happierRuntime';
import type { DaemonServiceListEntry } from '@/daemon/service/cli';

const {
    axiosGetMock,
    readStoredCredentialsMock,
    resolveInstalledDaemonServiceInventoryMock,
} = vi.hoisted(() => ({
    axiosGetMock: vi.fn(),
    readStoredCredentialsMock: vi.fn(async (): Promise<{ token: string; encryption: null } | null> => null),
    resolveInstalledDaemonServiceInventoryMock: vi.fn<
        (...args: unknown[]) => Promise<readonly DaemonServiceListEntry[]>
    >(async () => []),
}));

vi.mock('axios', async () => {
    const actual = await vi.importActual<typeof import('axios')>('axios');
    return {
        ...actual,
        default: {
            ...actual.default,
            get: (...args: unknown[]) => axiosGetMock(...args),
        },
        get: (...args: unknown[]) => axiosGetMock(...args),
    };
});

vi.mock('@/api/client/loopbackUrl', () => ({
    resolveLoopbackHttpUrl: (value: string) => value,
}));

vi.mock('@/configuration', () => ({
    configuration: {
        apiServerUrl: 'https://api.example.test',
        publicReleaseRing: 'stable',
    },
}));

vi.mock('@/persistence', () => ({
    readStoredCredentials: () => readStoredCredentialsMock(),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
    resolveInstalledDaemonServiceInventoryForCurrentRelay: (...args: unknown[]) =>
        resolveInstalledDaemonServiceInventoryMock(...args),
}));

import {
    resolveInstalledDefaultFollowingDaemonServiceModes,
    runDefaultFollowingBackgroundServiceRestartFollowUp,
    runDefaultFollowingBackgroundServiceServerChangeFollowUp,
    runServerSelectionBackgroundServiceFollowUp,
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
    afterEach(() => {
        readStoredCredentialsMock.mockReset();
        readStoredCredentialsMock.mockResolvedValue(null);
        axiosGetMock.mockReset();
        resolveInstalledDaemonServiceInventoryMock.mockReset();
        resolveInstalledDaemonServiceInventoryMock.mockResolvedValue([]);
        delete process.env.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP;
    });

    it('defers the child command follow-up while guided setup owns the larger sequence', async () => {
        process.env.HAPPIER_DEFER_SERVER_SELECTION_FOLLOW_UP = '1';

        await runServerSelectionBackgroundServiceFollowUp({
            interactive: true,
            targetServerUrl: 'https://relay.example.test',
        });

        expect(resolveInstalledDaemonServiceInventoryMock).not.toHaveBeenCalled();
    });

    it('restarts a default-following background service after an authenticated interactive server change', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

        const promptInput = vi.fn(async () => 'y');
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput,
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: vi.fn(),
            services: [createDaemonServiceListEntry()],
        });

        expect(promptInput).toHaveBeenCalledWith(
            'Restart the background service so it now follows https://b.example.test? [Y/n]: ',
        );
        expect(promptInput).toHaveBeenCalledTimes(1);
        expect(axiosGetMock).toHaveBeenCalledWith(
            'https://b.example.test/v1/account/profile',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer token-123',
                }),
            }),
        );
        expect(runCliAction).toHaveBeenCalledWith(['service', 'restart']);
    });

    it('logs auth + restart guidance when authentication is declined', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce(null);
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput: async () => 'n',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_out',
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(output.join('\n')).toContain('Background service was not restarted');
        expect(output.join('\n')).toContain('happier auth login');
        expect(output.join('\n')).toContain('happier service restart');
    });

    it('prompts for authentication when the profile probe returns an auth failure through the shared carrier shape', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockRejectedValueOnce({
            response: { status: 403 },
        });

        const promptInput = vi.fn(async (prompt: string) => prompt.includes('Authenticate Happier') ? 'n' : 'y');
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput,
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(promptInput).toHaveBeenCalledWith('Authenticate Happier against https://b.example.test now? [Y/n]: ');
        expect(output.join('\n')).toContain('happier auth login');
    });

    it('logs manual restart guidance in non-interactive mode', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce(null);
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(output.join('\n')).toContain('happier service restart');
        expect(output.join('\n')).toContain('https://b.example.test');
    });

    it('renders system-mode restart commands for system inventory entries', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

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
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry({
                path: '/etc/systemd/system/happier-daemon.default.service',
            })],
        });

        expect(resolveInstalledDefaultFollowingDaemonServiceModes(services)).toEqual(['system']);
        expect(output.join('\n')).toContain('happier service restart --mode system');
    });

    it('prefers explicit daemon service list entry mode over path heuristics', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction: vi.fn(async () => undefined),
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
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
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

        const output: string[] = [];
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput: async () => 'y',
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [
                createDaemonServiceListEntry({ path: '/tmp/happier-daemon.default.service' }),
                createDaemonServiceListEntry({ path: '/etc/systemd/system/happier-daemon.default.service' }),
            ],
        });

        expect(runCliAction).not.toHaveBeenCalled();
        expect(output.join('\n')).toContain('Multiple default-following background services are installed');
        expect(output.join('\n')).toContain('sudo happier service repair --yes');
    });

    it('requires repair guidance when a default-following service is missing Happier home metadata', async () => {
        const output: string[] = [];
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: false,
            promptInput: async () => '',
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [
                createDaemonServiceListEntry({
                    releaseChannel: 'preview',
                    happierHomeDir: null,
                }),
            ],
        });

        expect(runCliAction).not.toHaveBeenCalled();
        expect(output.join('\n')).toContain('missing Happier home metadata');
        expect(output.join('\n')).toContain('happier service repair --yes');
    });

    it('prompts to authenticate when stored credentials are no longer accepted by the target server', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockRejectedValueOnce({
            isAxiosError: true,
            response: { status: 401 },
        });

        const promptInput = vi.fn(async () => 'y');
        const runCliAction = vi.fn(async () => undefined);
        const output: string[] = [];

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput,
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_in',
            log: (message) => output.push(message),
            services: [createDaemonServiceListEntry()],
        });

        expect(promptInput).toHaveBeenNthCalledWith(
            1,
            'Authenticate Happier against https://b.example.test now? [Y/n]: ',
        );
        expect(promptInput).toHaveBeenNthCalledWith(
            2,
            'Restart the background service so it now follows https://b.example.test? [Y/n]: ',
        );
        expect(runCliAction).toHaveBeenCalledWith(['auth', 'login']);
        expect(runCliAction).toHaveBeenCalledWith(['service', 'restart']);
        expect(output.join('\n')).not.toContain('not authenticated yet');
    });

    it('trusts an explicit logged_out auth state instead of probing stored credentials again', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

        const promptInput = vi.fn(async () => 'y');
        const runCliAction = vi.fn(async () => undefined);

        await runDefaultFollowingBackgroundServiceServerChangeFollowUp({
            interactive: true,
            promptInput,
            runCliAction,
            targetServerUrl: 'https://b.example.test',
            authState: 'logged_out',
            log: vi.fn(),
            services: [createDaemonServiceListEntry()],
        });

        expect(axiosGetMock).not.toHaveBeenCalled();
        expect(promptInput).toHaveBeenNthCalledWith(
            1,
            'Authenticate Happier against https://b.example.test now? [Y/n]: ',
        );
        expect(promptInput).toHaveBeenNthCalledWith(
            2,
            'Restart the background service so it now follows https://b.example.test? [Y/n]: ',
        );
        expect(runCliAction).toHaveBeenCalledWith(['auth', 'login']);
        expect(runCliAction).toHaveBeenCalledWith(['service', 'restart']);
    });

    it('warns instead of failing when restart follow-up execution fails after the primary action already applied', async () => {
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: 'token-123',
            encryption: null,
        });
        axiosGetMock.mockResolvedValueOnce({
            status: 200,
            data: { id: 'account-123' },
        });

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
