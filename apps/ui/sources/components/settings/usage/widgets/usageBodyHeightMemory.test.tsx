import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { readUsageQueryBodyReadState, useUsageBodyHeightMemory, useUsageBodyRememberedHeight } from './usageBodyHeightMemory';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageQuotaPageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);

const layout = (height: number) =>
  ({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height } } }) as never;

afterEach(() => standardCleanup());

describe('the Usage body height memory (sweep 1110 N3)', () => {
  it('holds the remembered height on the very first render and remembers a body that shows facts before every read settles', async () => {
    // First visit: nothing remembered. The body draws its facts while a read stays outstanding (it never settles).
    const first = await renderHook(() =>
      useUsageBodyHeightMemory('home:usage-area.widget.overview:0', {
        facts: true,
        settled: false,
      }),
    );
    expect(first.getCurrent()!.style).toBeUndefined();
    await act(async () => {
      first.getCurrent()!.onLayout(layout(322));
    });
    await first.unmount();

    // Before the body's code has loaded (the web host's fallback), the same room is already known (#6: 223 → 2048).
    const fallback = await renderHook(() => useUsageBodyRememberedHeight('home:usage-area.widget.overview:0'));
    expect(fallback.getCurrent()).toBe(322);
    await fallback.unmount();

    // Next visit, before any read answers: the first render already holds exactly that room, so a taller reading
    // placeholder cannot push the page and the facts land inside it.
    const reading = await renderHook(() =>
      useUsageBodyHeightMemory('home:usage-area.widget.overview:0', {
        facts: false,
        settled: false,
      }),
    );
    expect(reading.getCurrent()!.style).toEqual({
      height: 322,
      overflow: 'hidden',
    });
    await reading.unmount();

    // Facts drawn, reads still outstanding: the room is a floor; once every read settles the body takes its own height.
    const drawn = await renderHook(
      ({ settled }: { settled: boolean }) =>
        useUsageBodyHeightMemory('home:usage-area.widget.overview:0', {
          facts: true,
          settled,
        }),
      { initialProps: { settled: false } },
    );
    expect(drawn.getCurrent()!.style).toEqual({ minHeight: 322 });
    await drawn.rerender({ settled: true });
    expect(drawn.getCurrent()!.style).toBeUndefined();
  });

  it('settles an allowance-only body once its allowance reads answer, whatever the sources it never asked for say', () => {
    // Projections, Resets and Capacity never ask for work or session evidence; those sources stay "not loaded". Read as
    // outstanding, the body never settled: the floor held its tallest cold-load height forever and remembered it again
    // (Projections 455 under a 197 px list: a blank gap under "Show all").
    const query = normalizeUsageQuery({ includeAccounting: false, includeQuota: true, includeSessionEvidence: false, includeWorkEvidence: false });
    const read = (status: 'pending' | 'available') => resolveUsageQuotaPageAggregation({ queries: [query],
      quota: { status: 'available', value: [] }, sources: [{ source: 'quota:account-a', status }] }).results[0]!;
    const model = (slice: ReturnType<typeof read>) => ({ slice, error: null, pending: false, requestedQuery: null });
    expect(readUsageQueryBodyReadState(query, model(read('pending')))).toEqual({ facts: true, settled: false });
    expect(readUsageQueryBodyReadState(query, model(read('available')))).toEqual({ facts: true, settled: true });
  });

  it("never remembers a reading placeholder as the body's height", async () => {
    const reading = await renderHook(() =>
      useUsageBodyHeightMemory('home:usage-area.widget.coach:0', {
        facts: false,
        settled: false,
      }),
    );
    await act(async () => {
      reading.getCurrent()!.onLayout(layout(380));
    });
    await reading.unmount();
    const next = await renderHook(() =>
      useUsageBodyHeightMemory('home:usage-area.widget.coach:0', {
        facts: false,
        settled: false,
      }),
    );
    expect(next.getCurrent()!.style).toBeUndefined();
  });
});
