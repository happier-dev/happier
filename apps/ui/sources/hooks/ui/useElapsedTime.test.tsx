import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useElapsedTime } from './useElapsedTime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const browser = await installBrowserRuntimeForTests({ url: 'https://elapsed.test/' });
let visible = true;
Object.defineProperty(browser.document, 'visibilityState', { configurable: true,
    get: () => visible ? 'visible' : 'hidden' });
beforeEach(() => {
    browser.activate();
    visible = true;
    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
});
afterEach(() => { standardCleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(() => browser.restore());

describe('elapsed presentation clock', () => {
    it.each(['layout', 'host'] as const)('suspends while %s is hidden and catches up on resume', async (hiddenOwner) => {
        const census = installTimerCensus();
        const counts = createRenderCommitCounter();
        let presented = true;
        const hook = await renderHook(() => {
            useRenderCommitCounter(counts);
            return useElapsedTime(1_000);
        }, { wrapper: (props) => <PluginSurfaceFocusEligibilityProvider active={presented}>
            {props.children}
        </PluginSurfaceFocusEligibilityProvider> });
        try {
            expect(hook.getCurrent()).toBe(9);
            expect(census.read().filter(timer => timer.kind === 'interval')).toHaveLength(1);
            if (hiddenOwner === 'layout') {
                presented = false;
                await hook.rerender();
            } else {
                await act(async () => {
                    visible = false;
                    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
                });
            }
            counts.reset();
            expect(census.read().filter(timer => timer.kind === 'interval')).toHaveLength(0);
            expect(vi.getTimerCount()).toBe(0);
            await act(async () => { vi.advanceTimersByTime(60_000); });
            expect(counts.read()).toEqual({ renders: 0, commits: 0 });
            expect(hook.getCurrent()).toBe(9);
            if (hiddenOwner === 'layout') {
                presented = true;
                await hook.rerender();
            } else {
                await act(async () => {
                    visible = true;
                    browser.document.dispatchEvent(new browser.window.Event('visibilitychange'));
                });
            }
            expect(hook.getCurrent()).toBe(69);
            expect(census.read().filter(timer => timer.kind === 'interval')).toHaveLength(1);
            counts.reset();
            await act(async () => { vi.advanceTimersByTime(1_000); });
            expect(hook.getCurrent()).toBe(70);
            expect(counts.read()).toEqual({ renders: 1, commits: 1 });
        } finally {
            await hook.unmount();
            expect(census.read()).toEqual([]);
            census.stop();
        }
    });
});
