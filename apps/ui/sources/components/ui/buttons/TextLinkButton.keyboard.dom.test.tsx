// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The in-app text size is device-local storage, outside the link owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

// A sentence's recovery link (the Work total's Retry, J-B46) is a real button: Tab reaches it, and Enter and Space
// each press it exactly once, through the browser's own keyboard path.
it.each(['Enter', ' '])('presses once with %j from the keyboard', async (key) => {
  const { TextLinkButton } = await import('./TextLinkButton');
  const onPress = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<TextLinkButton testID="retry" label="Retry" accessibilityLabel="Retry: 1 session couldn't be read" onPress={onPress} />); });
  const link = host.querySelector<HTMLElement>('[data-testid="retry"]')!;
  expect(link.getAttribute('role')).toBe('button');
  expect(link.tabIndex).toBe(0);
  expect(link.getAttribute('aria-label')).toBe("Retry: 1 session couldn't be read");
  await act(async () => {
    link.focus();
    const code = key === ' ' ? 'Space' : 'Enter';
    link.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    link.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true }));
    // A browser turns a button's Enter and Space into the click jsdom does not synthesize (as DisclosureToggle.rnw).
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  expect(document.activeElement).toBe(link);
  expect(onPress).toHaveBeenCalledTimes(1);
});
