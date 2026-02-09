import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/tokenStorage';

const mocks = vi.hoisted(() => ({
    registerPushToken: vi.fn(),
    listServerProfiles: vi.fn(),
    getActiveServerSnapshot: vi.fn(),
    getCredentialsForServerUrl: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}));

vi.mock('../apiPush', () => ({
    registerPushToken: mocks.registerPushToken,
}));

vi.mock('../serverProfiles', () => ({
    listServerProfiles: mocks.listServerProfiles,
}));

vi.mock('../serverRuntime', () => ({
    getActiveServerSnapshot: mocks.getActiveServerSnapshot,
}));

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: mocks.getCredentialsForServerUrl,
    },
}));

const secretPushToken = 'ExponentPushToken[secret-token]';

function collectLogs(): { messages: string[]; log: { log: (message: string) => void } } {
    const messages: string[] = [];
    return {
        messages,
        log: {
            log: (message: string) => {
                messages.push(message);
            },
        },
    };
}

function profileCredentials(serverUrl: string): AuthCredentials {
    return {
        token: `token-${serverUrl}`,
        secret: `secret-${serverUrl}`,
    };
}

async function arrangeNotifications(): Promise<void> {
    const notifications = await import('expo-notifications');
    vi.mocked(notifications.getPermissionsAsync).mockResolvedValue({ status: 'granted' } as never);
    vi.mocked(notifications.requestPermissionsAsync).mockResolvedValue({ status: 'granted' } as never);
    vi.mocked(notifications.getExpoPushTokenAsync).mockResolvedValue({ data: secretPushToken } as never);
}

