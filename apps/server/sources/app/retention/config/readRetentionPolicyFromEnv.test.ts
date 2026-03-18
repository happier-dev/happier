import { describe, expect, it } from 'vitest';

import { readRetentionPolicyFromEnv } from './readRetentionPolicyFromEnv';

describe('retention/readRetentionPolicyFromEnv', () => {
    it('falls back to defaults when env is undefined', () => {
        const policy = readRetentionPolicyFromEnv(undefined as unknown as NodeJS.ProcessEnv);

        expect(policy).toMatchObject({
            enabled: false,
            intervalMs: 6 * 60 * 60 * 1000,
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 1000,
            domains: {
                sessions: { mode: 'keep_forever' },
                accountChanges: { mode: 'keep_forever' },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'keep_forever' },
                globalLocks: { mode: 'keep_forever' },
            },
        });
    });

    it('defaults every domain to keep_forever with retention disabled', () => {
        const policy = readRetentionPolicyFromEnv({});

        expect(policy).toMatchObject({
            enabled: false,
            intervalMs: 6 * 60 * 60 * 1000,
            batchSize: 100,
            dryRun: false,
            maxDeletesPerRulePerRun: 1000,
            domains: {
                sessions: { mode: 'keep_forever' },
                accountChanges: { mode: 'keep_forever' },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'keep_forever' },
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
            HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
            HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '30',
            HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '14',
            HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__MODE: 'delete_older_than',
            HAPPIER_SERVER_RETENTION__VOICE_SESSION_LEASES__DAYS: '7',
        });

        expect(policy).toMatchObject({
            enabled: true,
            intervalMs: 30000,
            batchSize: 25,
            dryRun: true,
            maxDeletesPerRulePerRun: 250,
            domains: {
                sessions: { mode: 'delete_inactive', inactivityDays: 30 },
                accountChanges: { mode: 'delete_older_than', days: 14 },
                voiceSessionLeases: { mode: 'delete_older_than', days: 7 },
            },
        });
    });

    it('throws when a finite retention mode is missing its day value', () => {
        expect(() => readRetentionPolicyFromEnv({
            HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        })).toThrow(/SESSIONS__INACTIVITY_DAYS/i);
    });
});
