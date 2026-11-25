import type { ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { expect, vi } from 'vitest';

import { renderScreen } from '../render/renderScreen';
import { waitForHomeGovernance, type HomeGovernanceHarness } from './homeGovernanceHarness';

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type RequestCounts = Readonly<Record<string, number>>;

/** Counts transport work for a page while the real request and demand owners are mounted. */
export async function expectHomePageReadCosts(params: Readonly<{
    home: HomeGovernanceHarness;
    mount: () => Promise<Screen>;
    leave: ReactElement;
    returnTo: ReactElement;
    settled: (screen: Screen) => void;
    cold: RequestCounts;
    returning: RequestCounts;
}>): Promise<Screen> {
    const { home, cold, returning } = params;
    const paths = new Set([...Object.keys(cold), ...Object.keys(returning)]);
    const count = (start: number) => {
        const result = Object.fromEntries([...paths].map(path => [path, 0]));
        for (const { path } of home.requests.slice(start)) {
            if (paths.has(path)) result[path] += 1;
        }
        return result;
    };
    const assertIdle = async () => {
        const start = home.requests.length;
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(home.requests.slice(start)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    };

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
        const start = home.requests.length;
        const screen = await params.mount();
        await waitForHomeGovernance(() => params.settled(screen));
        await act(async () => {});
        expect(count(start), 'cold open').toEqual(cold);
        await assertIdle();

        await screen.update(params.leave);
        const returnStart = home.requests.length;
        await screen.update(params.returnTo);
        await waitForHomeGovernance(() => {
            params.settled(screen);
            expect(count(returnStart), 'return open').toEqual(returning);
        });
        await act(async () => {});
        expect(count(returnStart), 'settled return').toEqual(returning);
        await assertIdle();
        return screen;
    } finally {
        vi.useRealTimers();
    }
}
