import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PET_ANIMATION_ROWS_V1 } from '@happier-dev/protocol/pets/constants';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { reactNativeWebAppState } from '@/dev/testkit/mocks/reactNative';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { BotFacePet } = await import('./BotFacePet');
const { PetSprite } = await import('@/components/pets/render/PetSprite');
const { resolveBuiltInPetPackage } =
  await import('@/components/pets/builtIns/builtInPetRegistry');

const milo = resolveBuiltInPetPackage('milo');
const BOX = 24;
const k = BOX / Math.max(milo.opaqueBounds.width, milo.opaqueBounds.height);

type Played = {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  animation: {
    cancel: () => void;
    onfinish: (() => void) | null;
    currentTime: number;
    cancelled: boolean;
  };
};
let played: Played[] = [];
// The Web Animations API is the platform boundary that plays a pet's row on the compositor.
const host = {
  // The face's box in the viewport: the look aims from its centre (12, 12).
  getBoundingClientRect: () => ({ left: 0, top: 0, width: BOX, height: BOX }),
  animate: (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    const animation = {
      cancelled: false,
      onfinish: null as (() => void) | null,
      currentTime: 0,
      cancel() {
        this.cancelled = true;
      },
    };
    played.push({ keyframes, options, animation });
    return animation;
  },
};
const live = () => played.filter((play) => !play.animation.cancelled);
/** The atlas row a played track steps through, read back from its stepped offsets. */
const rowOf = (play: Played) => {
  const y = Number(
    /translate\([^,]+px, ([-\d.]+)px\)/.exec(
      String(play.keyframes[0]!.transform),
    )![1],
  );
  return Math.round((-y / k - milo.opaqueBounds.y) / 208);
};
const rowFor = (state: string) =>
  PET_ANIMATION_ROWS_V1.find((row) => row.state === state)!.row;

beforeEach(() => {
  played = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  setReducedMotionPreferenceOverride(null);
  vi.useRealTimers();
  await standardCleanup();
});

function face(props: Partial<React.ComponentProps<typeof BotFacePet>> = {}) {
  return (
    <BotFacePet
      spritesheetSource={milo.spritesheetSource}
      opaqueBounds={milo.opaqueBounds}
      size={BOX}
      mood="quiet"
      seed={7}
      motionMode="lively"
      {...props}
    />
  );
}
const render = (element: React.ReactElement) =>
  renderScreen(element, { createNodeMock: () => host });

it.each([
  ['quiet', 'idle', 0],
  ['working', 'running', 1],
  ['needsYou', 'waiting', 0],
  ['done', 'waving', 1],
  ['failed', 'failed', 7],
] as const)(
  "rests a %s face on its pose's still frame from the pose owner",
  async (mood, state, frame) => {
    const screen = await render(face({ mood }));
    expect(screen.findByType(PetSprite).props.frame).toMatchObject({
      state,
      row: rowFor(state),
      frame,
    });
    expect(played).toEqual([]);
  },
);

