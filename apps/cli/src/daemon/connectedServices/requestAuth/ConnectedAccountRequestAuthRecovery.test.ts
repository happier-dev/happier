import { describe, expect, it, vi } from 'vitest';

import {
    applyConnectedAccountRequestAuthRecovery,
    type ConnectedAccountRequestAuthRecoveryInput,
} from './ConnectedAccountRequestAuthRecovery';

const resolved = {
    account: {
        service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        },
        accountId: 'primary',
    },
    group: {
        groupId: 'fallbacks',
        generation: 7,
    },
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
} as const;

function recoveryInput(
    overrides: Partial<ConnectedAccountRequestAuthRecoveryInput> = {},
): ConnectedAccountRequestAuthRecoveryInput {
    return {
        resolved,
        failure: {
            class: 'quota',
            evidence: {
                httpStatus: 429,
                retryAfterMs: 1_000,
                limitCategory: 'rate_limit',
                quotaScope: 'account',
                evidenceSource: { kind: 'structured' },
            },
        },
        refreshCredential: vi.fn(async () => false),
        switchAfterClassifiedFailure: vi.fn(async () => ({ status: 'switched' })),
        recordTemporaryRetry: vi.fn(async () => ({ status: 'recorded' as const })),
        ...overrides,
    };
}

describe('ConnectedAccountRequestAuthRecovery', () => {
    it('preserves a novel qualified service identity through request-time group recovery', async () => {
        const service = {
            pluginId: 'example.connected-accounts',
            localId: 'service/with/path',
        } as const;
        const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));

        await expect(applyConnectedAccountRequestAuthRecovery({
            resolved: {
                ...resolved,
                account: {
                    service,
                    accountId: 'primary',
                },
            },
            failure: {
                class: 'quota',
                evidence: {
                    limitCategory: 'usage_limit',
                    quotaScope: 'account',
                    evidenceSource: { kind: 'structured' },
                },
            },
            refreshCredential: vi.fn(async () => false),
            switchAfterClassifiedFailure,
            recordTemporaryRetry: vi.fn(async () => ({ status: 'recorded' as const })),
        } as unknown as ConnectedAccountRequestAuthRecoveryInput)).resolves.toMatchObject({
            effect: 'switch_account',
            decision: {
                action: 'switch_account',
                serviceId: service,
            },
        });
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith(expect.objectContaining({
            serviceId: service,
            groupId: 'fallbacks',
            observedProfileId: 'primary',
        }));
    });

    it('delegates account-scoped limits to the canonical group-switch application owner', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));
        const input = recoveryInput({ switchAfterClassifiedFailure });

        await expect(applyConnectedAccountRequestAuthRecovery(input)).resolves.toMatchObject({
            effect: 'switch_account',
            decision: {
                action: 'switch_account',
                reason: 'rate_limit',
            },
        });
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
            serviceId: resolved.account.service,
            groupId: 'fallbacks',
            observedProfileId: 'primary',
            expectedFailureSource: {
                profileId: 'primary',
                credentialRevision:
                    'csr_0123456789ABCDEFGHJKMNPQRS',
                groupGeneration: 7,
            },
            reason: 'rate_limit',
            retryAfterMs: 1_000,
            limitCategory: 'rate_limit',
            quotaScope: 'account',
        });
    });

    it.each(['provider', 'unknown'] as const)(
        'keeps %s-scoped rate limits on the same account without arming session continuation',
        async (quotaScope) => {
            const refreshCredential = vi.fn(async () => false);
            const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));
            const recordTemporaryRetry = vi.fn(async () => ({ status: 'recorded' as const }));

            await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
                failure: {
                    class: 'quota',
                    evidence: {
                        httpStatus: 429,
                        limitCategory: 'rate_limit',
                        quotaScope,
                        evidenceSource: { kind: 'structured' },
                    },
                },
                refreshCredential,
                switchAfterClassifiedFailure,
                recordTemporaryRetry,
            }))).resolves.toMatchObject({
                effect: 'temporary_retry',
                decision: { action: 'temporary_retry' },
            });

            expect(refreshCredential).not.toHaveBeenCalled();
            expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
            expect(recordTemporaryRetry).toHaveBeenCalledWith({
                service: resolved.account.service,
                accountId: 'primary',
                groupId: 'fallbacks',
                groupGeneration: 7,
                limitCategory: 'rate_limit',
                quotaScope,
                retryAfterMs: null,
                resetAtMs: null,
                providerCode: null,
            });
        },
    );

    it('does not claim that a temporary retry was applied when the backoff owner is unavailable', async () => {
        const recordTemporaryRetry = vi.fn(async () => ({
            status: 'unavailable' as const,
            reason: 'backoff_owner_unavailable' as const,
        }));

        await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
            failure: {
                class: 'quota',
                evidence: {
                    httpStatus: 429,
                    limitCategory: 'capacity',
                    quotaScope: 'unknown',
                    evidenceSource: { kind: 'structured' },
                },
            },
            recordTemporaryRetry,
        }))).resolves.toMatchObject({
            effect: 'temporary_retry_unavailable',
            decision: { action: 'temporary_retry' },
            temporaryRetry: {
                status: 'unavailable',
                reason: 'backoff_owner_unavailable',
            },
        });
    });

    it('uses the existing credential refresh owner before considering an auth group switch', async () => {
        const refreshCredential = vi.fn(async () => true);
        const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));

        await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
            failure: {
                class: 'authentication',
                evidence: {
                    httpStatus: 401,
                    limitCategory: 'auth_invalid',
                    quotaScope: 'unknown',
                    evidenceSource: { kind: 'structured' },
                },
            },
            refreshCredential,
            switchAfterClassifiedFailure,
        }))).resolves.toMatchObject({
            effect: 'refresh',
            decision: { action: 'refresh' },
        });

        expect(refreshCredential).toHaveBeenCalledWith({
            account: resolved.account,
            expectedCredentialRevision:
                'csr_0123456789ABCDEFGHJKMNPQRS',
        });
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('falls through the same policy to group switching only after auth refresh fails', async () => {
        const refreshCredential = vi.fn(async () => false);
        const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));

        await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
            failure: {
                class: 'authentication',
                evidence: {
                    httpStatus: 401,
                    limitCategory: 'auth_invalid',
                    quotaScope: 'unknown',
                    evidenceSource: { kind: 'structured' },
                },
            },
            refreshCredential,
            switchAfterClassifiedFailure,
        }))).resolves.toMatchObject({
            effect: 'switch_account',
            decision: {
                action: 'switch_account',
                reason: 'auth_expired',
            },
        });
        expect(refreshCredential).toHaveBeenCalledOnce();
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
            serviceId: resolved.account.service,
            groupId: 'fallbacks',
            observedProfileId: 'primary',
            expectedFailureSource: {
                profileId: 'primary',
                credentialRevision:
                    'csr_0123456789ABCDEFGHJKMNPQRS',
                groupGeneration: 7,
            },
            reason: 'auth_expired',
            limitCategory: 'auth_invalid',
            quotaScope: 'unknown',
        });
    });

    it('maps a canonical stale-source rejection directly to stale request-auth recovery', async () => {
        await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
            switchAfterClassifiedFailure: vi.fn(async () => ({
                status: 'stale_context' as const,
                generation: 8,
            })),
        }))).resolves.toMatchObject({
            effect: 'stale_context',
            decision: {
                action: 'switch_account',
            },
        });
    });

    it('keeps unknown evidence diagnostic-only', async () => {
        const refreshCredential = vi.fn(async () => false);
        const switchAfterClassifiedFailure = vi.fn(async () => ({ status: 'switched' }));

        await expect(applyConnectedAccountRequestAuthRecovery(recoveryInput({
            failure: {
                class: 'quota',
                evidence: {
                    limitCategory: 'unknown',
                    quotaScope: 'unknown',
                    evidenceSource: { kind: 'structured' },
                },
            },
            refreshCredential,
            switchAfterClassifiedFailure,
        }))).resolves.toMatchObject({
            effect: 'none',
        });
        expect(refreshCredential).not.toHaveBeenCalled();
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });
});
