import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createNativeScrollEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { BotFace } from './BotFace';
import { BOT_FACE_MOMENT_MS } from './useBotFaceMoment';
import type { BotFaceIdentity } from './botFaceIdentity';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { createNearViewportTracker } from '@/components/widgets/nearViewport';
import { standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@shopify/react-native-skia', async () =>
  (
    await import('@/dev/testkit/mocks/reactNativeSkia')
  ).createReactNativeSkiaMock(),
);
// Select the web paint adapter; the Canvas2D surface below is the only synthetic port.
vi.mock('./BotFaceRasterView', async () => import('./BotFaceRasterView.web'));

// The browser frame clock is a platform boundary: a manual queue counts every frame callback the face asks for.
const clock = {
  now: 0,
  queue: new Map<number, FrameRequestCallback>(),
  next: 1,
  requested: 0,
};
function advance(ms: number) {
  const end = clock.now + ms;
  while (clock.now < end) {
    clock.now = Math.min(end, clock.now + 16);
    const due = [...clock.queue.values()];
    clock.queue.clear();
    for (const callback of due) callback(clock.now);
  }
}
const paints: number[] = [];
const canvas = {
  getContext: () => ({
    putImageData: () => {
      paints.push(clock.now);
    },
  }),
};
const identity: BotFaceIdentity = {
  body: 'octopus',
  colour: 'orchid',
  seed: 5,
};

beforeEach(() => {
  resetReanimatedFrameCallbacks();
  clock.now = 0;
  clock.queue.clear();
  clock.requested = 0;
  paints.length = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    clock.requested++;
    const id = clock.next++;
    clock.queue.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    clock.queue.delete(id);
  });
  vi.stubGlobal(
    'ImageData',
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
});

function driveMotionFrames(start: number, count: number) {
  let ran = 0;
  act(() => {
  for (let n = 0; n < count; n++) {
    for (const record of readReanimatedFrameCallbacks()) {
      if (!record.handle.isActive || record.handle.callbackId === -1) continue;
      record.run({ timestamp: start + n * 16, timeSincePreviousFrame: 16, timeSinceFirstFrame: n * 16 });
      ran++;
    }
  }
  });
  return ran;
}

it('breathes in the rail leaf without repainting the raster or rendering its parent each frame', async () => {
  let parents = 0;
  function Parent() {
    parents++;
    return <BotFace identity={identity} style="dither" size={24} mood="working" motion motionMode="lively" />;
  }
  await mount(<Parent />);
  expect(driveMotionFrames(0, 120)).toBe(120);
  expect(parents).toBe(1);
  expect(paints).toHaveLength(1);
});

it('draws a Dither or Solid reaction as redrawn poses, then paints nothing more at rest (R8: no moved picture)', async () => {
  for (const style of ['dither', 'solid'] as const) {
    paints.length = 0;
    let parents = 0;
    function Parent(props: Readonly<{ mood: 'quiet' | 'working' }>) {
      parents++;
      return <BotFace identity={identity} style={style} size={24} mood={props.mood} motion motionMode="reactions" />;
    }
    const screen = await mount(<Parent mood="quiet" />);
    await screen.update(<Parent mood="working" />);
    const before = paints.length;
    // One act per frame: the platform delivers each frame on its own task.
    for (let n = 0; n < 60; n++) driveMotionFrames(n * 16, 1);
    const during = paints.length - before;
    expect(during, style).toBeGreaterThan(3);
    expect(during, style).toBeLessThan(60);
    const settled = paints.length;
    expect(driveMotionFrames(2000, 60)).toBe(0);
    expect(paints.length).toBe(settled);
    expect(parents).toBe(2);
    await act(async () => { screen.unmount(); });
  }
});

it('reacts once per activity change and never replays a reaction missed while hidden', async () => {
  const face = (mood: 'quiet' | 'working' | 'needsYou', visible = true) =>
    <BotFace identity={identity} style="pixel" size={24} mood={mood} visible={visible} motion motionMode="reactions" />;
  const screen = await mount(face('quiet'));
  expect(driveMotionFrames(0, 120)).toBe(0);
  await screen.update(face('working'));
  expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(2000, 120)).toBe(0);
  await screen.update(face('working'));
  expect(driveMotionFrames(4000, 120)).toBe(0);
  await screen.update(face('needsYou', false));
  await screen.update(face('needsYou'));
  expect(driveMotionFrames(6000, 120)).toBe(0);
});

it('stops rail frames when hidden, Still or Reduce motion wins', async () => {
  const face = (mode: 'lively' | 'still', visible = true) =>
    <BotFace identity={identity} style="solid" size={24} mood="working" visible={visible} motion motionMode={mode} />;
  const screen = await mount(face('lively'));
  expect(driveMotionFrames(0, 5)).toBeGreaterThan(0);
  await screen.update(face('lively', false));
  expect(driveMotionFrames(1000, 10)).toBe(0);
  await screen.update(face('still'));
  expect(driveMotionFrames(2000, 10)).toBe(0);
  await act(async () => { setReducedMotionPreferenceOverride(true); });
  await screen.update(face('lively'));
  expect(driveMotionFrames(3000, 10)).toBe(0);
});

