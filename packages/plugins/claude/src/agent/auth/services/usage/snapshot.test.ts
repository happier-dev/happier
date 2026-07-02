import { describe, expect, it } from 'vitest';

import {
    ProviderAccountUsageSnapshotV1Schema,
    buildProviderAccountUsageRecordId,
    buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import { createClaudeSubscriptionQuotaFetcher } from '../quota/subscriptionFetcher.js';
import { mapClaudeRuntimeRateLimitsToUsageObservation } from '../runtime/usage.js';
import { resolveClaudeUsageSubjectRef } from './identity.js';

type ClaudeUsageSnapshotModule = typeof import('./snapshot.js');

async function loadSnapshotModule(): Promise<ClaudeUsageSnapshotModule | null> {
    return await import('./snapshot.js').catch(() => null);
}

describe('Claude provider account usage snapshots', () => {
    it('maps statusline rate limits to a canonical runtime usage snapshot before provider HTTP polling', async () => {
        const moduleRecord = await loadSnapshotModule();
        expect(moduleRecord).toEqual(expect.objectContaining({
            mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot: expect.any(Function),
        }));
        if (!moduleRecord) throw new Error('snapshot module missing');

        const observation = mapClaudeRuntimeRateLimitsToUsageObservation({
            rate_limits: {
                five_hour: { utilization: 70, resets_at: '2026-02-16T00:00:00Z' },
            },
        });
        const subject = resolveClaudeUsageSubjectRef({
            oauthAccountId: 'claude-account-1',
            accountLabel: 'alice@example.com',
        });

        const snapshot = moduleRecord.mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
            subject,
            observation,
            observedAtMs: 1_768_000_000_000,
            fetchedAtMs: 1_768_000_000_000,
            aliases: [{ kind: 'nativeCli', localCredentialRef: 'claude-code' }],
            accountLabel: 'alice@example.com',
        });

        const parsed = ProviderAccountUsageSnapshotV1Schema.parse(snapshot);
        expect(parsed).toMatchObject({
            v: 1,
            providerId: 'claude',
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            accountSubject: {
                kind: 'providerSubject',
                id: 'claude-account-1',
            },
            accountLabel: 'alice@example.com',
            aliases: [{
                kind: 'nativeCli',
                providerId: 'claude',
                localCredentialRef: 'claude-code',
                accountSubjectId: 'claude-account-1',
            }],
            meters: [expect.objectContaining({
                meterId: 'five_hour',
                utilizationPct: 70,
                resetsAt: Date.parse('2026-02-16T00:00:00Z'),
            })],
        });
        expect(parsed.recordId).toBe(buildProviderAccountUsageRecordId(parsed.recordKey));
    });

    it('projects Claude OAuth usage fetch results to canonical provider HTTP snapshots', async () => {
        const moduleRecord = await loadSnapshotModule();
        expect(moduleRecord).toEqual(expect.objectContaining({
            mapClaudeQuotaSnapshotToProviderAccountUsageSnapshot: expect.any(Function),
        }));
        if (!moduleRecord) throw new Error('snapshot module missing');

        const now = 1_768_000_000_000;
        const record = buildConnectedServiceCredentialRecord({
            now,
            serviceId: 'claude-subscription',
            profileId: 'work',
            kind: 'oauth',
            expiresAt: now + 60_000,
            oauth: {
                accessToken: 'at',
                refreshToken: 'rt',
                idToken: null,
                scope: 'user:inference user:profile user:sessions:claude_code',
                tokenType: null,
                providerAccountId: null,
                providerEmail: 'alice@example.com',
            },
        });
        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://api.anthropic.com/api/oauth/usage',
            runtimeFetch: async () => ({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: {},
                body: null,
                text: async () => '',
                json: async () => ({
                    five_hour: { utilization: 12, resets_at: '2026-02-16T00:00:00Z' },
                }),
                arrayBuffer: async () => new ArrayBuffer(0),
            }),
        });
        const quotaSnapshot = await fetcher.loadQuota({
            record,
            now,
            signal: new AbortController().signal,
        });
        if (!quotaSnapshot) throw new Error('quota snapshot missing');

        const snapshot = moduleRecord.mapClaudeQuotaSnapshotToProviderAccountUsageSnapshot({
            subject: resolveClaudeUsageSubjectRef({
                subscriptionId: 'subscription-1',
                accountLabel: 'alice@example.com',
            }),
            quotaSnapshot,
            observedAtMs: now,
        });

        expect(ProviderAccountUsageSnapshotV1Schema.parse(snapshot)).toMatchObject({
            providerId: 'claude',
            source: 'providerHttp',
            confidence: 'confirmed',
            state: 'loaded_data',
            accountSubject: {
                kind: 'providerSubject',
                id: 'subscription-1',
            },
            accountLabel: 'alice@example.com',
            aliases: [{
                kind: 'connectedServiceProfile',
                serviceId: 'claude-subscription',
                profileId: 'work',
                accountSubjectId: 'subscription-1',
            }],
        });
    });

    it('keeps missing Claude provider subject records provisional even when labels match', async () => {
        const moduleRecord = await loadSnapshotModule();
        expect(moduleRecord).toEqual(expect.objectContaining({
            mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot: expect.any(Function),
        }));
        if (!moduleRecord) throw new Error('snapshot module missing');

        const observation = mapClaudeRuntimeRateLimitsToUsageObservation({
            rate_limits: {
                five_hour: { utilization: 70 },
            },
        });
        const nativeSnapshot = moduleRecord.mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
            subject: resolveClaudeUsageSubjectRef({
                accountLabel: 'same@example.com',
                provisionalDiscriminator: 'native',
            }),
            observation,
            observedAtMs: 1_000,
            fetchedAtMs: 1_000,
            aliases: [{ kind: 'nativeCli', localCredentialRef: 'claude-code' }],
            accountLabel: 'same@example.com',
        });
        const connectedSnapshot = moduleRecord.mapClaudeRuntimeRateLimitsToProviderAccountUsageSnapshot({
            subject: resolveClaudeUsageSubjectRef({
                accountLabel: 'same@example.com',
                provisionalDiscriminator: 'connected',
            }),
            observation,
            observedAtMs: 1_000,
            fetchedAtMs: 1_000,
            aliases: [{
                kind: 'connectedServiceProfile',
                serviceId: 'claude-subscription',
                profileId: 'work',
            }],
            accountLabel: 'same@example.com',
        });

        expect(nativeSnapshot.recordId).not.toBe(connectedSnapshot.recordId);
    });
});
