import { act } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { createSurfaceContext } from '../../surfaceFixture.testSupport.js';
import { HappierRadioChoiceList } from './RadioChoiceList.js';

const OPTIONS = [
  { id: 'keep', title: 'Until I delete it' },
  { id: 'stop', title: 'Stop after 1 h unused', disabled: true },
  { id: 'delete', title: 'Delete after 1 h unused' },
  { id: 'archive', title: 'Archive after 1 h unused' },
] as const;

describe('radio choice list', () => {
  it('does not change a disabled group with arrow keys, including keys sent to its previously focused choice', () => {
    const onChange = vi.fn();
    const view = mountThroughReactNativeWeb(
      <HappierRadioChoiceList
        accessibilityLabel="Keep it"
        options={OPTIONS}
        value="keep"
        onChange={onChange}
        disabled
        theme={createSurfaceContext().theme}
        testIDPrefix="keep"
      />,
    );
    onTestFinished(() => view.unmount());
    const selected = view.container.querySelector<HTMLElement>('[data-testid="keep:keep"]')!;
    act(() => {
      selected.focus();
      for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft']) {
        selected.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      selected.click();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(selected.getAttribute('aria-checked')).toBe('true');
  });

  it('keeps disabled choices announced without leaving an editor tab stop in a disabled group', () => {
    const view = mountThroughReactNativeWeb(
      <HappierRadioChoiceList
        accessibilityLabel="Keep it"
        options={OPTIONS}
        value="keep"
        onChange={() => {}}
        disabled
        theme={createSurfaceContext().theme}
        testIDPrefix="keep"
      />,
    );
    onTestFinished(() => view.unmount());
    const choices = Array.from(view.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(choices).toHaveLength(OPTIONS.length);
    for (const choice of choices) {
      expect(choice.getAttribute('aria-disabled')).toBe('true');
      expect(choice.tabIndex).toBe(-1);
    }
  });

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
    onTestFinished(() => view.unmount());
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
    onTestFinished(() => view.unmount());
    const option = (id: string) => view.container.querySelector<HTMLElement>(`[data-testid="keep:${id}"]`)!;
    act(() => { option('keep').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('delete');
    expect(document.activeElement).toBe(option('delete'));
    act(() => { option('keep').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('archive');
    expect(document.activeElement).toBe(option('archive'));
    act(() => { option('archive').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith('keep');
    expect(document.activeElement).toBe(option('keep'));
  });
});