it('uses the scroll host viewport to stop offscreen rail faces and resume a visible working face', async () => {
  const content = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 2000 }) };
  const tracker = createNearViewportTracker({ quantum: 1, initialViewportHeight: 100, overscan: false, readContentNode: () => content });
  const screen = await renderScreen(<PluginUiScrollActivityProvider tracker={tracker}>
    <BotFace identity={identity} style="solid" size={24} mood="working" motion motionMode="lively" />
  </PluginUiScrollActivityProvider>, {
    // The DOM measurement and raster canvas are real system boundaries.
    createNodeMock: node => node.type === 'canvas' ? canvas : {
      getBoundingClientRect: () => ({ left: 0, top: 1000, width: 24, height: 24 }),
    },
  });
  expect(driveMotionFrames(0, 20)).toBe(0);
  await act(async () => { tracker.onScroll(createNativeScrollEvent({
    contentOffset: { x: 0, y: 990 }, layoutMeasurement: { width: 100, height: 100 }, contentSize: { width: 100, height: 2000 },
    contentInset: { top: 0, bottom: 0, left: 0, right: 0 }, zoomScale: 1,
  })); });
  expect(driveMotionFrames(1000, 20)).toBeGreaterThan(0);
  await screen.unmount();
});
afterEach(async () => {
  await standardCleanup();
  vi.useRealTimers();
  setReducedMotionPreferenceOverride(null);
  vi.unstubAllGlobals();
});

it('shares one idle clock, selects one resting face, and removes it when none is eligible', async () => {
  vi.useFakeTimers();
  const faces = (mode: 'lively' | 'reactions' | 'still', visible = true) => <>
    {[1, 2, 3].map(seed => <BotFace key={seed} identity={{ ...identity, seed }} style="dither" size={24}
      mood="quiet" motion motionMode={mode} visible={visible} />)}
  </>;
  const screen = await mount(faces('lively'));
  expect(vi.getTimerCount()).toBe(1);
  expect(driveMotionFrames(0, 10)).toBe(0);
  await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
  expect(readReanimatedFrameCallbacks().filter(r => r.handle.isActive)).toHaveLength(1);
  expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(2000, 10)).toBe(0);
  await screen.update(faces('reactions'));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(driveMotionFrames(4000, 10)).toBe(0);
  await screen.update(faces('lively', false));
  expect(vi.getTimerCount()).toBe(0);
  await screen.update(faces('still'));
  expect(vi.getTimerCount()).toBe(0);
});

it('answers new completion and failure watermarks once, learning hidden terminal facts silently', async () => {
  const face = (completedAt: number, failedAt: number | null = null, visible = true) =>
    <BotFace identity={identity} style="dither" size={24} mood="quiet" motion motionMode="reactions"
      completedAt={completedAt} failedAt={failedAt} visible={visible} />;
  const screen = await mount(face(1));
  expect(driveMotionFrames(0, 10)).toBe(0);
  await screen.update(face(2));
  expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(2000, 10)).toBe(0);
  await screen.update(face(2));
  expect(driveMotionFrames(3000, 10)).toBe(0);
  await screen.update(face(2, 3));
  expect(driveMotionFrames(4000, 120)).toBeGreaterThan(0);
  await screen.update(face(4, 3, false));
  await screen.update(face(4, 3));
  expect(driveMotionFrames(6000, 120)).toBe(0);
});

it('reacts once to an already-typed failure even when its observation timestamp is unavailable', async () => {
  const face = (mood: 'quiet' | 'failed', visible = true) =>
    <BotFace identity={identity} style="dither" size={24} mood={mood} motion motionMode="reactions" visible={visible} />;
  const screen = await mount(face('quiet'));
  await screen.update(face('failed'));
  expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
  await screen.update(face('failed'));
  expect(driveMotionFrames(2000, 120)).toBe(0);
  await screen.update(face('quiet', false));
  await screen.update(face('failed', false));
  await screen.update(face('failed'));
  expect(driveMotionFrames(4000, 120)).toBe(0);
});

/** Advance frame by frame, committing each one, as a browser would. */
async function play(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 16) await act(async () => { advance(16); });
}

async function mount(element: React.ReactElement) {
  return renderScreen(element, {
    createNodeMock: (node) => (node.type === 'canvas' ? canvas : null),
  });
}

it('keeps list faces still: no frame clock, and a repaint only when the mood changes', async () => {
  const screen = await mount(
    <BotFace identity={identity} style="dither" size={24} mood="quiet" />,
  );
  await act(async () => {
    advance(5000);
  });
  expect(clock.requested).toBe(0);
  expect(paints).toHaveLength(1);
  await screen.update(
    <BotFace identity={identity} style="dither" size={24} mood="working" />,
  );
  expect(clock.requested).toBe(0);
  expect(paints).toHaveLength(2);
});