beforeEach(() => {
    mocks.registerPushToken.mockResolvedValue({ ok: true });
    mocks.listServerProfiles.mockReturnValue([]);
    mocks.getActiveServerSnapshot.mockReturnValue({
        serverId: 'active',
        serverUrl: 'https://active.example.test',
        kind: 'custom',
        generation: 1,
    });
    mocks.getCredentialsForServerUrl.mockImplementation(async (serverUrl: string) => profileCredentials(serverUrl));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('registerPushTokenIfAvailable logging', () => {
    it('does not log the raw push token', async () => {
        await arrangeNotifications();
        mocks.listServerProfiles.mockReturnValue([{ serverUrl: 'https://active.example.test' }]);
        const { messages, log } = collectLogs();
        const { registerPushTokenIfAvailable } = await import('./account');

        await registerPushTokenIfAvailable({
            credentials: { token: 'active-token', secret: 'active-secret' },
            log,
        });

        expect(messages.join('\n')).not.toContain(secretPushToken);
        expect(mocks.registerPushToken).toHaveBeenCalledTimes(1);
    });

    it('continues registration for remaining profiles when the first profile fails', async () => {
        await arrangeNotifications();
        mocks.listServerProfiles.mockReturnValue([
            { serverUrl: 'https://s1.example.test' },
            { serverUrl: 'https://s2.example.test' },
        ]);
        mocks.getActiveServerSnapshot.mockReturnValue({
            serverId: 's2',
            serverUrl: 'https://s2.example.test',
            kind: 'custom',
            generation: 1,
        });
        mocks.registerPushToken
            .mockRejectedValueOnce(new Error('first server down'))
            .mockResolvedValueOnce({ ok: true });
        const { messages, log } = collectLogs();
        const { registerPushTokenIfAvailable } = await import('./account');

        await registerPushTokenIfAvailable({
            credentials: { token: 'fallback-token', secret: 'fallback-secret' },
            log,
        });

        expect(mocks.getCredentialsForServerUrl).toHaveBeenCalledTimes(2);
        expect(mocks.registerPushToken).toHaveBeenCalledTimes(2);
        expect(mocks.registerPushToken.mock.calls[0]?.[2]).toEqual({ apiEndpoint: 'https://s1.example.test' });
        expect(mocks.registerPushToken.mock.calls[1]?.[2]).toEqual({ apiEndpoint: 'https://s2.example.test' });
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(secretPushToken);
    });

    it('falls back to active-server credentials when the active profile registration fails', async () => {
        await arrangeNotifications();
        mocks.listServerProfiles.mockReturnValue([
            { serverUrl: 'https://s1.example.test' },
            { serverUrl: 'https://s2.example.test' },
        ]);
        mocks.getActiveServerSnapshot.mockReturnValue({
            serverId: 's2',
            serverUrl: 'https://s2.example.test',
            kind: 'custom',
            generation: 1,
        });
        mocks.registerPushToken
            .mockResolvedValueOnce({ ok: true })
            .mockRejectedValueOnce(new Error('active profile failed'))
            .mockResolvedValueOnce({ ok: true });
        const { messages, log } = collectLogs();
        const { registerPushTokenIfAvailable } = await import('./account');

        await registerPushTokenIfAvailable({
            credentials: { token: 'active-server-token', secret: 'active-server-secret' },
            log,
        });

        expect(mocks.registerPushToken).toHaveBeenCalledTimes(3);
        expect(mocks.registerPushToken.mock.calls[0]?.[2]).toEqual({ apiEndpoint: 'https://s1.example.test' });
        expect(mocks.registerPushToken.mock.calls[1]?.[2]).toEqual({ apiEndpoint: 'https://s2.example.test' });
        expect(mocks.registerPushToken.mock.calls[2]?.[0]).toEqual({
            token: 'active-server-token',
            secret: 'active-server-secret',
        });
        expect(mocks.registerPushToken.mock.calls[2]?.[2]).toBeUndefined();
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(secretPushToken);
    });

    it('registers active-server credentials when active server is missing from profiles', async () => {
        await arrangeNotifications();
        mocks.listServerProfiles.mockReturnValue([{ serverUrl: 'https://profile.example.test' }]);
        mocks.getActiveServerSnapshot.mockReturnValue({
            serverId: 'active',
            serverUrl: 'https://active.example.test',
            kind: 'custom',
            generation: 1,
        });
        mocks.registerPushToken
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: true });
        const { messages, log } = collectLogs();
        const { registerPushTokenIfAvailable } = await import('./account');

        await registerPushTokenIfAvailable({
            credentials: { token: 'active-server-token', secret: 'active-server-secret' },
            log,
        });

        expect(mocks.getCredentialsForServerUrl).toHaveBeenCalledTimes(1);
        expect(mocks.registerPushToken).toHaveBeenCalledTimes(2);
        expect(mocks.registerPushToken.mock.calls[0]?.[2]).toEqual({ apiEndpoint: 'https://profile.example.test' });
        expect(mocks.registerPushToken.mock.calls[1]?.[0]).toEqual({
            token: 'active-server-token',
            secret: 'active-server-secret',
        });
        expect(messages.join('\n')).toContain('Push token registered successfully');
        expect(messages.join('\n')).not.toContain(secretPushToken);
    });

    it('logs an overall failure when all profile attempts and fallback fail', async () => {
        await arrangeNotifications();
        mocks.listServerProfiles.mockReturnValue([
            { serverUrl: 'https://s1.example.test' },
            { serverUrl: 'https://s2.example.test' },
        ]);
        mocks.getActiveServerSnapshot.mockReturnValue({
            serverId: 's2',
            serverUrl: 'https://s2.example.test',
            kind: 'custom',
            generation: 1,
        });
        mocks.registerPushToken
            .mockRejectedValueOnce(new Error('s1 down'))
            .mockRejectedValueOnce(new Error('s2 down'))
            .mockRejectedValueOnce(new Error('fallback down'));
        const { messages, log } = collectLogs();
        const { registerPushTokenIfAvailable } = await import('./account');

        await registerPushTokenIfAvailable({
            credentials: { token: 'fallback-token', secret: 'fallback-secret' },
            log,
        });

        expect(mocks.registerPushToken).toHaveBeenCalledTimes(3);
        expect(messages.join('\n')).toContain('Failed to register push token for https://s1.example.test');
        expect(messages.join('\n')).toContain('Failed to register push token for https://s2.example.test');
        expect(messages.join('\n')).toContain('Failed to register push token:');
        expect(messages.join('\n')).not.toContain(secretPushToken);
    });
});
