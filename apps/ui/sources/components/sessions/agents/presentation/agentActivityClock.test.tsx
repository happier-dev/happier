import * as React from 'react';
import { Text } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { InboxRelativeTime } from '@/components/inbox/InboxRelativeTime';
import { useAgentActivityClockNow, useWorkRelativeTime } from './agentActivityClock';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';

const host = vi.hoisted(() => ({ appState: 'active', visibility: 'visible',
    appListeners: new Set<() => void>(), documentListeners: new Set<() => void>() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ AppState: {
    get currentState() { return host.appState; },
    addEventListener: (_event: string, listener: () => void) => {
        host.appListeners.add(listener); return { remove: () => host.appListeners.delete(listener) };
    },
} }));

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const DAY = 86_400_000;
beforeEach(async () => {
    vi.useFakeTimers({ now: NOW });
    host.appState = 'active'; host.visibility = 'visible';
    vi.stubGlobal('document', { get visibilityState() { return host.visibility; },
        addEventListener: (event: string, listener: () => void) => {
            if (event === 'visibilitychange') host.documentListeners.add(listener);
        } });
    await act(async () => { for (const listener of host.appListeners) listener(); });
});
afterEach(async () => {
    await standardCleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks();
});

/** Count physical clock wakes at the clock/platform boundary, not internal reads or React batching. */
function countClockFires() {
    let fires = 0;
    const timeout = globalThis.setTimeout, interval = globalThis.setInterval;
    const ownsTimer = () => /[\\/](agentActivityClock|sessionListRuntimeClock)\.ts:/.test(new Error().stack ?? '');
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
        const owned = ownsTimer();
        return timeout(() => { if (owned) fires += 1; callback(...args); }, delay);
    });
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) => {
        const owned = ownsTimer();
        return interval(() => { if (owned) fires += 1; callback(...args); }, delay);
    });
    return () => fires;
}

