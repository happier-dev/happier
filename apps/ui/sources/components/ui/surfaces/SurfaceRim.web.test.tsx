import * as React from 'react';
import Color from 'color';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { darkTheme } from '@/theme';

import { SurfaceRim } from './SurfaceRim';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

// Owner 2026-11-11 (desktop #12): the rim of an overlay pane stopped part way along its edge, its sheen cut with it.
describe('SurfaceRim on the web', () => {
  it('draws at the box the browser lays out, so a surface that grows after its first layout keeps its whole rim', async () => {
    const { act } = await import('react');
    const screen = await renderScreen(
      <SurfaceRim
        role="floating"
        radius={10}
        border="modal"
        theme={darkTheme}
      />,
    );
    const measuring = screen.findAll(
      (node) =>
        String(node.type) === 'View' &&
        typeof node.props.onLayout === 'function',
    );
    // A first layout while the surface opens must not pin the drawing to that size.
    for (const view of measuring) {
      await act(() => {
        view.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 150 } },
        });
      });
    }
    // The drawing element itself spans the surface: an <svg> without a size is the browser's 300 × 150 default, which
    // is where the owner's seam stopped (live probe: a 300 × 150 svg inside a 320 × 434 menu).
    const svg = screen.findAll((node) => String(node.type) === 'Svg')[0]!;
    expect(svg.props.width).toBe('100%');
    expect(svg.props.height).toBe('100%');
    const rects = screen.findAll((node) => String(node.type) === 'Rect');
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      expect(rect.props.width).toBe('100%');
      expect(rect.props.height).toBe('100%');
    }
  });

  it('carries its corner light along the whole edge instead of ending part way', async () => {
    const screen = await renderScreen(
      <SurfaceRim
        role="floating"
        radius={10}
        border="modal"
        theme={darkTheme}
      />,
    );
    const light = screen.findAll(
      (node) => String(node.type) === 'RadialGradient',
    )[0]!;
    const stops = light.findAll((node) => String(node.type) === 'Stop');
    const last = stops.at(-1)!;
    expect(Number(last.props.offset)).toBe(1);
    const alpha =
      (last.props.stopOpacity ?? 1) * Color(last.props.stopColor).alpha();
    expect(alpha).toBeGreaterThan(0);
  });
});
