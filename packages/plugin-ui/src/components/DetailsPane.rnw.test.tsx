import { act, useSyncExternalStore, type ReactNode } from 'react';
import { Text as RNText } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { usePluginHostApi } from '../hostApi/context.js';
import type {
  PluginUiDetailsPaneHost,
  PluginUiDetailsPanePresentation,
  PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { DetailPage, DetailsPane, DetailsPaneFooter, PushedDetailHeader, useDetailPageLead } from './DetailsPane.js';
import { PluginUiProviderInternal, usePluginTheme, usePluginTranslation, useSurfaceContext } from './PluginUiProvider.js';
import { Text } from './Text.js';
import { ScrollArea } from './Layout.js';

/**
 * Shell extensibility O6: `DetailsPane` renders its children in the page's app details pane, which the host draws
 * OUTSIDE the plugin's React tree (a sibling column of the page). The plugin context — theme, translation, the
 * surface context, the Host API and the public components that read them — must survive that move.
 *
 * The host boundary here is the real shape of the app binding: a publisher rendered in place, and a pane slot
 * mounted beside (not inside) the provider that reads the published content from a store.
 */
function createPaneHost(available: boolean) {
  let published: PluginUiDetailsPanePresentation | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  function Publisher(props: Readonly<{ input: PluginUiDetailsPanePresentation }>) {
    published = props.input;
    queueMicrotask(notify);
    return null;
  }
  const binding: PluginUiDetailsPaneHost = {
    useAvailable: () => available,
    renderDetailsPane: (input) => <Publisher input={input} />,
  };
  function Slot() {
    const input = useSyncExternalStore(
      (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      () => published,
    );
    if (!input || !input.open) return null;
    return (
      <div data-testid="host-pane">
        {input.title ? <span data-testid="host-pane-title">{input.title}</span> : null}
        {input.children}
      </div>
    );
  }
  return { binding, Slot, read: () => published };
}

function Probe() {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const surface = useSurfaceContext();
  const hostApi = usePluginHostApi();
  return (
    <>
      <RNText testID="probe-facts">{`${theme.colors.text}|${translate('probe.missing', 'fallback')}|${surface.platform}|${typeof hostApi.openSurface}`}</RNText>
      <Text testID="probe-public-text" value="Plugin text" />
    </>
  );
}

function mountWithPane(
  children: ReactNode,
  pane: ReturnType<typeof createPaneHost> | null,
  options: Readonly<{ context?: ReturnType<typeof createSurfaceContext>; host?: Partial<PluginUiPresentationHost> }> = {},
) {
  const context = options.context ?? createSurfaceContext();
  const presentationHost = {
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(pane ? { detailsPane: pane.binding } : {}),
    ...options.host,
  } as unknown as PluginUiPresentationHost;
  const Slot = pane?.Slot ?? (() => null);
  return mountThroughReactNativeWeb(
    <>
      <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
        {children}
      </PluginUiProviderInternal>
      <Slot />
    </>,
  );
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('DetailsPane (host details pane binding)', () => {
  it('lays a pane body out on the pane, not on the page column the surface was mounted in', async () => {
    const pane = createPaneHost(true);
    const view = mountWithPane(
      <DetailsPane open title="Entry #2481" onClose={() => undefined}>
        <ScrollArea><Text testID="pane-body" value="Detail body" /></ScrollArea>
      </DetailsPane>,
      pane,
      { host: { pageChrome: { showsTitle: false, columnMaxWidthPx: 850 } } },
    );
    await flush();

    const body = view.container.querySelector<HTMLElement>('[data-testid="pane-body"]')!;
    expect(body).not.toBeNull();
    // No ancestor inside the pane is clamped to the page's 850 px column.
    for (let node: HTMLElement | null = body; node !== null && node.getAttribute('data-testid') !== 'host-pane'; node = node.parentElement) {
      expect(node.style.maxWidth).not.toBe('850px');
    }
    view.unmount();
  });

  it('renders the open detail in the host pane, outside the plugin tree, with the plugin context intact', async () => {
    const pane = createPaneHost(true);
    const onClose = vi.fn();
    const view = mountWithPane(
      <DetailsPane open title="Entry #2481" onClose={onClose} testID="entry-pane">
        <Probe />
      </DetailsPane>,
      pane,
    );
    await flush();

    const hostPane = view.container.querySelector('[data-testid="host-pane"]');
    expect(hostPane).not.toBeNull();
    expect(view.container.querySelector('[data-testid="host-pane-title"]')?.textContent).toBe('Entry #2481');
    const facts = hostPane?.querySelector('[data-testid="probe-facts"]')?.textContent ?? '';
    expect(facts.split('|')).toEqual([createSurfaceContext().theme.colors.text, 'fallback', createSurfaceContext().platform, 'function']);
    expect(hostPane?.querySelector('[data-testid="probe-public-text"]')?.textContent).toBe('Plugin text');
    // Nothing of the detail stays in the page itself.
    expect(view.container.querySelectorAll('[data-testid="probe-facts"]')).toHaveLength(1);

    pane.read()?.onClose();
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('pushes the detail inside the page, with a way back, when the host has no pane beside it', async () => {
    for (const pane of [null, createPaneHost(false)]) {
      const onClose = vi.fn();
      const view = mountWithPane(
        <DetailsPane open title="Entry #2481" onClose={onClose} testID="entry-pane">
          <Probe />
        </DetailsPane>,
        pane,
      );
      await flush();
      expect(view.container.querySelector('[data-testid="host-pane"]')).toBeNull();
      const inPage = view.container.querySelector('[data-testid="entry-pane"]');
      expect(inPage?.getAttribute('role')).toBe('dialog');
      expect(inPage?.getAttribute('aria-modal')).toBe('true');
      expect(inPage?.querySelector('[role="heading"]')?.textContent).toBe('Entry #2481');
      expect(inPage?.textContent).toContain('Entry #2481');
      expect(inPage?.querySelector('[data-testid="probe-public-text"]')?.textContent).toBe('Plugin text');
      const back = view.container.querySelector<HTMLElement>('[data-testid="entry-pane:back"]');
      expect(back).not.toBeNull();
      act(() => back!.click());
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
    }
  });

  it('draws no Back of its own where the navigation\'s Back already returns to the list', async () => {
    const view = mountWithPane(
      <DetailsPane open title="Entry #2481" onClose={vi.fn()} testID="entry-pane">
        <Probe />
      </DetailsPane>,
      null,
      { host: { pageChrome: { showsTitle: true, navigationBackSpendsStep: true } } },
    );
    await flush();
    const inPage = view.container.querySelector('[data-testid="entry-pane"]');
    expect(inPage?.querySelector('[role="heading"]')?.textContent).toBe('Entry #2481');
    expect(view.container.querySelector('[data-testid="entry-pane:back"]')).toBeNull();
    view.unmount();
  });

  it('hands its way back to the navigation band where one is drawn, so a pushed detail has one band above it', async () => {
    const published: ((() => void) | null)[] = [];
    const onClose = vi.fn();
    const view = mountWithPane(
      <>
        <PushedDetailHeader onClose={onClose} testID="detail" />
        <PushedDetailHeader title="Named" onClose={onClose} testID="named" />
      </>,
      null,
      { host: { pageChrome: { publishBack: (press: (() => void) | null) => { published.push(press); } } as never } },
    );
    await flush();
    expect(view.container.querySelector('[data-testid="detail:back"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="named:back"]')).toBeNull();
    published.find((press) => press !== null)?.();
    expect(onClose).toHaveBeenCalledTimes(1);
    view.unmount();
    await flush();
    expect(published.at(-1)).toBeNull();
  });

  it('keeps its published way back when publishing it makes the navigation show a Back (no publish loop)', async () => {
    const published: ((() => void) | null)[] = [];
    const view = mountWithPane(
      <PushedDetailHeader onClose={vi.fn()} testID="detail" />,
      null,
      { host: { pageChrome: { navigationBackSpendsStep: true, publishBack: (press: (() => void) | null) => { published.push(press); } } as never } },
    );
    await flush();
    expect(published).toHaveLength(1);
    expect(published[0]).not.toBeNull();
    view.unmount();
  });

  it('keeps the identity mark beside the title and the mark leading the line when the detail is pushed', async () => {
    const view = mountWithPane(
      <DetailsPane
        open
        title="Move cart totals to server-side rounding"
        subtitle="tidewater/checkout-web #2476 · You opened 42m ago"
        leading={<RNText testID="kind-mark">k</RNText>}
        subtitleLeading={<RNText testID="source-mark">s</RNText>}
        onClose={() => undefined}
        testID="entry-pane"
      >
        <Probe />
      </DetailsPane>,
      null,
    );
    await flush();
    const inPage = view.container.querySelector('[data-testid="entry-pane"]')!;
    expect(inPage.querySelector('[data-testid="kind-mark"]')).not.toBeNull();
    const sourceMark = inPage.querySelector('[data-testid="source-mark"]');
    expect(sourceMark).not.toBeNull();
    expect(inPage.textContent).toContain('tidewater/checkout-web #2476 · You opened 42m ago');
    view.unmount();
  });

  it('pins a pushed detail footer below the story, above the home indicator, and leaves the wide pane without one', async () => {
    const context = createSurfaceContext({ safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 } });
    const detail = (
      <DetailsPane open title="Entry #2476" onClose={() => undefined} testID="entry-pane"
        footer={<RNText testID="footer-primary">Fix with Claude</RNText>}>
        <RNText testID="story">The ask</RNText>
      </DetailsPane>
    );
    const pushed = mountWithPane(detail, null, { context });
    await flush();
    const dialog = pushed.container.querySelector<HTMLElement>('[data-testid="entry-pane"]')!;
    const story = dialog.querySelector<HTMLElement>('[data-testid="story"]')!;
    const primary = dialog.querySelector<HTMLElement>('[data-testid="footer-primary"]');
    expect(primary).not.toBeNull();
    // Outside the region the story scrolls in, and after it: the story never runs under the primary.
    const region = story.parentElement!;
    expect(region.contains(primary)).toBe(false);
    expect(story.compareDocumentPosition(primary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const footer = dialog.querySelector<HTMLElement>('[data-testid="entry-pane:footer"]')!;
    expect(footer.contains(primary)).toBe(true);
    expect(getComputedStyle(footer).paddingBottom).toBe('34px');
    pushed.unmount();

    // On a phone the host keeps it above the keyboard; its home-indicator inset tucks under the keyboard.
    const sticky: Array<number | undefined> = [];
    const keyboardAware = mountWithPane(detail, null, {
      context,
      host: {
        renderKeyboardStickyFooter: (input) => {
          sticky.push(input.offset);
          return <div data-testid="keyboard-sticky">{input.children}</div>;
        },
      },
    });
    await flush();
    expect(keyboardAware.container.querySelector('[data-testid="keyboard-sticky"] [data-testid="footer-primary"]')).not.toBeNull();
    expect(sticky.at(-1)).toBe(34 - HAPPIER_PAGE_METRICS.groupSeparatorGapPx);
    keyboardAware.unmount();

    // A host's pinned bar owns the phone's bottom, so the shell's bar folds instead of stacking under this one.
    const hostBar = mountWithPane(detail, null, {
      context,
      host: { renderPagePinnedBar: (input) => <div data-testid="page-pinned-bar">{input.children}</div> },
    });
    await flush();
    expect(hostBar.container.querySelector('[data-testid="page-pinned-bar"] [data-testid="footer-primary"]')).not.toBeNull();
    hostBar.unmount();

    // Beside the page the primary lives in the pane's header; the footer is not drawn.
    const pane = createPaneHost(true);
    const wide = mountWithPane(detail, pane, { context });
    await flush();
    expect(wide.container.querySelector('[data-testid="host-pane"] [data-testid="story"]')).not.toBeNull();
    expect(wide.container.querySelector('[data-testid="footer-primary"]')).toBeNull();
    expect(pane.read()).not.toHaveProperty('footer');
    wide.unmount();
  });

  it('draws the footer slot a detail places itself: page ground, ink hairline, home-indicator inset', async () => {
    const context = createSurfaceContext({ safeAreaInsets: { top: 47, right: 0, bottom: 34, left: 0 } });
    const view = mountWithPane(
      <DetailsPaneFooter testID="slot"><RNText testID="slot-primary">Fix with Claude</RNText></DetailsPaneFooter>,
      null,
      { context },
    );
    await flush();
    const footer = view.container.querySelector<HTMLElement>('[data-testid="slot"]')!;
    expect(footer.contains(view.container.querySelector('[data-testid="slot-primary"]'))).toBe(true);
    expect(getComputedStyle(footer).paddingBottom).toBe('34px');
    expect(getComputedStyle(footer).borderTopWidth).not.toBe('0px');
    view.unmount();
  });

  it('renders nothing while closed', async () => {
    const view = mountWithPane(
      <DetailsPane open={false} title="Entry" onClose={() => undefined} testID="entry-pane"><Probe /></DetailsPane>,
      null,
    );
    await flush();
    expect(view.container.querySelector('[data-testid="entry-pane"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="probe-facts"]')).toBeNull();
    view.unmount();
  });
});

describe('DetailPage (an item that is its own page)', () => {
  function Story(props: Readonly<{ pushed: boolean; headerHosted: boolean }>) {
    const lead = useDetailPageLead();
    return (
      <>
        <RNText testID="context">{`${props.pushed}:${props.headerHosted}`}</RNText>
        {lead === null ? null : <div data-testid="story-lead">{lead}</div>}
      </>
    );
  }
  const page = (onBack: () => void) => (
    <DetailPage title="Move cart totals to server-side rounding" onBack={onBack} pushedBelowWidthPx={720} testID="entry-page">
      {(context) => <Story {...context} />}
    </DetailPage>
  );
  // Layout is a native boundary: deliver the page's measured width to its real handler.
  function measure(view: ReturnType<typeof mountWithPane>, width: number) {
    const root = view.container.querySelector('[data-testid="entry-page"]') as unknown as {
      __reactLayoutHandler?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
    };
    act(() => { root.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } }); });
  }

  it('is the pushed detail on a narrow page: its own way back, the title leading the story', async () => {
    const onBack = vi.fn();
    const view = mountWithPane(page(onBack), null);
    await flush();
    measure(view, 390);
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('true:true');
    const headings = [...view.container.querySelectorAll('[role="heading"]')];
    expect(headings.map((heading) => heading.textContent)).toEqual(['Move cart totals to server-side rounding']);
    expect(view.container.querySelector('[data-testid="story-lead"] [role="heading"]')).not.toBeNull();
    const back = view.container.querySelector<HTMLElement>('[data-testid="entry-page:back"]');
    expect(back).not.toBeNull();
    act(() => { back!.click(); });
    expect(onBack).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('hands its way back to a navigation band that shows the title, as a Collection\'s pushed detail does', async () => {
    const published: ((() => void) | null)[] = [];
    const onBack = vi.fn();
    const view = mountWithPane(page(onBack), null,
      { host: { pageChrome: { showsTitle: true, publishBack: (press: (() => void) | null) => { published.push(press); } } as never } });
    await flush();
    measure(view, 390);
    expect(view.container.querySelector('[data-testid="entry-page:back"]')).toBeNull();
    published.find((press) => press !== null)?.();
    expect(onBack).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('is the plain page where its list page would split: the detail draws its own header', async () => {
    const view = mountWithPane(page(vi.fn()), null);
    await flush();
    measure(view, 1440);
    expect(view.container.querySelector('[data-testid="context"]')?.textContent).toBe('false:false');
    expect(view.container.querySelector('[role="heading"]')).toBeNull();
    expect(view.container.querySelector('[data-testid="entry-page:back"]')).toBeNull();
    view.unmount();
  });
});
