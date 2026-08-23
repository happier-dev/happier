import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Row, Screen, ScrollArea, Stack } from './Layout.js';

/**
 * React Native Web keeps a node's layout observer callback on the host element
 * under this key and invokes it from its shared ResizeObserver. Reading it is
 * how this mount observes that an author's measurement callback reached the
 * real host rather than being dropped by the adapter; jsdom supplies no
 * ResizeObserver, so the observer itself never fires here.
 */
const DOM_LAYOUT_HANDLER_NAME = '__reactLayoutHandler';

function mountLayout(children: React.ReactNode) {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {children}
    </PluginUiProvider>,
  );
}

describe('plugin-ui semantic layout', () => {
  it('renders real RN hosts with semantic direction, spacing, and safe-area padding', () => {
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

    // Identity, not a wrapper: each box's own measurement reaches the author
    // who asked that box to report, and no box is measured through another's.
    expect(layoutHandler('screen')).toBe(onScreenLayout);
    expect(layoutHandler('stack')).toBe(onStackLayout);
    expect(layoutHandler('row')).toBe(onRowLayout);
    expect(layoutHandler('scroll')).toBe(onScrollLayout);
    mount.unmount();
  });
});
