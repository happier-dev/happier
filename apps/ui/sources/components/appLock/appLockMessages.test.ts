import { describe, expect, it, vi } from 'vitest';
import { APP_LOCK_RECOVERY_ERROR_CODES } from '@happier-dev/protocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

describe('app lock recovery messages', () => {
    it('describes a relay server failure without blaming the connection', async () => {
        const { describeAppLockRecoveryFailure } = await import('./appLockMessages');
        expect(describeAppLockRecoveryFailure({ ok: false, error: 'server' })).toBe('errors.serverError');
    });

    it('provides an error message for every canonical relay failure and network failure', async () => {
        const { describeAppLockRecoveryFailure } = await import('./appLockMessages');

        for (const error of [...APP_LOCK_RECOVERY_ERROR_CODES, 'network'] as const) {
            expect(describeAppLockRecoveryFailure({ ok: false, error }), error)
                .toMatch(/^appLock\.errors\./);
        }
    });
});

describe('app lock password rules', () => {
    it('accepts any 4 to 30 characters and requires the two entries to match', async () => {
        const { validateAppLockNewPassword } = await import('./appLockMessages');

        expect(validateAppLockNewPassword('abc', 'abc')).toBe('appLock.passwordLength');
        expect(validateAppLockNewPassword('abcd', 'abcd')).toBeNull();
        expect(validateAppLockNewPassword('a'.repeat(30), 'a'.repeat(30))).toBeNull();
        expect(validateAppLockNewPassword('a'.repeat(31), 'a'.repeat(31))).toBe('appLock.passwordLength');
        expect(validateAppLockNewPassword('abcd', 'abce')).toBe('appLock.passwordsDontMatch');
    });

    it('recommends, but does not require, mixing character types', async () => {
        const { appLockPasswordStrengthTip, validateAppLockNewPassword } = await import('./appLockMessages');

        expect(validateAppLockNewPassword('aaaa', 'aaaa')).toBeNull();
        expect(appLockPasswordStrengthTip('aaaa')).toBe('appLock.passwordTip');
        expect(appLockPasswordStrengthTip('Abc1!xyz')).toBeNull();
        expect(appLockPasswordStrengthTip('')).toBeNull();
    });
});
