import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMomentClock } from './useMomentClock';

beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] }));
afterEach(() => vi.useRealTimers());

it('schedules no moment frames in a retained inactive pane and resumes only its visible elapsed time', async () => {
    let seconds = 0;
    function Clock() { seconds = useMomentClock(true, false); return null; }
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
    function Clock() { renders += 1; useMomentClock(true, true); return null; }
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
