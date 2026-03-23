import { describe, expect, it } from 'vitest';

import { retentionPolicyToCapabilities } from './retentionPolicyToCapabilities';
import type { RetentionPolicy } from './retentionPolicyTypes';

function createPolicy(overrides?: Partial<RetentionPolicy>): RetentionPolicy {
    return {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 100,
        dryRun: false,
        maxDeletesPerRulePerRun: 500,
        domains: {
            sessions: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
            voiceSessionLeases: { mode: 'keep_forever' },
            userFeedItems: { mode: 'keep_forever' },
            sessionShareAccessLogs: { mode: 'keep_forever' },
            publicShareAccessLogs: { mode: 'keep_forever' },
            terminalAuthRequests: { mode: 'keep_forever' },
            accountAuthRequests: { mode: 'keep_forever' },
            authPairingSessions: { mode: 'keep_forever' },
            repeatKeys: { mode: 'keep_forever' },
            globalLocks: { mode: 'keep_forever' },
            automationRuns: { mode: 'keep_forever' },
            automationRunEvents: { mode: 'keep_forever' },
        },
        ...overrides,
    };
}

describe('retention/retentionPolicyToCapabilities', () => {
    it('reports keep_forever across all domains when retention is effectively disabled', () => {
        const capabilities = retentionPolicyToCapabilities(createPolicy({
            enabled: false,
            domains: {
                sessions: { mode: 'delete_inactive', inactivityDays: 30 },
                accountChanges: { mode: 'delete_older_than', days: 14 },
                voiceSessionLeases: { mode: 'keep_forever' },
                userFeedItems: { mode: 'keep_forever' },
                sessionShareAccessLogs: { mode: 'keep_forever' },
                publicShareAccessLogs: { mode: 'keep_forever' },
                terminalAuthRequests: { mode: 'keep_forever' },
                accountAuthRequests: { mode: 'keep_forever' },
                authPairingSessions: { mode: 'keep_forever' },
                repeatKeys: { mode: 'keep_forever' },
                globalLocks: { mode: 'keep_forever' },
                automationRuns: { mode: 'keep_forever' },
                automationRunEvents: { mode: 'keep_forever' },
            },
        }));

        expect(capabilities).toMatchObject({
            policyVersion: 1,
            enabled: false,
            sessions: { mode: 'keep_forever' },
            accountChanges: { mode: 'keep_forever' },
        });
    });

    it('maps finite retention policies to capability payload contracts', () => {
        const capabilities = retentionPolicyToCapabilities(createPolicy({
            domains: {
                sessions: { mode: 'delete_inactive', inactivityDays: 30 },
                accountChanges: { mode: 'delete_older_than', days: 14 },
                voiceSessionLeases: { mode: 'delete_older_than', days: 7 },
                userFeedItems: { mode: 'keep_forever' },
                sessionShareAccessLogs: { mode: 'delete_older_than', days: 21 },
                publicShareAccessLogs: { mode: 'keep_forever' },
                terminalAuthRequests: { mode: 'keep_forever' },
                accountAuthRequests: { mode: 'keep_forever' },
                authPairingSessions: { mode: 'keep_forever' },
                repeatKeys: { mode: 'keep_forever' },
                globalLocks: { mode: 'keep_forever' },
                automationRuns: { mode: 'delete_older_than', days: 45 },
                automationRunEvents: { mode: 'delete_older_than', days: 45 },
            },
        }));

        expect(capabilities).toMatchObject({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'delete_inactive',
                inactivityDays: 30,
                requires: ['updatedAt', 'lastActiveAt'],
            },
            accountChanges: { mode: 'delete_older_than', days: 14 },
            voiceSessionLeases: { mode: 'delete_older_than', days: 7 },
            automationRuns: { mode: 'delete_older_than', days: 45 },
            automationRunEvents: { mode: 'delete_older_than', days: 45 },
        });
    });
});
