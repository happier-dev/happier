import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    useHostedFrameLifecycle,
    type HostedFrameRetirementReason,
} from './useHostedFrameLifecycle';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useHostedFrameLifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('waits for actual readiness without a timer and accepts a late ready guest', async () => {
        vi.useFakeTimers();
        const retirements: HostedFrameRetirementReason[] = [];
        const lifecycle: { current?: ReturnType<typeof useHostedFrameLifecycle> } = {};
        function Harness(): null {
            lifecycle.current = useHostedFrameLifecycle({
                lifetimeKey: 'pending-guest',
                onRetireAttempt: reason => retirements.push(reason),
            });
            return null;
        }
        let renderer: ReactTestRenderer;
        await act(async () => { renderer = create(<Harness />); });
        await act(async () => { lifecycle.current?.markLoaded(); });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(lifecycle.current?.failure).toBeNull();
        expect(retirements).toEqual([]);
        await act(async () => { lifecycle.current?.markReady(); });
        expect(lifecycle.current?.ready).toBe(true);
        await act(async () => { renderer!.unmount(); });
        expect(retirements).toEqual(['unmount']);
    });

    it('recovers actual failures, fences stale attempts, and retires each attempt once', async () => {
        vi.useFakeTimers();
        const retirements: HostedFrameRetirementReason[] = [];
        const lifecycle: { current?: ReturnType<typeof useHostedFrameLifecycle> } = {};

        function Harness(props: Readonly<{ lifetimeKey: string }>): null {
            lifecycle.current = useHostedFrameLifecycle({
                lifetimeKey: props.lifetimeKey,
                onRetireAttempt: (reason) => retirements.push(reason),
            });
            return null;
        }

        let renderer: ReactTestRenderer;
        await act(async () => { renderer = create(<Harness lifetimeKey="source-a" />); });
        await act(async () => { await vi.advanceTimersByTimeAsync(5); });
        expect(lifecycle.current?.failure).toBeNull();

        if (!lifecycle.current) throw new Error('Expected hosted-frame lifecycle');
        const staleMarkReady = lifecycle.current.markReady;
        await act(async () => { lifecycle.current?.markLoaded(); });
        await act(async () => { lifecycle.current?.fail('load_failed'); });
        expect(lifecycle.current?.failure).toBe('load_failed');
        expect(retirements).toEqual(['load_failed']);

        await act(async () => { lifecycle.current?.reload(); });
        expect(lifecycle.current?.attempt).toBe(1);
        expect(lifecycle.current?.failure).toBeNull();
        expect(retirements).toEqual(['load_failed']);

        await act(async () => { staleMarkReady(); });
        expect(lifecycle.current?.ready).toBe(false);
        await act(async () => {
            lifecycle.current?.markLoaded();
            lifecycle.current?.markReady();
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(5); });
        expect(lifecycle.current?.failure).toBeNull();

        if (!lifecycle.current) throw new Error('Expected hosted-frame lifecycle');
        const staleFail = lifecycle.current.fail;
        await act(async () => { renderer!.update(<Harness lifetimeKey="source-b" />); });
        expect(lifecycle.current?.attempt).toBe(0);
        expect(retirements).toEqual(['load_failed', 'replaced']);
        await act(async () => { staleFail('guest_error'); });
        expect(lifecycle.current?.failure).toBeNull();

        await act(async () => { renderer!.unmount(); });
        expect(retirements).toEqual(['load_failed', 'replaced', 'unmount']);
    });
});
