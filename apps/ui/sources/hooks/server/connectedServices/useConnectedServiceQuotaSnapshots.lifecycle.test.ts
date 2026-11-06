import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { act } from 'react-test-renderer';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createDeferredResponse, createLegacyQuotaAuthWrapper, createLegacyQuotaTestHarness, makeQuotaSnapshot,
    plainQuotaResponse, resetConnectedServiceQuotaSnapshotsTestState, type ProfileRef } from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots predecessor acquisition lifecycle', () => {
    let boundary: Awaited<ReturnType<typeof createLegacyQuotaTestHarness>>;
    const Wrapper = createLegacyQuotaAuthWrapper(() => boundary);
    beforeEach(async () => { await resetConnectedServiceQuotaSnapshotsTestState(); boundary = await createLegacyQuotaTestHarness(); });
    afterEach(async () => { standardCleanup(); await boundary.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });

    it.each([false, true])('parks hidden quota renders and acquisition without disturbing a visible reader=%s, and reopens fresh', async shared => {
        vi.useFakeTimers();
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        let visible = true;
        let renders = 0;
        const profiles = [{ serviceId: 'anthropic', profileId: 'work' }];
        const ParkedWrapper = ({ children }: React.PropsWithChildren) => React.createElement(Wrapper, null,
            React.createElement(PluginSurfaceFocusEligibilityProvider, { active: visible, presentationActive: visible, children }));
        const hook = await renderHook(() => { renders += 1; return useConnectedServiceQuotaSnapshots(profiles); }, { wrapper: ParkedWrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        const peer = shared ? await renderHook(() => useConnectedServiceQuotaSnapshots(profiles), { wrapper: Wrapper }) : null;
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        visible = false;
        await hook.rerender();
        await flushHookEffects({ cycles: 8, turns: 8 });
        const held = hook.getCurrent();
        renders = 0;
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'current-window' })));
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect({ reads: boundary.plainRead.mock.calls.length, renders }).toEqual({ reads: shared ? 2 : 1, renders: 0 });
        expect(hook.getCurrent()).toBe(held);
        await peer?.unmount();
        visible = true;
        await hook.rerender();
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('current-window');
        expect(boundary.plainRead).toHaveBeenCalledTimes(shared ? 3 : 2);
        expect(boundary.control).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it.each(['equivalent', 'duplicate', 'reordered', 'removed sibling'] as const)(
        'keeps pending acquisition stable across a %s input rerender', async change => {
            const first = createDeferredResponse(), second = createDeferredResponse();
            boundary.plainRead.mockImplementation(async ref => (await (ref.serviceId === 'anthropic' ? first.promise : second.promise)).clone());
            const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
            const initial: ProfileRef[] = [{ serviceId: 'anthropic', profileId: 'work' }, { serviceId: 'openai-codex', profileId: 'work' }];
            const hook = await renderHook((profiles: readonly ProfileRef[]) => useConnectedServiceQuotaSnapshots(profiles),
                { initialProps: initial, wrapper: Wrapper });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(boundary.plainRead).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(true);
            const next = change === 'duplicate' ? [...initial, initial[0]!]
                : change === 'reordered' ? [...initial].reverse()
                : change === 'removed sibling' ? [initial[0]!] : initial.map(ref => ({ ...ref }));
            await hook.rerender(next); await flushHookEffects({ cycles: 8, turns: 8 });
            expect(boundary.plainRead).toHaveBeenCalledTimes(2);
            await act(async () => {
                first.resolve(plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' })));
                second.resolve(plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'openai-codex', meterId: 'monthly' })));
            });
            await flushHookEffects({ cycles: 8, turns: 8 });
            expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
            await vi.waitFor(() => expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false));
            if (change !== 'removed sibling') {
                expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('monthly');
                expect(hook.getCurrent().loadingByKey['openai-codex/work']).toBe(false);
            } else expect(hook.getCurrent().snapshotsByKey['openai-codex/work']).toBeUndefined();
            expect(boundary.control).not.toHaveBeenCalled();
        },
    );

    it.each([false, true])('isolates an old held response after Home replacement (same Home: %s)', async sameHome => {
        const held = createDeferredResponse();
        boundary.plainRead.mockImplementationOnce(() => held.promise);
        const oldUrl = boundary.account.home.serverUrl, oldIdentity = boundary.account.home.serverIdentityId!;
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await act(async () => {
            await boundary.dispose();
            boundary = await createLegacyQuotaTestHarness({ serverUrl: sameHome ? oldUrl : 'https://legacy-second-home.test',
                serverIdentityId: sameHome ? oldIdentity : 'srv_legacy_second_home' });
            boundary.plainRead.mockImplementation(async () => plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'current-home' })));
        });
        await hook.rerender(); await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('current-home');
        await act(async () => { held.resolve(plainQuotaResponse(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'retired-home' }))); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('current-home');
    });

    it('retains predecessor acquisition cadence while sharing readers and stops after final release', async () => {
        vi.useFakeTimers();
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const read = () => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]);
        const first = await renderHook(read, { wrapper: Wrapper }), second = await renderHook(read, { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(1);
        await first.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(2);
        expect(second.getCurrent().snapshotsByKey['anthropic/work']).not.toBeNull();
        await second.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(boundary.plainRead).toHaveBeenCalledTimes(2);
    });

    it('preserves retained data after failure without timed retries and recovers on a quota push', async () => {
        vi.useFakeTimers();
        const snapshot = makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'retained' });
        boundary.plainRead.mockImplementationOnce(async () => plainQuotaResponse(snapshot))
            .mockImplementationOnce(async () => Response.json({ error: 'quota_unavailable' }, { status: 400 }))
            .mockImplementation(async () => plainQuotaResponse({ ...snapshot, fetchedAt: Date.now(), meters: [{ ...snapshot.meters[0]!, meterId: 'recovered' }] }));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([{ serviceId: 'anthropic', profileId: 'work' }]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']).toEqual(snapshot);
        expect(hook.getCurrent().errorsByKey['anthropic/work']).not.toBeNull();
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        const failedReads = boundary.plainRead.mock.calls.length;
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.plainRead).toHaveBeenCalledTimes(failedReads);
        await act(async () => { publishHomeAccountChange(getActiveServerSnapshot().serverId,
            [PROVIDER_ACCOUNT_USAGE_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }); });
        await flushHookEffects({ cycles: 8, turns: 8 });
        await vi.waitFor(() => expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('recovered'));
        expect(hook.getCurrent().errorsByKey['anthropic/work']).toBeNull();
    });

    it('admits a selected manual refresh through the real daemon transport and acquires its newer observation', async () => {
        const first = makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'before', fetchedAt: 100 });
        boundary.plainRead.mockImplementation(async ref => plainQuotaResponse(ref.serviceId === 'anthropic' ? first : makeQuotaSnapshot({ serviceId: 'openai-codex' })));
        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'anthropic', profileId: 'work' }, { serviceId: 'openai-codex', profileId: 'work' },
        ]), { wrapper: Wrapper });
        await flushHookEffects({ cycles: 8, turns: 8 });
        expect(boundary.control).not.toHaveBeenCalled();
        boundary.plainRead.mockImplementation(async () => plainQuotaResponse({ ...first, fetchedAt: 101, meters: [{ ...first.meters[0]!, meterId: 'after' }] }));
        await act(async () => { await hook.getCurrent().refresh(['anthropic/work']); });
        expect(boundary.refreshRead).toHaveBeenCalledWith({ serviceId: 'anthropic', profileId: 'work' }, 'v3');
        expect(boundary.control).toHaveBeenCalledTimes(1);
        expect(boundary.controls[0]?.command).toEqual(expect.objectContaining({ operation: 'describeService', requiredOperation: 'quota_refresh' }));
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('after');
        expect(hook.getCurrent().refreshingByKey['anthropic/work']).toBe(false);
    });
});
