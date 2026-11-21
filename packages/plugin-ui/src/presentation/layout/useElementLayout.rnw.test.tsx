import { act } from 'react';
import { createRequire } from 'node:module';
import { URL as NodeURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb, type RnwMount } from '../../rnwMount.testSupport.js';
import { PresenceCapsule } from '../../components/Copresence.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { createHostApiStub, createSurfaceContext } from '../../surfaceFixture.testSupport.js';

const requireUi = createRequire(new NodeURL('../../../../../apps/ui/package.json', import.meta.url));
async function loadView(distribution: 'esm' | 'cjs') {
  if (distribution === 'esm') return (await import('react-native')).View;
  // The dependency's CommonJS entry is an untyped external package boundary.
  return requireUi('react-native-web/dist/cjs/exports/View') as typeof import('react-native').View;
}

// ResizeObserver and DOM geometry are the browser boundary. RNW View, its hook,
// UIManager measurement, React reconciliation, and PageHeader all remain real.
class BrowserResizeObserver {
  static instances: BrowserResizeObserver[] = [];
  readonly targets = new Set<Element>();
  readonly registrations = new Map<Element, number>();
  constructor(private readonly callback: ResizeObserverCallback) {
    BrowserResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
    this.registrations.set(target, (this.registrations.get(target) ?? 0) + 1);
    // Browsers deliver an initial notification after observe, even if size
    // has not changed. Defer until commit has finished, as the browser does.
    queueMicrotask(() => this.resize(target));
  }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  resize(target: Element) {
    if (!this.targets.has(target)) return;
    this.callback([{ target } as ResizeObserverEntry], this);
  }
}

const mounts: RnwMount[] = [];
function mount(element: Parameters<typeof mountThroughReactNativeWeb>[0]) {
  const result = mountThroughReactNativeWeb(element);
  mounts.push(result);
  return result;
}
function observerFor(target: Element) {
  const observer = BrowserResizeObserver.instances.find(value => value.registrations.has(target));
  if (!observer) throw new Error('The browser never observed this retained View.');
  return observer;
}
function size(target: Element, width: number, height: number) {
  Object.defineProperties(target, {
    offsetWidth: { configurable: true, value: width },
    offsetHeight: { configurable: true, value: height },
  });
}
async function flushLayout() {
  await act(async () => { await vi.runAllTimersAsync(); });
}

