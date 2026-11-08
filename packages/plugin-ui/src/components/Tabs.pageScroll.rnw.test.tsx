import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Tabs } from './Tabs.js';
import { List } from './List.js';
import { Text } from './Text.js';
import { PluginUiProvider } from './PluginUiProvider.js';

const ROWS = Array.from({ length: 80 }, (_unused, index) => ({ id: `row-${index}`, title: `Row ${index}` }));

/** `layout="page"` chooses List's existing page-scroll mode: the rows scroll with the page around them (D21). */
describe('Tabs page layout', () => {
  it.each(['page', 'fill'] as const)('lays a panel List out for a %s layout', async (layout) => {
    const mount = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(createSurfaceContext())} context={createSurfaceContext()}>
        <Tabs value="events" onValueChange={() => {}} ariaLabel="Detail" layout={layout}>
          <Tabs.Item value="events" title="Events">
            <List accessibilityLabel="Events" items={ROWS} keyForItem={(row) => row.id}
              header={<Text value="Selected event" />}
              renderItem={(row) => <Text value={row.title} />} />
          </Tabs.Item>
        </Tabs>
      </PluginUiProvider>,
    );
    try {
      for (let tick = 0; tick < 3; tick += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const list = mount.container.querySelector('[role="list"]') as HTMLElement | null;
      expect(list).not.toBeNull();
      const rows = (mount.container.textContent ?? '').match(/Row \d+/g)?.length ?? 0;
      // A page-scrolling List is the page's own content: every row is laid out in it, none behind a nested scroller.
      if (layout === 'page') {
        expect(rows).toBe(ROWS.length);
        expect(['auto', 'scroll']).not.toContain(getComputedStyle(list!).overflowY);
      } else {
        // A bounded List keeps its own windowed scroller.
        expect(rows).toBeGreaterThan(0);
        expect(rows).toBeLessThan(ROWS.length);
      }
    } finally { mount.unmount(); }
  });
});
