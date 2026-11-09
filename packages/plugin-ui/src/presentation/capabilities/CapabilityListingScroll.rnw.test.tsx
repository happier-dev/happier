import { act } from 'react';
import { Text, View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierCapabilityListingDetail, type HappierCapabilityAddHost } from './CapabilityAddBody.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('captures a real RNW review scroll and restores it when its page content is laid out', async () => {
  vi.useFakeTimers();
  // jsdom has no layout engine or ResizeObserver; only this browser measurement boundary is supplied.
  const observers = new Set<ResizeBoundary>();
  class ResizeBoundary implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
    deliver() {
      this.callback([...this.targets].map(target => ({ target, contentRect: target.getBoundingClientRect(),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] })), this);
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeBoundary);
  const host: Omit<HappierCapabilityAddHost, 'ModeTabs'> = {
    Collection: () => <View />,
    Button: ({ title }) => <Text>{title}</Text>,
    SourceFailure: ({ title }) => <Text>{title}</Text>,
    ErrorText: ({ children }) => <Text>{children}</Text>,
  };
  const position = { current: 0 };
  const review = (phone = false) => <HappierCapabilityListingDetail item="brave" itemKey="brave@2.1.3"
    renderDetail={() => <View testID="review-body"><Text accessibilityRole="header">Brave</Text></View>}
    detailScrollOffset={position} onClose={() => {}} pushed={phone} phone={phone}
    host={host} hairlineColor="transparent" testID="review"
    labels={{ modesLabel: 'Ways to add', searchLabel: 'Search', retry: 'Retry', closeDetails: 'Close', added: 'Added', done: 'Done', addFailed: 'Failed' }} />;
  const layout = async (container: HTMLElement) => {
    const scroller = container.querySelector('[data-testid="review:detail:brave@2.1.3"]')!.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, { clientHeight: { configurable: true, value: 900 }, scrollHeight: { configurable: true, value: 1200 } });
    await act(async () => { for (const observer of observers) observer.deliver(); await vi.runAllTimersAsync(); });
    return scroller;
  };
  const pane = mountThroughReactNativeWeb(review());
  let page: ReturnType<typeof mountThroughReactNativeWeb> | undefined;
  try {
    const paneScroller = await layout(pane.container);
    act(() => { paneScroller.scrollTop = 67; paneScroller.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(position.current).toBe(67);
    pane.unmount();
    page = mountThroughReactNativeWeb(review());
    const pageScroller = await layout(page.container);
    expect(pageScroller.scrollHeight - pageScroller.clientHeight).toBeGreaterThan(67);
    expect(pageScroller.scrollTop).toBe(67);
    await page.render(review(true));
    expect((await layout(page.container)).scrollTop).toBe(67);
  } finally {
    pane.unmount();
    page?.unmount();
  }
});

it('leaves an open review still when its owner re-renders with the same listing facts', async () => {
  const host: Omit<HappierCapabilityAddHost, 'ModeTabs'> = {
    Collection: () => <View />,
    Button: ({ title }) => <Text>{title}</Text>,
    SourceFailure: ({ title }) => <Text>{title}</Text>,
    ErrorText: ({ children }) => <Text>{children}</Text>,
  };
  const labels = { modesLabel: 'Ways to add', searchLabel: 'Search', retry: 'Retry', closeDetails: 'Close', added: 'Added', done: 'Done', addFailed: 'Failed' };
  const renderDetail = vi.fn(() => <View testID="review-body"><Text accessibilityRole="header">Brave</Text></View>);
  const onClose = () => {};
  // The Store's controller re-renders for every catalog and source arrival; the review's own facts are unchanged.
  const review = () => <HappierCapabilityListingDetail item="brave" itemKey="brave@2.1.3" renderDetail={renderDetail}
    onClose={onClose} pushed={false} phone={false} host={host} hairlineColor="transparent" testID="review" labels={labels} />;
  const mounted = mountThroughReactNativeWeb(review());
  try {
    const drawn = renderDetail.mock.calls.length;
    expect(drawn).toBeGreaterThan(0);
    await mounted.render(review());
    expect(renderDetail.mock.calls.length).toBe(drawn);
  } finally {
    mounted.unmount();
  }
});
