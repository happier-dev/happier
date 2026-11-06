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

// Collect the real store graph before the platform-clock test window starts.
const { storage } = await import('@/sync/domains/state/storageStore');
const { SessionBotFace } = await import('./SessionBotFace');
const { useSetting } = await import('@/sync/store/settingsReadHooks');

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

it('mutters a working Lively face from the shared clock: a repaint per step, no frame callbacks, no parent render', async () => {
  vi.useFakeTimers();
  let parents = 0;
  function Parent() {
    parents++;
    return <BotFace identity={identity} style="pixel" size={24} mood="working" motion motionMode="lively" />;
  }
  await mount(<Parent />);
  const before = paints.length;
  // One act per 50 ms, as the platform delivers each timer on its own task.
  for (let t = 0; t < 2800; t += 50) await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  // Two mutter cycles: four steps each (three raised dots, then the still "…").
  expect(paints.length - before).toBeGreaterThanOrEqual(7);
  expect(paints.length - before).toBeLessThanOrEqual(9);
  expect(driveMotionFrames(0, 120)).toBe(0);
  expect(parents).toBe(1);
});

it('rests on a still "…" in Reactions only and Still: no timer and no repaint', async () => {
  vi.useFakeTimers();
  for (const mode of ['reactions', 'still'] as const) {
    paints.length = 0;
    const screen = await mount(<BotFace identity={identity} style="dither" size={24} mood="working" motion motionMode={mode} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(vi.getTimerCount(), mode).toBe(0);
    expect(paints, mode).toHaveLength(1);
    await act(async () => { screen.unmount(); });
  }
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

it('draws a repeated Dither or Solid moment once: later plays reuse its pose drawings, and one play draws only visible steps', async () => {
  // The canvas is the paint boundary: each painted buffer is one drawing; a reused drawing paints the same buffer.
  const buffers: unknown[] = [];
  const counting = { getContext: () => ({ putImageData: (image: { data: unknown }) => { paints.push(clock.now); buffers.push(image.data); } }) };
  for (const style of ['dither', 'solid'] as const) {
    buffers.length = 0;
    const screen = await renderScreen(<BotFace identity={identity} style={style} size={24} mood="quiet" motion motionMode="reactions" />,
      { createNodeMock: node => (node.type === 'canvas' ? counting : null) });
    const perPlay: number[] = [];
    for (let play = 0; play < 4; play++) {
      const seen = new Set(buffers);
      pointer(screen, 'onPointerLeave', 'mouse');
      pointer(screen, 'onPointerEnter', 'mouse');
      for (let n = 0; n < 80; n++) driveMotionFrames(play * 4000 + n * 16, 1);
      perPlay.push(new Set(buffers.filter(b => !seen.has(b))).size);
    }
    console.info('R10A_DRAWS_PER_PERK', style, JSON.stringify(perPlay));
    expect(perPlay[0], style).toBeGreaterThan(2);
    // A drawing per visible step, not per frame: the play ran 80 frames.
    expect(perPlay[0], style).toBeLessThan(40);
    expect(perPlay.slice(1), style).toEqual([0, 0, 0]);
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

it('stops the attention clock when hidden, Still or Reduce motion wins', async () => {
  vi.useFakeTimers();
  const face = (mode: 'lively' | 'still', visible = true) =>
    <BotFace identity={identity} style="solid" size={24} mood="working" visible={visible} motion motionMode={mode} />;
  const screen = await mount(face('lively'));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(vi.getTimerCount()).toBe(1);
  await screen.update(face('lively', false));
  expect(vi.getTimerCount()).toBe(0);
  await screen.update(face('still'));
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { setReducedMotionPreferenceOverride(true); });
  await screen.update(face('lively'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(vi.getTimerCount()).toBe(0);
  expect(driveMotionFrames(3000, 10)).toBe(0);
});

it('uses the scroll host viewport to stop offscreen rail faces and resume a visible working face', async () => {
  vi.useFakeTimers();
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
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { tracker.onScroll(createNativeScrollEvent({
    contentOffset: { x: 0, y: 990 }, layoutMeasurement: { width: 100, height: 100 }, contentSize: { width: 100, height: 2000 },
    contentInset: { top: 0, bottom: 0, left: 0, right: 0 }, zoomScale: 1,
  })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(vi.getTimerCount()).toBe(1);
  await screen.unmount();
});

it('stops offscreen hero moments, shows the current face on return, and reacts to the next visible fact', async () => {
  const content = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 2000 }) };
  const tracker = createNearViewportTracker({ quantum: 1, initialViewportHeight: 100, overscan: false, readContentNode: () => content });
  const face = (mood: 'quiet' | 'needsYou') => <PluginUiScrollActivityProvider tracker={tracker}>
    <BotFace identity={identity} style="pixel" size={64} mood={mood} />
  </PluginUiScrollActivityProvider>;
  const screen = await renderScreen(face('quiet'), {
    createNodeMock: node => node.type === 'canvas' ? canvas : {
      getBoundingClientRect: () => ({ left: 0, top: 1000, width: 64, height: 64 }),
    },
  });
  const scroll = async (y: number) => act(async () => { tracker.onScroll(createNativeScrollEvent({
    contentOffset: { x: 0, y }, layoutMeasurement: { width: 100, height: 100 }, contentSize: { width: 100, height: 2000 },
    contentInset: { top: 0, bottom: 0, left: 0, right: 0 }, zoomScale: 1,
  })); });
  await play(200);
  expect(clock.requested).toBe(0);
  await scroll(990);
  await play(200);
  expect(clock.requested).toBeGreaterThan(0);
  await scroll(0);
  expect(clock.queue.size).toBe(0);
  await screen.update(face('needsYou'));
  const stoppedAt = clock.requested;
  const paintedAt = paints.length;
  await play(1000);
  expect(clock.requested).toBe(stoppedAt);
  expect(paints.length).toBe(paintedAt);
  await scroll(990);
  await play(100);
  expect(clock.requested).toBe(stoppedAt);
  await screen.update(face('quiet'));
  await play(BOT_FACE_MOMENT_MS.quiet + 100);
  expect(clock.requested).toBeGreaterThan(stoppedAt);
  expect(clock.queue.size).toBe(0);
  const settledAt = paints.length;
  await play(500);
  expect(paints.length).toBe(settledAt);
  await screen.unmount();
});
afterEach(async () => {
  await standardCleanup();
  vi.useRealTimers();
  setReducedMotionPreferenceOverride(null);
  vi.unstubAllGlobals();
});

it('shares one attention clock across resting faces, and removes it when none is eligible', async () => {
  vi.useFakeTimers();
  const faces = (mode: 'lively' | 'reactions' | 'still', visible = true) => <>
    {[1, 2, 3].map(seed => <BotFace key={seed} identity={{ ...identity, seed }} style="dither" size={24}
      mood="quiet" motion motionMode={mode} visible={visible} />)}
  </>;
  const screen = await mount(faces('lively'));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(vi.getTimerCount()).toBe(1);
  const before = paints.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  // They look around: each turn bucket is a repaint, and the R7 gestures stay finite frame callbacks.
  expect(paints.length).toBeGreaterThan(before);
  expect(vi.getTimerCount()).toBe(1);
  await screen.update(faces('reactions'));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(vi.getTimerCount()).toBe(0);
  const resting = paints.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(paints.length).toBe(resting);
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

it('lets a resting Lively hero look around and breathe after its moment, and keeps Still and hidden heroes asleep', async () => {
  vi.useFakeTimers();
  const hero = (mode: 'lively' | 'still', visible = true) => <BotFace identity={identity} style="solid" size={64} mood="quiet" motionMode={mode} visible={visible} />;
  const screen = await mount(hero('lively'));
  await act(async () => { advance(BOT_FACE_MOMENT_MS.quiet + 100); });
  const settled = paints.length;
  for (let t = 0; t < 30_000; t += 100) await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(paints.length).toBeGreaterThan(settled);
  const breath = screen.root.findAll(node => node.props.testID === 'bot-face-hero-breath');
  expect(breath).toHaveLength(1);
  await screen.update(hero('still'));
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.root.findAll(node => node.props.testID === 'bot-face-hero-breath')).toHaveLength(0);
  await screen.update(hero('lively', false));
  expect(vi.getTimerCount()).toBe(0);
});

it('plays the perk and holds its look when its host takes keyboard focus, never in Still', async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const host = { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type), matches: () => true };
  // The DOM is the platform boundary: the face's node finds its focusable pin or row.
  const nodeMock = (node: { type: unknown }) => node.type === 'canvas' ? canvas : { closest: () => host, getBoundingClientRect: () => ({ left: 0, top: 0, width: 24, height: 24 }) };
  for (const mode of ['reactions', 'still'] as const) {
    listeners.clear();
    const screen = await renderScreen(<BotFace identity={identity} style="pixel" size={24} mood="quiet" motion motionMode={mode} />, { createNodeMock: nodeMock });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    if (mode === 'still') { expect(listeners.size, mode).toBe(0); await screen.unmount(); continue; }
    expect(listeners.has('focus')).toBe(true);
    act(() => { listeners.get('focus')!(); });
    expect(driveMotionFrames(0, 120)).toBeGreaterThan(0);
    act(() => { listeners.get('blur')!(); });
    await screen.unmount();
    expect(listeners.size).toBe(0);
  }
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

it('reads the Bot default only for inheriting faces and leaves explicit and unrelated subscribers asleep', async () => {
  const before = storage.getState();
  storage.getState().applySettingsLocal({ botFaceStyle: 'dither', botMotion: 'still' });
  const commits = { inherited: 0, explicit: 0, unrelated: 0 };
  const inherited = { seed: 'inherited', face: null };
  const explicit = { seed: 'explicit', face: { style: 'pixel' as const } };
  function Unrelated() { useSetting('avatarStyle'); return null; }
  const faces = (explicitFacts: React.ComponentProps<typeof SessionBotFace>['facts'] = explicit) => <>
    <React.Profiler id="inherited" onRender={() => { commits.inherited++; }}><SessionBotFace facts={inherited} size={24} /></React.Profiler>
    <React.Profiler id="explicit" onRender={() => { commits.explicit++; }}><SessionBotFace facts={explicitFacts} size={24} /></React.Profiler>
    <React.Profiler id="unrelated" onRender={() => { commits.unrelated++; }}><Unrelated /></React.Profiler>
  </>;
  const screen = await renderScreen(faces());
  try {
    commits.inherited = 0; commits.explicit = 0; commits.unrelated = 0;
    await act(async () => { storage.getState().applySettingsLocal({ wrapLinesInDiffs: !before.settings.wrapLinesInDiffs }); });
    expect(commits).toEqual({ inherited: 0, explicit: 0, unrelated: 0 });
    await act(async () => { storage.getState().applySettingsLocal({ botFaceStyle: 'solid' }); });
    console.info('LIVING_BOTS_DEFAULT_READ_SCOPE', JSON.stringify(commits));
    expect(commits).toEqual({ inherited: 1, explicit: 0, unrelated: 0 });
    expect(screen.findAllByType(BotFace).map(node => node.props.style)).toEqual(['solid', 'pixel']);
    await screen.update(faces({ ...explicit, face: null }));
    commits.inherited = 0; commits.explicit = 0; commits.unrelated = 0;
    await act(async () => { storage.getState().applySettingsLocal({ botFaceStyle: 'dots' }); });
    expect(commits).toEqual({ inherited: 1, explicit: 1, unrelated: 0 });
    expect(screen.findAllByType(BotFace).map(node => node.props.style)).toEqual(['dots', 'dots']);
  } finally { await screen.unmount(); storage.setState(before, true); }
});
