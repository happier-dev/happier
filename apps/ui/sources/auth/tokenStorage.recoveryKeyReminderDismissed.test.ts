import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installLocalStorageMock } from './tokenStorage.web.testHelpers';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' },
}));

vi.mock('expo-secure-store', () => ({}));

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
});
