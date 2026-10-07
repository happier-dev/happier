import * as React from 'react';
import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * React Native's `Animated` is the platform boundary: it hands the animation graph to the native
 * driver, which no Node test can run. The mock records what the spinner hands it — the loops it
 * starts and stops, their driver, and each dot's interpolation — while the frame table, clock
 * sharing and motion policy stay real.
 */
const animated = vi.hoisted(() => ({
  loops: [] as Array<{ animation: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
}));

vi.mock('react-native', () => {
  class Interpolation {
    constructor(readonly config: Readonly<{ inputRange: number[]; outputRange: Array<number | string> }>, readonly parent: unknown) {}
    interpolate(config: Readonly<{ inputRange: number[]; outputRange: Array<number | string> }>) {
      return new Interpolation(config, this);
    }
  }
  class Value {
    constructor(readonly initial: number) {}
    setValue(_value: number) {}
    interpolate(config: Readonly<{ inputRange: number[]; outputRange: Array<number | string> }>) {
      return new Interpolation(config, this);
    }
  }
  return {
    Animated: {
      Value,
      View: 'AnimatedView',
      loop: (animation: unknown) => {
        const record = { animation, start: vi.fn(), stop: vi.fn() };
        animated.loops.push(record);
        return { start: record.start, stop: record.stop };
      },
      sequence: (steps: unknown[]) => ({ sequence: steps }),
      timing: (_value: unknown, config: unknown) => ({ timing: config }),
    },
    ActivityIndicator: 'ActivityIndicator',
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      inOut: (easing: (t: number) => number) => easing,
    },
    Platform: { OS: 'ios', select: <T,>(options: Readonly<{ ios?: T; default?: T }>) => options.ios ?? options.default },
    View: 'View',
  };
});

import { getDotSpinnerFrames, readDotSeries } from './dotSpinnerFrames.js';
import { HappierSpinner, HappierSpinnerHost, resolveHappierSpinnerPresentation } from './Spinner.js';
import { DEFAULT_HAPPIER_SPINNER_TIMING } from './spinnerStyles.js';

type RecordedInterpolation = { config: { inputRange: number[]; outputRange: Array<number | string> }; parent: unknown };

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  animated.loops.length = 0;
});

function render(element: React.ReactElement): ReactTestRenderer {
  act(() => {
    renderer = create(element);
  });
  return renderer!;
}

function dots(root: ReactTestRenderer): ReactTestInstance[] {
  return root.root.findAll((node) => node.type === 'AnimatedView' && node.props.testID === 'happier-spinner-dot');
}

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return style.reduce((acc, item) => Object.assign(acc, flatten(item)), {} as Record<string, unknown>);
  return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function runningLoops() {
  return animated.loops.filter((loop) => loop.start.mock.calls.length > loop.stop.mock.calls.length);
}

