import { act } from 'react';
import { expect, it, vi } from 'vitest';

import { HappierThreadMessage } from './ThreadMessage.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

const SPACE = { s2: 2, s8: 8, s10: 10, s12: 12, s16: 16 };
const SELECTION = { background: 'transparent', foreground: 'black' };

it('passes a pointer move inside the frame to its host, so actions hidden on a scroll-time enter reveal on the first real move', () => {
  // A host ignores the pointerenter that content scrolling under a resting pointer fires and reveals the row's
  // actions on the first real move; a frame that drops moves leaves them hidden until the pointer leaves the row
  // (EDITOR219-03: a hover after a scroll left the message menu unrevealed, so the row took the click).
  const enter = vi.fn();
  const move = vi.fn();
  const mounted = mountThroughReactNativeWeb(
    <HappierThreadMessage testID="message" startsGroup space={SPACE} selectionColors={SELECTION}
      onPointerEnter={enter} onPointerMove={move} onPointerLeave={vi.fn()} trailing={null} />,
  );
  try {
    const frame = mounted.container.querySelector<HTMLElement>('[data-testid="message"]')!;
    act(() => { frame.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })); });
    expect(move).toHaveBeenCalledOnce();
  } finally {
    mounted.unmount();
  }
});
