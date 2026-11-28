// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { Button, Collection, CollectionToolbar, Item as PluginItem, ItemGroup as PluginItemGroup, RowStatusLine, Select, Text as PluginText, useHappierCollection, type CollectionAnatomy } from '@happier-dev/plugin-ui';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

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

it.each([390, 1440])('keeps a source status together and aligns wrapped actions at %i px', async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const title = 'Example Workspace';
    const status = 'Not read · Trying again won’t fix this. Details has what support needs.';
    try {
        await act(async () => root.render(<View style={{ width }}><CoreCollectionScope renderPageScroller={renderPageScroller}>
            <PluginItemGroup title="Configured sources">
                <PluginItem title={title} subtitle="Bitbucket Cloud · example workspace"
                    icon={<View style={{ width: 16, height: 16 }} />}
                    accessory={<Button variant="plain" title="Fix" testID="source-fix" onPress={() => {}} />}
                    secondaryActions={[{ id: 'details', label: 'Details' }]} onSecondaryAction={() => {}}>
                    <RowStatusLine tone="warn" numberOfLines={3} text={status} testID="source-status" />
                </PluginItem>
            </PluginItemGroup>
        </CoreCollectionScope></View>));
        const statusLine = host.querySelector('[data-testid="source-status"]')!;
        statusLine.firstElementChild!.setAttribute('data-testid', 'source-status-dot');
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 }, texts: [title, status, 'Fix'], settle: replay => act(replay) });
        const dot = layout.rect('source-status-dot');
        const words = layout.textRects(status)[0]!;
        const firstLine = words.textFragments?.[0] ?? words;
        const titleBox = layout.textRects(title)[0]!;
        const fix = layout.textRects('Fix')[0]!;
        expect.soft(dot.top + dot.height / 2).toBeGreaterThan(firstLine.top);
        expect.soft(dot.top + dot.height / 2).toBeLessThan(firstLine.bottom);
        expect.soft(dot.right).toBeLessThanOrEqual(firstLine.left);
        expect.soft(layout.rect('source-status').left).toBeCloseTo(titleBox.left, 0);
        if (width === 390) {
            expect.soft(fix.left).toBeCloseTo(titleBox.left, 0);
            expect.soft(fix.top).toBeGreaterThanOrEqual(words.bottom);
        } else {
            expect.soft(fix.left).toBeGreaterThan(titleBox.left);
            expect.soft(fix.top).toBeLessThan(words.bottom);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([
    { tasks: true, attention: '8 sources need attention.' },
    { tasks: false, attention: '8 sources need attention.' },
    { tasks: false, attention: 'Happier exceptions could not be read. Their entries may be missing or out of date.' },
])('keeps the 1440 px toolbar height when freshness arrives (Tasks=$tasks, $attention)', async ({ tasks, attention }) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const noop = () => {};
    const render = (label?: string) => <View style={{ width: 1300 }}><CoreCollectionScope renderPageScroller={renderPageScroller}>
        <CollectionToolbar testID="toolbar" slots={{
            title: <Select label="Page" presentation="segmented" value={tasks ? 'tasks' : 'prs'} onChange={noop}
                options={[{ value: 'tasks', label: 'Tasks' }, { value: 'prs', label: 'PRs & Issues' }]} />,
            search: <View style={{ flexGrow: 1, flexBasis: HAPPIER_PAGE_METRICS.toolbarSearchMinWidthPx, height: 32, maxWidth: 380 }} />,
            selection: null,
            pageActions: <View style={{ width: 248, height: 32 }} />,
        }}
            scope={tasks ? <Select label="Show tasks" presentation="segmented" value="mine" onChange={noop}
                options={[{ value: 'mine', label: 'Mine' }, { value: 'agents', label: 'Agents' }, { value: 'everyone', label: 'Everyone' }]} /> : undefined}
            lens={<Button title="Views" variant="plain" onPress={noop} />}
            freshness={label === undefined ? null : {
                label, tone: 'muted', indicator: true, foldedItemId: 'manage-sources',
                action: <Button variant="plain" size="small" testID="manage-sources" accessibilityLabel="Manage sources" onPress={noop}>
                    <PluginText variant="meta" tone="secondary" value="Manage sources" />
                </Button>,
            }}
            refresh={{ label: 'Refresh', busy: label === undefined, onPress: noop }}
            more={{ label: 'More', items: [{ id: 'organize-list', label: 'Organize list' },
                { id: 'configure-actions', label: 'Configure actions' }, { id: 'manage-sources', label: 'Manage sources' }], onSelect: noop }}
            views={{ label: 'View', value: 'list', onChange: noop, options: [{ value: 'list', label: 'List', icon: 'list' },
                { value: 'board', label: 'Board', icon: 'board' }] }}
            primary={tasks ? { label: 'New task', testID: 'new-task', onPress: noop } : undefined}
        />
    </CoreCollectionScope></View>;
    const visible = attention.slice(0, -1);
    const layout = { viewport: { width: 1440, height: 900 }, texts: [visible, 'Manage sources'] };
    try {
        await act(async () => root.render(render()));
        const before = await measureWebLayout(host, layout);
        await act(async () => root.render(render(attention)));
        const first = await measureWebLayout(host, layout);
        const settled = await measureWebLayout(host, { ...layout, settle: replay => act(replay) });
        expect(first.rect('toolbar').height).toBe(before.rect('toolbar').height);
        expect(settled.rect('toolbar').height).toBe(first.rect('toolbar').height);
        const action = settled.rect('manage-sources');
        const copy = settled.textRects(visible)[0]!;
        expect(action.right).toBeLessThanOrEqual(settled.rect('toolbar').right);
        expect(action.clipped).toBe(false);
        expect(copy.right).toBeLessThan(action.left);
        expect(copy.top).toBeLessThan(action.bottom);
        expect(copy.bottom).toBeGreaterThan(action.top);
        if (attention.startsWith('Happier')) expect(copy.clipped).toBe(true);
        if (tasks) expect(settled.rect('new-task').text).toBe('New task');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

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
] as const)('aligns page-list headings and row marks with their page anatomy at %i px through %s', async (width, _surfaceName, Surface) => {
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
            const mark = layout.rect(`mark:${item.key}`);
            if (width === 390) {
                // Phone browse rows lie on the page text edge (owner 2026-11-15, 4b3117307f46),
                // with their glyph centred in the shared leading column; configuration rows keep their sheet inset.
                const leadingColumnCenter = edge + HAPPIER_PAGE_METRICS.rowLeadingColumnPx / 2;
                expect.soft(Math.abs(mark.left + mark.width / 2 - leadingColumnCenter), item.title).toBeLessThanOrEqual(1);
            } else {
                expect.soft(Math.abs(mark.left - layout.rect('neighbor-mark').left), item.title).toBeLessThanOrEqual(1);
            }
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
        getStorage().setState({ settings: { ...initialState.settings,
            collectionDisplayPreferencesV1: { ...initialState.settings.collectionDisplayPreferencesV1,
                artifact: { ...initialState.settings.collectionDisplayPreferencesV1.artifact, presentation: 'list' } } } });
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

// One title control shows several names in turn (a phone's Workflows · Runs switch keeps the same Space title in
// place): each name decides its own step, so a short name after a longer one keeps the phone's hero size.
it('keeps the hero title step when a phone title changes to a name that fits', async () => {
    const { HappierCollectionTitleButton } = await import('@happier-dev/plugin-ui/presentation');
    const { collectionTitleStyles } = await import('./CollectionTitleButton');
    const { Text } = await import('@/components/ui/text/Text');
    const title = (label: string) => <View style={{ width: 390 }}>
        <View style={{ flexDirection: 'row', paddingHorizontal: 16 }}>
            <HappierCollectionTitleButton testID="space-title" label={label} accessibilityLabel={label} expanded={false}
                hasPopup="menu" onPress={() => {}} scale="page" phone styles={collectionTitleStyles} Text={Text} chevron={null} />
        </View>
    </View>;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(title('All workflows')));
        const first = await measureWebLayout(host, { viewport: { width: 390, height: 400 }, texts: ['All workflows'], settle: (replay) => act(replay) });
        const heroSize = first.textRects('All workflows')[0]?.fontSize;
        await act(async () => root.render(title('All runs')));
        const second = await measureWebLayout(host, { viewport: { width: 390, height: 400 }, texts: ['All runs'], settle: (replay) => act(replay) });
        expect(heroSize).toBeGreaterThan(20);
        expect(second.textRects('All runs')[0]?.fontSize).toBe(heroSize);
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

// Triage Tasks on a phone (TRIAGE-DESIGN-ACCEPT-250 F9): the page switch and Views, whose tasks (Mine · Agents ·
// Everyone), and List | Board took three toolbar lines, the last one holding the switch alone. The scope takes the line
// under the lens, so the arrangement switch stays with the lens and the toolbar is two lines.
function ScopedList({ lensWidth }: { lensWidth: number }) {
    const model = useHappierCollection({ items, keyOf, groups, window: { kind: 'complete' }, openKey: null, onOpenChange: () => {} });
    return <CoreCollectionScope renderPageScroller={renderPageScroller}>
        <Collection model={model} anatomy={anatomy} accessibilityLabel="Entries" presentation="list" detail="none" scroll="page"
            minListWidth={PLUGIN_CARD_MIN_WIDTH_PX} minDetailWidth={PLUGIN_CARD_MIN_WIDTH_PX} preferredListRatio={0.5}
            header={(slots) => <CollectionToolbar slots={slots} testID="toolbar"
                lens={<View testID="lens" style={{ width: lensWidth, height: 32 }} />}
                scope={<View testID="scope" style={{ width: 208, height: 32 }} />}
                views={{ label: 'Arrange', value: 'list', onChange: () => {},
                    options: [{ value: 'list', label: 'List', icon: 'list', testID: 'view:list' },
                        { value: 'board', label: 'Board', icon: 'board', testID: 'view:board' }] }} />} />
    </CoreCollectionScope>;
}

it.each([
    { where: 'a phone (its scope takes the line under the lens)', width: 390, lensWidth: 226, beside: false },
    { where: 'a narrowed wide list (its scope stays beside the lens)', width: 700, lensWidth: 60, beside: true },
])('keeps the arrangement switch on the lens line beside a scope on $where', async ({ width, lensWidth, beside }) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<View style={{ width }}><ScopedList lensWidth={lensWidth} /></View>));
        const layout = await measureWebLayout(host, { viewport: { width, height: 900 }, settle: (replay) => act(replay) });
        const lens = layout.rect('lens');
        const scope = layout.rect('scope');
        const board = layout.rect('view:board');
        expect(board.top, JSON.stringify({ lens, board })).toBeLessThan(lens.bottom);
        expect(scope.top < lens.bottom && scope.bottom > lens.top, JSON.stringify({ lens, scope })).toBe(beside);
        if (!beside) expect(scope.top).toBeGreaterThanOrEqual(board.bottom);
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