it('plays one bounded hero moment from the leaf, then rests with no further frames', async () => {
  let parentRenders = 0;
  function Parent(props: { mood: 'quiet' | 'needsYou' }) {
    parentRenders++;
    return (
      <BotFace identity={identity} style="dither" size={96} mood={props.mood} />
    );
  }
  const screen = await mount(<Parent mood="quiet" />);
  await play(BOT_FACE_MOMENT_MS.quiet + 100);
  const played = paints.length;
  expect(played).toBeGreaterThan(10);
  expect(parentRenders).toBe(1);
  const requested = clock.requested;
  await act(async () => {
    advance(10_000);
  });
  expect(clock.requested).toBe(requested);
  expect(paints).toHaveLength(played);
  // A mood change is a new moment.
  await screen.update(<Parent mood="needsYou" />);
  await play(BOT_FACE_MOMENT_MS.needsYou + 100);
  expect(paints.length).toBeGreaterThan(played + 5);
  expect(clock.queue.size).toBe(0);
});

it('renders zero animation frames under reduced motion or when its surface is hidden, and stops mid-moment', async () => {
  setReducedMotionPreferenceOverride(true);
  const reduced = await mount(
    <BotFace identity={identity} style="solid" size={64} mood="needsYou" />,
  );
  await act(async () => {
    advance(2000);
  });
  expect(clock.requested).toBe(0);
  await reduced.unmount();
  setReducedMotionPreferenceOverride(null);

  const hidden = await mount(
    <BotFace
      identity={identity}
      style="pixel"
      size={64}
      mood="quiet"
      visible={false}
    />,
  );
  await act(async () => {
    advance(2000);
  });
  expect(clock.requested).toBe(0);
  await hidden.update(
    <BotFace identity={identity} style="pixel" size={64} mood="quiet" />,
  );
  await act(async () => {
    advance(200);
  });
  expect(clock.requested).toBeGreaterThan(0);
  await hidden.update(
    <BotFace
      identity={identity}
      style="pixel"
      size={64}
      mood="quiet"
      visible={false}
    />,
  );
  const stoppedAt = clock.requested;
  await act(async () => {
    advance(5000);
  });
  expect(clock.requested).toBe(stoppedAt);
  expect(clock.queue.size).toBe(0);
});

/** The pointer is a platform boundary: hover-in and press-in arrive as host pointer events on the face. */
function pointer(screen: Awaited<ReturnType<typeof mount>>, type: 'onPointerEnter' | 'onPointerLeave' | 'onPointerDown', pointerType: 'mouse' | 'touch') {
  const host = screen.root.findAll(node => typeof node.type === 'string' && typeof node.props[type] === 'function')[0];
  expect(host).toBeDefined();
  act(() => { host!.props[type]({ nativeEvent: { pointerType } }); });
}

it('plays one finite hover perk per hover-in on a resting face, without rendering its parent per frame', async () => {
  let parents = 0;
  function Parent(props: Readonly<{ mode: 'lively' | 'reactions' }>) {
    parents++;
    return <BotFace identity={identity} style="pixel" size={24} mood="quiet" motion motionMode={props.mode} />;
  }
  const screen = await mount(<Parent mode="reactions" />);
  expect(driveMotionFrames(0, 10)).toBe(0);
  pointer(screen, 'onPointerEnter', 'mouse');
  expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(2000, 10)).toBe(0);
  // Still hovering: a click is not a hover-in, and neither is the enter Chrome re-sends when the mouth layers swap
  // under a resting pointer (observed live: without a leave it looped the perk for as long as the pointer stayed).
  pointer(screen, 'onPointerDown', 'mouse');
  pointer(screen, 'onPointerEnter', 'mouse');
  expect(driveMotionFrames(3000, 10)).toBe(0);
  pointer(screen, 'onPointerLeave', 'mouse');
  pointer(screen, 'onPointerEnter', 'mouse');
  expect(driveMotionFrames(4000, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(6000, 10)).toBe(0);
  expect(parents).toBe(1);
  // Touch plays on press-in; the hover that touch synthesises does not add a second perk.
  await screen.update(<Parent mode="lively" />);
  pointer(screen, 'onPointerEnter', 'touch');
  expect(driveMotionFrames(7000, 10)).toBe(0);
  pointer(screen, 'onPointerDown', 'touch');
  expect(driveMotionFrames(8000, 120)).toBeGreaterThan(0);
  expect(driveMotionFrames(10000, 10)).toBe(0);
});

it('renders zero hover perk frames in Still or under Reduce motion', async () => {
  const face = (mode: 'lively' | 'still') =>
    <BotFace identity={identity} style="dots" size={24} mood="quiet" motion motionMode={mode} />;
  const screen = await mount(face('still'));
  pointer(screen, 'onPointerEnter', 'mouse');
  pointer(screen, 'onPointerDown', 'touch');
  expect(driveMotionFrames(0, 60)).toBe(0);
  await act(async () => { setReducedMotionPreferenceOverride(true); });
  await screen.update(face('lively'));
  pointer(screen, 'onPointerEnter', 'mouse');
  pointer(screen, 'onPointerDown', 'touch');
  expect(driveMotionFrames(1000, 60)).toBe(0);
});
