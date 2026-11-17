import { act } from 'react';
import { describe, expect, it } from 'vitest';

import { HappierCollectionRowContent } from './CollectionRowContent.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';

const FILLS = Object.freeze({ selected: '#e0e0e0', hover: '#f0f0f0' });

function row(engaged: boolean) {
  return (
    <HappierCollectionRowContent
      density="compact"
      fills={FILLS}
      hovered={engaged}
      title={
        <span data-testid="title">A long Session title that truncates</span>
      }
      trailingProps={{ testID: 'trailing' }}
      trailing={<span data-testid="status">●</span>}
      engagedTrailing={
        engaged
          ? {
              actionCount: 2,
              node: (
                <>
                  <button data-testid="pin">pin</button>
                  <button data-testid="more">more</button>
                </>
              ),
            }
          : null
      }
      renderContainer={(content, style) => (
        <div data-testid="press" style={style as never}>
          {content}
        </div>
      )}
    />
  );
}

describe('HappierCollectionRowContent engaged trailing (owner 2026-11-11)', () => {
  it('swaps the status for the row actions at the far end, keeping the status box so the title never reflows', async () => {
    const view = mountThroughReactNativeWeb(row(false));
    try {
      const q = (id: string) =>
        view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      const resting = () => q('status')!.parentElement!;
      expect(q('pin')).toBeNull();
      const restingSlotWidth = q('trailing')!.style.cssText;
      expect(getComputedStyle(resting()).opacity).not.toBe('0');

      await view.render(row(true));
      // Engaged: the actions are there, inside the trailing slot, pinned to its far end.
      expect(q('trailing')!.contains(q('pin'))).toBe(true);
      // The status is still laid out (same slot, same box) but hidden and out of the accessibility tree.
      expect(q('status')).not.toBeNull();
      expect(getComputedStyle(resting()).opacity).toBe('0');
      expect(resting().getAttribute('aria-hidden')).toBe('true');
      expect(q('trailing')!.style.cssText).toBe(restingSlotWidth);

      await view.render(row(false));
      expect(q('pin')).toBeNull();
      expect(getComputedStyle(resting()).opacity).not.toBe('0');
    } finally {
      view.unmount();
    }
  });
});

// DESIGN-ACCEPT-1116-D: a Session row's status holds a control of its own (the request peek). Tab reaches it, the
// row engages because keyboard focus is inside it, and the status used to fade out and leave the accessibility tree
// around the control that holds focus: an invisible, hidden focus stop. While focus is in the status it stays.
describe('HappierCollectionRowContent resting trailing that holds focus', () => {
  function focusRow(engaged: boolean) {
    return (
      <HappierCollectionRowContent
        density="compact"
        fills={FILLS}
        hovered={engaged}
        title={<span data-testid="title">Fix settings modal remount</span>}
        trailingProps={{ testID: 'trailing' }}
        trailing={<button data-testid="peek" aria-label="Review request">!</button>}
        engagedTrailing={engaged ? { actionCount: 1, node: <button data-testid="more">more</button> } : null}
      />
    );
  }

  it('keeps the status shown and in the accessibility tree while its own control holds focus', async () => {
    const view = mountThroughReactNativeWeb(focusRow(false));
    try {
      const q = (id: string) => view.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      const peek = q('peek')!;
      const resting = () => q('peek')!.parentElement!;
      await act(async () => {
        peek.focus();
      });
      // The consumer engages the row because keyboard focus is inside it.
      await view.render(focusRow(true));
      expect(document.activeElement).toBe(peek);
      expect(getComputedStyle(resting()).opacity).not.toBe('0');
      expect(resting().getAttribute('aria-hidden')).toBeNull();

      await act(async () => {
        peek.blur();
      });
      await view.render(focusRow(true));
      expect(getComputedStyle(resting()).opacity).toBe('0');
      expect(q('more')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
