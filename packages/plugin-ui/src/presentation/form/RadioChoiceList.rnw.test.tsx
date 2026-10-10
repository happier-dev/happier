import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierRadioChoiceList } from './RadioChoiceList.js';

const OPTIONS = [
  { id: 'keep', title: 'Until I delete it' },
  { id: 'stop', title: 'Stop after 1 h unused', disabled: true },
  { id: 'delete', title: 'Delete after 1 h unused' },
] as const;

describe('radio choice list', () => {
  it('is one radio group: the chosen option is checked and holds the only tab stop, and pressing chooses', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierRadioChoiceList
        accessibilityLabel="Keep it"
        options={OPTIONS}
        value="keep"
        onChange={onChange}
        theme={createSurfaceContext().theme}
        testIDPrefix="keep"
      />,
    );
    const option = (id: string) => view.container.querySelector<HTMLElement>(`[data-testid="keep:${id}"]`)!;
    expect(view.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Keep it');
    expect(option('keep').getAttribute('aria-checked')).toBe('true');
    expect(option('delete').getAttribute('aria-checked')).toBe('false');
    expect(option('keep').tabIndex).toBe(0);
    expect(option('delete').tabIndex).toBe(-1);
    act(() => { option('delete').click(); });
    expect(onChange).toHaveBeenCalledWith('delete');
    onChange.mockClear();
    // An unavailable option stays visible and cannot be chosen.
    act(() => { option('stop').click(); });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves the choice with the arrow keys, past an unavailable option and around the ends', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierRadioChoiceList
        accessibilityLabel="Keep it"
        options={OPTIONS}
        value="keep"
        onChange={onChange}
        theme={createSurfaceContext().theme}
        testIDPrefix="keep"
      />,
    );
    const option = (id: string) => view.container.querySelector<HTMLElement>(`[data-testid="keep:${id}"]`)!;
    act(() => { option('keep').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('delete');
    act(() => { option('keep').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('delete');
  });
});
