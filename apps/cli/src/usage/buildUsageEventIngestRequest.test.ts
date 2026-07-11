import { describe, expect, it } from 'vitest';

import { buildUsageEventIngestRequest } from './buildUsageEventIngestRequest';

describe('buildUsageEventIngestRequest', () => {
    it('maps canonical usage observations into protocol usage events', () => {
        const request = buildUsageEventIngestRequest({
            sessionId: 'session-1',
            observedAt: 1_710_000_000_000,
            observation: {
                provider: 'codex',
                source: 'codex-token-count',
                scope: 'session_cumulative',
                key: 'codex-session',
                modelId: 'gpt-5-codex',
                tokens: {
                    total: 120,
                    input: 50,
                    output: 40,
                    thought: 10,
                    cache_read: 15,
                    cache_creation: 5,
                },
                cost: {
                    total: 1.25,
                    invoiceUsd: 1.1,
                    breakdown: { cacheSavingsUsd: 0.125 },
                    billingContext: 'unknown',
                    costSource: 'pricing_estimate',
                },
                contextUsedTokens: 120,
                contextWindowTokens: 258_000,
            },
        });

        expect(request).toEqual({
            sessionId: 'session-1',
            observedAt: 1_710_000_000_000,
            agentId: 'codex',
            backendMode: null,
            modelId: 'gpt-5-codex',
            projectKey: null,
            workspaceId: null,
            machineId: null,
            source: 'codex-token-count',
            scope: 'session_cumulative',
            externalKey: null,
            turnId: null,
            isCumulative: true,
            tokens: {
                input: 50,
                output: 40,
                reasoning: 10,
                cacheRead: 15,
                cacheWrite: 5,
                total: 120,
            },
            cost: {
                reportedUsd: 0,
                estimatedUsd: 1.25,
                invoiceUsd: 1.1,
                billingContext: 'unknown',
                costSource: 'pricing_estimate',
                currency: 'USD',
                breakdown: { cacheSavingsUsd: 0.125 },
            },
            context: {
                usedTokens: 120,
                windowTokens: 258_000,
            },
            metadata: {
                observationKey: 'codex-session',
            },
        });
    });

    it('returns null when the observation has no tokens, cost, or context', () => {
        expect(
            buildUsageEventIngestRequest({
                sessionId: 'session-1',
                observedAt: 1,
                observation: {
                    provider: 'claude',
                    source: 'claude-sdk-result',
                    scope: 'session_final',
                    key: null,
                    modelId: null,
                    tokens: null,
                    cost: null,
                    contextUsedTokens: null,
                    contextWindowTokens: null,
                },
            }),
        ).toBeNull();
    });

    it('treats legacy total-only cost as estimated when explicitly marked', () => {
        const request = buildUsageEventIngestRequest({
            sessionId: 'session-1',
            observedAt: 5,
            observation: {
                provider: 'opencode',
                source: 'opencode-message-updated',
                scope: 'turn_delta',
                key: null,
                modelId: null,
                tokens: { total: 10 },
                cost: {
                    total: 0.4,
                    estimatedUsd: 0.4,
                    billingContext: 'subscription_included',
                    costSource: 'pricing_estimate',
                },
                contextUsedTokens: null,
                contextWindowTokens: null,
            },
        });

        expect(request?.cost).toEqual({
            reportedUsd: 0,
            estimatedUsd: 0.4,
            billingContext: 'subscription_included',
            costSource: 'pricing_estimate',
            currency: 'USD',
            breakdown: {},
        });
    });

    it.each([
        ['codex:thread-1:turn-1', 'codex'],
        ['claude:session-1:result:result-1', 'claude'],
    ])('preserves stable provider retry identity %s', (externalKey, provider) => {
        const request = buildUsageEventIngestRequest({
            sessionId: 'session-1',
            observedAt: 5,
            externalKey,
            observation: {
                provider,
                source: `${provider}-usage`,
                scope: 'session_cumulative',
                key: null,
                modelId: null,
                tokens: { total: 10 },
                cost: null,
                contextUsedTokens: null,
                contextWindowTokens: null,
            },
        });

        expect(request?.externalKey).toBe(externalKey);
    });
});
