/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '../modalComponentTestHelpers';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(document.documentElement, 'clientWidth', {
  configurable: true,
  value: 1440,
});
Object.defineProperty(document.documentElement, 'clientHeight', {
  configurable: true,
  value: 900,
});
installModalComponentCommonModuleMocks({
  reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } =
      getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>(
        'node:module',
      );
    // The real react-native-web View decides which props reach the DOM: that is the boundary under test.
    return await vi.importActual(
      createRequire(import.meta.url).resolve('react-native-web'),
    );
  },
});

// Layout is the browser boundary: react-native-web reports onLayout from a ResizeObserver and offset sizes.
const observerCallbacks: ResizeObserverCallback[] = [];
const observed = new Set<Element>();
vi.stubGlobal(
  'ResizeObserver',
  class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      observerCallbacks.push(callback);
    }
    disconnect(): void {}
    observe(target: Element): void {
      observed.add(target);
    }
    unobserve(target: Element): void {
      observed.delete(target);
    }
  },
);
const layout = { cardHeight: 760 };
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.happyModalCardBoundary === 'true'
      ? layout.cardHeight
      : 0;
  },
});

const { ModalCardFrame } = await import('./ModalCardFrame');
const { View } = await import('react-native');

it('keeps the height a person pressed in on the web, so a shorter next step does not shrink and re-centre the card', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ModalCardFrame
          scrollHost="bounded"
          screenKey="add"
          dimensions={{ maxHeightRatio: 0.9 }}
          title="Add a sandbox"
        >
          <View testID="continue" />
        </ModalCardFrame>,
      ),
    );
    const card = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-happy-modal-card-boundary="true"]',
      ),
    ].pop()!;
    const deliverLayout = async () => {
      const entries = [...observed].map(
        (target) => ({ target }) as unknown as ResizeObserverEntry,
      );
      await act(async () => {
        for (const callback of observerCallbacks)
          callback(entries, {} as ResizeObserver);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    await deliverLayout();

    // The person presses Continue (a pointer press inside the card), then the next step lays out shorter.
    await act(async () => {
      document
        .querySelector('[data-testid="continue"]')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    layout.cardHeight = 363;
    await deliverLayout();

    expect(card.style.minHeight).toBe('760px');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('opens each new screen at the top of its body, not at the previous screen’s scroll (PAGE-ACCEPT-176 R7-D2)', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const frame = (screenKey: string) => (
    <ModalCardFrame scrollHost="bounded" screenKey={screenKey} dimensions={{ maxHeightRatio: 0.9 }} title="Deploy an app">
      <View testID={`step-${screenKey}`} />
    </ModalCardFrame>
  );
  try {
    await act(async () => root.render(frame('where')));
    const body = document.querySelector<HTMLElement>('[data-testid="modal-card-body-viewport"]')!;
    // The person scrolled the previous step down to reach its Continue.
    body.scrollTop = 420;
    await act(async () => root.render(frame('deploy:details')));
    expect(body.scrollTop).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
