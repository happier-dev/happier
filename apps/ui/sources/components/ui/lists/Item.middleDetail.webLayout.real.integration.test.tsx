// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const mock = createReanimatedModuleMock();
    const Animated = { ...mock.default, View: native.View, ScrollView: native.ScrollView, Text: native.Text };
    return { ...mock, ...Animated, default: Animated };
});

installWebLayoutBridge();
const { Item } = await import('./Item');
const { ListPresentationProvider } = await import('./listPresentation');

const MONO = { fontFamily: 'monospace' } as const;

async function measureRow(widthPx: number, viewportPx: number, address: string, head: string, tail: string) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: widthPx }}>
                <ListPresentationProvider value="page">
                    <Item testID="row" detailTestID="detail" title="Repository" detail={address} detailStyle={MONO} detailEllipsizeMode="middle" showChevron={false} />
                </ListPresentationProvider>
            </View>,
        ));
        const layout = await measureWebLayout(host, {
            viewport: { width: viewportPx, height: 300 }, texts: ['Repository', head, tail], settle: (replay) => act(replay),
        });
        return { title: layout.textRects('Repository')[0]!, head: layout.textRects(head)[0]!, tail: layout.textRects(tail)[0]! };
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

// QA cut 46 row 4: a 670px desktop row cut "github.com/mic… /Windows-classic-samples" with ~250px free beside
// "Repository". An address's detail takes the room its short label leaves, so it shows whole whenever it fits.
it('shows a middle-ellipsized address whole on a wide row where it fits', async () => {
    const { title, head, tail } = await measureRow(670, 1440, 'github.com/microsoft/Windows-classic-samples', 'github.com/microsoft', '/Windows-classic-samples');
    expect(head.scrollWidth).toBeLessThanOrEqual(head.width + 1);
    expect(tail.scrollWidth).toBeLessThanOrEqual(tail.width + 1);
    // Still beside its label, on one line.
    expect(head.top).toBeLessThan(title.bottom);
    expect(head.left).toBeGreaterThanOrEqual(title.right);
}, 180_000);

// When the row truly runs out of room the address gives up its middle on its label's line; its end stays whole.
it('middle-truncates an address beside its label only once the row runs out of room', async () => {
    const head = 'github.com/microsoft-open-source-samples-archive';
    const { title, head: headBox, tail } = await measureRow(500, 1440, `${head}/Windows-classic-samples`, head, '/Windows-classic-samples');
    expect(headBox.scrollWidth).toBeGreaterThan(headBox.width + 1);
    expect(headBox.width).toBeGreaterThan(0);
    expect(tail.scrollWidth).toBeLessThanOrEqual(tail.width + 1);
    expect(headBox.top).toBeLessThan(title.bottom);
    expect(headBox.left).toBeGreaterThanOrEqual(title.right);
    // The label keeps its whole name.
    expect(title.scrollWidth).toBeLessThanOrEqual(title.width + 1);
}, 180_000);
