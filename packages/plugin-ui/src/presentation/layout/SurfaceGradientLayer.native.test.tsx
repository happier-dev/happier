import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ OS: 'ios' }));

// Native host primitives are the boundary; use RNW's real RN-compatible color parser.
vi.mock('react-native', async () => {
  const { processColor } = await vi.importActual<Pick<typeof import('react-native'), 'processColor'>>('react-native-web');
  return { Platform: platform, StyleSheet: { absoluteFillObject: {} }, View: 'View', processColor: (color: string) => {
    const parsed = processColor(color);
    return platform.OS === 'android' && typeof parsed === 'number' ? parsed | 0 : parsed;
  } };
});

import { HappierSurfaceGradientLayer } from './SurfaceGradientLayer.js';
import { happierSvgGradientStop } from './svgGradientStop.js';

let renderer: ReactTestRenderer | undefined;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  platform.OS = 'ios';
  vi.restoreAllMocks();
});

describe('native surface gradient paint', () => {
  it('leaves an authored surface background visible without painting a gradient above it', () => {
    const override = { overrideBackgroundColor: 'rgba(12, 34, 56, 0.4)' };
    act(() => {
      renderer = create(<HappierSurfaceGradientLayer {...override} gradient={{ colors: ['red', 'blue'] }} />);
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  it('paints Android full-surface layers natively so no view-sized SVG bitmap can outgrow the canvas limit', () => {
    platform.OS = 'android';
    act(() => {
      renderer = create(<HappierSurfaceGradientLayer borderRadius={12}
        underlay={{ colors: ['rgba(255, 255, 255, 0.14)', 'transparent'] }}
        gradient={{ colors: ['rgba(34, 34, 34, 0)', 'rgba(34, 34, 34, 0.5)'], locations: [0.3, 1], start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } }}
      />);
    });
    expect(renderer!.root.findAll(node => String(node.type) === 'Svg')).toHaveLength(0);
    const painted = renderer!.root.findAll(node => String(node.type) === 'View');
    expect(painted).toHaveLength(1);
    expect(painted[0].props.pointerEvents).toBe('none');
    expect(painted[0].props.style.borderRadius).toBe(12);
    // CSS paints its first layer on top: the gradient stays above its underlay, as in SVG order.
    expect(painted[0].props.style.experimental_backgroundImage).toEqual([
      { type: 'linear-gradient', direction: '0deg', colorStops: [
        { color: 'rgba(34, 34, 34, 0)', positions: ['30%'] }, { color: 'rgba(34, 34, 34, 0.5)', positions: ['100%'] },
      ] },
      { type: 'linear-gradient', direction: '180deg', colorStops: [
        { color: 'rgba(255, 255, 255, 0.14)', positions: ['0%'] }, { color: 'transparent', positions: ['100%'] },
      ] },
    ]);
  });

  it('keeps an Android edge band in its own fixed-height SVG strip', () => {
    platform.OS = 'android';
    act(() => {
      renderer = create(<HappierSurfaceGradientLayer gradient={{ colors: ['red', 'blue'], band: { edge: 'top', height: 32 } }} />);
    });
    expect(renderer!.root.findAll(node => String(node.type) === 'Svg').map(node => node.props.height)).toEqual([32]);
  });

  it('preserves alpha in full-height, underlay and band stops on ios', () => {
    platform.OS = 'ios';
    act(() => {
      renderer = create(<HappierSurfaceGradientLayer
        underlay={{ colors: ['rgba(255, 255, 255, 0.14)', 'transparent'] }}
        gradient={{ colors: ['rgba(34, 34, 34, 0)', 'rgba(34, 34, 34, 0.006)'],
          locations: [0.3, 1], band: { edge: 'bottom', height: 32 } }}
      />);
    });
    const stops = renderer!.root.findAll(node => String(node.type) === 'Stop');
    expect(stops.map(node => ({ color: node.props.stopColor, opacity: node.props.stopOpacity }))).toEqual([
      { color: 'rgb(255, 255, 255)', opacity: 36 / 255 },
      { color: 'rgb(0, 0, 0)', opacity: 0 },
      { color: 'rgb(34, 34, 34)', opacity: 0 },
      { color: 'rgb(34, 34, 34)', opacity: 2 / 255 },
    ]);
    expect(stops.map(node => node.props.offset)).toEqual([0, 1, 0.3, 1]);
  });

  it('retains opaque, named, short/long alpha hex and HSL colors', () => {
    act(() => {
      renderer = create(<HappierSurfaceGradientLayer gradient={{
        colors: ['#123', 'red', '#1234', '#11223380', 'hsla(120, 100%, 50%, 0.5)'],
      }} />);
    });
    expect(renderer!.root.findAll(node => String(node.type) === 'Stop')
      .map(node => ({ color: node.props.stopColor, opacity: node.props.stopOpacity }))).toEqual([
        { color: 'rgb(17, 34, 51)', opacity: 1 },
        { color: 'rgb(255, 0, 0)', opacity: 1 },
        { color: 'rgb(17, 34, 51)', opacity: 68 / 255 },
        { color: 'rgb(17, 34, 51)', opacity: 128 / 255 },
        { color: 'rgb(0, 255, 0)', opacity: 128 / 255 },
      ]);
  });

  it('does not add native paint on web', () => {
    platform.OS = 'web';
    act(() => { renderer = create(<HappierSurfaceGradientLayer gradient={{ colors: ['red', 'transparent'] }} />); });
    expect(renderer!.toJSON()).toBeNull();
  });

  it('combines a translucent theme color with a separate fade only once and keeps web CSS intact', () => {
    expect(happierSvgGradientStop('rgba(34, 34, 34, 0.4)', 0.64)).toEqual({
      stopColor: 'rgb(34, 34, 34)', stopOpacity: 0.4 * 0.64,
    });
    expect(happierSvgGradientStop('#1234', 0)).toEqual({ stopColor: 'rgb(17, 34, 51)', stopOpacity: 0 });
    platform.OS = 'web';
    expect(happierSvgGradientStop('rgba(34, 34, 34, 0.4)', 0.64)).toEqual({
      stopColor: 'rgba(34, 34, 34, 0.4)', stopOpacity: 0.64,
    });
    expect(happierSvgGradientStop('var(--theme-accent)')).toEqual({ stopColor: 'var(--theme-accent)', stopOpacity: 1 });
  });
});
