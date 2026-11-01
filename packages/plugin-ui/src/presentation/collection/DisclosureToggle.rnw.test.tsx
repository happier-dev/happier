import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierDisclosureToggle } from './DisclosureToggle.js';

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HappierDisclosureToggle
        testID="output-toggle"
        label="Review output"
        open={open}
        onPress={() => setOpen((value) => !value)}
        caret={<i data-testid="caret" data-expanded={String(open)} />}
        renderLabel={(label) => <span data-testid="label">{label}</span>}
        focusColor="rgb(1, 2, 3)"
      />
      {open ? (
        <span data-testid="body">npm ERR! missing script: dev</span>
      ) : null}
    </>
  );
}

describe('HappierDisclosureToggle', () => {
  it('is one button named by its label that reports and flips its open state, by pointer and by keyboard', async () => {
    const mount = mountThroughReactNativeWeb(<Harness />);
    const body = () => mount.container.querySelector('[data-testid="body"]');
    try {
      const toggle = mount.container.querySelector<HTMLElement>(
        '[data-testid="output-toggle"]',
      )!;
      expect(toggle.getAttribute('role')).toBe('button');
      expect(toggle.getAttribute('aria-label')).toBe('Review output');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      // The caret and the label are drawn by the toggle itself, caret first.
      const caret = toggle.querySelector('[data-testid="caret"]');
      const label = toggle.querySelector('[data-testid="label"]');
      expect(caret).not.toBeNull();
      expect(label?.textContent).toBe('Review output');
      expect(
        caret!.compareDocumentPosition(label!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(body()).toBeNull();

      await act(async () => {
        toggle.click();
      });
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(
        toggle
          .querySelector('[data-testid="caret"]')
          ?.getAttribute('data-expanded'),
      ).toBe('true');
      expect(body()).not.toBeNull();

      // A keyboard reaches it and Enter activates it (a browser turns a native button's Enter into the click
      // jsdom does not synthesize).
      await act(async () => {
        toggle.focus();
      });
      expect(document.activeElement).toBe(toggle);
      await act(async () => {
        toggle.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
        toggle.dispatchEvent(
          new KeyboardEvent('keyup', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }),
        );
        toggle.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
      });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(body()).toBeNull();
    } finally {
      mount.unmount();
    }
  });
});
