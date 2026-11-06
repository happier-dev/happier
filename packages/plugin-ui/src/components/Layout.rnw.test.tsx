import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Button } from './Button.js';
import { ListDetailLayout, Row, Screen, ScrollArea, Stack } from './Layout.js';
import { hitAreaClippingAncestors } from '../presentation/interaction/hitArea.testSupport.js';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '../environment/interactiveTarget.js';

/**
 * React Native Web keeps a node's layout observer callback on the host element
 * under this key and invokes it from its shared ResizeObserver. Reading it is
 * how this mount observes that an author's measurement callback reached the
 * real host rather than being dropped by the adapter; jsdom supplies no
 * ResizeObserver, so the observer itself never fires here.
 */
const DOM_LAYOUT_HANDLER_NAME = '__reactLayoutHandler';

function mountLayout(
  children: React.ReactNode,
  overrides?: Partial<ReturnType<typeof createSurfaceContext>>,
) {
  const context = createSurfaceContext(overrides);
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

describe('plugin-ui semantic layout', () => {
  it('resizes a controlled rail, commits the last width, and requests a reset without replacing panes', async () => {
    const commit = vi.fn();
    const reset = vi.fn();
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    function Surface() {
      const [width, setWidth] = useState(320);
      return <PluginUiProvider hostApi={hostApi} context={context}>
        <ListDetailLayout testID="resizable" listTestID="rail" detailTestID="body"
          minListWidth={200} minDetailWidth={400} preferredListRatio={0.4}
          listWidthPx={width} onListWidthChange={setWidth} onListWidthCommit={commit} onListWidthReset={reset}
          labels={{ resize: 'Resize collection', resizeValue: px => `${px} px` }}
          list={<Stack />} detail={<Button title="Detail action" />} />
      </PluginUiProvider>;
    }
    const mount = mountThroughReactNativeWeb(<Surface />);
    try {
      const node = mount.container.querySelector('[data-testid="resizable"]');
      const measure = Reflect.get(node!, DOM_LAYOUT_HANDLER_NAME) as (event: unknown) => void;
      act(() => measure({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 600 } } }));
      const body = mount.container.querySelector('[data-testid="body"]');
      const handle = mount.container.querySelector('[role="slider"]') as HTMLElement;
      expect(handle).not.toBeNull();
      act(() => handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 320 })));
      act(() => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 420 })));
      act(() => window.dispatchEvent(new MouseEvent('mouseup', { clientX: 420 })));
      expect(commit).toHaveBeenLastCalledWith(420);
      expect(mount.container.querySelector('[data-testid="body"]')).toBe(body);
      expect(handle.getAttribute('aria-valuenow')).toBe('420');
      act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      expect(reset).toHaveBeenCalledOnce();
    } finally { mount.unmount(); }
  });
  it('reaches the divider target past the seam over the detail so it never covers the rail\'s trailing controls', async () => {
    // The rail's header action sits at its trailing edge. A divider target reaching only inward from that
    // edge covered it (the Machines "+", 2026-11-06). Inside the rail it keeps to the drawn divider, which the
    // rail's gutter is laid out around; the rest of the pointer floor lands over the detail.
    const mount = mountLayout(
      <ListDetailLayout testID="panes" listTestID="rail" detailTestID="body"
        minListWidth={200} minDetailWidth={400} preferredListRatio={0.4}
        listWidthPx={320} onListWidthChange={() => {}}
        labels={{ resize: 'Resize collection' }}
        list={<Stack />} detail={<Button title="Detail action" />} />,
    );
    try {
      const root = mount.container.querySelector('[data-testid="panes"]') as HTMLElement;
      const measure = Reflect.get(root, DOM_LAYOUT_HANDLER_NAME) as (event: unknown) => void;
      act(() => measure({ nativeEvent: { layout: { x: 0, y: 0, width: 1000, height: 600 } } }));
      const handle = mount.container.querySelector('[role="slider"]') as HTMLElement;
      // Positioned by the layout row, outside the rail's clip, so the part over the detail is hit-tested.
      expect(handle.parentElement).toBe(root);
      expect(hitAreaClippingAncestors(handle, root)).toEqual([]);
      const px = (value: string) => Number.parseFloat(value) || 0;
      const start = px(handle.style.left) + px(handle.style.marginLeft);
      const size = Math.max(px(handle.style.width), px(handle.style.minWidth));
      expect(size).toBe(HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE);
      expect(start).toBe(320 - 10);
      expect(start + size).toBe(320 + HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE - 10);
    } finally { mount.unmount(); }
  });
  it('holds the split with an idle detail so the first selection does not reflow the list', async () => {
    // Without a selection the list took the whole width, and the first press
    // snapped it to its split share under the pointer. An idle detail keeps
    // the split geometry stable wherever both panes fit, and stays out of the
    // way when they do not.
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const content = (selected: boolean) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        <ListDetailLayout
          testID="panes"
          listTestID="list-pane"
          detailTestID="detail-pane"
          minListWidth={300}
          minDetailWidth={400}
          preferredListRatio={0.4}
          list={<Stack />}
          detail={selected ? <Button title="Detail action" /> : null}
          idleDetail={<Button title="Nothing selected" />}
        />
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(content(false));
    const listPane = () => mount.container.querySelector('[data-testid="list-pane"]') as HTMLElement;
    const detailPane = () => mount.container.querySelector('[data-testid="detail-pane"]') as HTMLElement;
    const measure = (width: number) => {
      const node = mount.container.querySelector('[data-testid="panes"]');
      const handler = Reflect.get(node!, DOM_LAYOUT_HANDLER_NAME) as (event: unknown) => void;
      act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } } }));
    };

    try {
      measure(900);
      const idleListFlex = listPane().style.flexGrow;
      expect(detailPane().getAttribute('aria-hidden')).not.toBe('true');
      expect(detailPane().textContent).toContain('Nothing selected');

      await mount.render(content(true));
      expect(listPane().style.flexGrow).toBe(idleListFlex);
      expect(detailPane().textContent).toContain('Detail action');

      // Stacked: with nothing selected the list is the page, not a placeholder.
      await mount.render(content(false));
      measure(500);
      expect(listPane().getAttribute('aria-hidden')).not.toBe('true');
      expect(detailPane().getAttribute('aria-hidden')).toBe('true');
    } finally {
      mount.unmount();
    }
  });

  it('keeps both pane instances while selection and measured width change', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return <Button title={`Count ${count}`} onPress={() => setCount((value) => value + 1)} />;
    }
    const context = createSurfaceContext();
    const hostApi = createHostApiStub(context);
    const content = (detailActive: boolean, minDetailWidth = 400) => (
      <PluginUiProvider hostApi={hostApi} context={context}>
        <ListDetailLayout
          testID="panes"
          listTestID="list-pane"
          detailTestID="detail-pane"
          minListWidth={300}
          minDetailWidth={minDetailWidth}
          preferredListRatio={0.4}
          gap="small"
          list={<Counter />}
          detail={<Button title="Detail action" />}
          detailActive={detailActive}
        />
      </PluginUiProvider>
    );
    const mount = mountThroughReactNativeWeb(content(false));
    const listPane = mount.container.querySelector('[data-testid="list-pane"]') as HTMLElement;
    const detailPane = mount.container.querySelector('[data-testid="detail-pane"]') as HTMLElement;
    const counter = listPane.querySelector('[role="button"]') as HTMLElement;
    const detailAction = detailPane.querySelector('[role="button"]');
    const measure = (width: number) => {
      const node = mount.container.querySelector('[data-testid="panes"]');
      const handler = Reflect.get(node!, DOM_LAYOUT_HANDLER_NAME) as (event: unknown) => void;
      act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } } }));
    };

    try {
      act(() => counter.click());
      expect(counter.textContent).toBe('Count 1');
      expect(detailPane.getAttribute('aria-hidden')).toBe('true');

      // Opening detail before the first measurement must not guess a split.
      await mount.render(content(true));
      expect(listPane.getAttribute('aria-hidden')).toBe('true');
      expect(detailPane.getAttribute('aria-hidden')).not.toBe('true');

      measure(900);
      expect(listPane.getAttribute('aria-hidden')).not.toBe('true');
      expect(detailPane.getAttribute('aria-hidden')).not.toBe('true');

      // Larger readable content can collapse the panes without another resize.
      await mount.render(content(true, 700));
      expect(listPane.getAttribute('aria-hidden')).toBe('true');
      expect(detailPane.querySelector('[role="button"]')).toBe(detailAction);

      await mount.render(content(false));
      expect(listPane.querySelector('[role="button"]')).toBe(counter);
      expect(counter.textContent).toBe('Count 1');
      expect(listPane.getAttribute('aria-hidden')).not.toBe('true');
      expect(detailPane.getAttribute('aria-hidden')).toBe('true');
    } finally {
      mount.unmount();
    }
  });

  it('reports measured layout to its list slot and includes the semantic gutter in the fit', () => {
    const context = createSurfaceContext();
    const layouts: unknown[] = [];
    const mount = mountLayout(
      <ListDetailLayout
        testID="panes"
        minListWidth={300}
        minDetailWidth={400}
        preferredListRatio={0.4}
        gap="small"
        list={(layout) => { layouts.push(layout); return <Stack />; }}
        detail={<Stack />}
      />,
      context,
    );
    const node = mount.container.querySelector('[data-testid="panes"]');
    const handler = Reflect.get(node!, DOM_LAYOUT_HANDLER_NAME) as (event: unknown) => void;
    const measure = (width: number) => act(() => handler({
      nativeEvent: { layout: { x: 0, y: 0, width, height: 600 } },
    }));
    try {
      expect(layouts.at(-1)).toBeNull();
      measure(700 + context.theme.spacing.small - 1);
      expect(layouts.at(-1)).toEqual({ mode: 'stacked' });
      measure(700 + context.theme.spacing.small);
      expect(layouts.at(-1)).toEqual({ mode: 'split', listRatio: 300 / 700, detailWidthPx: 400 });
    } finally {
      mount.unmount();
    }
  });

  it('renders real RN hosts for every layout box', () => {
    const mount = mountLayout(
      <Screen testID="screen" safeArea>
        <Stack testID="stack" gap="large">
          <Row testID="row" gap="small" wrap>
            <Stack testID="nested" />
          </Row>
        </Stack>
      </Screen>,
    );

    expect(mount.container.innerHTML).not.toContain('happier-plugin-');
    expect(mount.container.querySelector('[data-testid="screen"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="stack"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="row"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps Row logical under an RTL surface context instead of reversing it manually', () => {
    // Physical reversal and a blanket `writingDirection` are the two wrong
    // answers here: a horizontal Row is logical order under the layout
    // direction the platform already resolves, so reversing children or the
    // flex axis would double-reverse a real RTL mount. Whether a surface may
    // carry a direction that differs from the ambient one is still an unproven
    // loaded-runtime question; this gate only holds the base components to
    // logical output so that question stays answerable.
    for (const direction of ['ltr', 'rtl'] as const) {
      const mount = mountLayout(
        <Row testID="row" gap="small">
          <Stack testID="nested" />
        </Row>,
        { direction },
      );

      const row = mount.container.querySelector('[data-testid="row"]') as HTMLElement | null;
      expect(row).not.toBeNull();
      const style = row === null ? null : row.ownerDocument.defaultView?.getComputedStyle(row);
      expect(style?.flexDirection).toBe('row');
      expect(row?.style.getPropertyValue('writing-mode')).toBe('');
      expect(row?.getAttribute('dir')).toBeNull();
      mount.unmount();
    }
  });

  it('uses one scroll owner and exposes the collection name to assistive technology', () => {
    const mount = mountLayout(
      <ScrollArea testID="scroll" accessibilityLabel="Connection diagnostics">
        <Stack />
      </ScrollArea>,
    );

    const scroll = mount.container.querySelector('[data-testid="scroll"]');
    expect(scroll).not.toBeNull();
    expect(scroll?.getAttribute('aria-label')).toBe('Connection diagnostics');
    mount.unmount();
  });

  it('reports each layout box measurement to the author that owns the box', () => {
    const onScreenLayout = vi.fn();
    const onStackLayout = vi.fn();
    const onRowLayout = vi.fn();
    const onScrollLayout = vi.fn();
    const mount = mountLayout(
      <Screen testID="screen" onLayout={onScreenLayout}>
        <Stack testID="stack" onLayout={onStackLayout}>
          <Row testID="row" onLayout={onRowLayout} />
        </Stack>
        <ScrollArea testID="scroll" onLayout={onScrollLayout} />
      </Screen>,
    );

    const layoutHandler = (testID: string): unknown => (
      mount.container.querySelector(`[data-testid="${testID}"]`) as unknown as
        Record<string, unknown> | null
    )?.[DOM_LAYOUT_HANDLER_NAME];

    try {
      // RNW may wrap a layout handler (ScrollView does). Assert the observable
      // measurement contract, not the platform adapter's callback identity.
      for (const [index, [testID, callback]] of ([
        ['screen', onScreenLayout], ['stack', onStackLayout],
        ['row', onRowLayout], ['scroll', onScrollLayout],
      ] as const).entries()) {
        const handler = layoutHandler(testID);
        expect(handler).toBeTypeOf('function');
        const event = { nativeEvent: { layout: { x: 0, y: 0, width: (index + 1) * 100, height: 600 } } };
        if (typeof handler === 'function') act(() => handler(event));
        expect(callback).toHaveBeenCalledWith(event);
      }
    } finally { mount.unmount(); }
  });
});
