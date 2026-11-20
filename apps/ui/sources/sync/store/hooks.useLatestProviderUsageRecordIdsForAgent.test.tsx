import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { useLatestProviderUsageRecordIdsForAgent } from './hooks';
import { storage } from '@/sync/domains/state/storageStore';

afterEach(() => standardCleanup());

describe('native provider usage discovery', () => {
  it('keeps known refs through newer unmetered sessions without subscribing the composer to other providers', async () => {
    const previous = storage.getState();
    const metadata = (flavor: string, recordIds: string[]) => ({ flavor, path: '/repo', host: 'test',
      providerAccountUsageRefsV1: { v: 1 as const, recordIds, updatedAtMs: 1_000 } });
    storage.setState({ isDataReady: true, sessions: {
      old: createSessionFixture({ id: 'old', updatedAt: 1_000, metadata: metadata('codex', ['paug_v1_aaaaaaaa']) }),
      known: createSessionFixture({ id: 'known', updatedAt: 2_000, metadata: metadata('codex', ['paug_v1_bbbbbbbb']) }),
      direct: createSessionFixture({ id: 'direct', updatedAt: 3_000, metadata: metadata('codex', []) }),
    } });
    try {
      let renderCount = 0;
      const hook = await renderHook((agentId: 'codex' | 'claude' | null) => {
        renderCount++;
        return useLatestProviderUsageRecordIdsForAgent(agentId);
      }, { initialProps: 'codex' as 'codex' | 'claude' | null });
      try {
        expect(hook.getCurrent()).toEqual(['paug_v1_bbbbbbbb']);
        const settledCount = renderCount;
        await act(async () => storage.setState(state => ({ sessions: { ...state.sessions,
          other: createSessionFixture({ id: 'other', updatedAt: 4_000, metadata: metadata('claude', ['paug_v1_cccccccc']) }),
        } })));
        expect(renderCount).toBe(settledCount);
        await hook.rerender('claude');
        expect(hook.getCurrent()).toEqual(['paug_v1_cccccccc']);
        await hook.rerender(null);
        expect(hook.getCurrent()).toEqual([]);
        await hook.rerender('codex');
        await act(async () => storage.setState({ isDataReady: false, sessions: {} }));
        expect(hook.getCurrent()).toEqual([]);
      } finally { await hook.unmount(); }
    } finally { storage.setState(previous); }
  });
});
