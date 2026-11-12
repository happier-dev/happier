// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { CustomModal } from '@/modal/components/CustomModal';
import { NavigationPlacementCustomizerView, type NavigationPlacementItem } from './NavigationPlacementCustomizer';

// The browser window is the platform boundary; the sheet, list, rows and their sizing stay real.
vi.mock('react-native', async () => ({
    ...(await vi.importActual<Record<string, unknown>>('react-native-web')),
    useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

const items: readonly NavigationPlacementItem[] = Array.from({ length: 40 }, (_, index) => ({
    id: `action-${index}`,
    title: `Composer action ${index}`,
    defaultPlacement: 'pinned',
}));

function PlacementBody() {
    return <NavigationPlacementCustomizerView surfaceId="composer" items={items}
        preferences={{ orderedIds: [], placements: {} }} onChange={() => {}}
        showHeader={false} scrollsInBody testID="placements"
        renderPreview={() => <Text>Composer preview</Text>} />;
}

it('gives a phone sheet placement list a measured height and reaches its last control through the sheet scroller', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<CustomModal visible onClose={() => {}}
            config={{ id: 'customize', type: 'custom', component: PlacementBody, chrome: {
                kind: 'card', title: 'Customize composer', scrollHost: 'body', bodyScroll: 'auto',
                phonePresentation: 'sheet', dimensions: { size: 'lg' },
                footer: <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <RoundButton title="Reset" display="secondary" size="small" onPress={() => {}} />
                    <RoundButton title="Done" size="small" onPress={() => {}} />
                </View>,
            } }} />));
        const options = { viewport: { width: 390, height: 844 }, settle: (replay: () => Promise<void>) => act(replay) };
        const layout = await measureWebLayout(document.body, options);
        expect(layout.rect('placements').height).toBeGreaterThan(0);
        const body = layout.rect('modal-card-body-scroll');
        expect(body.height).toBeGreaterThan(0);
        expect(body.top).toBeGreaterThanOrEqual(0);
        expect(body.bottom).toBeLessThanOrEqual(options.viewport.height);
        expect(layout.rect('placements').height).toBeGreaterThan(body.height);

        // Placement choices exist without a live Account; reordering grips deliberately require its scope.
        const lastControl = 'placements.placement:action-39:hidden';
        const reached = await measureWebLayout(document.body, { ...options, focusedTestId: lastControl });
        const last = reached.rect(lastControl);
        const viewport = reached.rect('modal-card-body-scroll');
        expect(last.top).toBeGreaterThanOrEqual(viewport.top);
        expect(last.bottom).toBeLessThanOrEqual(viewport.bottom);
        expect(last.receivesPointer).toBe(true);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
