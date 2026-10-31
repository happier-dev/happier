import { act } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierUiTypographyProvider } from '../../environment/context.js';
import type { HappierUiTypography } from '../../environment/types.js';
import { HAPPIER_TYPE_SCALE, type HappierTypeRole } from '../text/typeScale.js';
import {
  HappierSegmentedChoiceRow,
  resolveHappierSegmentedChoiceRow,
} from './SegmentedChoiceRow.js';

const COLORS = {
  track: 'rgb(1, 1, 1)',
  thumb: 'rgb(2, 2, 2)',
  label: 'rgb(3, 3, 3)',
  activeLabel: 'rgb(4, 4, 4)',
  focusRing: 'rgb(5, 5, 5)',
  rowLabel: 'rgb(6, 6, 6)',
  rowDetail: 'rgb(7, 7, 7)',
} as const;
const WIDTHS = [
  {
    id: 'half',
    label: 'Half',
    unavailableReason: 'Daily usage needs the full width',
  },
  { id: 'full', label: 'Full' },
] as const;

describe('segmented choice row', () => {
  it('announces the option label with its unavailable reason through React Native Web', () => {
    const view = mountThroughReactNativeWeb(
      <HappierSegmentedChoiceRow
        testID="view"
        label="View"
        options={[
          { id: 'table', label: 'Detailed table', unavailableReason: 'Needs a wider view' },
          { id: 'map', label: 'Map', unavailableReason: 'Choose a project first' },
        ]}
        value="table"
        onChange={() => undefined}
        colors={COLORS}
      />,
    );
    expect(view.container.querySelector('[data-testid="view:table"]')?.getAttribute('aria-label'))
      .toBe('Detailed table, Needs a wider view');
    expect(view.container.querySelector('[data-testid="view.detail"]')?.textContent)
      .toBe('Detailed table: Needs a wider view Map: Choose a project first');
    view.unmount();
  });
  it('keeps an unavailable option visible and says why, in its name and under the label', () => {
    const model = resolveHappierSegmentedChoiceRow({
      options: WIDTHS,
      value: 'full',
    });
    expect(model.segments).toMatchObject([
      {
        id: 'half',
        selected: false,
        disabled: true,
        accessibilityLabel: 'Half, Daily usage needs the full width',
      },
      {
        id: 'full',
        selected: true,
        disabled: false,
        accessibilityLabel: 'Full',
      },
    ]);
    expect(model.detail).toBe('Daily usage needs the full width');
  });

  it('retains both the whole-row explanation and a single option reason while disabled', () => {
    const view = mountThroughReactNativeWeb(
      <HappierSegmentedChoiceRow testID="width" label="Width" options={WIDTHS} value="full"
        description="Turn on the widget to choose" disabled onChange={() => {}} colors={COLORS} />,
    );
    expect(view.container.querySelector('[data-testid="width.detail"]')?.textContent)
      .toBe('Turn on the widget to choose Daily usage needs the full width');
    expect(view.container.querySelector('[data-testid="width:half"]')?.getAttribute('aria-disabled')).toBe('true');
    view.unmount();
  });

  it('shows the chosen option’s meaning before any reason, and no line when there is nothing to say', () => {
    expect(
      resolveHappierSegmentedChoiceRow({
        options: [
          { id: 'card', label: 'Card', description: 'Its own surface' },
          {
            id: 'plain',
            label: 'Plain',
            unavailableReason: 'Not on this page',
          },
        ],
        value: 'card',
        description: 'How it is framed',
      }).detail,
    ).toBe('Its own surface Not on this page');
    expect(
      resolveHappierSegmentedChoiceRow({
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        value: 'a',
      }).detail,
    ).toBeUndefined();
  });

  it('attaches each reason to its option only when several options are unavailable for different reasons', () => {
    const model = resolveHappierSegmentedChoiceRow({
      options: [
        { id: 'invite', label: 'By invitation' },
        { id: 'directory', label: 'From the directory', unavailableReason: 'Add a directory first.' },
        { id: 'jit', label: 'At first sign-in', unavailableReason: 'Add a sign-in connection first.' },
      ],
      value: 'invite',
      description: 'Only when someone invites them.',
    });
    expect(model.unavailableReasons).toEqual([
      'From the directory: Add a directory first.',
      'At first sign-in: Add a sign-in connection first.',
    ]);
    expect(model.segments[1]?.accessibilityLabel).toBe('From the directory, Add a directory first.');
    // Options that share one reason are named together, and a lone reason stays as it was said.
    expect(resolveHappierSegmentedChoiceRow({
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B', unavailableReason: 'Not here.' },
        { id: 'c', label: 'C', unavailableReason: 'Not here.' },
      ],
      value: 'a',
    }).unavailableReasons).toEqual(['Not here.']);
  });

  it('changes the value from an available segment only', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierSegmentedChoiceRow
        testID="width"
        label="Width"
        options={[...WIDTHS, { id: 'compact', label: 'Compact' }]}
        value="full"
        onChange={onChange}
        colors={COLORS}
      />,
    );
    onTestFinished(() => view.unmount());
    const segment = (id: string) =>
      view.container.querySelector<HTMLElement>(`[data-testid="width:${id}"]`)!;
    expect(
      view.container.querySelector('[data-testid="width.detail"]')?.textContent,
    ).toBe('Daily usage needs the full width');
    expect(segment('half').getAttribute('aria-disabled')).toBe('true');
    act(() => {
      segment('half').click();
    });
    act(() => {
      segment('full').click();
    });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { segment('compact').click(); });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('compact');
  });
  it('draws the chosen label in the host semibold face, never a numeric weight over the regular face', () => {
    // A same-realm host whose faces encode their weight (Inter registered at normal weight): a
    // numeric 600 over the regular family makes the browser synthesize bold.
    const roles = Object.fromEntries(
      (Object.keys(HAPPIER_TYPE_SCALE) as HappierTypeRole[]).map((role) => [role, { fontSize: HAPPIER_TYPE_SCALE[role].fontSize, lineHeight: HAPPIER_TYPE_SCALE[role].lineHeight }]),
    ) as Record<HappierTypeRole, { fontSize: number; lineHeight: number }>;
    const typography: HappierUiTypography = {
      ...roles,
      weights: {
        regular: { fontFamily: 'Face-Regular' },
        medium: { fontFamily: 'Face-Medium' },
        semiBold: { fontFamily: 'Face-SemiBold' },
        bold: { fontFamily: 'Face-SemiBold' },
      },
    };
    const view = mountThroughReactNativeWeb(
      <HappierUiTypographyProvider typography={typography}>
        <HappierSegmentedChoiceRow testID="width" label="Width" options={WIDTHS} value="full" onChange={() => undefined} colors={COLORS} />
      </HappierUiTypographyProvider>,
    );
    onTestFinished(() => view.unmount());
    const label = (id: string) => [...view.container.querySelectorAll<HTMLElement>(`[data-testid="width:${id}"] *`)]
      .find((node) => node.textContent === (id === 'full' ? 'Full' : 'Half') && node.children.length === 0)!;
    expect(label('full').style.fontFamily).toBe('Face-SemiBold');
    expect(label('full').style.fontWeight).toBe('');
    expect(label('half').style.fontFamily).toBe('Face-Regular');
    expect(label('full').style.fontSize).toBe(`${HAPPIER_TYPE_SCALE.body.fontSize}px`);
  });
});
