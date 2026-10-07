import { describe, expect, it } from 'vitest';

import { HAPPIER_FOCUS_RING_V1, happierFocusRingStyle, isHappierFocusVisible } from './focusVisible.js';

/**
 * The focused element as an engine reports it. WebKit (Safari, the macOS desktop webview) does not
 * focus a button on click, so a popover that moves focus into itself right after a click is a
 * script focus with no focused predecessor, and WebKit can report it as `:focus-visible` even
 * though the user only used the mouse. Chromium reports the same focus as not visible.
 */
function focusedElement(engineSaysVisible: boolean) {
  return { matches: (selector: string) => selector === ':focus-visible' && engineSaysVisible };
}

function press(kind: 'pointer' | 'keyboard', key = 'Tab') {
  if (kind === 'pointer') document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  else document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('isHappierFocusVisible', () => {
  it('shows no ring for focus that follows a pointer press, whatever the engine reports', () => {
    press('pointer');
    expect(isHappierFocusVisible(focusedElement(true))).toBe(false);
    expect(isHappierFocusVisible(focusedElement(false))).toBe(false);
  });

  it('shows the ring for keyboard focus, as the engine decides it', () => {
    press('keyboard', 'Tab');
    expect(isHappierFocusVisible(focusedElement(true))).toBe(true);
    press('pointer');
    press('keyboard', 'ArrowRight');
    expect(isHappierFocusVisible(focusedElement(true))).toBe(true);
  });

  it('does not treat a modifier alone (Cmd/Ctrl-click) as keyboard use', () => {
    press('pointer');
    press('keyboard', 'Meta');
    expect(isHappierFocusVisible(focusedElement(true))).toBe(false);
  });

  it('publishes the input type on the document root so the browser ring follows it too', () => {
    press('pointer');
    expect(document.documentElement.getAttribute('data-happier-input-modality')).toBe('pointer');
    press('keyboard', 'Tab');
    expect(document.documentElement.getAttribute('data-happier-input-modality')).toBe('keyboard');
  });
});

describe('happierFocusRingStyle', () => {
  it('draws the one ring outside the control: the focus colour, separated by a gap the page shows through', () => {
    expect(happierFocusRingStyle({ visible: true, color: '#0a84ff' })).toEqual({
      outlineStyle: 'solid',
      outlineWidth: HAPPIER_FOCUS_RING_V1.widthPx,
      outlineColor: '#0a84ff',
      outlineOffset: HAPPIER_FOCUS_RING_V1.gapPx,
    });
    expect(HAPPIER_FOCUS_RING_V1).toEqual({ widthPx: 2, gapPx: 2 });
  });

  it('paints nothing while the ring is not visible', () => {
    expect(happierFocusRingStyle({ visible: false, color: '#0a84ff' })).toBeNull();
  });

  it('draws the inset placement inside the box, with no gap, for a full-bleed row a container clips', () => {
    expect(happierFocusRingStyle({ visible: true, color: '#0a84ff', placement: 'inset' })).toMatchObject({
      outlineWidth: 2,
      outlineColor: '#0a84ff',
      outlineOffset: -2,
    });
  });
});
