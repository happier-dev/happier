// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CustomModal } from '@/modal/components/CustomModal';
import { CapabilityAddModalBody, capabilityAddChrome, type CapabilityAddModalConfig } from './CapabilityAddModal';

// The window's size is the platform boundary: jsdom has no viewport for react-native-web to read, so the test sets it.
const viewport = vi.hoisted(() => ({ width: 1440 }));
vi.mock('react-native', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('react-native-web')),
    useWindowDimensions: () => ({ width: viewport.width, height: 800, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

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
            // A row that was already added says so at its title line's end and has no button; the others carry one.
            whereSummary: (entry) => (entry.added ? 'Added' : null),
            action: (entry) => (entry.added ? null : <View testID={`add-button:${entry.name}`} style={{ width: 56, height: 28 }} />),
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
    viewport.width = width;
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
            viewport.width = 390;
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
])('puts the dialog title, tools band and rows on one edge (%i px: %i px from the card)', async (width, edge) => {
    viewport.width = width;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <CustomModal
                visible
                onClose={() => {}}
                config={{ id: 'add', type: 'custom', component: CapabilityAddModalBody as never, props: { config } as never, chrome: capabilityAddChrome(config) }}
            />,
        ));
        const layout = await measureWebLayout(document.body, { viewport: { width, height: 800 }, texts: ['Add a skill', 'Added', 'docx'], settle: (replay) => act(replay) });
        const card = layout.rect('modal-card-header');
        const title = layout.textRects('Add a skill').find((rect) => rect.width > 1)!;
        const band = layout.rect('add:mode:browse');
        const close = layout.rect('add:close');
        // The first tab sits a segmented-bar padding inside the band's edge; the title and the rows' text sit on it.
        const bandEdge = band.left - card.left - 2;
        expect.soft(Math.abs(bandEdge - edge)).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(title.left - card.left - edge)).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(layout.textRects('docx')[0]!.left - card.left - edge)).toBeLessThanOrEqual(2);
        // The close button keeps the same inset at the other end, and the rows' trailing controls end on it.
        expect.soft(Math.abs(card.right - close.right - edge)).toBeLessThanOrEqual(2);
        expect.soft(Math.abs(card.right - layout.rect('add-button:docx').right - edge)).toBeLessThanOrEqual(2);
        const added = layout.textRects('Added')[0]!;
        expect.soft(Math.abs(added.right - layout.rect('add-button:docx').right)).toBeLessThanOrEqual(1);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
