import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { useUsageBodyHeightMemory } from './usageBodyHeightMemory';

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
