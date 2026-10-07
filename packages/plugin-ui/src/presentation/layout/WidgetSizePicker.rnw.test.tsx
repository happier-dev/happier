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
});
