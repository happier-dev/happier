import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredCredentials } from '@/persistence';

const {
    readSettingsMock,
    readCredentialsMock,
    readStoredCredentialsMock,
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
    readStoredCredentialsMock: vi.fn(
        async (): Promise<StoredCredentials | null> => null,
    ),
    readDaemonStateMock: vi.fn(async (): Promise<Readonly<{
        pid: number;
        httpPort: number;
        startupSource: string;
        serviceLabel: string;
        // Optional on the persisted record, and the readiness fact is what separates a working
        // daemon from a live one that cannot serve a single machine RPC.
        lastHeartbeatAt?: number;
        machineControlReady?: boolean;
    }>> => ({
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
    readStoredCredentials: () => readStoredCredentialsMock(),
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
        readStoredCredentialsMock.mockClear();
        readDaemonStateMock.mockClear();
        resolveDaemonServiceInstallationSnapshotFromEnvMock.mockClear();
        vi.resetModules();
    });

    it('reports token-only credentials as authenticated', async () => {
        const payload = Buffer.from(JSON.stringify({ sub: 'account-token-only' })).toString('base64url');
        readStoredCredentialsMock.mockResolvedValueOnce({
            token: `header.${payload}.signature`,
            encryption: null,
        });

        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        expect(snapshot.auth).toMatchObject({
            authenticated: true,
            accountId: 'account-token-only',
        });
        expect(readStoredCredentialsMock).toHaveBeenCalledOnce();
        expect(readCredentialsMock).not.toHaveBeenCalled();
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

    it('treats an EPERM signal probe as a live daemon owner', async () => {
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
            if (pid === process.pid && signal === 0) {
                throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            }
            return true;
        }) as typeof process.kill);

        try {
            const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

            const snapshot = await readDaemonStatusSnapshot();

            expect(snapshot.daemon.running).toBe(true);
            expect(snapshot.service.running).toBe(true);
        } finally {
            killSpy.mockRestore();
        }
    });

    // `daemon.running` answers "does the process exist"; `daemon.healthy` answers "does the
    // service work". Splitting them is the whole point: a daemon whose machine-control RPC
    // registration never completed is a live process that cannot serve a single RPC, and a
    // PID probe is structurally incapable of saying so.
    it('reports a live daemon that never completed machine-control registration as unhealthy', async () => {
        readDaemonStateMock.mockResolvedValueOnce({
            pid: process.pid,
            httpPort: 53288,
            startupSource: 'background-service',
            serviceLabel: 'com.happier.cli.daemon.default',
            lastHeartbeatAt: Date.now(),
            machineControlReady: false,
        });

        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        // The process is genuinely there — reporting it absent would send repair/start paths
        // after a daemon that already holds the lifecycle lock.
        expect(snapshot.daemon.running).toBe(true);
        expect(snapshot.daemon.healthy).toBe(false);
    });

    it('reports a daemon that completed machine-control registration as healthy', async () => {
        readDaemonStateMock.mockResolvedValueOnce({
            pid: process.pid,
            httpPort: 53288,
            startupSource: 'background-service',
            serviceLabel: 'com.happier.cli.daemon.default',
            lastHeartbeatAt: Date.now(),
            machineControlReady: true,
        });

        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        expect(snapshot.daemon.running).toBe(true);
        expect(snapshot.daemon.healthy).toBe(true);
    });

    // The inconclusive case must stay inconclusive. Two lanes in this program found the
    // opposite anti-pattern — an unknown observation acted on as a definite negative — so a
    // daemon that has published no readiness fact reports unknown, never `false`.
    it('reports unknown, not unhealthy, when the daemon published no readiness fact', async () => {
        readDaemonStateMock.mockResolvedValueOnce({
            pid: process.pid,
            httpPort: 53288,
            startupSource: 'background-service',
            serviceLabel: 'com.happier.cli.daemon.default',
        });

        const { readDaemonStatusSnapshot } = await import('./statusSnapshot');

        const snapshot = await readDaemonStatusSnapshot();

        expect(snapshot.daemon.running).toBe(true);
        expect(snapshot.daemon.healthy).toBeNull();
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
