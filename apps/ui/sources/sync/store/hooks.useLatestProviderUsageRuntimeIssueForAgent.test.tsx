import { afterEach, describe, expect, it } from 'vitest';
import { createSessionFixture, standardCleanup } from '@/dev/testkit';
import { selectProviderUsageRecordIds, selectProviderUsageRuntimeIssuesForAccounts } from './hooks';

afterEach(() => standardCleanup());

function limitIssue(provider: string, occurredAt: number, profileId?: string) {
    return {
        v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
        provider, occurredAt,
        usageLimit: {
            v: 1, resetAtMs: 100_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait',
            ...(profileId ? { quotaSnapshotRef: { serviceId: 'openai-codex', profileId, fetchedAtMs: occurredAt } } : {}),
        },
    } as const;
}

function session(id: string, flavor: string, issue: unknown, recordIds: string[] = []) {
    return createSessionFixture({
        id,
        metadata: {
            flavor,
            ...(recordIds.length ? { providerAccountUsageRefsV1: { v: 1, recordIds, updatedAtMs: 1 } } : {}),
        } as never,
        lastRuntimeIssue: issue as never,
    });
}

describe('selectProviderUsageRuntimeIssuesForAccounts', () => {
    it.each(['claude', 'codex', 'opencode'] as const)(
        'filters %s evidence by the selected account before choosing the newest',
        (provider) => {
            const sessions = {
                a1: session('a1', provider, limitIssue(provider, 1_000, 'A')),
                a2: session('a2', provider, limitIssue(provider, 2_000, 'A')),
                b3: session('b3', provider, limitIssue(provider, 3_000, 'B')),
            };
            const [issue] = selectProviderUsageRuntimeIssuesForAccounts(sessions, [{
                providerId: provider,
                profileRef: { serviceId: 'openai-codex', profileId: 'A' },
            }]);
            expect(issue?.occurredAt).toBe(2_000);
        },
    );

    it('shares native evidence only between sessions of the same native account', () => {
        const sessions = {
            mine: session('mine', 'codex', limitIssue('codex', 1_000), ['paug_v1_mineaaaa']),
            mineLater: session('mineLater', 'codex', limitIssue('codex', 2_000), ['paug_v1_mineaaaa']),
            other: session('other', 'codex', limitIssue('codex', 3_000), ['paug_v1_otherbbb']),
        };
        const [issue] = selectProviderUsageRuntimeIssuesForAccounts(sessions, [{
            providerId: 'codex',
            metadataRecordIds: ['paug_v1_mineaaaa'],
            sessionId: 'mine',
        }]);
        expect(issue?.occurredAt).toBe(2_000);
    });

    it('keeps evidence session-local when the account is unknown', () => {
        const sessions = {
            mine: session('mine', 'codex', limitIssue('codex', 1_000)),
            other: session('other', 'codex', limitIssue('codex', 3_000)),
        };
        const [issue] = selectProviderUsageRuntimeIssuesForAccounts(sessions, [{ providerId: 'codex', sessionId: 'mine' }]);
        expect(issue?.occurredAt).toBe(1_000);
    });

    it('does not rescan sessions while the sessions record is unchanged', () => {
        const sessions = { mine: session('mine', 'codex', limitIssue('codex', 1_000), ['paug_v1_mineaaaa']) };
        const target = [{ providerId: 'codex', metadataRecordIds: ['paug_v1_mineaaaa'], sessionId: 'mine' }];
        const first = selectProviderUsageRuntimeIssuesForAccounts(sessions, target);
        // Mutating the session in place would be visible to a rescan; a cached read keeps the first answer.
        (sessions.mine as { lastRuntimeIssue: unknown }).lastRuntimeIssue = limitIssue('codex', 9_000);
        expect(selectProviderUsageRuntimeIssuesForAccounts(sessions, target)[0]).toBe(first[0]);
        const ids = selectProviderUsageRecordIds(sessions);
        expect(selectProviderUsageRecordIds(sessions)).toBe(ids);
    });

    it('ignores the asking session\'s own evidence when it is for another provider', () => {
        const sessions = { mine: session('mine', 'codex', limitIssue('codex', 1_000)) };
        const [issue] = selectProviderUsageRuntimeIssuesForAccounts(sessions, [{ providerId: 'claude', sessionId: 'mine' }]);
        expect(issue).toBeNull();
    });
});
