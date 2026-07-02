import { describe, expect, it, vi } from 'vitest';

import { handleConnectedServiceRuntimeAuthFailure } from './handleConnectedServiceRuntimeAuthFailure';

describe('handleConnectedServiceRuntimeAuthFailure', () => {
    it('requires profile action for a single connected profile selection instead of attempting a group switch', async () => {
        const switchAfterClassifiedFailure = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailure({
            selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'profile_1' },
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'profile_1',
                groupId: 'group_1',
                resetsAtMs: null,
                retryAfterMs: 60_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 0,
            switchCoordinator: { switchAfterClassifiedFailure },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'profile_action_required',
                serviceId: 'openai-codex',
                profileId: 'profile_1',
                groupId: 'group_1',
                reason: 'usage_limit',
            },
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('requires reconnect for credential failures on a single connected profile selection', async () => {
        const switchAfterClassifiedFailure = vi.fn();

        await expect(handleConnectedServiceRuntimeAuthFailure({
            selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'profile_1' },
            classification: {
                kind: 'auth_expired',
                limitCategory: 'auth_invalid',
                serviceId: 'openai-codex',
                profileId: 'profile_1',
                groupId: 'group_1',
                resetsAtMs: null,
                retryAfterMs: null,
                quotaScope: 'account',
                providerLimitId: null,
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 0,
            switchCoordinator: { switchAfterClassifiedFailure },
        })).resolves.toEqual({
            status: 'recovery_action_required',
            action: {
                kind: 'reconnect_profile',
                serviceId: 'openai-codex',
                profileId: 'profile_1',
                groupId: 'group_1',
                reason: 'auth_expired',
            },
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('prefers group switching when the provider classifies the failure as requiring shared state', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailure({
            selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'group_1',
                activeProfileId: 'primary',
            },
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group_1',
                resetsAtMs: null,
                retryAfterMs: 60_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
                recoveryAction: { kind: 'provider_state_sharing_required' },
            },
            switchesThisTurn: 1,
            switchCoordinator: { switchAfterClassifiedFailure },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: {
                status: 'switched',
                activeProfileId: 'backup',
                generation: 2,
            },
        });

        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'group_1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            retryAfterMs: 60_000,
            resetsAtMs: null,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            providerLimitId: 'weekly',
            action: null,
            planType: null,
            switchesThisTurn: 1,
        });
    });

    it('switches matching group selections through the coordinator', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailure({
            selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'group_1',
                activeProfileId: 'primary',
            },
            classification: {
                kind: 'usage_limit',
                limitCategory: 'usage_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group_1',
                resetsAtMs: null,
                retryAfterMs: 60_000,
                quotaScope: 'account',
                providerLimitId: 'weekly',
                action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 1,
            switchCoordinator: { switchAfterClassifiedFailure },
        })).resolves.toEqual({
            status: 'switch_attempted',
            result: { status: 'switched', activeProfileId: 'backup', generation: 2 },
        });
        expect(switchAfterClassifiedFailure).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            groupId: 'group_1',
            reason: 'usage_limit',
            observedProfileId: 'primary',
            retryAfterMs: 60_000,
            resetsAtMs: null,
            limitCategory: 'usage_limit',
            quotaScope: 'account',
            providerLimitId: 'weekly',
            action: { kind: 'open_url', url: 'https://chatgpt.com/codex/settings/usage' },
            planType: null,
            switchesThisTurn: 1,
        });
    });

    it('degrades temporary throttles to scheduler-unavailable without switching accounts when retry scheduling is absent', async () => {
        const switchAfterClassifiedFailure = vi.fn(async () => ({
            status: 'switched' as const,
            activeProfileId: 'backup',
            generation: 2,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailure({
            sessionId: 'sess_1',
            selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'group_1',
                activeProfileId: 'primary',
            },
            classification: {
                kind: 'temporary_throttle',
                limitCategory: 'rate_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group_1',
                resetsAtMs: null,
                retryAfterMs: 2_500,
                quotaScope: 'provider',
                providerLimitId: 'temporary_provider_throttle',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 1,
            switchCoordinator: { switchAfterClassifiedFailure },
        })).resolves.toEqual({
            status: 'temporary_retry_unavailable',
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'group_1',
            attemptCount: 0,
            maxAttempts: 0,
            reason: 'scheduler_unavailable',
            retryAfterMs: 2_500,
            retryAtMs: null,
            resetAtMs: null,
        });

        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('arms temporary throttles through the scheduler without switching accounts', async () => {
        const switchAfterClassifiedFailure = vi.fn();
        const enable = vi.fn(async () => ({
            status: 'waiting',
            nextRetryAtMs: 12_500,
            attemptCount: 0,
            maxAttempts: 3,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailure({
            sessionId: 'sess_1',
            selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'group_1',
                activeProfileId: 'primary',
            },
            classification: {
                kind: 'temporary_throttle',
                limitCategory: 'rate_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group_1',
                resetsAtMs: 12_500,
                retryAfterMs: 2_500,
                quotaScope: 'provider',
                providerLimitId: 'temporary_provider_throttle',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 1,
            switchCoordinator: { switchAfterClassifiedFailure },
            temporaryThrottleRecovery: { enable },
        })).resolves.toMatchObject({
            status: 'temporary_retry_armed',
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'group_1',
            attemptCount: 0,
            maxAttempts: 3,
            retryAfterMs: 2_500,
            retryAtMs: 12_500,
            resetAtMs: 12_500,
        });

        expect(enable).toHaveBeenCalledWith({
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'group_1',
            issueFingerprint: 'temporary-throttle:openai-codex:group_1:primary',
            retryAfterMs: 2_500,
            resetAtMs: 12_500,
        });
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });

    it('maps unsupported temporary-throttle schedulers to typed unavailable recovery', async () => {
        const switchAfterClassifiedFailure = vi.fn();
        const enable = vi.fn(async () => ({
            status: 'unsupported',
            nextRetryAtMs: null,
            attemptCount: 0,
            maxAttempts: 0,
        }));

        await expect(handleConnectedServiceRuntimeAuthFailure({
            sessionId: 'sess_1',
            selection: {
                kind: 'group',
                serviceId: 'openai-codex',
                groupId: 'group_1',
                activeProfileId: 'primary',
            },
            classification: {
                kind: 'temporary_throttle',
                limitCategory: 'rate_limit',
                serviceId: 'openai-codex',
                profileId: 'primary',
                groupId: 'group_1',
                resetsAtMs: 12_500,
                retryAfterMs: 2_500,
                quotaScope: 'provider',
                providerLimitId: 'temporary_provider_throttle',
                action: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
            switchesThisTurn: 1,
            switchCoordinator: { switchAfterClassifiedFailure },
            temporaryThrottleRecovery: { enable },
        })).resolves.toEqual({
            status: 'temporary_retry_unavailable',
            sessionId: 'sess_1',
            serviceId: 'openai-codex',
            profileId: 'primary',
            groupId: 'group_1',
            attemptCount: 0,
            maxAttempts: 0,
            reason: 'scheduler_unavailable',
            retryAfterMs: 2_500,
            retryAtMs: null,
            resetAtMs: 12_500,
        });
        expect(switchAfterClassifiedFailure).not.toHaveBeenCalled();
    });
});
