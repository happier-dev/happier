// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { HAPPIER_STATE_LINE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CustomModal } from '@/modal/components/CustomModal';
import { CapabilityAddModalBody, capabilityAddChrome, type CapabilityAddModalConfig } from './CapabilityAddModal';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, ScrollView, Text } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return createReanimatedModuleMock({ hostComponents: { View, ScrollView, Text } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

// Both device classification and layout read RNW Dimensions. Feed its real DOM
// boundary so they observe the same viewport (62cdaaeafb2).
const viewportProperties = [
    { target: document.documentElement, key: 'clientWidth' },
    { target: document.documentElement, key: 'clientHeight' },
    { target: window.screen, key: 'width' },
    { target: window.screen, key: 'height' },
];
const previousDescriptors = viewportProperties.map(({ target, key }) => Object.getOwnPropertyDescriptor(target, key));
function setViewport(width: number) {
    viewportProperties.forEach(({ target, key }) => Object.defineProperty(target, key, {
        configurable: true, value: key === 'width' || key === 'clientWidth' ? width : 800,
    }));
    window.dispatchEvent(new Event('resize'));
}
afterEach(() => {
    viewportProperties.forEach(({ target, key }, index) => {
        const descriptor = previousDescriptors[index];
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
    });
    window.dispatchEvent(new Event('resize'));
});

type Entry = Readonly<{ name: string; added: boolean }>;
const entries: readonly Entry[] = [
    { name: 'docx', added: false },
    { name: 'pdf', added: true },
    { name: 'webapp-testing', added: false },
];

const config: CapabilityAddModalConfig<Entry> = {
    title: 'Add a skill',
    modes: [{ key: 'browse', label: 'Browse', icon: 'magnifying-glass', kind: 'catalog' }],
    catalog: {
        query: '',
        onQueryChange: () => {},
        searchPlaceholder: 'Search skills',
        items: entries,
        itemKey: (entry) => entry.name,
        anatomy: buildCapabilityCollectionAnatomy<Entry>({
            title: (entry) => entry.name,
            description: () => 'Create and edit documents, with tracked changes and comments, in a long enough line to wrap.',
            // Browse records open their details; Add lives in the detail footer.
            whereSummary: (entry) => (entry.added ? 'Added' : null),
            facts: () => ({}),
            accessibilityLabel: (entry) => entry.name,
            testID: (entry) => `row:${entry.name}`,
        }),
        loading: false,
        empty: null,
    },
    renderDetail: () => null,
    detailFooter: () => ({ primary: { label: 'Add', onPress: async () => null } }),
    testID: 'add',
};

it.each([1440, 390])('lands once on asynchronously admitted results without pushing a phone (%i px)', async (width) => {
    setViewport(width);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const primary = vi.fn(async () => ({ itemId: 'created', then: 'stay' as const }));
    let current: CapabilityAddModalConfig<Entry> = { ...config, catalog: { ...config.catalog, items: [] as readonly Entry[], loading: true },
        renderDetail: (entry: Entry) => <View testID={`preview:${entry.name}`} />,
        detailFooter: () => ({ primary: { label: 'Add', onPress: primary } }),
    };
    let measuredWidth = width;
    const render = async () => {
        await act(async () => root.render(<CustomModal visible onClose={() => {}}
            config={{ id: 'add', type: 'custom', component: CapabilityAddModalBody as never,
                props: { config: current } as never, chrome: capabilityAddChrome(current) }} />));
        // The real modal portals outside the React root, so measure and read its actual document surface.
        await measureWebLayout(document.body, { viewport: { width: measuredWidth, height: 800 }, settle: (replay) => act(replay) });
    };
    const preview = (name: string) => document.body.querySelector(`[data-testid="preview:${name}"]`);
    try {
        await render();
        expect(preview('docx')).toBeNull();
        current = { ...current, catalog: { ...current.catalog, items: entries, loading: false } };
        await render();
        expect(preview('docx') !== null).toBe(width === 1440);
        expect(primary).not.toHaveBeenCalled();
        if (width === 1440) {
            current = { ...current, catalog: { ...current.catalog, items: [...entries].reverse() } };
            await render();
            expect(preview('docx')).not.toBeNull();
            expect(preview('webapp-testing')).toBeNull();
            await act(async () => setViewport(390));
            measuredWidth = 390;
            await render();
            expect(preview('docx')).toBeNull();
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it.each([
    [1440, 24],
    [390, 16],
])('keeps its header and catalog on their responsive edges (%i px: %i px from the card)', async (width, edge) => {
    setViewport(width);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    // One mode has no chooser (717576ac290); this geometry case exercises a
    // real choice so that its tools band is present on both responsive paths.
    const choosing: CapabilityAddModalConfig<Entry> = {
        ...config,
        catalog: { ...config.catalog, groups: [{ key: 'available', title: 'Available skills', itemKeys: entries.map((entry) => entry.name) }] },
        modes: [...config.modes, {
            key: 'url', label: 'From a URL', icon: 'link', kind: 'input', renderBody: () => null,
        }],
    };
    try {
        await act(async () => root.render(
            <CustomModal
                visible
                onClose={() => {}}
                config={{ id: 'add', type: 'custom', component: CapabilityAddModalBody as never, props: { config: choosing } as never, chrome: capabilityAddChrome(choosing) }}
            />,
        ));
        const layout = await measureWebLayout(document.body, { viewport: { width, height: 800 }, texts: ['Add a skill', 'Available skills', 'Added', 'docx'], settle: (replay) => act(replay) });
        const card = layout.rect('modal-card-header');
        const title = layout.textRects('Add a skill').find((rect) => rect.width > 1)!;
        const band = layout.rect('add:mode:browse');
        const close = layout.rect('add:close');
        // The shared Add frame (717576ac290) puts desktop modes beside the
        // title; a phone gives them their own band on the body's content edge.
        if (width === 390) {
            expect.soft(Math.abs(band.left - card.left - 2 - edge)).toBeLessThanOrEqual(2);
            expect.soft(band.top).toBeGreaterThanOrEqual(card.bottom);
        } else {
            expect.soft(band.left).toBeGreaterThan(title.right);
            expect.soft(band.right).toBeLessThan(close.left);
            expect.soft(band.top).toBeLessThan(title.bottom);
            expect.soft(band.bottom).toBeGreaterThan(title.top);
        }
        expect.soft(Math.abs(title.left - card.left - edge)).toBeLessThanOrEqual(2);
        const list = layout.rect('add:list');
        const rowTitle = layout.textRects('docx')[0]!;
        // The desktop catalog is its own side pane (19145ebc224), with its
        // headings on its rows' edge; the phone catalog occupies the whole card.
        expect.soft(Math.abs(rowTitle.left - layout.textRects('Available skills')[0]!.left)).toBeLessThanOrEqual(2);
        expect.soft(rowTitle.left).toBeGreaterThanOrEqual(list.left);
        expect.soft(rowTitle.right).toBeLessThanOrEqual(list.right);
        expect.soft(Math.abs(card.right - close.right - edge)).toBeLessThanOrEqual(2);
        if (width === 390) {
            expect.soft(Math.abs(rowTitle.left - card.left - edge)).toBeLessThanOrEqual(2);
        }
        // The held-state meta remains whole in the list beside its detail.
        const added = layout.textRects('Added')[0]!;
        expect.soft(added.left).toBeGreaterThanOrEqual(rowTitle.left);
        expect.soft(added.right).toBeLessThanOrEqual(list.right);
        expect.soft(added.clipped).toBe(false);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('keeps a failed registry sentence on row titles and Retry on the state-line trailing inset', async () => {
    setViewport(1440);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const failing: CapabilityAddModalConfig<Entry> = {
        ...config,
        catalog: {
            ...config.catalog,
            anatomy: buildCapabilityCollectionAnatomy<Entry>({
                title: (entry) => entry.name,
                description: () => 'Create and edit documents.',
                mark: (entry) => <View testID={`mark:${entry.name}`} style={{ width: 20, height: 20 }} />,
                facts: () => ({}),
                whereSummary: () => 'Built in',
                accessibilityLabel: (entry) => entry.name,
                testID: (entry) => `row:${entry.name}`,
            }),
            sourceFailures: [{ sourceId: 'curated', message: 'Curated marketplace · Couldn’t reach this registry.', onRetry: () => {} }],
        },
    };
    try {
        await act(async () => root.render(
            <CustomModal visible onClose={() => {}}
                config={{ id: 'add', type: 'custom', component: CapabilityAddModalBody as never, props: { config: failing } as never, chrome: capabilityAddChrome(failing) }} />,
        ));
        const sentence = 'Curated marketplace · Couldn’t reach this registry.';
        const layout = await measureWebLayout(document.body, { viewport: { width: 1440, height: 800 }, texts: [sentence, 'docx', 'Retry'], settle: (replay) => act(replay) });
        const rowTitle = layout.textRects('docx')[0]!;
        // Visible text edges; the rows' own focus-ring arithmetic leaves a sub-3 px remainder (was ~20 px).
        expect.soft(Math.abs(layout.textRects(sentence)[0]!.left - rowTitle.left)).toBeLessThanOrEqual(3);
        // The published line anatomy owns its trailing inset. Title meta ends
        // before a separate accessory cell (06f49678e9a), so it is no edge peer.
        // d3bfdb57b1c puts the label here while its hit pad reaches past it.
        const line = layout.rect('add:sourceFailure:curated');
        expect.soft(line.right - layout.textRects('Retry')[0]!.right).toBeCloseTo(HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx, 0);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('opens a listing whose icon row is mark + name, its purpose and facts on the content edge', async () => {
    setViewport(1440);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const { CapabilityDetailHeader } = await import('@/components/capabilities/detail/CapabilityDetailHeader');
    const listing: CapabilityAddModalConfig<Entry> = {
        ...config,
        renderDetail: (entry) => (
            <CapabilityDetailHeader testID="detail-header" title={entry.name}
                mark={<View testID="detail-mark" style={{ width: 28, height: 28 }} />}
                purpose="Create and edit documents with tracked changes."
                facts={{ source: { kind: 'registry', label: 'ACP Registry' }, extra: ['Cognition'] }} />
        ),
    };
    try {
        await act(async () => root.render(
            <CustomModal visible onClose={() => {}}
                config={{ id: 'add', type: 'custom', component: CapabilityAddModalBody as never, props: { config: listing } as never, chrome: capabilityAddChrome(listing) }} />,
        ));
        const purpose = 'Create and edit documents with tracked changes.';
        const layout = await measureWebLayout(document.body, { viewport: { width: 1440, height: 800 }, texts: [purpose, 'ACP Registry', 'docx'], settle: (replay) => act(replay) });
        const mark = layout.rect('detail-mark');
        const title = layout.textRects('docx').find((rect) => rect.left > mark.right)!;
        // The mark centres on the name's line, not on the three-line block.
        expect.soft(Math.abs((mark.top + mark.bottom) / 2 - (title.top + title.bottom) / 2)).toBeLessThanOrEqual(2);
        // Purpose and facts start on the content edge (the icon row's, where the mark's slot starts), under the mark.
        const contentEdge = layout.rect('detail-header-title-row').left;
        expect.soft(Math.abs(layout.textRects(purpose)[0]!.left - contentEdge)).toBeLessThanOrEqual(1);
        expect.soft(Math.abs(layout.textRects('ACP Registry')[0]!.left - contentEdge)).toBeLessThanOrEqual(1);
        expect.soft(mark.left - contentEdge).toBeLessThanOrEqual(8);
        expect.soft(layout.textRects(purpose)[0]!.top).toBeGreaterThan(mark.bottom - 2);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
