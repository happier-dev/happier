import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';

import { useLatestProviderUsageRecordIdsByAgent, useLatestProviderUsageRuntimeIssuesByAgent } from '@/sync/store/hooks';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => {
    standardCleanup();
});

const withUsageRefs = (recordIds: string[]) => ({
    flavor: 'claude',
    providerAccountUsageRefsV1: { v: 1, recordIds, updatedAtMs: 1_000 },
});

describe('useLatestProviderUsageRecordIdsByAgent', () => {
    it('keeps limit evidence stable through unrelated updates and clears it when the latest session recovers', async () => {
        const previousState = storage.getState();
        const issue = {
            v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            provider: 'claude', occurredAt: 1_000,
            usageLimit: { v: 1, resetAtMs: 10_000, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' },
        } as const;
        const session = createSessionFixture({ id: 'limited', metadata: { flavor: 'claude' } as never, lastRuntimeIssue: issue });
        try {
            storage.setState({ isDataReady: true, sessions: { limited: session } });
            let renders = 0;
            const hook = await renderHook(() => { renders++; return useLatestProviderUsageRuntimeIssuesByAgent(); });
            expect(hook.getCurrent().get('claude')).toEqual(issue);
            const before = renders;
            await act(async () => storage.setState({ sessions: { limited: { ...session, thinking: true } } }));
            expect(renders).toBe(before);
            await act(async () => storage.setState({ sessions: { limited: {
                ...session, metadata: { ...session.metadata, path: '/repo', host: 'test', flavor: 'codex' },
            } } }));
            expect(hook.getCurrent().get('claude')).toEqual(issue);
            expect(hook.getCurrent().has('codex')).toBe(false);
            await act(async () => storage.setState({ sessions: { limited: { ...session, lastRuntimeIssue: undefined } } }));
            expect(hook.getCurrent().has('claude')).toBe(false);
            await hook.unmount();
        } finally { storage.setState(previousState); }
    });
    it('stays quiet while unrelated session fields change, and updates when the record ids change', async () => {
        const previousState = storage.getState();
        try {
            const session = createSessionFixture({ id: 's1', metadata: withUsageRefs(['paug_v1_aaaaaaaa']) as never });
            storage.setState((state) => ({ ...state, isDataReady: true, sessions: { s1: session } }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useLatestProviderUsageRecordIdsByAgent();
            }, { flushOptions: { cycles: 1, turns: 4 } });
            expect(hook.getCurrent().get('claude')).toEqual(['paug_v1_aaaaaaaa']);
            const settledRenderCount = renderCount;

            // A streaming-style update: the session object changes, the usage ids do not.
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { s1: { ...session, updatedAt: session.updatedAt + 1, thinking: true } },
                }));
            });
            expect(renderCount).toBe(settledRenderCount);

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    sessions: { s1: { ...session, metadata: withUsageRefs(['paug_v1_bbbbbbbb']) as never } },
                }));
            });
            expect(hook.getCurrent().get('claude')).toEqual(['paug_v1_bbbbbbbb']);
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
