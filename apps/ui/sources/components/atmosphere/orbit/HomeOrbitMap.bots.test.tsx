import * as React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import {
  readReanimatedFrameCallbacks,
  resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';

import { HomeOrbitMap, type HomeOrbitBotsProps } from './HomeOrbitMap';
import { layoutHomeOrbitBots, type HomeOrbitBotInput } from './homeOrbitScene';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const bots: readonly HomeOrbitBotInput[] = [
  { key: 'flake', activity: 'needsYou' },
  { key: 'release', activity: 'working' },
  { key: 'docs', activity: 'quiet' },
  { key: 'triage', activity: 'quiet' },
];
const scene = layoutHomeOrbitBots(
  { width: 900, height: 600 },
  { px: 700, py: 160, pr: 200 },
  bots,
);

let marks = 0;
function botProps(
  overrides: Partial<HomeOrbitBotsProps> = {},
): HomeOrbitBotsProps {
  return {
    labels: { flake: 'Flake hunter', release: 'Release captain' },
    accessibilityLabels: {
      flake: 'Flake hunter, needs you',
      release: 'Release captain, working',
      docs: 'Docs gardener',
      triage: 'Issue triager',
    },
    eligible: true,
    sparks: {},
    renderMark: (key, size, done) => {
      marks += 1;
      return <View testID={`mark:${key}:${size}:${done ? 'done' : 'rest'}`} />;
    },
    onPress: () => {},
    ...overrides,
  };
}

/** Drives `count` display frames through every registered frame callback; returns the callbacks that ran. */
function driveFrames(count: number): number {
  let ran = 0;
  for (let frame = 0; frame < count; frame++) {
    for (const record of readReanimatedFrameCallbacks()) {
      if (record.handle.callbackId === -1 || !record.handle.isActive) continue;
      record.run({
        timestamp: frame * 16,
        timeSincePreviousFrame: 16,
        timeSinceFirstFrame: frame * 16,
      });
      ran += 1;
    }
  }
  return ran;
}

beforeEach(() => {
  resetReanimatedFrameCallbacks();
  marks = 0;
});
afterEach(async () => {
  await standardCleanup();
});

describe('Home Bot moons (plan U3, Q2)', () => {
  it('keeps finite reactions available without continuous orbit in Reactions only', async () => {
    const screen = await renderScreen(<HomeOrbitMap scene={scene}
      bots={botProps({ continuous: false })} accessibilityLabel="Bots" testID="map" />);
    expect(driveFrames(120)).toBe(0);
    await screen.update(<HomeOrbitMap scene={scene}
      bots={botProps({ continuous: false, sparks: { release: 1 } })} accessibilityLabel="Bots" testID="map" />);
    expect(screen.findAllByTestId('mark:release:30:done').length).toBeGreaterThan(0);
    expect(driveFrames(120)).toBe(0);
  });
  it('runs one frame callback for the working moon only, every frame of a continued visible interval', async () => {
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={scene}
        bots={botProps()}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    expect(driveFrames(120)).toBe(120);
    // Quiet moons and the waiting needs-you moon register no running callback.
    expect(
      readReanimatedFrameCallbacks().filter((record) => record.handle.isActive),
    ).toHaveLength(1);
    await screen.unmount();
  });

  it('produces zero frames while hidden, offscreen or under reduced motion, and resumes a still-working moon on return', async () => {
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={scene}
        bots={botProps({ eligible: false })}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    expect(driveFrames(120)).toBe(0);
    await screen.update(
        <HomeOrbitMap
          scene={scene}
          bots={botProps()}
          accessibilityLabel="Bots"
          testID="map"
        />,
      );
    expect(driveFrames(10)).toBe(10);
    await screen.update(
        <HomeOrbitMap
          scene={scene}
          bots={botProps({ eligible: false })}
          accessibilityLabel="Bots"
          testID="map"
        />,
      );
    expect(driveFrames(120)).toBe(0);
    await screen.unmount();
  });

  it('settles when the work stops: an all-quiet orbit runs nothing', async () => {
    const quiet = layoutHomeOrbitBots(
      { width: 900, height: 600 },
      { px: 700, py: 160, pr: 200 },
      bots.map((bot) => ({ ...bot, activity: 'quiet' as const })),
    );
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={quiet}
        bots={botProps()}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    expect(driveFrames(120)).toBe(0);
    await screen.unmount();
  });

  it('never renders the map per frame: frames move the moon by transform only', async () => {
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={scene}
        bots={botProps()}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    const before = marks;
    driveFrames(240);
    expect(marks).toBe(before);
    await screen.unmount();
  });

  it('opens each visible moon from an accessible button, and sparks once per new completion', async () => {
    const opened: string[] = [];
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={scene}
        bots={botProps({ onPress: (key) => opened.push(key) })}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    const moon = screen.findByTestId('map.bot.release')!;
    expect(moon.props.accessibilityRole).toBe('button');
    expect(moon.props.accessibilityLabel).toBe('Release captain, working');
    await act(async () => {
      moon.props.onPress();
    });
    expect(opened).toEqual(['release']);
    // The first sight of a completion count is not a spark; a new one is.
    expect(screen.findByTestId('mark:docs:30:done')).toBeNull();
    await screen.update(
        <HomeOrbitMap
          scene={scene}
          bots={botProps({ sparks: { docs: 1 } })}
          accessibilityLabel="Bots"
          testID="map"
        />,
      );
    expect(screen.findByTestId('mark:docs:30:done')).toBeTruthy();
    await screen.unmount();
  });

  it('does not spark while it cannot move (a completion missed while hidden is not replayed)', async () => {
    const screen = await renderScreen(
      <HomeOrbitMap
        scene={scene}
        bots={botProps({ eligible: false })}
        accessibilityLabel="Bots"
        testID="map"
      />,
    );
    await screen.update(
        <HomeOrbitMap
          scene={scene}
          bots={botProps({ eligible: false, sparks: { docs: 1 } })}
          accessibilityLabel="Bots"
          testID="map"
        />,
      );
    await screen.update(
        <HomeOrbitMap
          scene={scene}
          bots={botProps({ sparks: { docs: 1 } })}
          accessibilityLabel="Bots"
          testID="map"
        />,
      );
    expect(screen.findByTestId('mark:docs:30:done')).toBeNull();
    await screen.unmount();
  });
});

describe('Home Bot orbit layout', () => {
  it('waits needs-you in front, spreads the rest over the lanes in roster order and only the working moon travels', () => {
    const byKey = new Map(scene.bots!.moons.map((moon) => [moon.key, moon]));
    expect(byKey.get('flake')!.park).not.toBeNull();
    expect(byKey.get('flake')!.speed).toBe(0);
    expect(byKey.get('release')!.speed).toBeGreaterThan(0);
    expect(byKey.get('docs')!.speed).toBe(0);
    expect(
      new Set([
        byKey.get('release')!.orbit,
        byKey.get('docs')!.orbit,
        byKey.get('triage')!.orbit,
      ]).size,
    ).toBe(3);
    expect(scene.canvas).toBeNull();
  });

  it('draws a few moons, the first in the roster, and leaves the rest to one "+N"', () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      key: `bot-${index}`,
      activity: 'quiet' as const,
    }));
    const dense = layoutHomeOrbitBots(
      { width: 900, height: 600 },
      { px: 700, py: 160, pr: 120 },
      many,
    );
    const shown = dense.bots!.moons.length;
    expect(shown).toBe(4);
    expect(dense.bots!.more?.count).toBe(400 - shown);
    // The roster's first Bots are the ones drawn.
    expect(dense.bots!.moons.map((moon) => moon.key)).toContain('bot-0');
    expect(dense.bots!.moons.map((moon) => moon.key)).not.toContain('bot-399');
  });
});