it('loops a working Lively pet as one compositor track, with no React commit or timer while it plays', async () => {
  let commits = 0;
  const screen = await render(
    <React.Profiler
      id="pet"
      onRender={() => {
        commits++;
      }}
    >
      {face({ mood: 'working', motion: true })}
    </React.Profiler>,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(live()).toHaveLength(1);
  expect(live()[0]!.options.iterations).toBe(Infinity);
  expect(rowOf(live()[0]!)).toBe(rowFor('running'));
  const settled = commits;
  for (let t = 0; t < 10_000; t += 100)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  expect(commits - settled).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  // Hiding the app stops it; viewing it again resumes in phase.
  await act(async () => {
    reactNativeWebAppState.emit('background');
  });
  expect(live()).toHaveLength(0);
  await act(async () => {
    reactNativeWebAppState.emit('active');
  });
  expect(live()).toHaveLength(1);
  await act(async () => {
    screen.unmount();
  });
});

it('plays nothing in Still or under Reduce motion: the state rests on its still frame', async () => {
  const still = await render(
    face({ mood: 'working', motion: true, motionMode: 'still' }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(played).toEqual([]);
  expect(still.findByType(PetSprite).props.frame.frame).toBe(1);
  await act(async () => {
    still.unmount();
  });
  setReducedMotionPreferenceOverride(true);
  const reduced = await render(face({ mood: 'needsYou', motion: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(played).toEqual([]);
  await act(async () => {
    reduced.unmount();
  });
});

it('plays a fact once on rail faces (Done waves), then rests; ordinary rows only show the new still frame', async () => {
  const rail = await render(face({ motion: true }));
  await rail.update(face({ motion: true, mood: 'done' }));
  const wave = live().find((play) => play.options.iterations === 1)!;
  expect(rowOf(wave)).toBe(rowFor('waving'));
  await act(async () => {
    wave.animation.onfinish?.();
  });
  expect(live().filter((play) => play.options.iterations === 1)).toHaveLength(
    0,
  );
  expect(rail.findByType(PetSprite).props.frame).toMatchObject({
    state: 'waving',
    frame: 1,
  });
  await act(async () => {
    rail.unmount();
  });

  played = [];
  const row = await render(face({ motion: 'interaction' }));
  await row.update(face({ motion: 'interaction', mood: 'done' }));
  expect(played).toEqual([]);
  await act(async () => {
    row.unmount();
  });
});

it('plays working once in Reactions only, then rests on running frame 1', async () => {
  const screen = await render(face({ motion: true, motionMode: 'reactions' }));
  await screen.update(
    face({ motion: true, motionMode: 'reactions', mood: 'working' }),
  );
  expect(live()).toHaveLength(1);
  expect(live()[0]!.options.iterations).toBe(1);
  await act(async () => {
    live()[0]!.animation.onfinish?.();
  });
  expect(live()).toHaveLength(0);
  expect(screen.findByType(PetSprite).props.frame).toMatchObject({
    state: 'running',
    frame: 1,
  });
  await act(async () => {
    screen.unmount();
  });
});

it('plays the idle row once now and then on the shared clock, never as a loop', async () => {
  const screen = await render(face({ motion: true }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(45_000);
  });
  const idles = played.filter((play) => rowOf(play) === rowFor('idle'));
  expect(idles.length).toBeGreaterThanOrEqual(1);
  expect(idles.every((play) => play.options.iterations === 1)).toBe(true);
  await act(async () => {
    screen.unmount();
  });
});

it('hops once under the pointer on its own box, not again within the refractory window', async () => {
  const screen = await render(face({ motion: 'interaction' }));
  const box = screen.root.find(
    (node) => typeof node.props.onPointerEnter === 'function',
  );
  await act(async () => {
    box.props.onPointerEnter({ nativeEvent: { pointerType: 'mouse' } });
  });
  expect(live().map(rowOf)).toEqual([rowFor('jumping')]);
  await act(async () => {
    live()[0]!.animation.onfinish?.();
  });
  await act(async () => {
    box.props.onPointerLeave();
    box.props.onPointerEnter({ nativeEvent: { pointerType: 'mouse' } });
  });
  expect(live()).toHaveLength(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1300);
  });
  await act(async () => {
    box.props.onPointerLeave();
    box.props.onPointerEnter({ nativeEvent: { pointerType: 'mouse' } });
  });
  expect(live()).toHaveLength(1);
  await act(async () => {
    screen.unmount();
  });
});

it('turns a resting v2 pet toward a fine pointer, looks at you on the face, and rests again out of reach; v1 never turns', async () => {
  // The document's pointer events are the platform boundary of the shared attention clock.
  const handlers = new Map<string, (event: unknown) => void>();
  const target = {
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers.set(type, fn); },
    removeEventListener: (type: string) => { handlers.delete(type); },
  };
  vi.stubGlobal('document', { ...target, documentElement: target });
  const pointAt = async (x: number, y: number) => {
    await act(async () => {
      handlers.get('pointermove')?.({ pointerType: 'mouse', clientX: x, clientY: y });
      await vi.advanceTimersByTimeAsync(40);
    });
  };
  const cell = (screen: Awaited<ReturnType<typeof render>>) => {
    const { row, frame } = screen.findByType(PetSprite).props.frame;
    return [row, frame];
  };
  const screen = await render(face({ mood: 'done', motion: 'interaction', spriteVersionNumber: 2, hasNeutralLookCell: false }));
  expect(cell(screen)).toEqual([rowFor('waving'), 1]);
  await pointAt(12, -100); // straight up: direction 0
  expect(cell(screen)).toEqual([9, 0]);
  await pointAt(200, 12); // to the right: direction 4
  expect(cell(screen)).toEqual([9, 4]);
  await pointAt(200, 58); // 14° on, past the sector edge: the 15° hysteresis keeps direction 4
  expect(cell(screen)).toEqual([9, 4]);
  await pointAt(12, 13); // on the face: no neutral cell on this sheet, so idle frame 0
  expect(cell(screen)).toEqual([0, 0]);
  await pointAt(2000, 2000); // out of reach: the state's own still frame
  expect(cell(screen)).toEqual([rowFor('waving'), 1]);
  await act(async () => { screen.unmount(); });

  const v1 = await render(face({ mood: 'quiet', motion: 'interaction' }));
  await pointAt(12, -100);
  expect(cell(v1)).toEqual([rowFor('idle'), 0]);
  await act(async () => { v1.unmount(); });
  vi.unstubAllGlobals();
});

it('draws a v2 sheet from its own atlas: 192 × 208 cells over 11 rows, never squashed into the v1 nine', async () => {
  const screen = await render(face({ spriteVersionNumber: 2 }));
  const image = screen.root.findAllByType('Image')[0]!;
  const { width, height } = image.props.style;
  // The scaled atlas keeps the sheet's own proportions (1536 × 2288), so one cell stays 192 × 208.
  expect(width / height).toBeCloseTo(1536 / 2288, 5);
  expect((height / 11) / (width / 8)).toBeCloseTo(208 / 192, 5);
  await act(async () => { screen.unmount(); });
});
