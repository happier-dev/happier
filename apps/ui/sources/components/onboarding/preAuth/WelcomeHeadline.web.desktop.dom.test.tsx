/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The desktop shell is the boundary here: its window bridge answers as macOS does for a main window it revealed while
// the app was still activating (ordered on screen without becoming key). The document is visible; native focus says no
// and never changes until the person clicks. Text layout is the other browser boundary jsdom lacks.
const desktop = vi.hoisted(() => ({ calls: [] as string[] }));
vi.hoisted(() => {
  let callback = 0;
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
    },
    transformCallback: () => ++callback,
    invoke: async (command: string) => {
      desktop.calls.push(command);
      if (command === 'plugin:window|is_focused') return false;
      if (command.startsWith('plugin:event|')) return 1;
      return null;
    },
  };
  (
    window as unknown as Record<string, unknown>
  ).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
});
vi.mock('react-native', async () =>
  vi.importActual<typeof import('react-native-web')>('react-native-web'),
);
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key: string) => key });
});

import { WelcomeHeadline } from './WelcomeHeadline.web';
import { WELCOME_HEADLINE_SWAP_INTERVAL_MS } from './welcomeHeadlineMotion';

let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void) | null = null;

async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 50) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(50, left));
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
    ],
  });
  const getContext = HTMLCanvasElement.prototype.getContext;
  const rect = Element.prototype.getBoundingClientRect;
  const hasFocus = Document.prototype.hasFocus;
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: '',
    measureText: (text: string) => ({ width: text.length * 20 }),
  })) as never;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 520,
      bottom: 44,
      width: 520,
      height: 44,
      toJSON() {},
    } as DOMRect;
  };
  Document.prototype.hasFocus = () => false;
  restore = () => {
    HTMLCanvasElement.prototype.getContext = getContext;
    Element.prototype.getBoundingClientRect = rect;
    Document.prototype.hasFocus = hasFocus;
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  restore?.();
  vi.useRealTimers();
});

it('rotates in a desktop window that is on screen and in front although the shell never made it the key window', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const headline = {
    phrases: [
      { lead: 'Review', vary: 'every diff.' },
      { lead: 'Run', vary: 'Codex.' },
      { lead: 'Open', vary: 'a terminal.' },
    ],
    joiner: ' ',
    line2: 'Everywhere you go.',
  };
  await act(async () => {
    root!.render(
      <WelcomeHeadline
        headline={headline}
        interactive
        lineStyle={null}
        line2Style={null}
      />,
    );
  });
  const shown = () =>
    `${host!.querySelector('[data-testid="welcome-headline-lead"]')?.textContent} ${host!.querySelector('[data-testid="welcome-headline-vary"]')?.textContent}`;
  expect(shown()).toBe('Review every diff.');
  await wait(WELCOME_HEADLINE_SWAP_INTERVAL_MS + 1_000);
  // The shell was asked and said the window is not focused: the desktop condition holds.
  expect(desktop.calls).toContain('plugin:window|is_focused');
  expect(shown()).toBe('Run Codex.');
});
