import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentialsMock = vi.hoisted(() => vi.fn());
const getCredentialsForServerUrlMock = vi.hoisted(() => vi.fn());
const readPendingExternalAuthStateMock = vi.hoisted(() => vi.fn());
const readPendingExternalAuthStateForServerUrlMock = vi.hoisted(() => vi.fn());
const classifyRejectedCredentialMock = vi.hoisted(() => vi.fn());
const setCredentialsMock = vi.hoisted(() => vi.fn());
const isDesktopHostMock = vi.hoisted(() => vi.fn(() => false));
const invokeDesktopHostMock = vi.hoisted(() => vi.fn());

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: (...args: unknown[]) => getCredentialsMock(...args),
        getCredentialsForServerUrl: (...args: unknown[]) => getCredentialsForServerUrlMock(...args),
        readPendingExternalAuthState: (...args: unknown[]) => readPendingExternalAuthStateMock(...args),
        readPendingExternalAuthStateForServerUrl: (...args: unknown[]) =>
            readPendingExternalAuthStateForServerUrlMock(...args),
        classifyPendingExternalAuthFirstKeyRejectedCredential:
            (...args: unknown[]) =>
                classifyRejectedCredentialMock(...args),
        setCredentials: (...args: unknown[]) => setCredentialsMock(...args),
    },
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostMock(),
    invokeDesktopHost: (...args: unknown[]) => invokeDesktopHostMock(...args),
}));

function createStorageMock() {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
}

