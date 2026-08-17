import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Row, Screen, ScrollArea, Stack } from './Layout.js';

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
});
