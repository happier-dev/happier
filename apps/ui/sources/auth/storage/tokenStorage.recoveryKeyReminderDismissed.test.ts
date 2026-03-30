import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';
import { installTokenStorageWebPlatformMocks } from './tokenStorage.testHelpers';

installTokenStorageWebPlatformMocks();

describe('TokenStorage recovery key reminder dismissed (web)', () => {
    let restoreLocalStorage: (() => void) | null = null;

    beforeEach(() => {
        vi.resetModules();
        restoreLocalStorage = installLocalStorageMock().restore;
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        restoreLocalStorage?.();
        restoreLocalStorage = null;
    });

    it('round-trips dismissed state', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        await expect(TokenStorage.getRecoveryKeyReminderDismissed()).resolves.toBe(false);

        await expect(TokenStorage.setRecoveryKeyReminderDismissed(true)).resolves.toBe(true);
        await expect(TokenStorage.getRecoveryKeyReminderDismissed()).resolves.toBe(true);

        await expect(TokenStorage.setRecoveryKeyReminderDismissed(false)).resolves.toBe(true);
        await expect(TokenStorage.getRecoveryKeyReminderDismissed()).resolves.toBe(false);
    });

    it('exposes the dismissed state through the synchronous cache path on web', async () => {
        const { TokenStorage } = await import('./tokenStorage');

        expect(TokenStorage.getCachedRecoveryKeyReminderDismissed()).toBe(false);

        await expect(TokenStorage.setRecoveryKeyReminderDismissed(true)).resolves.toBe(true);
        expect(TokenStorage.getCachedRecoveryKeyReminderDismissed()).toBe(true);

        await expect(TokenStorage.setRecoveryKeyReminderDismissed(false)).resolves.toBe(true);
        expect(TokenStorage.getCachedRecoveryKeyReminderDismissed()).toBe(false);
    });
});
