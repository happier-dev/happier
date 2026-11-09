import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { sealProviderAccountUsageSnapshotCiphertext } from '@happier-dev/protocol/connect/accountUsage';
import { createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, makeProviderAccountUsageSnapshot, makeQuotaSnapshot,
    plainQuotaResponse, resetConnectedServiceQuotaSnapshotsTestState } from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots source-backed authority', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    beforeEach(async () => { await resetConnectedServiceQuotaSnapshotsTestState(); boundary = await createLegacyQuotaTestHarness(); });
    afterEach(async () => { standardCleanup(); await boundary.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it('requires the connected-account view to bind cached provider usage to a legacy profile', async () => {
        const providerSnapshot = { ...makeProviderAccountUsageSnapshot(), subscription: {
            status: 'subscribed' as const, renewal: 'off' as const, observedAtMs: Date.now(), staleAfterMs: 60_000, currentPeriodEndAtMs: Date.now() + 86_400_000,
        } };
        boundary.usageRead.mockImplementation(async () => Response.json({ content: { t: 'plain', v: providerSnapshot },
            metadata: { fetchedAt: providerSnapshot.fetchedAtMs, staleAfterMs: providerSnapshot.staleAfterMs, status: 'ok' }, sources: [] }));
        const { useProviderAccountUsageSnapshots } = await import('./useProviderAccountUsageSnapshots');
        const canonical = await renderHook(() => useProviderAccountUsageSnapshots([providerSnapshot.recordId]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(canonical.getCurrent().snapshotsByRecordId[providerSnapshot.recordId]?.subscription).toEqual(providerSnapshot.subscription);
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const cached = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'openai-codex', profileId: 'work' }], { fetchPolicy: 'cache_only' }), { wrapper: Wrapper });
        expect(cached.getCurrent().snapshotsByKey['openai-codex/work'] ?? null).toBeNull();
        expect(boundary.plainRead).not.toHaveBeenCalled();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'openai-codex', meterId: 'connected-weekly' })));
        const acquiring = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'openai-codex', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        expect(acquiring.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('connected-weekly');
        expect(canonical.getCurrent().snapshotsByRecordId[providerSnapshot.recordId]?.meters[0]?.meterId).toBe('weekly');
    });

    it('opens predecessor provider-account usage ciphertext through the connected-service quota route', async () => {
        await boundary.dispose(); boundary = await createLegacyQuotaTestHarness({ accountMode: 'e2ee' });
        const canonicalSnapshot = makeProviderAccountUsageSnapshot();
        const ciphertext = sealProviderAccountUsageSnapshotCiphertext({
            material: { type: 'legacy', secret: new Uint8Array(32).fill(3) }, payload: canonicalSnapshot,
            randomBytes: length => new Uint8Array(length).fill(6),
        });
        boundary.sealedRead.mockImplementation(async () => Response.json({ sealed: { format: 'account_scoped_v1', ciphertext },
            metadata: { fetchedAt: canonicalSnapshot.fetchedAtMs, staleAfterMs: canonicalSnapshot.staleAfterMs, status: 'ok' } }));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'openai-codex', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).not.toHaveBeenCalled();
        expect(boundary.sealedRead).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']).toEqual(expect.objectContaining({
            serviceId: 'openai-codex', profileId: 'work', providerId: 'codex', activeAccountId: 'acct_stable',
        }));
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('weekly');
    });
});
