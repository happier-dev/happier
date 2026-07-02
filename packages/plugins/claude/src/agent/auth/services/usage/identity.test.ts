import { describe, expect, it } from 'vitest';

import { resolveClaudeUsageSubjectRef } from './identity.js';

describe('resolveClaudeUsageSubjectRef', () => {
    it('uses provider-owned account or subscription evidence as a stable subject', () => {
        expect(resolveClaudeUsageSubjectRef({
            providerAccountId: 'claude-account-1',
            accountLabel: 'same@example.com',
        })).toEqual({
            providerId: 'claude',
            kind: 'providerSubject',
            accountSubjectId: 'claude-account-1',
            subjectKind: 'account',
            proof: 'provider_account_id',
        });

        expect(resolveClaudeUsageSubjectRef({
            subscriptionId: 'subscription-1',
            accountLabel: 'same@example.com',
        })).toMatchObject({
            kind: 'providerSubject',
            accountSubjectId: 'subscription-1',
            subjectKind: 'subscription',
        });
    });

    it('keeps missing-account-id records provisional instead of merging by email', () => {
        const first = resolveClaudeUsageSubjectRef({
            accountLabel: 'same@example.com',
            provisionalDiscriminator: 'native-keychain',
        });
        const second = resolveClaudeUsageSubjectRef({
            accountLabel: 'same@example.com',
            provisionalDiscriminator: 'connected-profile',
        });

        expect(first.kind).toBe('provisionalLocalSubject');
        expect(second.kind).toBe('provisionalLocalSubject');
        expect(first.accountSubjectId).not.toBe(second.accountSubjectId);
    });

    it('requires provider-owned local evidence before creating a provisional subject', () => {
        expect(() => resolveClaudeUsageSubjectRef({
            accountLabel: 'same@example.com',
        })).toThrow(/provisional subject discriminator/i);
    });
});
