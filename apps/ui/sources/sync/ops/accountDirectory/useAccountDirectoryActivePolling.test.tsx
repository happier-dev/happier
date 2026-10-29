import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const runtimeState = vi.hoisted(() => ({
    active: true,
    listeners: new Set<() => void>(),
}));

vi.mock('@/utils/runtime/isRuntimeActive', () => ({
    isRuntimeActive: () => runtimeState.active,
    subscribeToRuntimeActiveChange: (listener: () => void) => {
        runtimeState.listeners.add(listener);
        return () => runtimeState.listeners.delete(listener);
    },
}));

describe('useAccountDirectoryActivePolling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0);
        runtimeState.active = true;
        runtimeState.listeners.clear();
    });

    afterEach(() => {
        standardCleanup();
        runtimeState.listeners.clear();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses the canonical enrollment backoff for pending approval attempts and resets after completion', async () => {
        const { useAccountDirectoryActivePolling } = await import('./useAccountDirectoryActivePolling');
        let attempt = 0;
        const poll = vi.fn(async (): Promise<'backoff' | 'completed'> => (
            ++attempt <= 12 ? 'backoff' : 'completed'
        ));

        await renderHook(() => useAccountDirectoryActivePolling(poll), {
            flushOptions: { cycles: 0 },
        });

        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
        expect(poll).toHaveBeenCalledTimes(1);

        // Pending attempts advance the shared 1s -> 2s -> 4s -> 5s cadence.
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
        expect(poll).toHaveBeenCalledTimes(2);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_999 });
        expect(poll).toHaveBeenCalledTimes(2);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(poll).toHaveBeenCalledTimes(3);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 3_999 });
        expect(poll).toHaveBeenCalledTimes(3);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(poll).toHaveBeenCalledTimes(4);

        await flushHookEffects({ cycles: 1, advanceTimersMs: 4_999 });
        expect(poll).toHaveBeenCalledTimes(4);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(poll).toHaveBeenCalledTimes(5);

        // Once capped, a late approval can complete at 53s with 13 total
        // redemption attempts, remaining below the Home route's 30/min budget.
        for (let cappedAttempt = 0; cappedAttempt < 8; cappedAttempt += 1) {
            await flushHookEffects({ cycles: 1, advanceTimersMs: 5_000 });
        }
        expect(poll).toHaveBeenCalledTimes(13);
        expect(poll.mock.calls.length).toBeLessThanOrEqual(30);

        // Terminal completion restores the normal one-second cadence.
        await flushHookEffects({ cycles: 1, advanceTimersMs: 999 });
        expect(poll).toHaveBeenCalledTimes(13);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1 });
        expect(poll).toHaveBeenCalledTimes(14);
    });

    it('treats thrown polling work as transient and keeps one shared retry scheduler', async () => {
        const { useAccountDirectoryActivePolling } = await import('./useAccountDirectoryActivePolling');
        const first = vi.fn()
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValue('completed');
        const second = vi.fn(async () => 'completed' as const);

        await renderHook(() => {
            useAccountDirectoryActivePolling(first);
            useAccountDirectoryActivePolling(second);
        }, { flushOptions: { cycles: 0 } });

        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
        expect(first).toHaveBeenCalledTimes(2);
        expect(second).toHaveBeenCalledTimes(2);
        expect(runtimeState.listeners.size).toBe(1);
    });

    it('parks without a timer while hidden and resumes overdue displayed approval demand once', async () => {
        const { useAccountDirectoryActivePolling } = await import('./useAccountDirectoryActivePolling');
        const poll = vi.fn(async () => 'completed' as const);
        const hook = await renderHook(() => useAccountDirectoryActivePolling(poll, true), { flushOptions: { cycles: 0 } });
        runtimeState.active = false;
        for (const listener of runtimeState.listeners) listener();
        expect(vi.getTimerCount()).toBe(0);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 300_000 });
        expect(poll).not.toHaveBeenCalled();
        runtimeState.active = true;
        for (const listener of runtimeState.listeners) listener();
        await flushHookEffects({ cycles: 1 });
        expect(poll).toHaveBeenCalledTimes(1);
        await hook.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('installs no cadence without displayed pending demand and withdraws it when the retained pane is hidden', async () => {
        const { useAccountDirectoryActivePolling } = await import('./useAccountDirectoryActivePolling');
        let presented = true;
        function Presentation({ children }: React.PropsWithChildren) {
            return React.createElement(PluginSurfaceFocusEligibilityProvider, { active: presented, presentationActive: presented, children });
        }
        const poll = vi.fn(async () => 'completed' as const);
        const hook = await renderHook((enabled: boolean) => useAccountDirectoryActivePolling(poll, enabled), {
            initialProps: false, wrapper: Presentation, flushOptions: { cycles: 0 },
        });
        await flushHookEffects({ cycles: 1, advanceTimersMs: 300_000 });
        expect(poll).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await hook.rerender(true);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 1_000 });
        expect(poll).toHaveBeenCalledTimes(1);
        presented = false;
        await hook.rerender(true);
        await flushHookEffects({ cycles: 1, advanceTimersMs: 300_000 });
        expect(poll).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        await hook.unmount();
    });
});
