import { beforeEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import { sealProviderAccountUsageSnapshotCiphertext } from '@happier-dev/protocol';

import {
    fetchAccountEncryptionModeSpy,
    getConnectedServiceQuotaSnapshotSealedSpy,
    getConnectedServiceQuotaSnapshotPlainSpy,
    getProviderAccountUsageSnapshotPlainSpy,
    makeProviderAccountUsageSnapshot,
    makeQuotaSnapshot,
    resetConnectedServiceQuotaSnapshotsTestState,
} from './useConnectedServiceQuotaSnapshots.testkit';

function fixedRandomBytes(byte: number) {
    return (length: number) => new Uint8Array(length).fill(byte);
}

describe('useConnectedServiceQuotaSnapshots source-backed authority', () => {
    beforeEach(async () => {
        const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
        __resetConnectedServiceQuotaSnapshotStore();
        resetConnectedServiceQuotaSnapshotsTestState();
    });

    it('does not project connected-service quota snapshots from cached provider-account usage', async () => {
        const providerSnapshot = makeProviderAccountUsageSnapshot();
        getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(providerSnapshot);

        const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
        const canonicalHook = await renderHook(() => useProviderAccountUsageSnapshots([providerSnapshot.recordId]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'openai-codex', profileId: 'work' },
        ], { fetchPolicy: 'cache_only' }));

        expect(hook.getCurrent().snapshotsByKey['openai-codex/work'] ?? null).toBeNull();
        expect(getConnectedServiceQuotaSnapshotPlainSpy).not.toHaveBeenCalled();
        await hook.unmount();
        await canonicalHook.unmount();
    });

    it('loads the connected-service quota view even when matching provider-account usage is cached', async () => {
        const providerSnapshot = makeProviderAccountUsageSnapshot();
        getProviderAccountUsageSnapshotPlainSpy.mockResolvedValue(providerSnapshot);
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(
            makeQuotaSnapshot({ serviceId: 'openai-codex', meterId: 'connected-weekly' }),
        );

        const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
        const canonicalHook = await renderHook(() => useProviderAccountUsageSnapshots([providerSnapshot.recordId]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'openai-codex', profileId: 'work' },
        ]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('connected-weekly');
        await hook.unmount();
        await canonicalHook.unmount();
    });

    it('opens provider-account usage ciphertext returned by the connected-service quota view route', async () => {
        fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'e2ee', updatedAt: 0 });
        const canonicalSnapshot = makeProviderAccountUsageSnapshot();
        const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
            material: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
            payload: canonicalSnapshot,
            randomBytes: fixedRandomBytes(6),
        });
        getConnectedServiceQuotaSnapshotSealedSpy.mockResolvedValue({
            sealed: { format: 'account_scoped_v1', ciphertext },
            metadata: {
                fetchedAt: canonicalSnapshot.fetchedAtMs,
                staleAfterMs: canonicalSnapshot.staleAfterMs,
                status: 'ok',
            },
        });

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'openai-codex', profileId: 'work' },
        ]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']).toEqual(expect.objectContaining({
            serviceId: 'openai-codex',
            profileId: 'work',
            providerId: 'codex',
            activeAccountId: 'acct_stable',
        }));
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('weekly');
        await hook.unmount();
    });
});