beforeAll(() => { vi.stubGlobal('ResizeObserver', BrowserResizeObserver); });
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  mounts.splice(0).forEach(value => value.unmount());
  // Let RNW drain measurements queued during the last React commit before
  // replacing the fake clock. Its queue outlives each mounted fixture.
  await flushLayout();
  vi.useRealTimers();
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('RNW layout handler presence', () => {
  it.each(['inline', 'strip'] as const)('measures retained capsule words only when a late available width needs them (%s)', async placement => {
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const render = (availableWidth?: number) => (
      <PluginUiProvider context={context} hostApi={hostApi}>
        <PresenceCapsule presence={{ kind: 'agent', controlEpoch: 1 }} agentName="Claude" agentTitle="Claude is browsing"
          onTakeControl={() => undefined} availableWidth={availableWidth} placement={placement} testID="capsule" />
      </PluginUiProvider>
    );
    const view = mount(render());
    const words = view.container.querySelector('[data-testid="capsule-text"]')!;
    await flushLayout();
    expect(BrowserResizeObserver.instances.some(observer => observer.targets.has(words))).toBe(false);
    size(words, placement === 'strip' ? 24 : 4, 30);
    await view.render(render(115));
    expect(view.container.querySelector('[data-testid="capsule-text"]')).toBe(words);
    await flushLayout();
    const observer = observerFor(words);
    expect(view.container.querySelector('[data-testid="capsule-text"]') === null).toBe(placement === 'inline');
    expect(view.container.querySelector('[data-testid="capsule-actions-beneath"]') !== null).toBe(placement === 'strip');

    await view.render(render(400));
    const restoredWords = view.container.querySelector('[data-testid="capsule-text"]')!;
    size(restoredWords, 220, 30);
    observer.resize(restoredWords);
    await flushLayout();
    expect(view.container.querySelector('[data-testid="capsule-text"]')).toBe(restoredWords);
    expect(view.container.querySelector('[data-testid="capsule-actions-beneath"]')).toBeNull();
    await view.render(render());
    expect(observer.targets.has(restoredWords)).toBe(false);
    view.unmount();
    expect(observer.targets.has(restoredWords)).toBe(false);
  });

  it.each(['esm', 'cjs'] as const)('%s: starts measuring a late listener without remount, stops on removal, and can enable it again', async distribution => {
    const View = await loadView(distribution);
    const first = vi.fn();
    const latest = vi.fn();
    const view = mount(<View testID="late" />);
    const target = view.container.querySelector('[data-testid="late"]')!;
    size(target, 120, 30);
    await view.render(<View testID="late" onLayout={first} />);
    await flushLayout();
    expect(view.container.querySelector('[data-testid="late"]')).toBe(target);
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeEvent: expect.objectContaining({ layout: expect.objectContaining({ width: 120, height: 30 }) }),
    }));
    const observer = observerFor(target);
    size(target, 240, 40);
    observer.resize(target);
    await flushLayout();
    expect(first).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeEvent: expect.objectContaining({ layout: expect.objectContaining({ width: 240, height: 40 }) }),
    }));
    size(target, 260, 40);
    observer.resize(target);
    await view.render(<View testID="late" />);
    expect(observer.targets.has(target)).toBe(false);
    first.mockClear();
    await flushLayout();
    expect(first).not.toHaveBeenCalled();
    size(target, 240, 40);
    await view.render(<View testID="late" onLayout={latest} />);
    await flushLayout();
    expect(latest).toHaveBeenCalledOnce();
    view.unmount();
    expect(observer.targets.has(target)).toBe(false);
  });

  it.each(['esm', 'cjs'] as const)('%s: uses the newest callback while 20 callback replacements cause zero observation churn', async distribution => {
    const View = await loadView(distribution);
    const initial = vi.fn();
    const view = mount(<View testID="stable" onLayout={initial} />);
    const target = view.container.querySelector('[data-testid="stable"]')!;
    size(target, 120, 30);
    await flushLayout();
    const observer = observerFor(target);
    const registrations = observer.registrations.get(target);
    initial.mockClear();
    const callbacks = Array.from({ length: 20 }, () => vi.fn());
    for (const callback of callbacks) await view.render(<View testID="stable" onLayout={callback} />);
    await flushLayout();
    expect(observer.registrations.get(target)).toBe(registrations);
    expect(callbacks.every(callback => callback.mock.calls.length === 0)).toBe(true);
    size(target, 300, 50);
    observer.resize(target);
    await flushLayout();
    expect(initial).not.toHaveBeenCalled();
    expect(callbacks.slice(0, -1).every(callback => callback.mock.calls.length === 0)).toBe(true);
    expect(callbacks.at(-1)).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeEvent: expect.objectContaining({ layout: expect.objectContaining({ width: 300, height: 50 }) }),
    }));
    view.unmount();
    expect(observer.targets.has(target)).toBe(false);
  });

  it('lets a retained PageHeader measure delayed actions and move them below a narrow identity', async () => {
    const { Text } = await import('react-native');
    const { HappierPageHeader } = await import('./PageHeader.js');
    const view = mount(<HappierPageHeader testID="header" title="Development machine" />);
    const titleRow = view.container.querySelector('[data-testid="header-title-row"]')!;
    const split = titleRow.firstElementChild!;
    size(split, 200, 72);
    await view.render(<HappierPageHeader testID="header" title="Development machine"
      actions={<Text testID="delayed-action">Run on this machine</Text>} />);
    expect(titleRow.firstElementChild).toBe(split);
    // Real PageHeader handlers must receive RNW's measurements; calling a
    // component's onLayout prop directly would conceal the dependency defect.
    for (const node of view.container.querySelectorAll('*')) {
      if (node !== split) size(node, 160, 36);
    }
    await flushLayout();
    expect(view.container.querySelector('[data-testid="header-actions-below"]')).not.toBeNull();
    const observer = observerFor(split);
    expect(observer.targets.has(split)).toBe(true);
    size(split, 800, 36);
    observer.resize(split);
    await flushLayout();
    expect(view.container.querySelector('[data-testid="header-actions-below"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="delayed-action"]')).not.toBeNull();
  });
});

