import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { installNewSessionComponentsCommonModuleMocks } from '../components/newSessionComponentsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            InteractionManager: {
                runAfterInteractions: (fn: () => void) => {
                    fn();
                    return { cancel: () => {} };
                },
            },
        });
    },
});

describe('useNewSessionCapabilitiesPrefetch', () => {
    it('does not repeatedly prefetch when only machines array identity churns', async () => {
        vi.resetModules();

        const prefetchMachineCapabilitiesIfStale = vi.fn(async () => {});

        const { useNewSessionCapabilitiesPrefetch } = await import('./useNewSessionCapabilitiesPrefetch');

        const baseMachine = { id: 'm1', daemonStateVersion: 1 };
        const request = { checklistId: 'new_session' };

        const hook = await renderHook(
            ({ churn }: { churn: number }) => {
                useNewSessionCapabilitiesPrefetch({
                    enabled: true,
                    serverId: 's1',
                    machines: [{ ...baseMachine, daemonStateVersion: 1 + (churn * 0) }],
                    favoriteMachineItems: [],
                    recentMachines: [],
                    selectedMachineId: 'm1',
                    isMachineOnline: () => true,
                    staleMs: 60_000,
                    request,
                    prefetchMachineCapabilitiesIfStale,
                });
            },
            { initialProps: { churn: 0 } },
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        // One call for wizard glyph prefetch + one for the actively selected machine.
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);

        await hook.rerender({ churn: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Should not prefetch again just because the machines array identity changed.
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);
    });

    it('does not lose prefetch when rerender happens before the web deferral tick', async () => {
        vi.resetModules();

        const prefetchMachineCapabilitiesIfStale = vi.fn(async () => {});
        const { useNewSessionCapabilitiesPrefetch } = await import('./useNewSessionCapabilitiesPrefetch');

        const baseMachine = { id: 'm1', daemonStateVersion: 1 };
        const request = { checklistId: 'new_session' };

        const hook = await renderHook(
            ({ churn }: { churn: number }) => {
                useNewSessionCapabilitiesPrefetch({
                    enabled: true,
                    serverId: 's1',
                    machines: [{ ...baseMachine, daemonStateVersion: 1 + (churn * 0) }],
                    favoriteMachineItems: [],
                    recentMachines: [],
                    selectedMachineId: 'm1',
                    isMachineOnline: () => true,
                    staleMs: 60_000,
                    request,
                    prefetchMachineCapabilitiesIfStale,
                });
            },
            { initialProps: { churn: 0 } },
        );

        // Immediately rerender before the deferred callback fires; we still expect one prefetch wave to happen.
        await hook.rerender({ churn: 1 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);
    });

    it('re-prefetches wizard glyphs when serverId changes (server-scoped cache)', async () => {
        vi.resetModules();

        const prefetchMachineCapabilitiesIfStale = vi.fn(async () => {});
        const { useNewSessionCapabilitiesPrefetch } = await import('./useNewSessionCapabilitiesPrefetch');

        const baseMachine = { id: 'm1', daemonStateVersion: 1 };
        const machines = [baseMachine];
        const favoriteMachineItems = [baseMachine];
        const recentMachines: ReadonlyArray<typeof baseMachine> = [];
        const request = { checklistId: 'new_session' };

        const hook = await renderHook(
            ({ serverId }: { serverId: string }) => {
                useNewSessionCapabilitiesPrefetch({
                    enabled: true,
                    serverId,
                    machines,
                    favoriteMachineItems,
                    recentMachines,
                    selectedMachineId: 'm1',
                    isMachineOnline: () => true,
                    staleMs: 60_000,
                    request,
                    prefetchMachineCapabilitiesIfStale,
                });
            },
            { initialProps: { serverId: 's1' } },
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        // One call for wizard glyph prefetch + one for selected machine.
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);

        await hook.rerender({ serverId: 's2' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Selected-machine prefetch key includes serverId, so +1. Wizard glyphs should also re-prefetch (+1).
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(4);
    });

    it('re-prefetches when the selected machine daemonStateVersion changes', async () => {
        vi.resetModules();

        const prefetchMachineCapabilitiesIfStale = vi.fn(async () => {});

        const { useNewSessionCapabilitiesPrefetch } = await import('./useNewSessionCapabilitiesPrefetch');

        const request = { checklistId: 'new_session' };

        const hook = await renderHook(
            ({ daemonStateVersion }: { daemonStateVersion: number }) => {
                useNewSessionCapabilitiesPrefetch({
                    enabled: true,
                    serverId: 's1',
                    machines: [{ id: 'm1', daemonStateVersion }],
                    favoriteMachineItems: [],
                    recentMachines: [],
                    selectedMachineId: 'm1',
                    isMachineOnline: () => true,
                    staleMs: 60_000,
                    request,
                    prefetchMachineCapabilitiesIfStale,
                });
            },
            { initialProps: { daemonStateVersion: 1 } },
        );

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(2);

        await hook.rerender({ daemonStateVersion: 2 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(3);
    });

    it('does not prefetch when disabled', async () => {
        vi.resetModules();

        const prefetchMachineCapabilitiesIfStale = vi.fn(async () => {});

        const { useNewSessionCapabilitiesPrefetch } = await import('./useNewSessionCapabilitiesPrefetch');

        await renderHook(() => {
            useNewSessionCapabilitiesPrefetch({
                enabled: false,
                serverId: 's1',
                machines: [{ id: 'm1', daemonStateVersion: 1 }],
                favoriteMachineItems: [],
                recentMachines: [],
                selectedMachineId: 'm1',
                isMachineOnline: () => true,
                staleMs: 60_000,
                request: { checklistId: 'new_session' },
                prefetchMachineCapabilitiesIfStale,
            });
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(prefetchMachineCapabilitiesIfStale).toHaveBeenCalledTimes(0);
    });
});
