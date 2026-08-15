import { describe, expect, it } from 'vitest';

import {
    formatServerRetentionDisclosure,
    formatServerRetentionRows,
    formatSessionRetentionSummary,
} from './formatServerRetentionPolicy';
import {
    hasFiniteRetentionPolicy,
    normalizeServerRetentionPolicyV2,
    type ServerRetentionPolicy,
} from './serverRetentionPolicy';

describe('hasFiniteRetentionPolicy', () => {
    it('treats missing domain entries as non-finite instead of throwing', () => {
        expect(() => hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).not.toThrow();
        expect(hasFiniteRetentionPolicy({
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as any)).toBe(false);
    });
});

describe('formatServerRetentionRows', () => {
    it('treats omitted optional domain policies as keep-forever rows', () => {
        const policy = {
            policyVersion: 1,
            enabled: true,
            sessions: {
                mode: 'keep_forever',
            },
        } as unknown as ServerRetentionPolicy; // Boundary fixture: older servers may omit domain entries.

        expect(() => formatServerRetentionRows(policy)).not.toThrow();
        expect(formatServerRetentionRows(policy)).toHaveLength(1);
    });

    it('renders unknown complete-policy domains instead of silently dropping them', () => {
        const policy = normalizeServerRetentionPolicyV2({
            version: 2,
            enabled: true,
            complete: true,
            domains: [{ id: 'futureDomain', policy: { mode: 'delete_older_than', days: 9 } }],
        });

        expect(formatServerRetentionRows(policy)).toEqual([{
            key: 'futureDomain',
            title: 'futureDomain',
            detail: expect.any(String),
        }]);
        expect(hasFiniteRetentionPolicy(policy)).toBe(true);
    });

    it('distinguishes an incomplete legacy policy from complete keep-forever policy', () => {
        const legacy = {
            policyVersion: 1,
            enabled: true,
            sessions: { mode: 'keep_forever' },
        } as unknown as ServerRetentionPolicy;

        expect(formatSessionRetentionSummary(legacy)).not.toBe(formatSessionRetentionSummary({
            enabled: false,
            completeness: 'complete',
            domains: [],
        }));
    });
});

describe('formatServerRetentionDisclosure', () => {
    it('describes a sidechain policy as compact user-facing subagent cleanup copy', () => {
        const policy = normalizeServerRetentionPolicyV2({
            version: 2,
            enabled: true,
            complete: true,
            domains: [{ id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } }],
        });

        expect(formatServerRetentionDisclosure(policy)).toBe(
            'This relay cleans up subagent transcripts after 7 days.',
        );
    });

    it('lists multiple cleanup policies in one comma-separated sentence', () => {
        const policy = normalizeServerRetentionPolicyV2({
            version: 2,
            enabled: true,
            complete: true,
            domains: [
                { id: 'sessions', policy: { mode: 'delete_inactive', inactivityDays: 30 } },
                { id: 'sessionSidechainMessages', policy: { mode: 'delete_older_than', days: 7 } },
            ],
        });

        expect(formatServerRetentionDisclosure(policy)).toBe(
            'This relay cleans up inactive sessions after 30 days, subagent transcripts after 7 days.',
        );
    });
});
