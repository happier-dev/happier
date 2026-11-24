import { act, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { HappierDataChart } from './Chart.js';
import { HappierDataRows, HappierDataTable } from './DataRows.js';
import { HappierDataMetric } from './Metric.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';

/**
 * jsdom has no layout engine, so this measures the declared block geometry the host would lay out: each element's
 * explicit or minimum height, its padding, borders and margins, the gaps between its children, a column summing its
 * children and a row taking its tallest, and a text leaf taking its line box. Both states are measured with the same
 * yardstick, so a loading reserve that is not the arriving body's shape fails here; the live browser pass measures
 * the real boxes.
 */
const px = (value: string) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
/** jsdom resolves some inline properties (line-height) only on the element's own style, never in its computed style. */
function styleOf(element: HTMLElement): Readonly<Record<string, string>> {
  const computed = getComputedStyle(element);
  return new Proxy({}, { get: (_, key: string) => (element.style as unknown as Record<string, string>)[key]
    || (computed as unknown as Record<string, string>)[key] || '' });
}
function outerHeight(element: HTMLElement): number {
  const style = styleOf(element);
  if (style.display === 'none' || style.position === 'absolute') return 0;
  return blockHeight(element) + px(style.marginTop) + px(style.marginBottom);
}
function blockHeight(element: HTMLElement): number {
  const style = styleOf(element);
  if (style.height.endsWith('px')) return px(style.height);
  const children = [...element.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement,
  );
  const isText =
    element.tagName === 'SPAN' || element.getAttribute('dir') === 'auto';
  const frame =
    px(style.paddingTop) +
    px(style.paddingBottom) +
    px(style.borderTopWidth) +
    px(style.borderBottomWidth);
  let content: number;
  if (isText) content = px(style.lineHeight);
  else {
    const flowing = children.filter((child) => {
      const childStyle = styleOf(child);
      return (
        childStyle.display !== 'none' && childStyle.position !== 'absolute'
      );
    });
    const heights = flowing.map(outerHeight);
    content =
      style.flexDirection === 'row'
        ? Math.max(0, ...heights)
        : heights.reduce((sum, height) => sum + height, 0) +
          px(style.rowGap || style.gap) * Math.max(0, flowing.length - 1);
  }
  return Math.max(px(style.minHeight), content + frame);
}

function measure(element: ReactElement, testID: string, width = 320): number {
  const mount = mountThroughReactNativeWeb(element);
  try {
    // Charts and tables lay out their columns from their measured width, as on screen.
    for (const node of mount.container.querySelectorAll('*')) {
      const handler = (
        node as unknown as {
          __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void;
        }
      ).__reactLayoutHandler;
      if (handler)
        act(() =>
          handler({
            nativeEvent: { layout: { x: 0, y: 0, width, height: 120 } },
          }),
        );
    }
    const root = mount.container.querySelector<HTMLElement>(
      `[data-testid="${testID}"]`,
    );
    expect(root, `${testID} renders`).not.toBeNull();
    return outerHeight(root!);
  } finally {
    mount.unmount();
  }
}

const { theme } = createSurfaceContext();
const funnel = [
  { label: 'Step' },
  { label: 'Detail' },
  { label: 'People', proportion: true },
] as const;
const people = [
  { label: 'Person' },
  { label: 'Plan' },
  { label: 'Joined' },
] as const;

describe('a data body keeps its own shape while its first read is in flight', () => {
  it('a figure holds its value, comparison and caption lines', () => {
    const loaded = measure(
      <HappierDataMetric
        testID="m"
        theme={theme}
        label="Signups"
        value={1284}
        unit="people"
        comparison={{ value: '+18%', label: 'vs last week', meaning: 'good' }}
      />,
      'm',
    );
    const pending = measure(
      <HappierDataMetric
        testID="m"
        theme={theme}
        label="Signups"
        value=""
        unit="people"
        pending
        comparison={{ value: '', label: 'vs last week', meaning: 'good' }}
      />,
      'm',
    );
    expect(loaded).toBeGreaterThan(0);
    expect(pending).toBe(loaded);

    const stat = measure(
      <HappierDataMetric
        testID="s"
        theme={theme}
        size="stat"
        label="Checkout"
        value="182 ms"
        caption="99.9% uptime over 30 days"
      />,
      's',
    );
    expect(
      measure(
        <HappierDataMetric
          testID="s"
          theme={theme}
          size="stat"
          label="Checkout"
          value=""
          caption=""
          pending
        />,
        's',
      ),
    ).toBe(stat);
  });

  it('rows hold each row’s title, its facts line and its proportion bar', () => {
    const rows = [
      ['Signed up', 'Web', 1284],
      ['Paired', 'Web', 812],
      ['Started a session', 'Phone', 530],
    ];
    const loaded = measure(
      <HappierDataRows
        testID="r"
        theme={theme}
        label="Funnel"
        columns={funnel}
        rows={rows}
      />,
      'r',
    );
    const pending = measure(
      <HappierDataRows
        testID="r"
        theme={theme}
        label="Funnel"
        columns={funnel}
        rows={[]}
        pendingRows={3}
      />,
      'r',
    );
    expect(loaded).toBeGreaterThan(0);
    expect(pending).toBe(loaded);
  });

  it('a table keeps its real header and holds each row’s cells', () => {
    const rows = [
      ['Ada', 'Team', '09:00'],
      ['Grace', 'Free', '10:00'],
      ['Linus', 'Team', '11:00'],
    ];
    const loaded = measure(
      <HappierDataTable
        testID="t"
        theme={theme}
        label="Newest people"
        columns={people}
        rows={rows}
      />,
      't',
    );
    const pending = measure(
      <HappierDataTable
        testID="t"
        theme={theme}
        label="Newest people"
        columns={people}
        rows={[]}
        pendingRows={3}
      />,
      't',
    );
    expect(loaded).toBeGreaterThan(0);
    expect(pending).toBe(loaded);
  });

  it('a table keeps its columns where the rows will put them', () => {
    // The trailing columns' declared widths place every header after the name column, so their sum is where
    // "Plan" starts from the card's end. A table sized from its header labels alone sat ~73 px off on screen.
    const trailingWidth = (element: ReactElement) => {
      const mount = mountThroughReactNativeWeb(element);
      try {
        return [1, 2, 3].reduce((sum, index) => {
          const cell = mount.container.querySelector<HTMLElement>(`[data-testid="t-header-${index}"]`)!.parentElement!;
          return sum + px(styleOf(cell).width);
        }, 0);
      } finally {
        mount.unmount();
      }
    };
    const columns = [{ label: 'Person' }, { label: 'Plan', priority: 'secondary' as const }, { label: 'Got to' }, { label: 'Joined' }];
    const rows = [['Mira Kovač', 'Team', 'Paired 2 machines', '10:38'], ['Jonas Weber', 'Free', 'Started a session', '10:21'],
      ['Aiko Tanaka', 'Free', 'Signed up', '10:02']];
    const loaded = trailingWidth(<HappierDataTable testID="t" theme={theme} label="Newest people" columns={columns} rows={rows} />);
    const pending = trailingWidth(<HappierDataTable testID="t" theme={theme} label="Newest people" columns={columns} rows={[]} pendingRows={3} />);
    expect(loaded).toBeGreaterThan(0);
    expect(Math.abs(pending - loaded)).toBeLessThanOrEqual(30);
  });

  it('a chart holds its plot, its axis line and its Details toggle', () => {
    const points = [
      { x: 'Mon', y: 120 },
      { x: 'Tue', y: 236 },
      { x: 'Wed', y: 183 },
    ];
    const loaded = measure(
      <HappierDataChart
        testID="c"
        theme={theme}
        label="Signups per day"
        style="bar"
        points={points}
      />,
      'c',
    );
    const pending = measure(
      <HappierDataChart
        testID="c"
        theme={theme}
        label="Signups per day"
        style="bar"
        points={[]}
        pending
      />,
      'c',
    );
    expect(loaded).toBeGreaterThan(150);
    expect(pending).toBe(loaded);
    const line = measure(
      <StackedSeriesChart
        testID="l"
        theme={theme}
        label="Signups"
        variant="line"
        size="full"
        viewportHeight={220}
        series={[
          {
            id: 'a',
            label: 'Signups',
            points: points.map((point) => ({ ...point, id: point.x })),
          },
        ]}
      />,
      'l',
    );
    expect(
      measure(
        <StackedSeriesChart
          testID="l"
          theme={theme}
          label="Signups"
          variant="line"
          size="full"
          viewportHeight={220}
          series={[]}
          pending
        />,
        'l',
      ),
    ).toBe(line);
  });
});
