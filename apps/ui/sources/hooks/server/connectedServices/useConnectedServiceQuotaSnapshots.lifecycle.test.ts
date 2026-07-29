import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import {
    activeServerSnapshotState,
    createDeferredPlainSnapshot,
    getConnectedServiceQuotaSnapshotPlainSpy,
    makeQuotaSnapshot,
    resetConnectedServiceQuotaSnapshotsTestState,
    stableCredentials,
    type PlainQuotaSnapshotResult,
    type ProfileRef,
} from './useConnectedServiceQuotaSnapshots.testkit';

describe('useConnectedServiceQuotaSnapshots fetch lifecycle', () => {
    beforeEach(async () => {
        const { __resetConnectedServiceQuotaSnapshotStore } = await import('./connectedServiceQuotaSnapshotStore');
        __resetConnectedServiceQuotaSnapshotStore();
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
        }, {
            expectedActiveServer: {
                serverId: 'server-a',
                generation: 1,
            },
        });
        expect(hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]?.meterId).toBe('weekly');
        expect(hook.getCurrent().loadingByKey['anthropic/work']).toBe(false);
        await hook.unmount();
    });

    it('isolates the quota cache by active server even when credentials are identical', async () => {
        getConnectedServiceQuotaSnapshotPlainSpy
            .mockResolvedValueOnce(makeQuotaSnapshot({
                serviceId: 'anthropic',
                meterId: 'server-a',
            }))
            .mockResolvedValueOnce(makeQuotaSnapshot({
                serviceId: 'anthropic',
                meterId: 'server-b',
            }));

        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(
            () => useConnectedServiceQuotaSnapshots([
                { serviceId: 'anthropic', profileId: 'work' },
            ]),
        );
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]
                ?.meterId,
        ).toBe('server-a');

        activeServerSnapshotState.current = {
            serverId: 'server-b',
            serverUrl: 'https://server-b.example.test',
            generation: 2,
        };
        await hook.rerender();
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(getConnectedServiceQuotaSnapshotPlainSpy).toHaveBeenCalledTimes(
            2,
        );
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']?.meters[0]
                ?.meterId,
        ).toBe('server-b');
        await hook.unmount();
    });

    it('does not commit an in-flight quota snapshot after the same server reconnects', async () => {
        const first = createDeferredPlainSnapshot();
        getConnectedServiceQuotaSnapshotPlainSpy
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce(makeQuotaSnapshot({
                serviceId: 'anthropic',
                meterId: 'generation-2',
            }));

        const { useConnectedServiceQuotaSnapshots } = await import(
            './useConnectedServiceQuotaSnapshots'
        );
        const hook = await renderHook(
            () => useConnectedServiceQuotaSnapshots([
                { serviceId: 'anthropic', profileId: 'work' },
            ]),
        );
        await flushHookEffects({ cycles: 5, turns: 5 });
        expect(
            getConnectedServiceQuotaSnapshotPlainSpy,
        ).toHaveBeenCalledTimes(1);

        activeServerSnapshotState.current = {
            serverId: 'server-a',
            serverUrl: 'https://server-a.example.test',
            generation: 2,
        };
        await hook.rerender();
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(
            getConnectedServiceQuotaSnapshotPlainSpy,
        ).toHaveBeenCalledTimes(2);
        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('generation-2');

        await act(async () => {
            first.resolve(makeQuotaSnapshot({
                serviceId: 'anthropic',
                meterId: 'generation-1',
            }));
        });
        await flushHookEffects({ cycles: 5, turns: 5 });

        expect(
            hook.getCurrent().snapshotsByKey['anthropic/work']
                ?.meters[0]?.meterId,
        ).toBe('generation-2');
        await hook.unmount();
    });
});
