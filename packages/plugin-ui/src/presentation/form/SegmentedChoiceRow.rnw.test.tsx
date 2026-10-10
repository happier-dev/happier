import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
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

  it('changes the value from an available segment only', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierSegmentedChoiceRow
        testID="width"
        label="Width"
        options={WIDTHS}
        value="full"
        onChange={onChange}
        colors={COLORS}
      />,
    );
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
  });
});
