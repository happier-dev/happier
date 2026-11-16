import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

import type { AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { describeAccountPostAuthResultReason } from './accountServiceFailurePresentation';

function failure(overrides: Partial<Extract<AccountPostAuthResult, { kind: 'failure' }>>): AccountPostAuthResult {
    return {
        kind: 'failure',
        stage: 'enroll',
        accountCredentialCommitted: true,
        homeCredentialCommitted: false,
        code: { source: 'home', code: 'failed' },
        recovery: 'retry_stage',
        ...overrides,
    };
}

describe('describeAccountPostAuthResultReason', () => {
    const context = { signInToHome: false, homeName: 'Home B' };

    it('reads every completed Home outcome with the success copy', () => {
        for (const result of [
            { kind: 'home_entered', homeServerIdentityId: 'srv_b', selection: 'explicit' },
            { kind: 'home_enrolled', homeServerIdentityId: 'srv_b' },
        ] as const) {
            expect(describeAccountPostAuthResultReason(result, context)).toBe('settingsAccount.accountServiceOAuth.success.body');
        }
    });

    it('keeps each typed failure on its own presenter body', () => {
        expect(describeAccountPostAuthResultReason(failure({ code: { source: 'home', code: 'rejected' } }), context))
            .toBe('connect.pairingRejectedBody');
        expect(describeAccountPostAuthResultReason(failure({ code: { source: 'home', code: 'expired' } }), context))
            .toBe('settingsAccount.accountServiceOAuth.errors.expired.body');
    });

    it('presents an Account-mode mismatch as a recoverable Home link failure', () => {
        expect(describeAccountPostAuthResultReason(failure({ code: { source: 'directory', code: 'label_mode_mismatch' } }), context))
            .toBe('settingsAccount.accountServiceOAuth.errors.homeLink.body');
    });

    it('applies the recovery-specific reasons over the failure body', () => {
        expect(describeAccountPostAuthResultReason(failure({ recovery: 'reauthenticate_account' }), context))
            .toBe('settingsAccount.accountServiceDiscoveryUnavailableDescription');
        expect(describeAccountPostAuthResultReason(failure({ recovery: 'use_home_auth' }), context))
            .toBe('connect.scanExistingHomeQrBody');
        expect(describeAccountPostAuthResultReason(failure({ recovery: 'use_home_auth' }), { ...context, signInToHome: true }))
            .toBe('settingsAccount.accountServiceOAuth.notLinked.body');
    });
});
