/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real RNW hosts and the real headline leaf; only native styling and translations cross the test boundary. Text layout
// is a browser boundary jsdom does not have: the column's width and the canvas's text metrics are supplied below.
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

import { FirstOpenWelcomeEpoch } from '@/components/onboarding/firstOpen/FirstOpenWelcomeModelContext';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';

import { WelcomeHeadline } from './WelcomeHeadline.web';
import { WELCOME_HEADLINE_SWAP_INTERVAL_MS } from './welcomeHeadlineMotion';
import type { WelcomeHeadline as WelcomeHeadlineModel } from './welcomeHeadlineModel';

const HEADLINE: WelcomeHeadlineModel = {
  phrases: [
    { lead: 'Run', vary: 'Codex.' },
    { lead: 'Review', vary: 'every diff.' },
    { lead: 'Run', vary: 'Claude.' },
  ],
  joiner: ' ',
  line2: 'Everywhere you go.',
};
const SETTLED_MS = WELCOME_HEADLINE_SWAP_INTERVAL_MS + 1_000;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreLayout: (() => void) | null = null;

function shownPhrase(): string {
  const lead =
    host!.querySelector('[data-testid="welcome-headline-lead"]')?.textContent ??
    '';
  const vary =
    host!.querySelector('[data-testid="welcome-headline-vary"]')?.textContent ??
    '';
  return `${lead} ${vary}`.trim();
}

async function mount(element: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(element);
  });
}

/** Time passing in frame-sized steps, so each committed swap's frames run as they would on screen. */
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
  restoreLayout = () => {
    HTMLCanvasElement.prototype.getContext = getContext;
    Element.prototype.getBoundingClientRect = rect;
  };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  restoreLayout?.();
  setReducedMotionPreferenceOverride(null);
  vi.useRealTimers();
});

describe('the first Welcome headline', () => {
  it("moves to the visit's next phrase on the live Welcome, its letters settling on the new words", async () => {
    await mount(
      <WelcomeHeadline
        headline={HEADLINE}
        interactive
        lineStyle={null}
        line2Style={null}
      />,
    );
    expect(shownPhrase()).toBe('Run Codex.');
    await wait(SETTLED_MS);
    expect(shownPhrase()).toBe('Review every diff.');
    await wait(WELCOME_HEADLINE_SWAP_INTERVAL_MS);
    expect(shownPhrase()).toBe('Run Claude.');
    // The second line never changes.
    expect(
      host!.querySelector('[data-testid="welcome-headline-line2"]')
        ?.textContent,
    ).toBe('Everywhere you go.');
  });

  it("stays on the first phrase in the opening's replica", async () => {
    await mount(
      <WelcomeHeadline
        headline={HEADLINE}
        interactive={false}
        lineStyle={null}
        line2Style={null}
      />,
    );
    await wait(SETTLED_MS * 2);
    expect(shownPhrase()).toBe('Run Codex.');
  });

  it('starts rotating only once the opening has handed the window to the Welcome', async () => {
    const live = (epoch: number | null) => (
      <FirstOpenWelcomeEpoch.Provider value={epoch}>
        <WelcomeHeadline
          headline={HEADLINE}
          interactive
          lineStyle={null}
          line2Style={null}
        />
      </FirstOpenWelcomeEpoch.Provider>
    );
    await mount(live(1234));
    await wait(SETTLED_MS * 2);
    // At the hand-off the live Welcome still shows what the replica shows.
    expect(shownPhrase()).toBe('Run Codex.');
    await act(async () => {
      root!.render(live(null));
    });
    await wait(SETTLED_MS);
    expect(shownPhrase()).toBe('Review every diff.');
  });

  it('shows the first phrase, still, under reduced motion', async () => {
    setReducedMotionPreferenceOverride(true);
    await mount(
      <WelcomeHeadline
        headline={HEADLINE}
        interactive
        lineStyle={null}
        line2Style={null}
      />,
    );
    await wait(SETTLED_MS * 2);
    expect(shownPhrase()).toBe('Run Codex.');
  });

  it('pauses while the page is hidden and goes on when it is shown again', async () => {
    await mount(
      <WelcomeHeadline
        headline={HEADLINE}
        interactive
        lineStyle={null}
        line2Style={null}
      />,
    );
    const visibility = Object.getOwnPropertyDescriptor(
      Document.prototype,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(SETTLED_MS * 2);
    expect(shownPhrase()).toBe('Run Codex.');
    if (visibility)
      Object.defineProperty(document, 'visibilityState', visibility);
    Reflect.deleteProperty(document, 'visibilityState');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await wait(SETTLED_MS);
    expect(shownPhrase()).toBe('Review every diff.');
  });
});
