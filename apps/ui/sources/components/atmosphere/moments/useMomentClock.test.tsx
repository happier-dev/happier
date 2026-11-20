import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useGlyphClock } from './useMomentClock';

beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
afterEach(() => vi.useRealTimers());

it('schedules no moment frames in a retained inactive pane and resumes only its visible elapsed time', async () => {
    let seconds = 0;
    const motion = { kind: 'elapsed', durationS: Infinity, paused: false } as const;
    const paint = (time: number) => { seconds = time; };
    function Clock() { useGlyphClock(motion, 'ready', paint); return null; }
    const element = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}><Clock /></PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(element(false));
    expect(vi.getTimerCount()).toBe(0);
    await screen.update(element(true));
    await act(async () => { vi.advanceTimersByTime(96); });
    expect(seconds).toBeGreaterThan(0);
    const held = seconds;
    await screen.update(element(false));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(seconds).toBe(held);
    await screen.update(element(true));
    await act(async () => { vi.advanceTimersByTime(16); });
    expect(seconds).toBeGreaterThan(held);
    expect(seconds).toBeLessThan(held + 0.032);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
});

it('renders nothing of its own when its retained pane is hidden and shown', async () => {
    let renders = 0;
    const motion = { kind: 'elapsed', durationS: Infinity, paused: true } as const;
    const paint = () => {};
    function Clock() { renders += 1; useGlyphClock(motion, 'ready', paint); return null; }
    // The pane keeps its body element: only the presentation fact flips.
    const clock = <Clock />;
    const element = (active: boolean) => <PluginSurfaceFocusEligibilityProvider active={active}>{clock}</PluginSurfaceFocusEligibilityProvider>;
    const screen = await renderScreen(element(true));
    renders = 0;
    await screen.update(element(false));
    await screen.update(element(true));
    expect(renders).toBe(0);
    await screen.unmount();
});

it('holds an elapsed glyph scene while it waits and resumes its existing timeline without React commits', async () => {
    const frames: number[] = [];
    const paint = (seconds: number) => frames.push(seconds);
    let commits = 0;
    function Loading({ end }: { end: number }) {
        React.useLayoutEffect(() => { commits++; });
        useGlyphClock({ kind: 'elapsed', durationS: end, paused: false }, 'ready', paint);
        return null;
    }
    const screen = await renderScreen(<Loading end={0.048} />);
    await act(async () => { vi.advanceTimersByTime(112); });
    expect(frames).toEqual([0, 0.016, 0.032, 0.048]);
    expect(commits).toBe(1);
    await screen.update(<Loading end={0.08} />);
    await act(async () => { vi.advanceTimersByTime(128); });
    expect(frames.at(-1)).toBe(0.08);
    expect(commits).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    await screen.unmount();
});
