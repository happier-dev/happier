import { act, createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { ScrollArea } from '../../components/Layout.js';
import { PluginUiProvider } from '../../components/PluginUiProvider.js';
import { Tabs } from '../../components/Tabs.js';
import {
  PluginUiPresentationHostProviderInternal,
  type PluginUiPresentationHost,
} from '../../presentationHost/context.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  createHostApiStub,
  createSurfaceContext,
} from '../../surfaceFixture.testSupport.js';

function scrollTo(element: Element, top: number) {
  act(() => {
    (element as HTMLElement).scrollTop = top;
    element.dispatchEvent(new Event('scroll', { bubbles: false }));
  });
}

type Reporter = (distancePx: number) => void;

/**
 * The host's scroll-shade channels (a genuine host boundary: the app owns the shade and its channel). Each
 * scope is a context value, as the app's pane header scope is.
 */
function createHost(
  paneReported: number[],
  stripReported: number[],
): PluginUiPresentationHost {
  const Channel = createContext<Reporter | null>((distancePx) =>
    paneReported.push(distancePx),
  );
  const stripReporter: Reporter = (distancePx) =>
    stripReported.push(distancePx);
  function Scope(
    props: Readonly<{ passThrough: boolean; children: ReactNode }>,
  ) {
    const outer = useContext(Channel);
    return (
      <Channel.Provider value={props.passThrough ? outer : stripReporter}>
        {props.children}
      </Channel.Provider>
    );
  }
  return {
    paneHeaderScroll: {
      useReporter: () => useContext(Channel),
      renderBandScope: (input) => (
        <Scope passThrough={input.passThrough}>{input.children}</Scope>
      ),
      renderBandShade: () => <View testID="band-shade" />,
    },
  };
}

function mount(layout: 'fill' | 'content', host: PluginUiPresentationHost) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <PluginUiPresentationHostProviderInternal host={host}>
        <Tabs
          value="overview"
          onValueChange={() => {}}
          ariaLabel="Entry"
          layout={layout}
        >
          <Tabs.Item value="overview" title="Overview">
            <ScrollArea testID="panel-body" />
          </Tabs.Item>
          <Tabs.Item value="files" title="Files">
            {null}
          </Tabs.Item>
        </Tabs>
      </PluginUiPresentationHostProviderInternal>
    </PluginUiProvider>,
  );
}

describe('a tab strip standing over its bounded panels', () => {
  it('takes the scroll shade under the strip, so the panel body never shades the pane header above the tabs', () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
    const pane: number[] = [];
    const strip: number[] = [];
    const view = mount('fill', createHost(pane, strip));
    for (const top of [0, 8])
      scrollTo(
        view.container.querySelector('[data-testid="panel-body"]')!,
        top,
      );
    expect(strip).toEqual([0, 8]);
    expect(pane).toEqual([]);
    expect(
      view.container.querySelectorAll('[data-testid="band-shade"]'),
    ).toHaveLength(1);
    view.unmount();
    clock.mockRestore();
  });

  it('leaves a strip that scrolls with its content to the pane header', () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (now += 50));
    const pane: number[] = [];
    const strip: number[] = [];
    const view = mount('content', createHost(pane, strip));
    for (const top of [0, 8])
      scrollTo(
        view.container.querySelector('[data-testid="panel-body"]')!,
        top,
      );
    expect(pane).toEqual([0, 8]);
    expect(strip).toEqual([]);
    view.unmount();
    clock.mockRestore();
  });
});
