import { afterEach, expect, it, vi } from 'vitest';

import { Button } from './Button.js';
import { Row, ScrollArea } from './Layout.js';
import { Menu } from './Overlay.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { hitAreaClippingAncestors, readHitAreaReach } from '../presentation/interaction/hitArea.testSupport.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';

afterEach(() => vi.unstubAllGlobals());

it('bounds a coarse-pointer action band at the scroll content edge', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }));
  const context = createSurfaceContext({ platform: 'web' });
  const mount = mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ScrollArea clipContentOverflow testID="header-scroll">
        <Row>
          <Button title="Investigate" size="small" onPress={() => {}} />
          <Menu open={false} onOpenChange={() => {}} trigger="Investigate options"
            triggerAppearance="primary" triggerSize="small" triggerJoinedEdge="start"
            triggerAccessibilityLabel="Investigate options" items={[]} onSelect={() => {}} />
        </Row>
      </ScrollArea>
    </PluginUiProvider>,
  );
  try {
    const viewport = mount.container.querySelector<HTMLElement>('[data-testid="header-scroll"]')!;
    for (const name of ['Investigate', 'Investigate options']) {
      const control = viewport.querySelector<HTMLElement>(`[role="button"][aria-label="${name}"]`)!;
      expect(readHitAreaReach(control)?.bottom).toBeGreaterThan(0);
      const [boundary] = hitAreaClippingAncestors(control, viewport);
      expect(boundary).toBe(viewport.firstElementChild);
      expect(getComputedStyle(boundary!).overflowY).toBe('clip');
    }
    expect(getComputedStyle(viewport).overflowY).toBe('auto');
  } finally {
    mount.unmount();
  }
});