describe('RNW layout of a node that is not rendered', () => {
  // The browser boundary jsdom lacks: `checkVisibility()` is false for a node under `display: none`
  // (on it or an ancestor) and true for a rendered node, even one whose box is 0×0.
  const prototype = Element.prototype as unknown as { checkVisibility?: () => boolean };
  beforeEach(() => {
    prototype.checkVisibility = function (this: Element) {
      for (let node: Element | null = this; node; node = node.parentElement) {
        if (window.getComputedStyle(node).display === 'none') return false;
      }
      return true;
    };
  });
  afterEach(() => { delete prototype.checkVisibility; });

  it.each(['esm', 'cjs'] as const)('%s: publishes no layout while a retained pane hides it and publishes a changed size once shown again', async distribution => {
    const View = await loadView(distribution);
    const layouts: Array<readonly [number, number]> = [];
    const onLayout = (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      layouts.push([event.nativeEvent.layout.width, event.nativeEvent.layout.height]);
    };
    const pane = (hidden: boolean) => (
      <View testID="pane" style={hidden ? { display: 'none' } : null}>
        <View testID="inner" onLayout={onLayout} />
      </View>
    );
    const view = mount(pane(false));
    const inner = view.container.querySelector('[data-testid="inner"]')!;
    size(inner, 300, 50);
    await flushLayout();
    expect(layouts).toEqual([[300, 50]]);
    const observer = observerFor(inner);

    // Hiding the pane: the browser's observer reports the hidden box as 0×0.
    await view.render(pane(true));
    expect(window.getComputedStyle(view.container.querySelector('[data-testid="pane"]')!).display).toBe('none');
    size(inner, 0, 0);
    observer.resize(inner);
    await flushLayout();
    expect(layouts).toEqual([[300, 50]]);

    // Revealing the same geometry does not publish another layout.
    await view.render(pane(false));
    size(inner, 300, 50);
    observer.resize(inner);
    await flushLayout();
    expect(layouts).toEqual([[300, 50]]);
    size(inner, 320, 60);
    observer.resize(inner);
    await flushLayout();
    expect(layouts).toEqual([[300, 50], [320, 60]]);
  });

  it.each(['esm', 'cjs'] as const)('%s: still publishes a rendered box that is really 0×0', async distribution => {
    const View = await loadView(distribution);
    const onLayout = vi.fn();
    const view = mount(<View testID="empty" onLayout={onLayout} />);
    size(view.container.querySelector('[data-testid="empty"]')!, 0, 0);
    await flushLayout();
    expect(onLayout).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeEvent: expect.objectContaining({ layout: expect.objectContaining({ width: 0, height: 0 }) }),
    }));
  });
});

