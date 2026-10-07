import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { WidgetSizePicker } from './WidgetSizePicker.js';

describe('WidgetSizePicker', () => {
  it('keeps the supplied policy order for pointer and keyboard selection and announces the selected choice', async () => {
    const selected: string[] = [];
    const view = mountThroughReactNativeWeb(<WidgetSizePicker
      accessibilityLabel="Widget size" value="medium" testID="size"
      choices={[
        { key: 'small', label: 'Small', footprint: { columnSpan: 1, columns: 2, rowSpan: 1 } },
        { key: 'medium', label: 'Medium', footprint: { columnSpan: 1, columns: 2, rowSpan: 2 } },
        { key: 'large', label: 'Large', footprint: { columnSpan: 2, columns: 2, rowSpan: 4 } },
      ]}
      colors={{ track: 'gray', thumb: 'white', label: 'black', activeLabel: 'black', focusRing: 'blue' }}
      onChange={value => selected.push(value)}
    />);
    const radios = Array.from(view.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map(radio => radio.getAttribute('aria-label'))).toEqual(['Small', 'Medium', 'Large']);
    expect(radios[1]!.getAttribute('aria-checked')).toBe('true');
    await act(async () => { radios[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    expect(selected).toEqual(['large']);
    await act(async () => { radios[0]!.click(); });
    expect(selected).toEqual(['large', 'small']);
    view.unmount();
  });

  it('never wraps: one track while it fits, the host’s compact picker when the room is narrower', async () => {
    const compact: string[] = [];
    const choices = ['small', 'medium', 'wide', 'full', 'tall', 'large'].map((key, index) => ({
      key, label: key[0]!.toUpperCase() + key.slice(1), footprint: { columnSpan: index % 2 + 1, columns: 2, rowSpan: index < 4 ? 1 : 4 },
    }));
    const view = mountThroughReactNativeWeb(<WidgetSizePicker
      accessibilityLabel="Widget size" value="medium" testID="size" choices={choices}
      colors={{ track: 'gray', thumb: 'white', label: 'black', activeLabel: 'black', focusRing: 'blue' }}
      renderCompact={(input) => { compact.push(`${input.value}:${input.choices.length}`); return <span data-testid="size.compact" />; }}
      onChange={() => {}}
    />);
    const layout = (testID: string, width: number) => {
      const node = view.container.querySelector(`[data-testid="${testID}"]`) as unknown as
        { __reactLayoutHandler: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void };
      act(() => node.__reactLayoutHandler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 34 } } }));
    };
    const track = () => view.container.querySelector<HTMLElement>('[data-testid="size"][role="radiogroup"]');
    expect(track()?.style.flexWrap).not.toBe('wrap');
    layout('size.track', 520);
    layout('size.room', 600);
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(6);
    expect(view.container.querySelector('[data-testid="size.compact"]')).toBeNull();
    layout('size.room', 300);
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(view.container.querySelector('[data-testid="size.compact"]')).not.toBeNull();
    expect(compact.at(-1)).toBe('medium:6');
    layout('size.room', 600);
    expect(view.container.querySelectorAll('[role="radio"]')).toHaveLength(6);
    view.unmount();
  });
});
