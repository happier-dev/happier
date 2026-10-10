// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { Collection, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PluginsPageCollection } from '@/components/settings/plugins/collection/PluginsPageCollection';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { getStorage } from '@/sync/domains/state/storage';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';
import { CoreCollectionScope } from './CoreCollectionScope';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

const items = [{ key: 'a', group: 'first', title: 'First item' }, { key: 'b', group: 'second', title: 'Second item' }];
type Entry = typeof items[number];
const anatomy: CollectionAnatomy<Entry> = {
    glyph: (item) => <View testID={`mark:${item.key}`} style={{ width: 18, height: 18 }} />,
    title: (item) => item.title,
    accessibilityLabel: (item) => item.title,
    columnTitles: { title: 'Name' },
};
const groups = {
    groupOf: (item: Entry) => item.group,
    axis: [{ key: 'first', title: 'First section' }, { key: 'second', title: 'Second section' }],
};
const keyOf = (item: Entry) => item.key;
function PageContents({ children }: { children: React.ReactNode }) {
    const maxWidth = useLayoutMaxWidth();
    return <View style={{ width: '100%', maxWidth, alignSelf: 'center' }}>
        <PageHeader title="Collection page" />
        {children}
        <ItemGroup title="Neighbor section" surface="none"><View /></ItemGroup>
    </View>;
}
const renderPageScroller = (children: React.ReactNode) => (
    <ItemList>
        <PageContents>{children}</PageContents>
    </ItemList>
);

function PageList() {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' } });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page" />
    </CoreCollectionScope>;
}

function PluginsList() {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' } });
    return <PluginsPageCollection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list"
        header={<PageHeader title="Collection page" />}
        footer={<ItemGroup title="Neighbor section" surface="none"><View /></ItemGroup>}
        testID="plugins-page" />;
}

it.each([
    [1440, 'Core page', PageList], [390, 'Core page', PageList],
    [1440, 'Plugins page', PluginsList], [390, 'Plugins page', PluginsList],
] as const)('aligns page-list section headings and row marks at %i px through %s', async (width, _surfaceName, Surface) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width }}><Surface /></View>));
        const headings = ['Collection page', 'First section', 'Second section', 'Neighbor section'];
        const layout = await measureWebLayout(host, { viewport: { width, height: 1200 }, texts: headings, settle: (replay) => act(replay) });
        const edge = layout.textRects('Neighbor section')[0]!.left;
        for (const heading of headings) {
            expect.soft(Math.abs(layout.textRects(heading)[0]!.left - edge), heading).toBeLessThanOrEqual(1);
        }
        for (const item of items) {
            expect.soft(Math.abs(layout.rect(`mark:${item.key}`).left - edge), item.title).toBeLessThanOrEqual(1);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([1440, 390])('keeps the Artifacts list sheet on the page edge at %i px', async (width) => {
    const { ArtifactsBrowser } = await import('@/components/artifacts/ArtifactsBrowserScreen');
    const initialState = getStorage().getState();
    const artifact: DecryptedArtifact = {
        id: 'layout-note', title: 'Layout note', isDecrypted: true,
        header: { title: 'Layout note' }, headerVersion: 1, bodyVersion: 1,
        seq: 1, body: 'A note', createdAt: 1, updatedAt: 1, access: 'owner', storageMode: 'plain',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        getStorage().setState({ localSettings: { ...initialState.localSettings, artifactsBrowserViewV1: { presentation: 'list' } } });
        await act(async () => root.render(<View style={{ width }}><AppPaneProvider>
            <ArtifactsBrowser artifacts={[artifact]} loaded loadFailed={false} onRetry={() => {}} usage={null} />
        </AppPaneProvider></View>));
        const title = t('artifacts.title');
        const layout = await measureWebLayout(host, { viewport: { width, height: 1200 }, texts: [title], settle: (replay) => act(replay) });
        // A row's border is one hairline before its mark, which shares the header's page edge.
        expect(Math.abs(layout.rect('artifacts:row:layout-note').left + 1 - layout.textRects(title)[0]!.left)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
        getStorage().setState(initialState, true);
    }
});

it.each([1440, 390])('keeps a nested Managed size table on its enclosing page-sheet edge at %i px', async (width) => {
    const { ManagedSizeTable } = await import('@/components/settings/machines/managed/ManagedChoiceSections');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width }}><ItemList>
            <ItemGroup title="Size choices"><ManagedSizeTable
                sizes={[{ id: 'small', name: 'Small', cpu: '2 cores', memory: '4 GB', disk: '40 GB', spec: '2 cores · 4 GB' }]}
                value="small" onChange={() => {}} testID="managed-layout" />
            </ItemGroup>
        </ItemList></View>));
        const layout = await measureWebLayout(host, { viewport: { width, height: 1200 }, texts: ['Size choices'], settle: replay => act(replay) });
        const stage = layout.rect('managed-layout:stage');
        expect(Math.abs(stage.left - layout.textRects('Size choices')[0]!.left)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
