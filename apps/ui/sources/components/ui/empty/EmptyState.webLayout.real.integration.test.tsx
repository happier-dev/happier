// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScrollView, Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { HappierListDetailLayout } from '@happier-dev/plugin-ui/presentation';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { ItemList } from '@/components/ui/lists/ItemList';
import { EmptyState } from './EmptyState';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// The native animation/gradient boundaries keep real RNW layout boxes during browser measurement.
vi.mock('react-native-reanimated', async () => {
    const mock = (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock();
    const native = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { ...mock, default: { ...mock.default, View: native.View, Text: native.Text, ScrollView: native.ScrollView } };
});
vi.mock('expo-linear-gradient', async () => {
    const native = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { LinearGradient: native.View };
});

installWebLayoutBridge();

it.each([390, 593, 850])('keeps a page invitation and its action inside a %spx scrolling pane', async width => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View testID="pane" style={{ width, height: 700 }}>
                <ScrollView style={{ flex: 1 }}>
                    <EmptyState
                        layout="page"
                        testID="invitation"
                        title="Bring your own models"
                        titleTestID="invitation-title"
                        subtitle="Connect the model sources you use, from hosted services to endpoints running on your machine."
                        subtitleTestID="invitation-description"
                        action={<Text testID="invitation-action">Set up a machine</Text>}
                    />
                </ScrollView>
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width: 1200, height: 900 } });
        const pane = layout.rect('pane');
        for (const testID of ['invitation', 'invitation-title', 'invitation-description', 'invitation-action']) {
            const box = layout.rect(testID);
            expect(box.left).toBeGreaterThanOrEqual(pane.left);
            expect(box.right).toBeLessThanOrEqual(pane.right);
            expect(box.clipped).toBe(false);
            expect(Math.abs((box.left + box.right) / 2 - (pane.left + pane.right) / 2)).toBeLessThanOrEqual(1);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});

it('keeps the naked add invitation inside a measured settings collection detail with the real page scroll owner', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width: 859, height: 700 }}>
                <HappierListDetailLayout
                    testID="collection"
                    listTestID="rail"
                    detailTestID="pane"
                    minListWidth={266}
                    minDetailWidth={420}
                    preferredListRatio={0}
                    gap={0}
                    list={<Text>Providers</Text>}
                    detail={<View style={{ flex: 1, minHeight: 0 }}><ItemList>
                        <EmptyState
                            layout="page"
                            variant="add"
                            testID="invitation"
                            title="Bring your own models"
                            titleTestID="invitation-title"
                            subtitle="Connect the model sources you use, from hosted services to endpoints running on your machine."
                            subtitleTestID="invitation-description"
                            primaryAction={{ label: 'Set up a machine', onPress: () => {}, testID: 'invitation-action' }}
                        />
                    </ItemList></View>}
                />
            </View>,
        ));
        const layout = await measureWebLayout(host, {
            viewport: { width: 1200, height: 900 },
            settle: async replay => { await act(replay); },
        });
        const pane = layout.rect('pane');
        expect(pane.width).toBeCloseTo(593);
        for (const testID of ['invitation', 'invitation-title', 'invitation-description', 'invitation-action']) {
            const box = layout.rect(testID);
            expect(box.left).toBeGreaterThanOrEqual(pane.left);
            expect(box.right).toBeLessThanOrEqual(pane.right);
            expect(box.clipped).toBe(false);
            expect(Math.abs((box.left + box.right) / 2 - (pane.left + pane.right) / 2)).toBeLessThanOrEqual(1);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