function stubWebRuntime(href: string): void {
    const localStorage = createStorageMock();
    const sessionStorage = createStorageMock();
    const parsedUrl = new URL(href);
    vi.stubGlobal('window', {
        location: {
            hash: parsedUrl.hash,
            host: parsedUrl.host,
            hostname: parsedUrl.hostname,
            href,
            origin: parsedUrl.origin,
            pathname: parsedUrl.pathname,
            search: parsedUrl.search,
        },
        localStorage,
        history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('document', {});
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('sessionStorage', sessionStorage);
}

describe('resolveBootCredentials', () => {
    beforeEach(() => {
        vi.resetModules();
        getCredentialsMock.mockReset();
        getCredentialsForServerUrlMock.mockReset();
        setCredentialsMock.mockReset();
        setCredentialsMock.mockResolvedValue(true);
        readPendingExternalAuthStateMock.mockReset();
        readPendingExternalAuthStateMock.mockResolvedValue({
            value: null,
            serverMismatch: false,
        });
        readPendingExternalAuthStateForServerUrlMock.mockReset();
        readPendingExternalAuthStateForServerUrlMock.mockResolvedValue({
            value: null,
            serverMismatch: false,
        });
        classifyRejectedCredentialMock.mockReset();
        classifyRejectedCredentialMock.mockResolvedValue({
            kind: 'allowed',
        });
        isDesktopHostMock.mockReset();
        isDesktopHostMock.mockReturnValue(false);
        invokeDesktopHostMock.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('prefers server-scoped credentials and bootstraps the active server when the web location overrides the server', async () => {
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2Flocalhost%3A24731');

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        setServerUrl('https://other.example.test');

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://localhost:24731', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(getCredentialsMock).not.toHaveBeenCalled();
        expect(getServerUrl()).toBe('http://localhost:24731');
    });

    it('keeps the current server and credentials when active custody blocks a web server override', async () => {
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2Flocalhost%3A24731');

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://retained.example.test');
        getCredentialsMock.mockResolvedValue({ token: 'retained-token' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'target-token' });
        readPendingExternalAuthStateMock.mockResolvedValue({
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
            serverMismatch: false,
        });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'retained-token',
        });
        expect(getServerUrl()).toBe('https://retained.example.test');
        expect(getCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(setCredentialsMock).not.toHaveBeenCalled();
    });

    it('falls back to default credentials when no terminal-connect boot override exists for the current route', async () => {
        stubWebRuntime('http://happier.example.test/');
        (globalThis as any).sessionStorage.setItem(
            'happier:terminalConnect:webBootstrapHash:v1',
            '#key=abc123&server=http%3A%2F%2Flocalhost%3A24731',
        );
        getCredentialsMock.mockResolvedValue({ token: 'default-token', secret: 'default-secret' });

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://other.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'default-token', secret: 'default-secret' });
        expect(getCredentialsMock).toHaveBeenCalledTimes(1);
        expect(getCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(getServerUrl()).toBe('https://other.example.test');
        expect((globalThis as any).sessionStorage.getItem('happier:terminalConnect:webBootstrapHash:v1')).toBeNull();
    });

    it('does not adopt the exact first-key bearer rejected before reload', async () => {
        stubWebRuntime('http://happier.example.test/');
        const rejectedCredentials = {
            token: 'rejected-token',
        };
        getCredentialsMock.mockResolvedValue(
            rejectedCredentials,
        );
        classifyRejectedCredentialMock.mockResolvedValue({
            kind: 'rejected',
            pending: {},
        });

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        setServerUrl('https://retained.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toBeNull();
        expect(classifyRejectedCredentialMock)
            .toHaveBeenCalledWith({
                serverUrl:
                    'https://retained.example.test',
                serverId:
                    getActiveServerSnapshot().serverId,
                token: rejectedCredentials.token,
            });
        expect(setCredentialsMock).not.toHaveBeenCalled();
    });

    it('adopts a replacement bearer when the first-key rejection classifier allows it', async () => {
        stubWebRuntime('http://happier.example.test/');
        const replacementCredentials = {
            token: 'replacement-token',
        };
        getCredentialsMock.mockResolvedValue(
            replacementCredentials,
        );
        classifyRejectedCredentialMock.mockResolvedValue({
            kind: 'allowed',
        });

        const { setServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://retained.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves
            .toEqual(replacementCredentials);
        expect(classifyRejectedCredentialMock)
            .toHaveBeenCalledWith(
                expect.objectContaining({
                    serverUrl:
                        'https://retained.example.test',
                    token:
                        replacementCredentials.token,
                }),
            );
    });

    it('falls back to stack-owned desktop boot credentials when a stack Tauri app has no persisted UI credentials yet', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });

        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://127.0.0.1:3009', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(getCredentialsMock).not.toHaveBeenCalled();
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_read_stack_boot_credentials');
        expect(setCredentialsMock).toHaveBeenCalledWith({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
    });

    it('persists token-only stack desktop boot credentials without fabricating account encryption material', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'stack-token-only',
            encryption: null,
        });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'stack-token-only',
        });
        expect(setCredentialsMock).toHaveBeenCalledWith({
            token: 'stack-token-only',
        });
    });

    it('does not adopt imported desktop credentials when marked first-key custody refuses replacement', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'replacement-token',
            encryption: null,
        });
        getCredentialsMock.mockResolvedValue({
            token: 'retained-token',
        });
        readPendingExternalAuthStateForServerUrlMock.mockResolvedValue({
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
            serverMismatch: false,
        });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'retained-token',
        });
        expect(setCredentialsMock).not.toHaveBeenCalled();
    });

    it('does not adopt imported desktop credentials when credential persistence is refused', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'replacement-token',
            encryption: null,
        });
        getCredentialsMock.mockResolvedValue({
            token: 'retained-token',
        });
        setCredentialsMock.mockResolvedValue(false);

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'retained-token',
        });
    });

    it('activates the stack runtime server before persisting desktop boot credentials without an explicit override', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://other.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
        expect(getServerUrl()).toBe('http://127.0.0.1:3009');
        expect(setCredentialsMock).toHaveBeenCalledWith({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
    });

    it('prefers stack-runtime scoped credentials over unrelated active-server credentials in stack Tauri mode', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsMock.mockResolvedValue({ token: 'other-token', secret: 'other-secret' });
        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        setServerUrl('https://other.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getServerUrl()).toBe('http://127.0.0.1:3009');
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://127.0.0.1:3009', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(getCredentialsMock).not.toHaveBeenCalled();
    });

    it('keeps the current server and credentials when active custody blocks stack runtime activation', async () => {
        stubWebRuntime('http://localhost:8081/');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsMock.mockResolvedValue({
            token: 'retained-token',
        });
        getCredentialsForServerUrlMock.mockResolvedValue({
            token: 'stack-token',
        });
        readPendingExternalAuthStateMock.mockResolvedValue({
            value: {
                accountEncryptionFirstKey: {
                    migrationSubmissionAttempted: true,
                },
            },
            serverMismatch: false,
        });

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        setServerUrl('https://retained.example.test');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'retained-token',
        });
        expect(getServerUrl()).toBe('https://retained.example.test');
        expect(getCredentialsForServerUrlMock).not.toHaveBeenCalled();
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
        expect(setCredentialsMock).not.toHaveBeenCalled();
    });

    it('falls back to stack-owned desktop boot credentials when the active stack server is selected but no server-scoped UI credentials exist yet', async () => {
        stubWebRuntime('http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3009');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });

        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://127.0.0.1:3009', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(invokeDesktopHostMock).toHaveBeenCalledWith('desktop_read_stack_boot_credentials');
        expect(setCredentialsMock).toHaveBeenCalledWith({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });
    });

    it('does not reuse stack desktop boot credentials for a different boot server URL', async () => {
        stubWebRuntime('http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3010');
        (globalThis as any).window.__HAPPIER_WEB_RUNTIME_CONFIG__ = {
            serverUrl: 'http://127.0.0.1:3009',
            serverContext: 'stack',
        };
        isDesktopHostMock.mockReturnValue(true);
        getCredentialsForServerUrlMock.mockResolvedValue(null);
        invokeDesktopHostMock.mockResolvedValue({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        });

        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toBeNull();
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://127.0.0.1:3010', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(invokeDesktopHostMock).not.toHaveBeenCalled();
        expect(setCredentialsMock).not.toHaveBeenCalled();
    });

    it('prefers server-scoped credentials when booting from a terminal-connect hash stored in sessionStorage', async () => {
        stubWebRuntime('http://happier.example.test/terminal/connect');
        (globalThis as any).sessionStorage.setItem(
            'happier:terminalConnect:webBootstrapHash:v1',
            '#key=abc123&server=http%3A%2F%2Flocalhost%3A24731',
        );

        const { setServerUrl, getServerUrl } = await import('@/sync/domains/server/serverConfig');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        setServerUrl('https://other.example.test');

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'hash-token', secret: 'hash-secret' });

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'hash-token', secret: 'hash-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://localhost:24731', {
            serverId: getActiveServerSnapshot().serverId,
        });
        expect(getCredentialsMock).not.toHaveBeenCalled();
        expect(getServerUrl()).toBe('http://localhost:24731');
    });

    it('preserves the explicit active server id when equivalent server profiles already exist for the boot URL', async () => {
        const storageScope = `resolve_boot_${Date.now()}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = storageScope;
        stubWebRuntime('http://happier.example.test/?server=http%3A%2F%2F127.0.0.1%3A3009');

        const { scopedStorageId } = await import('@/utils/system/storageScope');
        globalThis.localStorage.setItem(
            `${scopedStorageId('server-profiles', storageScope)}:server-state-v1`,
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'manual-id',
                servers: {
                    'stack-id': {
                        id: 'stack-id',
                        name: 'Stack Seeded',
                        serverUrl: 'http://localhost:3009',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 0,
                        source: 'stack-env',
                    },
                    'manual-id': {
                        id: 'manual-id',
                        name: 'Manual Active',
                        serverUrl: 'http://127.0.0.1:3009',
                        createdAt: 150,
                        updatedAt: 250,
                        lastUsedAt: 999,
                        source: 'manual',
                    },
                },
            }),
        );

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe('manual-id');

        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://127.0.0.1:3009', {
            serverId: 'manual-id',
        });
        expect(getActiveServerSnapshot().serverId).toBe('manual-id');
    });

    it('does not rewrite an equivalent stack relay profile url when terminal-connect boot uses another loopback alias', async () => {
        const storageScope = `resolve_boot_stack_${Date.now()}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = storageScope;
        stubWebRuntime('http://happier-stack.localhost:24541/terminal/connect#key=abc123&server=http%3A%2F%2Flocalhost%3A24541');

        const { scopedStorageId } = await import('@/utils/system/storageScope');
        globalThis.localStorage.setItem(
            `${scopedStorageId('server-profiles', storageScope)}:server-state-v1`,
            JSON.stringify({
                activeServerIdIsExplicit: true,
                activeServerId: 'stack-id',
                servers: {
                    'stack-id': {
                        id: 'stack-id',
                        name: 'Stack Seeded',
                        serverUrl: 'http://happier-stack.localhost:24541',
                        createdAt: 100,
                        updatedAt: 200,
                        lastUsedAt: 300,
                        source: 'stack-env',
                    },
                },
            }),
        );

        getCredentialsForServerUrlMock.mockResolvedValue({ token: 'stack-token', secret: 'stack-secret' });

        const { getActiveServerId, getActiveServerUrl } = await import('@/sync/domains/server/serverProfiles');
        const { resolveBootCredentials } = await import('./resolveBootCredentials');
        await expect(resolveBootCredentials('web')).resolves.toEqual({ token: 'stack-token', secret: 'stack-secret' });
        expect(getCredentialsForServerUrlMock).toHaveBeenCalledWith('http://localhost:24541', {
            serverId: 'stack-id',
        });
        expect(getActiveServerId()).toBe('stack-id');
        expect(getActiveServerUrl()).toBe('http://happier-stack.localhost:24541');
    });

});
