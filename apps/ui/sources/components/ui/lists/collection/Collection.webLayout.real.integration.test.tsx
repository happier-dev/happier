// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { Collection, CollectionToolbar, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidth } from '@/components/ui/layout/layout';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PLUGIN_CARD_MIN_WIDTH_PX, PluginsPageCollection } from '@/components/settings/plugins/collection/PluginsPageCollection';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
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
const neighborSection = <ItemGroup title="Neighbor section"><Item title="Neighbor item"
    icon={<View testID="neighbor-mark" style={{ width: 18, height: 18 }} />} /></ItemGroup>;
function PageContents({ children }: { children: React.ReactNode }) {
    const maxWidth = useLayoutMaxWidth();
    return <View style={{ width: '100%', maxWidth, alignSelf: 'center' }}>
        <PageHeader title="Collection page" />
        {children}
        {neighborSection}
    </View>;
}
const renderPageScroller = (children: React.ReactNode) => (
    <ItemList>
        <PageContents>{children}</PageContents>
    </ItemList>
);

function PageList() {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page"
            minListWidth={PLUGIN_CARD_MIN_WIDTH_PX} minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX} preferredListRatio={0.5} />
    </CoreCollectionScope>;
}

function PluginsList() {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <PluginsPageCollection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list"
        header={<PageHeader title="Collection page" />}
        footer={neighborSection}
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
            // Page lists now draw sheet rows (b65a1bf2dfc5), with their marks inside
            // the sheet. Compare peer row marks, separately from section headings.
            expect.soft(Math.abs(layout.rect(`mark:${item.key}`).left - layout.rect('neighbor-mark').left), item.title).toBeLessThanOrEqual(1);
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
        await act(async () => root.render(<InjectedAuthProvider credentials={null}><View style={{ width }}><AppPaneProvider>
            <ArtifactsBrowser artifacts={[artifact]} loaded loadFailed={false} onRetry={() => {}} usage={null} />
        </AppPaneProvider></View></InjectedAuthProvider>));
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

// An authored name is read whole on a page list and on its title, even when a phone at 200% text leaves
// 195 CSS px (FIN-QA-LARGETEXT T1): the row and the title grow instead of cutting the name.
const longItems = [{ key: 'long', group: 'first', title: 'FIN-QA-VARIANTS-B-1112 dispose of the retired staging Machine and its volumes' }];
function LongNameList() {
    const model = useHappierCollection({ items: longItems, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={longAnatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page"
            minListWidth={PLUGIN_CARD_MIN_WIDTH_PX} minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX} preferredListRatio={0.5} />
    </CoreCollectionScope>;
}
// A Library row: its name, then where it runs (lab two-line resting row).
const longAnatomy: CollectionAnatomy<Entry> = { ...anatomy, where: () => '3 steps · On a schedule' };

it('keeps a long authored row name and the collection title whole at 195 px', async () => {
    const { CollectionTitleButton } = await import('./CollectionTitleButton');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width: 195 }}>
            <View style={{ flexDirection: 'row', paddingHorizontal: 16 }}>
                <CollectionTitleButton testID="space-title" label="All workflows" accessibilityLabel="All workflows"
                    expanded={false} hasPopup="menu" onPress={() => {}} scale="page" />
            </View>
            <LongNameList />
        </View>));
        const texts = [longItems[0]!.title, 'All workflows'];
        const layout = await measureWebLayout(host, { viewport: { width: 195, height: 1600 }, texts, settle: (replay) => act(replay) });
        for (const text of texts) {
            const rects = layout.textRects(text);
            expect(rects.length, text).toBeGreaterThan(0);
            for (const rect of rects) {
                expect(rect.clipped, `${text}: ${JSON.stringify(rect)}`).toBe(false);
                expect(rect.right, text).toBeLessThanOrEqual(195);
            }
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

// A lens wider than its share of the folded toolbar's line (here: all but 40 px of it) (Triage Tasks: Mine · Agents · Everyone and Views,
// DESIGN-ACCEPT-209 at 308 px) gives the arrangement switch the next line instead of having it drawn over it.
function WideLensList({ lensWidth }: { lensWidth: number }) {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page"
            minListWidth={PLUGIN_CARD_MIN_WIDTH_PX} minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX} preferredListRatio={0.5}
            header={(slots) => <CollectionToolbar slots={slots} testID="toolbar"
                lens={<View testID="wide-lens" style={{ width: lensWidth, height: 28 }} />}
                views={{ label: 'Arrange', value: 'list', onChange: () => {},
                    options: [{ value: 'list', label: 'List', icon: 'list', testID: 'view:list' },
                        { value: 'board', label: 'Board', icon: 'board', testID: 'view:board' }] }} />} />
    </CoreCollectionScope>;
}

it.each([308, 390])('keeps the arrangement switch clear of a wide lens in the folded toolbar at %i px', async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width }}><WideLensList lensWidth={width - 40} /></View>));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 }, settle: (replay) => act(replay) });
        const lens = layout.rect('wide-lens');
        const toolbar = layout.rect('toolbar');
        for (const text of ['view:list', 'view:board']) {
            const rect = layout.rect(text);
            const overlaps = rect.left < lens.right && rect.right > lens.left && rect.top < lens.bottom && rect.bottom > lens.top;
            expect(overlaps, `${text} ${JSON.stringify(rect)} over lens ${JSON.stringify(lens)}`).toBe(false);
            expect(rect.right, text).toBeLessThanOrEqual(toolbar.right + 1);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

// A list narrowed beside a detail pane (Triage Tasks at 1440, DESIGN-ACCEPT-209): the page's name beside the search
// left the field about 70 px ("Searc"). The name takes its own line instead, so the search keeps a readable width.
function TitledSearchList() {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page"
            minListWidth={PLUGIN_CARD_MIN_WIDTH_PX} minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX} preferredListRatio={0.5}
            search={{ label: 'Search tasks', value: '', onValueChange: () => {}, testID: 'search' }}
            header={(slots) => <CollectionToolbar slots={{ ...slots, title: <View testID="page-name" style={{ width: 165, height: 32 }} /> }}
                testID="toolbar" lens={<View style={{ width: 200, height: 28 }} />}
                primary={{ label: 'New task', onPress: () => {} }}
                more={{ label: 'More', items: [{ id: 'refresh', label: 'Refresh' }], onSelect: () => {} }} />} />
    </CoreCollectionScope>;
}

it.each([400, 780])('gives the search a readable width beside a page name in the folded toolbar at %i px', async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width }}><TitledSearchList /></View>));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 }, settle: (replay) => act(replay) });
        const field = layout.rect('search.field');
        const name = layout.rect('page-name');
        expect(field.width, JSON.stringify(field)).toBeGreaterThanOrEqual(220);
        // Neither is drawn over the other; with room for both, the name stays on the search's line.
        expect(field.top >= name.bottom || field.left >= name.right).toBe(true);
        if (width === 780) expect(field.top).toBeLessThan(name.bottom);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
