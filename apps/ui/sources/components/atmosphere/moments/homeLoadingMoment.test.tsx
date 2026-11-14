import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
  homePlanetGeometry,
  homePlanetSceneOptions,
} from '../homePlanetPlacement';
import { useHomeLoadingMoment, type HomePlanetHold } from './homeLoadingMoment';
import type { PlanetMomentTarget } from './planetMomentTimeline';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// These lifecycle cases need a painted native frame. The default native boundary leaves fonts unloaded.
vi.mock('@shopify/react-native-skia', async () => {
  const { createReactNativeSkiaMock } = await import('@/dev/testkit/mocks/reactNativeSkia');
  const font = {};
  return { ...createReactNativeSkiaMock(), useTypeface: () => font };
});

const pane = { width: 1150, height: 900 };
const orientation = { rotate: -1.5, mirror: false };
const planet: PlanetMomentTarget = {
  kind: 'planet',
  options: homePlanetSceneOptions(homePlanetGeometry('corner', pane), pane, {
    theme: 'dark',
    style: 'balanced',
    digits: true,
  }),
};

type Seen = { hold: HomePlanetHold; layer: boolean };

function Home(
  props: Readonly<{
    waiting: boolean;
    target: PlanetMomentTarget | null;
    drawn: boolean;
    reducedMotion?: boolean;
    abort?: boolean;
    paused?: boolean;
    seen: Seen[];
  }>,
) {
  const home = React.useMemo(
    () => ({
      waiting: props.waiting,
      target: props.target,
      drawn: props.drawn,
      orientation,
    }),
    [props.drawn, props.target, props.waiting],
  );
  const moment = useHomeLoadingMoment({
    waiting: props.waiting,
    start: 'mount',
    abort: props.abort,
    paused: props.paused ?? false,
    reducedMotion: props.reducedMotion ?? false,
    theme: 'dark',
    pane,
    home,
  });
  props.seen.push({ hold: moment.hold, layer: moment.layer !== null });
  return <View testID="home">{moment.layer}</View>;
}

/** Advances the display clock frame by frame, as the browser would. */
async function frames(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) {
    await act(async () => {
      vi.advanceTimersByTime(16);
    });
  }
}

describe('Home loading moment', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules no assembly preparation while its loading host is paused', async () => {
    const seen: Seen[] = [];
    const screen = await renderScreen(<Home waiting target={null} drawn={false} paused seen={seen} />);
    expect(vi.getTimerCount()).toBe(0);
    await screen.update(<Home waiting target={null} drawn={false} seen={seen} />);
    await frames(400);
    expect(screen.findByTestId('loading-planet.assembly')).not.toBeNull();
    await screen.update(<Home waiting target={null} drawn={false} paused seen={seen} />);
    expect(vi.getTimerCount()).toBe(0);
    await screen.update(<Home waiting target={null} drawn={false} seen={seen} />);
    expect(vi.getTimerCount()).toBe(1);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows no loader when Home is ready inside the grace, and Home's planet arrives as usual", async () => {
    const seen: Seen[] = [];
    const screen = await renderScreen(
      <Home waiting target={null} drawn={false} seen={seen} />,
    );
    await frames(200);
    await screen.update(
      <Home waiting={false} target={planet} drawn={false} seen={seen} />,
    );
    await frames(2000);
    expect(screen.findByTestId('loading-planet.assembly')).toBeNull();
    expect(screen.findByTestId('loading-planet')).toBeNull();
    expect(seen.at(-1)).toEqual({
      hold: { held: false, arrive: 'fade' },
      layer: false,
    });
    expect(seen.some(({ hold }) => hold.arrive === 'instant')).toBe(false);
  });

  it("holds the cloud until ready, then lands on Home's planet and hands over in the same frame", async () => {
    const seen: Seen[] = [];
    const screen = await renderScreen(
      <Home waiting target={null} drawn={false} seen={seen} />,
    );
    await frames(1000);
    expect(screen.findByTestId('loading-planet.assembly')).not.toBeNull();
    expect(seen.at(-1)?.hold.held).toBe(true);

    await screen.update(
      <Home waiting={false} target={planet} drawn={false} seen={seen} />,
    );
    await frames(1200);
    // Landed, but Home's canvas has not drawn yet: the moment keeps the landed planet up.
    expect(screen.findByTestId('loading-planet')).not.toBeNull();
    expect(seen.at(-1)?.hold.held).toBe(true);

    const before = seen.length;
    await screen.update(
      <Home waiting={false} target={planet} drawn seen={seen} />,
    );
    const handOver = seen.slice(before).find(({ hold }) => !hold.held)!;
    // The commit that releases Home's planet removes the moment and arrives at once.
    expect(handOver).toEqual({
      hold: { held: false, arrive: 'instant' },
      layer: false,
    });
    await frames(32);
    expect(seen.at(-1)).toEqual({
      hold: { held: false, arrive: 'fade' },
      layer: false,
    });
  });

  it("under reduced motion releases Home's planet on ready and cross-fades the resting one away", async () => {
    const seen: Seen[] = [];
    const screen = await renderScreen(
      <Home waiting target={null} drawn={false} reducedMotion seen={seen} />,
    );
    await frames(1000);
    expect(screen.findByTestId('loading-planet.assembly')).not.toBeNull();
    // The reduced-motion resting planet has no changing fact to display while Home connects.
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(vi.getTimerCount()).toBe(0);
    // Home can be connected before its measured planet target is available.
    await screen.update(<Home waiting={false} target={null} drawn={false} reducedMotion seen={seen} />);
    expect(vi.getTimerCount()).toBe(0);
    await screen.update(
      <Home
        waiting={false}
        target={planet}
        drawn={false}
        reducedMotion
        seen={seen}
      />,
    );
    await frames(48);
    expect(seen.at(-1)).toEqual({
      hold: { held: false, arrive: 'fade' },
      layer: true,
    });
    await frames(200);
    expect(screen.findByTestId('loading-planet')).toBeNull();
  });

  it("gives way to Home's unreachable state instead of covering it", async () => {
    const seen: Seen[] = [];
    const screen = await renderScreen(
      <Home waiting target={null} drawn={false} seen={seen} />,
    );
    await frames(600);
    await screen.update(
      <Home waiting target={null} drawn={false} abort seen={seen} />,
    );
    expect(screen.findByTestId('loading-planet')).toBeNull();
    expect(seen.at(-1)).toEqual({
      hold: { held: false, arrive: 'fade' },
      layer: false,
    });
  });
});
