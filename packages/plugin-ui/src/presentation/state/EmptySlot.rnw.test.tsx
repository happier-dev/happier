import { Text } from 'react-native';
import { describe, expect, it, onTestFinished } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierEmptySlot } from './EmptySlot.js';
import { HAPPIER_EMPTY_STATE_FRAME } from './InfoState.js';

function byId(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('HappierEmptySlot', () => {
  it('draws the one dashed add frame in the host border ink and grows with the room it is given', () => {
    const view = mountThroughReactNativeWeb(
      <HappierEmptySlot testID="slot" colors={{ border: 'rgb(1, 2, 3)' }} label={<Text>Drop a widget here</Text>} />,
    );
    onTestFinished(() => view.unmount());
    const slot = byId(view.container, 'slot')!;
    const style = getComputedStyle(slot);
    // RNW expands border shorthands; jsdom retains base shorthand values separately.
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      expect(style[`border${side}Style`]).toBe('dashed');
      expect(style[`border${side}Color`]).toBe('rgb(1, 2, 3)');
    }
    for (const corner of ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const) {
      expect(style[`border${corner}Radius`]).toBe(`${HAPPIER_EMPTY_STATE_FRAME.add.borderRadius}px`);
    }
    expect(style.flexGrow).toBe('1');
    expect(slot.getAttribute('role')).not.toBe('button');
  });

  it('is a single button when the whole slot is the control, and stays one place marker otherwise', () => {
    let pressed = 0;
    const view = mountThroughReactNativeWeb(
      <HappierEmptySlot testID="slot" colors={{ border: 'rgb(1, 2, 3)' }} label={<Text>Add widget</Text>}
        accessibilityLabel="Add a widget to Project" onPress={() => { pressed += 1; }} />,
    );
    onTestFinished(() => view.unmount());
    const slot = byId(view.container, 'slot')!;
    expect(slot.getAttribute('role')).toBe('button');
    expect(slot.getAttribute('aria-label')).toBe('Add a widget to Project');
    slot.click();
    expect(pressed).toBe(1);
  });
});