describe('RNW layout measurement cost', () => {
  // The browser's offset geometry is the boundary jsdom lacks. Each element gets an offset parent,
  // offsets, borders and scroll; reads of any element's offsetLeft/offsetTop are counted.
  type Geometry = { offsetParent: Element | null; left: number; top: number; border: number; scroll: number };
  let reads: Map<Element, number>;
  function place(element: Element, geometry: Geometry) {
    const read = (value: number) => () => { reads.set(element, (reads.get(element) ?? 0) + 1); return value; };
    Object.defineProperties(element, {
      offsetParent: { configurable: true, get: () => geometry.offsetParent },
      offsetLeft: { configurable: true, get: read(geometry.left) },
      offsetTop: { configurable: true, get: read(geometry.top + 1) },
      clientLeft: { configurable: true, value: geometry.border },
      clientTop: { configurable: true, value: geometry.border },
      scrollLeft: { configurable: true, value: 0 },
      scrollTop: { configurable: true, value: geometry.scroll },
    });
  }
  // React Native's contract for onLayout: the box relative to its parent. RNW's original walk, as the oracle.
  function pagePosition(node: Element | null) {
    let left = 0, top = 0;
    for (let first = true; node; node = (node as HTMLElement).offsetParent, first = false) {
      const element = node as HTMLElement;
      left += element.offsetLeft + (first ? 0 : element.clientLeft - element.scrollLeft);
      top += element.offsetTop + (first ? 0 : element.clientTop - element.scrollTop);
    }
    return { left: left - window.scrollX, top: top - window.scrollY };
  }
  beforeEach(() => { reads = new Map(); });

  it.each([
    ['esm', 'positioned parent'], ['cjs', 'positioned parent'],
    ['esm', 'static parent'], ['cjs', 'static parent'],
  ] as const)('%s, %s: reports the layout relative to the parent without reading the ancestors above it', async (distribution, parentKind) => {
    const View = await loadView(distribution);
    const layouts: Array<{ x: number; y: number; width: number; height: number }> = [];
    let lastLayout: Record<string, number> | null = null;
    const onLayout = (event: { nativeEvent: { layout: Record<string, number> } }) => {
      const { x, y, width, height } = event.nativeEvent.layout;
      layouts.push({ x, y, width, height });
      lastLayout = event.nativeEvent.layout;
    };
    // A transcript row sits under ~60 positioned Views; 30 shows the walk's cost scaling with depth.
    let tree = <View testID="leaf" onLayout={onLayout} />;
    tree = <View testID="parent">{tree}</View>;
    for (let depth = 0; depth < 30; depth++) tree = <View testID={`ancestor-${depth}`}>{tree}</View>;
    const view = mount(tree);
    const leaf = view.container.querySelector('[data-testid="leaf"]')!;
    const parent = leaf.parentElement!;
    const chain: Element[] = [];
    for (let node = parent.parentElement; node; node = node.parentElement) chain.push(node);
    chain.forEach((element, index) => place(element, { offsetParent: chain[index + 1] ?? null, left: 3 + index, top: 7 + index, border: 1, scroll: index % 3 }));
    place(parent, { offsetParent: chain[0]!, left: 11, top: 13, border: 2, scroll: 5 });
    place(leaf, parentKind === 'positioned parent'
      ? { offsetParent: parent, left: 17, top: 19, border: 0, scroll: 0 }
      : { offsetParent: chain[0]!, left: 28, top: 32, border: 0, scroll: 0 });
    size(leaf, 120, 30);
    const expectedPage = pagePosition(leaf);
    const parentPage = pagePosition(parent);
    reads.clear();
    await flushLayout();

    expect(layouts).toEqual([{ x: expectedPage.left - parentPage.left, y: expectedPage.top - parentPage.top, width: 120, height: 30 }]);
    // Measuring touched only the node and its parent: no read of any of the 31 ancestors above.
    expect(chain.reduce((total, element) => total + (reads.get(element) ?? 0), 0)).toBe(0);
    // RNW's extra page position stays available on the event.
    expect({ left: lastLayout!.left, top: lastLayout!.top }).toEqual(expectedPage);
  });

  it.each(['esm', 'cjs'] as const)('%s: keeps the full walk for a node whose offset parent is neither its parent nor its parent\'s', async distribution => {
    const View = await loadView(distribution);
    const layouts: Array<Record<string, number>> = [];
    const onLayout = (event: { nativeEvent: { layout: Record<string, number> } }) => { layouts.push({ ...event.nativeEvent.layout }); };
    const view = mount(<View testID="a"><View testID="b"><View testID="leaf" onLayout={onLayout} /></View></View>);
    const leaf = view.container.querySelector('[data-testid="leaf"]')!;
    const parent = leaf.parentElement!;
    const chain: Element[] = [];
    for (let node = parent.parentElement; node; node = node.parentElement) chain.push(node);
    chain.forEach((element, index) => place(element, { offsetParent: chain[index + 1] ?? null, left: 2 + index, top: 4 + index, border: 1, scroll: 1 }));
    // e.g. a fixed-position parent inside a static one: the two offset parents differ.
    place(parent, { offsetParent: chain[0]!, left: 6, top: 8, border: 1, scroll: 2 });
    place(leaf, { offsetParent: chain[1]!, left: 40, top: 50, border: 0, scroll: 0 });
    size(leaf, 64, 20);
    const expectedPage = pagePosition(leaf);
    const parentPage = pagePosition(parent);
    await flushLayout();
    expect(layouts).toEqual([{ x: expectedPage.left - parentPage.left, y: expectedPage.top - parentPage.top, width: 64, height: 20, left: expectedPage.left, top: expectedPage.top }]);
  });
});
