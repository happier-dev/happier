import { describe, expect, it, vi } from 'vitest';

import type { ExpoNotificationsModule } from '@/utils/platform/loadExpoNotifications';
import {
    readExpoPushToken,
    readPushPermission,
    requestPushPermission,
} from './pushNotificationAccess';

vi.mock('expo-constants', () => ({
    default: { expoConfig: { extra: { eas: { projectId: 'project-123' } } } },
}));

function moduleWith(overrides: Record<string, unknown>): () => Promise<ExpoNotificationsModule> {
    return async () => ({
        getPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
        requestPermissionsAsync: async () => ({ status: 'granted', granted: true, canAskAgain: true }),
        getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[abc]' }),
        ...overrides,
    } as unknown as ExpoNotificationsModule);
}

describe('readPushPermission', () => {
    it('reports the granted permission state from the notification runtime', async () => {
        const outcome = await readPushPermission({ loadModule: moduleWith({}) });

        expect(outcome).toEqual({
            ok: true,
            permission: { status: 'granted', granted: true, canAskAgain: true },
        });
    });

    it('normalizes an unrecognized native status to undetermined', async () => {
        const outcome = await readPushPermission({
            loadModule: moduleWith({
                getPermissionsAsync: async () => ({ status: 'provisional', granted: false, canAskAgain: false }),
            }),
        });

        expect(outcome).toEqual({
            ok: true,
            permission: { status: 'undetermined', granted: false, canAskAgain: false },
        });
    });

    it('reports runtime_timeout instead of stalling when the native call never settles', async () => {
        vi.useFakeTimers();
        try {
            const settled = readPushPermission({
                loadModule: moduleWith({ getPermissionsAsync: () => new Promise(() => {}) }),
                timeoutMs: 4_000,
            });
            await vi.advanceTimersByTimeAsync(4_000);

            expect(await settled).toEqual({ ok: false, reason: 'runtime_timeout' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports runtime_timeout when the notification module load never settles', async () => {
        vi.useFakeTimers();
        try {
            const settled = readPushPermission({
                loadModule: () => new Promise(() => {}),
                timeoutMs: 4_000,
            });
            await vi.advanceTimersByTimeAsync(4_000);

            expect(await settled).toEqual({ ok: false, reason: 'runtime_timeout' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports runtime_unavailable when the notification runtime is missing', async () => {
        const outcome = await readPushPermission({
            loadModule: async () => { throw new Error('native module unavailable'); },
        });

        expect(outcome).toEqual({ ok: false, reason: 'runtime_unavailable' });
    });
});

describe('requestPushPermission', () => {
    it('returns the post-prompt permission state', async () => {
        const requestPermissionsAsync = vi.fn(async () => ({ status: 'denied', granted: false, canAskAgain: false }));
        const outcome = await requestPushPermission({ loadModule: moduleWith({ requestPermissionsAsync }) });

        expect(requestPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(outcome).toEqual({
            ok: true,
            permission: { status: 'denied', granted: false, canAskAgain: false },
        });
    });

    it('reports runtime_timeout instead of stalling on the OS prompt', async () => {
        vi.useFakeTimers();
        try {
            const settled = requestPushPermission({
                loadModule: moduleWith({ requestPermissionsAsync: () => new Promise(() => {}) }),
                timeoutMs: 4_000,
            });
            await vi.advanceTimersByTimeAsync(4_000);

            expect(await settled).toEqual({ ok: false, reason: 'runtime_timeout' });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('readExpoPushToken', () => {
    it('requests the token for the resolved EAS project id', async () => {
        const getExpoPushTokenAsync = vi.fn(async () => ({ data: 'ExponentPushToken[abc]' }));
        const outcome = await readExpoPushToken({ loadModule: moduleWith({ getExpoPushTokenAsync }) });

        expect(getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-123' });
        expect(outcome).toEqual({ ok: true, token: 'ExponentPushToken[abc]' });
    });

    it('reports token_unavailable when the device cannot mint a token', async () => {
        const outcome = await readExpoPushToken({
            loadModule: moduleWith({
                getExpoPushTokenAsync: async () => {
                    throw new Error('no valid "aps-environment" entitlement string found');
                },
            }),
        });

        expect(outcome).toEqual({ ok: false, reason: 'token_unavailable' });
    });

    it('reports token_unavailable when the runtime returns an empty token', async () => {
        const outcome = await readExpoPushToken({
            loadModule: moduleWith({ getExpoPushTokenAsync: async () => ({ data: '  ' }) }),
        });

        expect(outcome).toEqual({ ok: false, reason: 'token_unavailable' });
    });

    it('reports runtime_timeout instead of stalling when token minting never settles', async () => {
        vi.useFakeTimers();
        try {
            const settled = readExpoPushToken({
                loadModule: moduleWith({ getExpoPushTokenAsync: () => new Promise(() => {}) }),
                timeoutMs: 4_000,
            });
            await vi.advanceTimersByTimeAsync(4_000);

            expect(await settled).toEqual({ ok: false, reason: 'runtime_timeout' });
        } finally {
            vi.useRealTimers();
        }
    });
});
