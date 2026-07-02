import { beforeEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import {
    getConnectedServiceQuotaSnapshotPlainSpy,
    getProviderAccountUsageSnapshotPlainSpy,
    makeProviderAccountUsageSnapshot,
    resetConnectedServiceQuotaSnapshotsTestState,
} from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots canonical account usage projection', () => {
    beforeEach(() => {
        resetConnectedServiceQuotaSnapshotsTestState();
    });

    it('projects connected-service quota results from the canonical provider account usage cache', async () => {
        const providerSnapshot = makeProviderAccountUsageSnapshot();
        getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(providerSnapshot);

        const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
        const canonicalHook = await renderHook(() => useProviderAccountUsageSnapshots([providerSnapshot.recordId]));
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(canonicalHook.getCurrent().snapshotsByRecordId[providerSnapshot.recordId]?.recordId).toBe(providerSnapshot.recordId);

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'openai-codex', profileId: 'work' },
        ], { fetchPolicy: 'cache_only' }));

        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.activeAccountId).toBe('acct_stable');
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('weekly');
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
        await hook.unmount();
        await canonicalHook.unmount();
    });
});
