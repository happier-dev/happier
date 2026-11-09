import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { pressTestInstance, renderScreen } from '@/dev/testkit';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { ScrubLens } from '@/components/settings/usage/UsageScrubLens';
import { lightTheme } from '@/theme';

import {
  renderDeclarativeNode,
  type DeclarativeNodeRenderContext,
} from './declarativeNodes';

/**
 * Agent-made charts (Artifacts, Boards, Home widgets, reply visuals) render through the one declarative
 * renderer and read through the same all-series lens as the Usage charts: the bucket label over one
 * swatch · name · value row per series, in the chart's own ink and reading, beside a crosshair.
 */
const context = {
  colors: lightTheme.colors,
  presentationTheme: projectPluginUiTheme(lightTheme),
  minimumTouchTarget: 44,
  localize: (value: unknown) => (typeof value === 'string' ? value : ''),
  resolveAction: () => null,
  renderField: () => null,
  renderCollectionList: () => null,
} satisfies DeclarativeNodeRenderContext;

type LensGesture = Readonly<{
  __handlers: Record<string, (event: { x: number }) => void>;
}>;

async function renderMeasuredChart(node: unknown) {
  const screen = await renderScreen(
    <>{renderDeclarativeNode(node, context)}</>,
  );
  // The chart measures its own width before it lays out its plot; give it a phone card's width.
  const measured = screen.tree.root.findAll(
    (instance) =>
      typeof instance.type === 'string' &&
      typeof instance.props.onLayout === 'function',
  );
  act(() => {
    for (const host of measured)
      host.props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 180 } },
      });
  });
  return screen;
}

function lensRows(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const lens = screen.findByTestId('plugin-declarative-chart-lens-lens');
  expect(lens).toBeTruthy();
  const texts = lens!
    .findAll((instance) => typeof instance.type === 'string')
    .flatMap((instance) =>
      instance.children.filter(
        (child): child is string => typeof child === 'string',
      ),
    );
  const swatches = lens!
    .findAll(
      (instance) =>
        typeof instance.type === 'string' && instance.children.length === 0,
    )
    .map(
      (instance) =>
        [instance.props.style]
          .flat(Infinity)
          .find(
            (style: { backgroundColor?: string } | undefined) =>
              style?.backgroundColor,
          )?.backgroundColor,
    )
    .filter(Boolean);
  return { texts, swatches };
}

describe('agent-made declarative charts', () => {
  it('read a single-series bucket as its x label over a swatch, the series name and its value', async () => {
    const screen = await renderMeasuredChart({
      kind: 'chart',
      path: 'root',
      label: 'Signups per day',
      style: 'bar',
      rows: [],
      data: {
        kind: 'value',
        value: [
          { x: 'Tue', y: 236 },
          { x: 'Wed', y: 1183 },
        ],
      },
      x: { path: ['x'], type: 'string' },
      y: { path: ['y'], type: 'number' },
    });
    expect(screen.findAllByType(ScrubLens)).toHaveLength(1);
    expect(
      screen.findAllHostsByTestId('plugin-declarative-chart-lens-lens'),
    ).toHaveLength(0);
    act(() =>
      pressTestInstance(
        screen.findByTestId('plugin-declarative-chart-bucket-1'),
        'bucket',
      ),
    );
    const { texts, swatches } = lensRows(screen);
    expect(texts).toEqual(['Wed', 'Signups per day', '1,183']);
    expect(swatches).toHaveLength(1);
  });

  it('follows the pointer with one row per series in each series’ own colour and a known total', async () => {
    const screen = await renderMeasuredChart({
      kind: 'chart',
      path: 'root',
      label: 'Builds',
      style: 'bar',
      rows: [],
      series: { path: ['branch'], type: 'string' },
      data: {
        kind: 'value',
        value: [
          { day: 'Mon', branch: 'main', n: 4 },
          { day: 'Mon', branch: 'dev', n: 9 },
          { day: 'Tue', branch: 'main', n: 2 },
          { day: 'Tue', branch: 'dev', n: 5 },
        ],
      },
      x: { path: ['day'], type: 'string' },
      value: { path: ['n'], type: 'number' },
    });
    const detector = screen.findByType('GestureDetector' as never);
    const [hover] = (
      detector.props.gesture as { gestures: readonly [LensGesture] }
    ).gestures;
    act(() => hover.__handlers.onBegin!({ x: 10 }));
    const { texts, swatches } = lensRows(screen);
    expect(texts).toEqual(['Mon', '13', 'main', '4', 'dev', '9']);
    expect(swatches).toHaveLength(2);
    expect(new Set(swatches).size).toBe(2);
    act(() => hover.__handlers.onFinalize!({ x: 10 }));
    expect(
      screen.findAllHostsByTestId('plugin-declarative-chart-lens-lens'),
    ).toHaveLength(0);
  });
});
