import { describe, expect, it } from 'vitest';

import { readRetentionPolicyFromEnv } from './readRetentionPolicyFromEnv';
import { RETENTION_DOMAIN_SERVER_CONFIG } from './retentionServerConfig';

describe('retention/readRetentionPolicyFromEnv', () => {
    it('defaults provider history to 90 days and accepts the operator override', () => {
        // Owner ruling 2026-11-12: covered detail expires; sealed daily summaries remain.
        expect(readRetentionPolicyFromEnv({}).domains).toMatchObject({
            providerAccountUsageHistory: { mode: 'delete_older_than', days: 90 },
        });
        expect(readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__PROVIDER_ACCOUNT_USAGE_HISTORY__DAYS: '180',
        }).domains).toMatchObject({
            providerAccountUsageHistory: { mode: 'delete_older_than', days: 180 },
        });
        expect(readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__PROVIDER_ACCOUNT_USAGE_HISTORY__MODE: 'keep_forever',
        }).domains).toMatchObject({ providerAccountUsageHistory: { mode: 'keep_forever' } });
        expect(RETENTION_DOMAIN_SERVER_CONFIG.find((entry) => entry.key === 'HAPPIER_SERVER_RETENTION__PROVIDER_ACCOUNT_USAGE_HISTORY__MODE'))
            .toMatchObject({ default: 'delete_older_than', editable: 'home', apply: 'live' });
        expect(RETENTION_DOMAIN_SERVER_CONFIG.find((entry) => entry.key === 'HAPPIER_SERVER_RETENTION__PROVIDER_ACCOUNT_USAGE_HISTORY__DAYS'))
            .toMatchObject({ default: 90, editable: 'home', apply: 'live' });
        expect(readRetentionPolicyFromEnv({}).enabled).toBe(false);
    });

    it('defaults public share access logs to 90 days, running even when automatic deletion is off', () => {
        // Owner ruling 2026-11-15 (Growth decisions final).
        expect(readRetentionPolicyFromEnv({}).domains.publicShareAccessLogs).toEqual({ mode: 'delete_older_than', days: 90 });
        expect(RETENTION_DOMAIN_SERVER_CONFIG.find((entry) => entry.key === 'HAPPIER_SERVER_RETENTION__PUBLIC_SHARE_ACCESS_LOGS__MODE'))
            .toMatchObject({ default: 'delete_older_than', description: expect.stringContaining('Runs even when automatic deletion is off.') });
        expect(RETENTION_DOMAIN_SERVER_CONFIG.find((entry) => entry.key === 'HAPPIER_SERVER_RETENTION__PUBLIC_SHARE_ACCESS_LOGS__DAYS'))
            .toMatchObject({ default: 90 });
    });

    it('falls back to defaults when env is undefined', () => {
        const policy = readRetentionPolicyFromEnv(undefined as unknown as NodeJS.ProcessEnv);

        expect(policy).toMatchObject({
            enabled: false,
            intervalMs: 60 * 60 * 1000,
            batchSize: 500,
            dryRun: false,
            maxDeletesPerRulePerRun: 100_000,
            sweepTimeBudgetMs: 10_000,
            maxCandidatesPerRulePerRun: 10_000,
            domains: {
                sessions: { mode: 'keep_forever' },
                sessionSidechainMessages: { mode: 'keep_forever' },
                accountChanges: { mode: 'keep_forever' },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'keep_forever' },
                usageEvents: { mode: 'keep_forever' },
            },
        });
    });

    it('keeps automatic deletion disabled by default', () => {
        const policy = readRetentionPolicyFromEnv({});

        expect(policy).toMatchObject({
            enabled: false,
            intervalMs: 60 * 60 * 1000,
            batchSize: 500,
            dryRun: false,
            maxDeletesPerRulePerRun: 100_000,
            sweepTimeBudgetMs: 10_000,
            maxCandidatesPerRulePerRun: 10_000,
            domains: {
                sessions: { mode: 'keep_forever' },
                sessionSidechainMessages: { mode: 'keep_forever' },
                accountChanges: { mode: 'keep_forever' },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'keep_forever' },
                usageEvents: { mode: 'keep_forever' },
            },
        });
    });

    it('parses finite retention policies from env', () => {
        const policy = readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__ENABLED: 'true',
            HAPPIER_SERVER_RETENTION__INTERVAL_MS: '30000',
            HAPPIER_SERVER_RETENTION__BATCH_SIZE: '25',
            HAPPIER_SERVER_RETENTION__DRY_RUN: '1',
            HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: '250',
            HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: '5000',
            HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: '750',
            HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
            HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '30',
            HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: '7',
            HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '14',
            HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__DAYS: '7',
            HAPPIER_SERVER_RETENTION__USAGE_EVENTS__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__USAGE_EVENTS__DAYS: '180',
        });

        expect(policy).toMatchObject({
            enabled: true,
            intervalMs: 30000,
            batchSize: 25,
            dryRun: true,
            maxDeletesPerRulePerRun: 250,
            sweepTimeBudgetMs: 5_000,
            maxCandidatesPerRulePerRun: 750,
            domains: {
                sessions: { mode: 'delete_inactive', inactivityDays: 30 },
                sessionSidechainMessages: { mode: 'delete_older_than', days: 7 },
                accountChanges: { mode: 'delete_older_than', days: 14 },
                voiceSessionLeases: { mode: 'delete_older_than', days: 7 },
                usageEvents: { mode: 'delete_older_than', days: 180 },
            },
        });
    });

    it('throws when a finite retention mode is missing its day value', () => {
        expect(() => readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        })).toThrow(/SESSIONS__INACTIVITY_DAYS/i);

        expect(() => readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: 'delete_older_than',
        })).toThrow(/SESSION_SIDECHAIN_MESSAGES__DAYS/i);
    });

    it('rejects non-integer numeric values for positive integer settings', () => {
        expect(() => readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__INTERVAL_MS: '1.5',
        })).toThrow(/INTERVAL_MS must be a positive integer/i);

        expect(() => readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__BATCH_SIZE: '1e3',
        })).toThrow(/BATCH_SIZE must be a positive integer/i);
    });
});
