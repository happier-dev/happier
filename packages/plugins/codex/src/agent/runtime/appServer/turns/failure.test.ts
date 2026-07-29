import { describe, expect, it } from 'vitest';

import {
    createCodexAppServerTurnFailure,
    formatCodexAppServerErrorForUi,
    isCodexAppServerContextWindowExhaustedError,
    isCodexAppServerTemporaryRecoverableTurnFailureError,
} from './failure.js';

describe('createCodexAppServerTurnFailure', () => {
    it('carries structured runtime-auth classification for Codex usage-limit errors', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: 'Usage limit reached',
                    codexErrorInfo: 'UsageLimitExceeded',
                    resets_at: '2026-05-17T15:30:00.000Z',
                    retry_after_ms: 90_000,
                    plan_type: 'plus',
                    rate_limits: { primary: { used_percent: 100 } },
                },
            },
            authContext: { profileId: 'leeroy', groupId: 'happier' },
            sourceAccountIdentity: {
                providerAccountId: 'acct_source',
                accountLabel: 'source@example.test',
                profileId: 'runtime-profile',
                groupId: 'runtime-group',
                generation: 42,
                credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            },
        });

        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'leeroy',
            groupId: 'happier',
            resetsAtMs: Date.parse('2026-05-17T15:30:00.000Z'),
            retryAfterMs: 90_000,
            planType: 'plus',
            source: 'structured_provider_error',
            sourceProviderAccountId: 'acct_source',
            sourceAccountLabel: 'source@example.test',
            groupGeneration: 42,
            expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
        });
        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification)
            .not.toHaveProperty('rateLimits');
    });

    it('uses failure-time runtime identity when separate auth context is unavailable', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: 'Usage limit reached',
                    codexErrorInfo: 'UsageLimitExceeded',
                },
            },
            sourceAccountIdentity: {
                providerAccountId: 'acct_source',
                accountLabel: 'source@example.test',
                profileId: 'runtime-profile',
                groupId: 'runtime-group',
                generation: 42,
            },
        });

        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'usage_limit',
            serviceId: 'openai-codex',
            profileId: 'runtime-profile',
            groupId: 'runtime-group',
            sourceProviderAccountId: 'acct_source',
            sourceAccountLabel: 'source@example.test',
            groupGeneration: 42,
        });
    });

    it('marks context-window failures from structured Codex app-server payloads', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'Codex ran out of room in the context window.',
                        codex_error_info: 'context_window_exceeded',
                    },
                },
            },
        });

        expect(isCodexAppServerContextWindowExhaustedError(failure)).toBe(true);
    });

    it('marks selected-model capacity failures as temporary recoverable failures', () => {
        const failure = createCodexAppServerTurnFailure({
            value: {
                turn: {
                    error: {
                        message: 'Selected model is at capacity. Please try a different model.',
                        codex_error_info: 'other',
                    },
                },
            },
        });

        expect(isCodexAppServerTemporaryRecoverableTurnFailureError(failure)).toBe(true);
        expect((failure as Error & { runtimeAuthClassification?: unknown }).runtimeAuthClassification).toMatchObject({
            kind: 'capacity',
            limitCategory: 'capacity',
            quotaScope: 'provider',
            serviceId: 'openai-codex',
        });
    });

    it('formats non-empty messages for UI without double-prefixing error text', () => {
        expect(formatCodexAppServerErrorForUi(new Error('provider failed'))).toBe('Error: provider failed');
        expect(formatCodexAppServerErrorForUi(new Error('Error: provider failed'))).toBe('Error: provider failed');
    });

    it('does not expose provider failure prose through the terminal Error or UI formatter', () => {
        const providerMessageSentinel = 'VOICE_PRIVATE_FAILURE_MESSAGE_SENTINEL';
        const providerDetailsSentinel = 'VOICE_PRIVATE_FAILURE_DETAILS_SENTINEL';
        const failure = createCodexAppServerTurnFailure({
            value: {
                error: {
                    message: `provider rejected ${providerMessageSentinel}`,
                    additional_details: providerDetailsSentinel,
                },
            },
        });

        expect(failure.message).toBe('Codex app-server turn failed.');
        expect(failure.stack ?? '').not.toContain(providerMessageSentinel);
        expect(failure.stack ?? '').not.toContain(providerDetailsSentinel);
        expect(formatCodexAppServerErrorForUi(failure)).toBe('Error: Codex app-server turn failed.');
    });
});
