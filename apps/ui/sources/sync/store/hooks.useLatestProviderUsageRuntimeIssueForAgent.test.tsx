import { afterEach, describe, expect, it } from 'vitest';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useLatestProviderUsageRuntimeIssueForAgent } from './hooks';

afterEach(() => standardCleanup());

describe('useLatestProviderUsageRuntimeIssueForAgent', () => {
    it.each(['claude', 'codex', 'opencode'] as const)('returns the latest %s usage-limit observation across sessions', async (agentId) => {
        const previous = storage.getState();
        const oldIssue = {
            v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            provider: agentId, occurredAt: 1_000,
            usageLimit: { v: 1, resetAtMs: 10_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
        } as const;
        const latestIssue = { ...oldIssue, occurredAt: 2_000 };
        try {
            storage.setState({ isDataReady: true, sessions: {
                old: createSessionFixture({ id: 'old', metadata: { flavor: agentId } as never, lastRuntimeIssue: oldIssue }),
                latest: createSessionFixture({ id: 'latest', metadata: { flavor: agentId } as never, lastRuntimeIssue: latestIssue }),
            } });
            const hook = await renderHook(() => useLatestProviderUsageRuntimeIssueForAgent(agentId));
            try {
                expect(hook.getCurrent()).toEqual({ isDataReady: true, issue: latestIssue });
            } finally { await hook.unmount(); }
        } finally { storage.setState(previous); }
    });
});
