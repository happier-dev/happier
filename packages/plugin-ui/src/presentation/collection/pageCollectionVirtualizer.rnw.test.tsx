import { act } from 'react';
import { Text } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import type { PluginUiScrollActivityTracker } from '../../presentationHost/scrollActivity.js';
import type { CollectionVirtualizerRequest } from './collectionVirtualizer.js';
import { PageCollectionVirtualizer } from './pageCollectionVirtualizer.js';

describe('page collection initial geometry', () => {
  it('paints its first window at the page top before the page position is known, and keeps it once placed', async () => {
    // Physical page measurement is the asynchronous platform boundary.
    let resolveSpan!: (span: Readonly<{ top: number }>) => void;
    const measured = new Promise<Readonly<{ top: number }>>(resolve => { resolveSpan = resolve; });
    const viewport = { top: 0, bottom: 844 };
    const tracker: PluginUiScrollActivityTracker = {
      onScroll() {}, onLayout() {}, onContentSizeChange() {},
      subscribe: () => () => {}, getWindow: () => viewport,
      measureSpan: () => measured, invalidateLayout() {}, getLayoutRevision: () => 0,
    };
    const request: CollectionVirtualizerRequest<string> = {
      kind: 'sections', sections: [{ key: 'monitoring', title: 'Monitoring', data: ['uptime'] }],
      keyForItem: item => item,
      renderItem: () => <Text testID="row">Uptime Kuma</Text>,
      renderSectionHeader: () => <Text testID="heading">Monitoring</Text>,
      onHandle() {}, role: 'list',
    };
    const mount = mountThroughReactNativeWeb(<PageCollectionVirtualizer request={request} tracker={tracker}
      geometry={{ rowHeight: () => 72, headerHeight: 40, width: 390, defaultRowHeight: 72 }} tabStopKey="uptime" />);
    try {
      // One rule with the page grid: until the page places the list, it stands at the page's top.
      expect([...mount.container.querySelectorAll('[data-testid]')].map(node => node.textContent))
        .toEqual(['Monitoring', 'Uptime Kuma']);
      await act(async () => { resolveSpan({ top: 100 }); await measured; });
      expect([...mount.container.querySelectorAll('[data-testid]')].map(node => node.textContent))
        .toEqual(['Monitoring', 'Uptime Kuma']);
    } finally {
      mount.unmount();
    }
  });
});
