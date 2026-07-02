import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import {
    createDeferredPlainSnapshot,
    getConnectedServiceQuotaSnapshotPlainSpy,
    makeQuotaSnapshot,
    resetConnectedServiceQuotaSnapshotsTestState,
    stableCredentials,
    type PlainQuotaSnapshotResult,
    type ProfileRef,
} from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots fetch lifecycle', () => {
    beforeEach(() => {
        resetConnectedServiceQuotaSnapshotsTestState();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('does not start duplicate quota fetches when rerendered with equivalent profile refs before the first fetch settles', async () => {
        const pendingPlain = createDeferredPlainSnapshot();
        getConnectedServiceQuotaSnapshotPlainSpy.mockReturnValue(pendingPlain.promise);

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (props: ProfileRef) => useConnectedServiceQuotaSnapshots([props]),
            { initialProps: { serviceId: 'anthropic', profileId: 'work' } },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        await hook.rerender({ serviceId: 'anthropic', profileId: 'work' });
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingPlain.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));
        });
        await flushHookEffects({ cycles: 10, turns: 10 });

        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        await hook.unmount();
    });

    it('does not abort an unresolved quota fetch when an equivalent rerender adds a duplicate profile ref', async () => {
        const pendingPlain = createDeferredPlainSnapshot();
        getConnectedServiceQuotaSnapshotPlainSpy.mockReturnValue(pendingPlain.promise);

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
            { initialProps: [{ serviceId: 'anthropic', profileId: 'work' }] },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(true);

        await hook.rerender([
            { serviceId: 'anthropic', profileId: 'work' },
            { serviceId: 'anthropic', profileId: 'work' },
        ]);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(1);

        await act(async () => {
            pendingPlain.resolve(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));
        });
        await flushHookEffects({ cycles: 10, turns: 10 });

        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        await hook.unmount();
    });

    it('does not abort unresolved quota fetches when equivalent profile refs are reordered', async () => {
        const snapshotByKey = {
            'anthropic/work': makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }),
            'openai-codex/work': makeQuotaSnapshot({ serviceId: 'openai-codex', meterId: 'monthly' }),
        } as const;
        const resolvers: Partial<Record<keyof typeof snapshotByKey, (value: PlainQuotaSnapshotResult) => void>> = {};
        getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => {
            const key = `${params.serviceId}/${params.profileId}` as keyof typeof snapshotByKey;
            return await new Promise<PlainQuotaSnapshotResult>((resolve) => {
                resolvers[key] = resolve;
            });
        });

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
            {
                initialProps: [
                    { serviceId: 'anthropic', profileId: 'work' },
                    { serviceId: 'openai-codex', profileId: 'work' },
                ],
            },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(true);
        expect(hook.getCurrent().loadingByKey['openai-codex/work']).toBe(true);

        await hook.rerender([
            { serviceId: 'openai-codex', profileId: 'work' },
            { serviceId: 'anthropic', profileId: 'work' },
        ]);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolvers['anthropic/work']?.(snapshotByKey['anthropic/work']);
            resolvers['openai-codex/work']?.(snapshotByKey['openai-codex/work']);
        });
        await flushHookEffects({ cycles: 10, turns: 10 });

        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().snapshotsByKey['openai-codex/work']?.meters[0]?.meterId).toBe('monthly');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        expect(hook.getCurrent().loadingByKey['openai-codex/work']).toBe(false);
        await hook.unmount();
    });

    it('keeps an unresolved quota fetch alive when a rerender removes a different profile ref', async () => {
        const snapshotByKey = {
            'anthropic/work': makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }),
            'openai-codex/work': makeQuotaSnapshot({ serviceId: 'openai-codex' }),
        } as const;
        const resolvers: Partial<Record<keyof typeof snapshotByKey, (value: PlainQuotaSnapshotResult) => void>> = {};
        getConnectedServiceQuotaSnapshotPlainSpy.mockImplementation(async (_credentials, params) => {
            const key = `${params.serviceId}/${params.profileId}` as keyof typeof snapshotByKey;
            return await new Promise<PlainQuotaSnapshotResult>((resolve) => {
                resolvers[key] = resolve;
            });
        });

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(
            (profiles: ReadonlyArray<ProfileRef>) => useConnectedServiceQuotaSnapshots(profiles),
            {
                initialProps: [
                    { serviceId: 'anthropic', profileId: 'work' },
                    { serviceId: 'openai-codex', profileId: 'work' },
                ],
            },
        );

        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(true);

        await hook.rerender([{ serviceId: 'anthropic', profileId: 'work' }]);
        await flushHookEffects({ cycles: 3, turns: 3 });
        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolvers['anthropic/work']?.(snapshotByKey['anthropic/work']);
            resolvers['openai-codex/work']?.(snapshotByKey['openai-codex/work']);
        });
        await flushHookEffects({ cycles: 10, turns: 10 });

        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        await hook.unmount();
    });

    it('fetches a reliable session-bound quota snapshot even when no meters are pinned', async () => {
        getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(makeQuotaSnapshot({ serviceId: 'anthropic', meterId: 'weekly' }));

        const { useConnectedServiceQuotaSnapshots } = await import('./useConnectedServiceQuotaSnapshots');
        const hook = await renderHook(() => useConnectedServiceQuotaSnapshots([
            { serviceId: 'anthropic', profileId: 'work' },
        ]));
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledWith(stableCredentials, {
            serviceId: 'anthropic',
            profileId: 'work',
        }, { signal: expect.any(AbortSignal) });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        await hook.unmount();
    });
});