describe('shared Work clock', () => {
    it('keeps one interval for visible elapsed demand while a retained sibling reopens with a new start', async () => {
        const census = installTimerCensus((stack) => stack.includes('agentActivityClock') ? 'elapsed' : null);
        function Elapsed(props: Readonly<{ id: string; startedAtMs: number }>) {
            return <Text testID={props.id}>{useAgentActivityClockNow() - props.startedAtMs}</Text>;
        }
        const draw = (firstActive: boolean, secondActive: boolean, secondStart = NOW) => <>
            <PluginSurfaceFocusEligibilityProvider active={firstActive}><Elapsed id="first" startedAtMs={NOW} /></PluginSurfaceFocusEligibilityProvider>
            <PluginSurfaceFocusEligibilityProvider active={secondActive}><Elapsed id="second" startedAtMs={secondStart} /></PluginSurfaceFocusEligibilityProvider>
        </>;
        const screen = await renderScreen(draw(true, false));
        const elapsed = (id: string) => screen.findByTestId(id)?.props.children;
        try {
            expect(census.read()).toEqual([{ kind: 'interval', delayMs: 1000, consumer: 'elapsed' }]);
            await act(async () => { vi.advanceTimersByTime(30_000); });
            expect(elapsed('first')).toBe(30_000);
            expect(elapsed('second')).toBe(0);
            const newStart = Date.now() - 2_000;
            await screen.update(draw(true, true, newStart));
            expect(elapsed('second')).toBe(2_000);
            expect(census.read()).toHaveLength(1);
            await screen.update(draw(false, true, newStart));
            await act(async () => { vi.advanceTimersByTime(1_000); });
            expect(elapsed('second')).toBe(3_000);
            expect(census.readFires()).toEqual({ interval: 31, timeout: 0 });
            await screen.update(draw(false, false, newStart));
            expect(census.read()).toEqual([]);
        } finally {
            await screen.unmount();
            census.stop();
        }
    });
    it('requires both host visibility and layout presentation for the shared elapsed clock', async () => {
        const census = installTimerCensus((stack) => stack.includes('agentActivityClock') ? 'elapsed' : null);
        function Elapsed() { return String(useAgentActivityClockNow() - NOW); }
        const draw = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}><Elapsed /></PluginSurfaceFocusEligibilityProvider>;
        const screen = await renderScreen(draw(true));
        try {
            expect(screen.getTextContent()).toBe('0');
            await act(async () => {
                host.visibility = 'hidden';
                for (const listener of host.documentListeners) listener();
            });
            const before = census.readFires();
            await act(async () => { vi.advanceTimersByTime(300_000); });
            expect(census.readFires()).toEqual(before);
            expect(census.read()).toEqual([]);
            await screen.update(draw(false));
            await act(async () => {
                host.visibility = 'visible';
                for (const listener of host.documentListeners) listener();
            });
            expect(census.read()).toEqual([]);
            await screen.update(draw(true));
            expect(screen.getTextContent()).toBe('300000');
            expect(census.read()).toEqual([{ kind: 'interval', delayMs: 1000, consumer: 'elapsed' }]);
            await act(async () => {
                host.appState = 'background';
                for (const listener of host.appListeners) listener();
            });
            expect(census.read()).toEqual([]);
            await act(async () => {
                vi.advanceTimersByTime(60_000);
                host.appState = 'active';
                for (const listener of host.appListeners) listener();
            });
            expect(screen.getTextContent()).toBe('360000');
        } finally {
            await screen.unmount();
            census.stop();
        }
    });
    it('preserves the shared one-second elapsed clock without repainting its parent', async () => {
        let elapsedFires = 0;
        const originalInterval = globalThis.setInterval;
        const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
            originalInterval(() => { elapsedFires += 1; callback(...args); }, delay));
        const clear = vi.spyOn(globalThis, 'clearInterval');
        const paints = vi.fn();
        function Relative() { return useWorkRelativeTime(NOW); }
        function Elapsed() { return String(Math.floor((useAgentActivityClockNow() - NOW) / 1000)); }
        function Row() { paints(); return <><Relative /><Elapsed /><Elapsed /></>; }
        const screen = await renderScreen(<Row />);
        expect(interval).toHaveBeenCalledTimes(1);
        const before = paints.mock.calls.length;
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.getTextContent()).toContain('1m');
        expect(screen.getTextContent()).toContain('60');
        expect(elapsedFires).toBe(60);
        expect(paints.mock.calls.length).toBe(before);
        await act(async () => screen.tree.unmount());
        expect(clear).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('wakes for crossed display boundaries, not seconds times 128 old Inbox dates', async () => {
        const fires = countClockFires();
        let rowRenders = 0;
        function InboxDates() {
            rowRenders += 1;
            return <>{Array.from({ length: 128 }, (_, index) =>
                <InboxRelativeTime key={index} timestamp={NOW - (40 + index) * DAY - 3_600_000} />)}
                <InboxRelativeTime timestamp={NOW - 50_000} />
                <InboxRelativeTime timestamp={NOW - 20_000} /></>;
        }
        const screen = await renderScreen(<InboxDates />);
        const before = rowRenders;
        // Real event-loop turns let each boundary register its successor. The two
        // recent leaves cross ten distinct boundaries; no old label changes.
        for (const step of [10_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 20_000]) {
            await act(async () => { vi.advanceTimersByTime(step); });
        }
        expect(fires()).toBe(10);
        expect(screen.getTextContent()).toMatch(/5m\s+5m$/);
        expect(rowRenders).toBe(before);
        expect(vi.getTimerCount()).toBe(1);
        await screen.update(<InboxRelativeTime timestamp={NOW - 40 * DAY - 3_600_000} />);
        const oldOnly = fires();
        await act(async () => { vi.advanceTimersByTime(300_000); });
        expect(fires()).toBe(oldOnly);
        await act(async () => screen.tree.unmount());
        expect(vi.getTimerCount()).toBe(0);
    });

    it('withdraws hidden relative deadlines and resumes at current time without replaying missed ticks', async () => {
        const fires = countClockFires();
        const screen = await renderScreen(<InboxRelativeTime timestamp={NOW - 90_000} />);
        expect(screen.getTextContent()).toBe('1m');
        await act(async () => {
            host.visibility = 'hidden';
            for (const listener of host.documentListeners) listener();
        });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(300_000); });
        expect(fires()).toBe(0);
        expect(screen.getTextContent()).toBe('1m');
        await act(async () => {
            host.visibility = 'visible';
            for (const listener of host.documentListeners) listener();
        });
        expect(screen.getTextContent()).toBe('6m');
        expect(fires()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(screen.getTextContent()).toBe('7m');
        expect(fires()).toBe(1);
        await act(async () => {
            host.appState = 'background';
            for (const listener of host.appListeners) listener();
        });
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => {
            vi.advanceTimersByTime(60_000); host.appState = 'active';
            for (const listener of host.appListeners) listener();
        });
        expect(screen.getTextContent()).toBe('8m');
        expect(fires()).toBe(1);
    });

    it('keeps supplied snapshots timer-free and observes new timestamps and future boundaries exactly', async () => {
        const fires = countClockFires();
        const screen = await renderScreen(<InboxRelativeTime timestamp={NOW + 500} />);
        expect(screen.getTextContent()).toBe('');
        await act(async () => { vi.advanceTimersByTime(499); });
        expect(fires()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(screen.getTextContent()).toBe('now');
        expect(fires()).toBe(1);
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(screen.getTextContent()).toBe('1m');
        expect(fires()).toBe(2);
        await screen.update(<InboxRelativeTime timestamp={NOW - 3_600_000} nowMs={NOW} />);
        expect(screen.getTextContent()).toBe('1h');
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { vi.advanceTimersByTime(300_000); });
        expect(fires()).toBe(2);
        expect(screen.getTextContent()).toBe('1h');
        await screen.update(<InboxRelativeTime timestamp={-60_000} nowMs={0} />);
        expect(screen.getTextContent()).toBe('1m');
        expect(vi.getTimerCount()).toBe(0);
        await screen.update(<InboxRelativeTime timestamp={NaN} />);
        expect(screen.getTextContent()).toBe('');
        expect(vi.getTimerCount()).toBe(0);
    });
});
