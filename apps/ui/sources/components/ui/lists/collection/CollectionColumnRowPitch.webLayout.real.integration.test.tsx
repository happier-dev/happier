// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

installWebLayoutBridge();

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
});

/**
 * Owner 2026-11-15 (A5, ade8e626): the Machines column's Defaults, Updates and Activity each stood taller than the
 * Overview above them, because a column's catalog row kept the described floor without a line beneath. A row's
 * height follows its content: undescribed, it takes the column's one-line pitch; described, it keeps the floor.
 */
it('gives an undescribed catalog row in a column the one-line pitch and keeps the floor for a described one', async () => {
    const { CollectionList } = await import('./CollectionList');
    const { CollectionIndexRow } = await import('./CollectionIndexRow');
    const { Item } = await import('@/components/ui/lists/Item');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(
        <CollectionList testID="column" title="Machines" surface="plane">
            <CollectionIndexRow testID="overview" selected={false} onPress={() => {}} />
            <Item testID="defaults" rowRole="catalogRow" title="Defaults" density="compact" showChevron={false} onPress={() => {}} />
            <Item testID="described" rowRole="catalogRow" title="Build box" subtitle="Online · 4 cores" density="compact"
                showChevron={false} onPress={() => {}} />
        </CollectionList>,
    ));
    const layout = await measureWebLayout(host, { viewport: { width: 280, height: 600 }, settle: replay => act(replay) });
    const overview = layout.rect('overview').height;
    expect(overview).toBeGreaterThan(0);
    expect(Math.abs(layout.rect('defaults').height - overview)).toBeLessThanOrEqual(0.5);
    expect(layout.rect('described').height).toBeGreaterThan(overview + 4);
});
