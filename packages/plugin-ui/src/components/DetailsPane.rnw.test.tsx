import { act, useSyncExternalStore, type ReactNode } from 'react';
import { Text as RNText } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { usePluginHostApi } from '../hostApi/context.js';
import type {
  PluginUiDetailsPaneHost,
  PluginUiDetailsPanePresentation,
  PluginUiPresentationHost,
} from '../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { DetailsPane } from './DetailsPane.js';
import { PluginUiProviderInternal, usePluginTheme, usePluginTranslation, useSurfaceContext } from './PluginUiProvider.js';
import { Text } from './Text.js';

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

function mountWithPane(children: ReactNode, pane: ReturnType<typeof createPaneHost> | null) {
  const context = createSurfaceContext();
  const presentationHost = {
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...(pane ? { detailsPane: pane.binding } : {}),
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