describe('HappierSpinner on native (dot styles)', () => {
  it('draws the mark with eight native-driven dots whose opacity interpolates the frame table', () => {
    const root = render(<HappierSpinner size={18} color="red" />);
    const drawn = dots(root);
    const frames = getDotSpinnerFrames('wave', DEFAULT_HAPPIER_SPINNER_TIMING);

    expect(root.root.findAllByType('ActivityIndicator' as never)).toHaveLength(0);
    expect(drawn).toHaveLength(8);
    expect(flatten(drawn[0]!.props.style)).toMatchObject({ width: 3, height: 3, backgroundColor: 'red' });

    const opacity = flatten(drawn[2]!.props.style).opacity as RecordedInterpolation;
    const series = readDotSeries(frames, frames.opacity, 2);
    expect(opacity.config.outputRange).toEqual([...series, series[0]]);
    expect(opacity.config.inputRange).toHaveLength(frames.frameCount + 1);
    expect(opacity.config.inputRange[0]).toBe(0);
    expect(opacity.config.inputRange[frames.frameCount]).toBe(1);

    expect(runningLoops()).toHaveLength(1);
    expect(runningLoops()[0]!.animation).toEqual({
      timing: expect.objectContaining({ toValue: 1, duration: 1004, useNativeDriver: true }),
    });
  });

  it('runs a speed and pause on the shared clock for its played cycle: motion ÷ rate, then the pause', () => {
    const spinner = (indicatorSpeed: string, indicatorPause: string) => {
      const presentation = resolveHappierSpinnerPresentation({ platform: 'native', indicatorSpeed, indicatorPause, size: 16 });
      if (!presentation) throw new Error('Expected a visible spinner');
      return <HappierSpinnerHost presentation={presentation} hostProps={{ size: 16 }} />;
    };
    render(<>{spinner('fast', 'long')}{spinner('fast', 'long')}{spinner('slow', 'none')}</>);

    const durations = runningLoops().map((loop) => (loop.animation as { timing: { duration: number } }).timing.duration);
    expect(durations.sort((a, b) => a - b)).toEqual([Math.round(804 / 1.5 + 500), Math.round(804 / 0.75)]);
  });

  it('keeps the seven-dot H selectable and shares its wave clock with the mark', () => {
    const h = resolveHappierSpinnerPresentation({ platform: 'native', indicatorStyle: 'hWave', size: 18 });
    if (!h) throw new Error('Expected a visible H spinner');
    const root = render(<><HappierSpinner size={18} /><HappierSpinnerHost presentation={h} hostProps={{ size: 18 }} /></>);
    expect(dots(root)).toHaveLength(15);
    expect(runningLoops()).toHaveLength(1);
  });

  it('runs one shared clock for every spinner of a cycle and stops it when the last one leaves', () => {
    const three = (count: number) => (
      <>
        {Array.from({ length: count }, (_, index) => <HappierSpinner key={index} size={16} />)}
      </>
    );
    const root = render(three(3));

    expect(animated.loops).toHaveLength(1);
    expect(runningLoops()).toHaveLength(1);
    const clocks = new Set(dots(root).map((dot) => (flatten(dot.props.style).opacity as RecordedInterpolation).parent));
    expect(clocks.size).toBe(1);

    act(() => root.update(three(1)));
    expect(runningLoops()).toHaveLength(1);

    act(() => root.update(three(0)));
    expect(runningLoops()).toHaveLength(0);
    expect(animated.loops[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('holds the full mark still with no clock when ambient motion is paused', () => {
    const root = render(<HappierSpinner size={18} animationEnabled={false} />);

    expect(animated.loops).toHaveLength(0);
    expect(dots(root).map((dot) => flatten(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
  });

  it('breathes the still H with a native-driven fade under reduced motion', () => {
    const root = render(<HappierSpinner size={18} reducedMotion />);

    expect(dots(root).map((dot) => flatten(dot.props.style).opacity)).toEqual(Array(8).fill(0.85));
    expect(runningLoops()).toHaveLength(1);
    expect(JSON.stringify(runningLoops()[0]!.animation)).toContain('"useNativeDriver":true');
    const layer = root.root.find((node) => node.type === 'AnimatedView' && node.props.testID === 'happier-spinner-dots');
    expect((flatten(layer.props.style).opacity as RecordedInterpolation).config.outputRange).toEqual([1, 0.45]);
  });

  it('keeps the layout box but draws nothing when stopped and hidden', () => {
    const root = render(<HappierSpinner testID="spinner" accessibilityLabel="Working" size={18} animating={false} />);

    expect(dots(root)).toHaveLength(0);
    expect(animated.loops).toHaveLength(0);
    expect(root.root.findByType('View' as never).props).toMatchObject({
      accessible: false,
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
    const host = root.root.findByType('View' as never);
    act(() => root.update(<HappierSpinner testID="spinner" accessibilityLabel="Working" size={18} />));
    expect(root.root.findByType('View' as never)).toBe(host);
    expect(host.props.accessibilityElementsHidden).not.toBe(true);
    expect(host.props.importantForAccessibility).not.toBe('no-hide-descendants');
    expect(dots(root)).toHaveLength(8);
  });
});
