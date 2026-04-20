import { afterEach, describe, expect, it, vi } from 'vitest';

const {
    readSettingsMock,
    readCredentialsMock,
    readDaemonStateMock,
    resolveDaemonServiceInstallationSnapshotFromEnvMock,
} = vi.hoisted(() => ({
    readSettingsMock: vi.fn(async () => ({
        servers: {
            cloud: {
                id: 'cloud',
                localServerUrl: 'http://127.0.0.1:53288',
            },
        },
    })),
    readCredentialsMock: vi.fn(async () => null),
    readDaemonStateMock: vi.fn(async () => ({
        pid: process.pid,
        httpPort: 53288,
        startupSource: 'background-service',
        serviceLabel: 'com.happier.cli.daemon.default',
    })),
    resolveDaemonServiceInstallationSnapshotFromEnvMock: vi.fn(async () => ({
        platform: 'darwin' as const,
        installed: false,
        installedPath: '/tmp/com.happier.cli.daemon.default.plist',
        label: 'com.happier.cli.daemon.default',
    })),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        activeServerId: 'cloud',
        serverUrl: 'http://127.0.0.1:53288',
        publicServerUrl: 'http://127.0.0.1:53288',
        webappUrl: 'http://127.0.0.1:19364',
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: () => readSettingsMock(),
    readCredentials: () => readCredentialsMock(),
    readDaemonState: () => readDaemonStateMock(),
}));

vi.mock('@/daemon/service/cli', () => ({
    resolveDaemonServiceInstallationSnapshotFromEnv: () =>
        resolveDaemonServiceInstallationSnapshotFromEnvMock(),
}));

describe('readDaemonStatusSnapshot', () => {
    afterEach(() => {
        readSettingsMock.mockClear();
        readCredentialsMock.mockClear();
        readDaemonStateMock.mockClear();
        resolveDaemonServiceInstallationSnapshotFromEnvMock.mockClear();
        vi.resetModules();
    });

    it('treats a matching running background-service owner as installed even when the filesystem probe lags', async () => {
        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        expect(snapshot.daemon.serviceManaged).toBe(true);
        expect(snapshot.daemon.serviceLabel).toBe('com.happier.cli.daemon.default');
        expect(snapshot.service).toEqual({
            installed: true,
            running: true,
        });
    });

    it('keeps service.installed false when the running service label does not match the expected installation', async () => {
        readDaemonStateMock.mockResolvedValueOnce({
            pid: process.pid,
            httpPort: 53288,
            startupSource: 'background-service',
            serviceLabel: 'com.happier.cli.daemon.other',
        });

        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        expect(snapshot.daemon.serviceManaged).toBe(true);
        expect(snapshot.daemon.serviceLabel).toBe('com.happier.cli.daemon.other');
        expect(snapshot.service).toEqual({
            installed: false,
            running: false,
        });
    });
});
