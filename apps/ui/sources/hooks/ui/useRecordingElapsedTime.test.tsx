import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useRecordingElapsedTime } from './useRecordingElapsedTime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const browser = await installBrowserRuntimeForTests({ url: 'https://recording-elapsed.test/' });
beforeEach(() => { browser.activate(); vi.useFakeTimers(); vi.setSystemTime(10_000); });
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => browser.restore());

describe('recording elapsed presentation', () => {
    it('keeps paused elapsed time across hidden remounts and resumes only the elapsed leaf clock', async () => {
        const census = installTimerCensus();
        const leaf = createRenderCommitCounter();
        const parent = createRenderCommitCounter();
        let timing = { durationMs: 2_500, activeSinceMs: 9_000 as number | null };
        let visible = true;
        const wrapper = (props: { children?: React.ReactNode }) => {
            useRenderCommitCounter(parent);
            return <PluginSurfaceFocusEligibilityProvider active>{props.children}</PluginSurfaceFocusEligibilityProvider>;
        };
        const mount = () => renderHook(() => {
            useRenderCommitCounter(leaf);
            return useRecordingElapsedTime(timing, visible);
        }, { wrapper });
        let hook = await mount();
        try {
            expect(hook.getCurrent()).toBe(3);
            parent.reset(); leaf.reset();
            await act(async () => { vi.advanceTimersByTime(1_000); });
            expect(hook.getCurrent()).toBe(4);
            expect(leaf.read()).toEqual({ renders: 1, commits: 1 });
            expect(parent.read()).toEqual({ renders: 0, commits: 0 });

            timing = { durationMs: 4_500, activeSinceMs: null };
            await hook.rerender();
            expect(hook.getCurrent()).toBe(4);
            expect(vi.getTimerCount()).toBe(0);
            leaf.reset();
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(leaf.read()).toEqual({ renders: 0, commits: 0 });
            await hook.unmount();
            hook = await mount();
            expect(hook.getCurrent()).toBe(4);
            expect(vi.getTimerCount()).toBe(0);

            visible = false;
            timing = { durationMs: 4_500, activeSinceMs: Date.now() };
            await hook.rerender();
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { vi.advanceTimersByTime(10_000); });
            visible = true;
            await hook.rerender();
            expect(hook.getCurrent()).toBe(14);
            expect(census.read().filter(timer => timer.kind === 'interval')).toHaveLength(1);
        } finally {
            await hook.unmount();
            expect(census.read()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            census.stop();
        }
    });
});
