/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// The browser boundaries, as a reduced-motion browser presents them: the media query the host watch reads, a face that
// arrives after first paint (its metrics change), and the column's width and canvas metrics jsdom lacks.
const fonts = vi.hoisted(() => {
  let arrive!: () => void;
  const ready = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const state = {
    loaded: false,
    arrive: () => {
      state.loaded = true;
      arrive();
    },
  };
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { ready },
  });
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: query === '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return state;
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
  // The fallback face is narrower than the headline's own, which arrives later.
  HTMLCanvasElement.prototype.getContext = (() => ({
    font: '',
    measureText: (text: string) => ({
      width: text.length * (fonts.loaded ? 20 : 14),
    }),
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
  restore = () => {
    HTMLCanvasElement.prototype.getContext = getContext;
    Element.prototype.getBoundingClientRect = rect;
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

it('under reduced motion holds the first phrase still, and its parts jump rather than glide when the face arrives', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const headline = {
    phrases: [
      { lead: 'Talk', vary: 'it through.' },
      { lead: 'Run', vary: 'Codex.' },
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
  const part = (id: string) =>
    host!.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  const placedAt = () => part('welcome-headline-vary').style.transform;
  const before = placedAt();
  await act(async () => {
    fonts.arrive();
    await Promise.resolve();
  });
  // The words moved to their places in the arrived face, in one step: nothing on the line is in transit.
  expect(placedAt()).not.toBe(before);
  for (const id of ['welcome-headline-lead', 'welcome-headline-vary']) {
    expect(['', '0s', 'none']).toContain(
      part(id).style.transitionDuration || part(id).style.transition,
    );
  }
  await wait(WELCOME_HEADLINE_SWAP_INTERVAL_MS * 2);
  expect(
    `${part('welcome-headline-lead').textContent} ${part('welcome-headline-vary').textContent}`,
  ).toBe('Talk it through.');
});
