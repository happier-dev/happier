// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { useTriageRefreshEligibilityNowV1 } from './refreshEligibilityClock.js';
import type { TriageRefreshPacingBlockV1 } from '../../refresh/refreshEligibility.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });

function mountClock(initial: Readonly<{ completedAtMs?: number; block?: TriageRefreshPacingBlockV1; active?: boolean }>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  let observedNowMs = 0;
  function Probe(props: typeof initial) {
    observedNowMs = useTriageRefreshEligibilityNowV1(props.block, props.completedAtMs, props.active ?? true);
    return null;
  }
  const update = (props: typeof initial) => act(() => { root.render(<Probe {...props} />); });
  dispose = () => act(() => { root.unmount(); container.remove(); });
  update(initial);
  return { update, now: () => observedNowMs };
}

it('wakes the displayed read age on minute boundaries and stops when it is hidden', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const clock = mountClock({ completedAtMs: 0 });
  act(() => { vi.advanceTimersByTime(49_999); });
  expect(clock.now()).toBe(10_000);
  act(() => { vi.advanceTimersByTime(1); });
  expect(clock.now()).toBe(60_000);
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(clock.now()).toBe(120_000);
  clock.update({});
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(clock.now()).toBe(120_000);
  expect(vi.getTimerCount()).toBe(0);
});

it('observes an earlier refresh deadline through the same clock before the next read-age minute', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const clock = mountClock({ completedAtMs: 0, block: { reason: 'sourceRetryDeadline', nextEligibleAtMs: 20_000 } });
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(clock.now()).toBe(20_000);
  expect(vi.getTimerCount()).toBe(1);
  act(() => { vi.advanceTimersByTime(40_000); });
  expect(clock.now()).toBe(60_000);
  clock.update({ completedAtMs: 60_000 });
  act(() => { vi.advanceTimersByTime(60_000); });
  expect(clock.now()).toBe(120_000);
});

it('suspends both clock wakes while the surface is retained and resumes from the current time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const facts = { completedAtMs: 0, block: { reason: 'sourceRetryDeadline', nextEligibleAtMs: 20_000 } } as const;
  const clock = mountClock(facts);
  expect(vi.getTimerCount()).toBe(1);

  clock.update({ ...facts, active: false });
  act(() => { vi.advanceTimersByTime(120_000); });
  expect(clock.now()).toBe(10_000);
  expect(vi.getTimerCount()).toBe(0);

  clock.update(facts);
  expect(clock.now()).toBe(130_000);
  expect(vi.getTimerCount()).toBe(1);
  act(() => { vi.advanceTimersByTime(50_000); });
  expect(clock.now()).toBe(180_000);
});
