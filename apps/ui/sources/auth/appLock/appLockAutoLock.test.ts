import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installLocalStorageMock, type LocalStorageMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';

installTokenStorageWebPlatformMocks();

const MINUTE = 60_000;

async function setUp(autoLockMinutes: number | null) {
    const runtime = await import('./appLockRuntime');
    const { createAppLockAutoLock } = await import('./appLockAutoLock');
    await runtime.loadAppLock();
    await runtime.activateAppLock({
        v: 1,
        lockId: 'lock_0123456789abcdefghijkl',
        email: 'owner@example.com',
        serverUrl: 'https://relay.example.test',
        wrapped: {
            kdf: { alg: 'scrypt', N: 1024, r: 8, p: 1, salt: 'c2FsdA==' },
            passwordWrappedKey: 'x',
            recoveryWrappedKey: 'y',
        },
        autoLockMinutes,
        biometric: false,
    }, new Uint8Array(32));
    return { runtime, autoLock: createAppLockAutoLock() };
}

describe('app lock auto-lock', () => {
    let storage: LocalStorageMockHandle | null = null;

    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-31T10:00:00Z'));
        storage = installLocalStorageMock();
    });

    afterEach(() => {
        vi.useRealTimers();
        storage?.restore();
        storage = null;
    });

    it('locks after the chosen time in the background, not before', async () => {
        const { runtime, autoLock } = await setUp(5);

        autoLock.onAppStateChange('background');
        vi.advanceTimersByTime(4 * MINUTE);
        autoLock.onAppStateChange('active');
        expect(runtime.getAppLockSnapshot().status).toBe('unlocked');

        autoLock.onAppStateChange('background');
        vi.advanceTimersByTime(5 * MINUTE);
        expect(runtime.getAppLockSnapshot().status).toBe('locked');
        autoLock.dispose();
    });

    it('locks on return when background timers did not run', async () => {
        const { runtime, autoLock } = await setUp(5);

        autoLock.onAppStateChange('background');
        // Mobile platforms suspend timers in the background: only the clock moves.
        vi.setSystemTime(new Date('2026-10-31T10:06:00Z'));
        autoLock.onAppStateChange('active');
        expect(runtime.getAppLockSnapshot().status).toBe('locked');
        autoLock.dispose();
    });

    it('locks immediately for "immediately" and never for "only on launch"', async () => {
        const immediate = await setUp(0);
        immediate.autoLock.onAppStateChange('background');
        expect(immediate.runtime.getAppLockSnapshot().status).toBe('locked');
        immediate.autoLock.dispose();

        vi.resetModules();
        storage?.restore();
        storage = installLocalStorageMock();
        const launchOnly = await setUp(null);
        launchOnly.autoLock.onAppStateChange('background');
        vi.advanceTimersByTime(120 * MINUTE);
        launchOnly.autoLock.onAppStateChange('active');
        expect(launchOnly.runtime.getAppLockSnapshot().status).toBe('unlocked');
        launchOnly.autoLock.dispose();
    });
});
