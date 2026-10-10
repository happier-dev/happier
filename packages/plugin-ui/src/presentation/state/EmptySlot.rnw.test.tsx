import { Text } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierEmptySlot } from './EmptySlot.js';
import { HAPPIER_EMPTY_STATE_FRAME } from './InfoState.js';

function byId(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('HappierEmptySlot', () => {
  it('draws the one dashed add frame in the host border ink and grows with the room it is given', () => {
    const { container } = mountThroughReactNativeWeb(
      <HappierEmptySlot testID="slot" colors={{ border: 'rgb(1, 2, 3)' }} label={<Text>Drop a widget here</Text>} />,
    );
    const slot = byId(container, 'slot')!;
    expect(slot.style.borderStyle).toBe('dashed');
    expect(slot.style.borderRadius).toBe(`${HAPPIER_EMPTY_STATE_FRAME.add.borderRadius}px`);
    expect(slot.style.borderColor).toBe('rgb(1, 2, 3)');
    expect(slot.style.flexGrow).toBe('1');
    expect(slot.getAttribute('role')).not.toBe('button');
  });

  it('is a single button when the whole slot is the control, and stays one place marker otherwise', () => {
    let pressed = 0;
    const { container } = mountThroughReactNativeWeb(
      <HappierEmptySlot testID="slot" colors={{ border: 'rgb(1, 2, 3)' }} label={<Text>Add widget</Text>}
        accessibilityLabel="Add a widget to Project" onPress={() => { pressed += 1; }} />,
    );
    const slot = byId(container, 'slot')!;
    expect(slot.getAttribute('role')).toBe('button');
    expect(slot.getAttribute('aria-label')).toBe('Add a widget to Project');
    slot.click();
    expect(pressed).toBe(1);
  });
});
