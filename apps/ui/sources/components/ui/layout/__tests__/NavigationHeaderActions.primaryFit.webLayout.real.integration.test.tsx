// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Text, View } from 'react-native';
import { expect, it, vi } from 'vitest';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

const navigation = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ navigation }).module);

installWebLayoutBridge();

const { useNavigationHeaderActions } = await import('../NavigationHeaderActions');
const { PageHeaderMenu } = await import('../PageHeaderEntityParts');
const { Header } = await import('@/components/navigation/Header');

/**
 * The phone bar as a page publishes it: Back, the destination's title, the page's overflow and its one
 * filled action. At 200% text a 390pt phone lays this bar out in 195 CSS px (FIN-QA-LARGETEXT F1).
 */
async function publishInBar(width: number) {
    navigation.setOptions.mockClear();
    const doesNotFit = vi.fn();
    function Publisher() {
        useNavigationHeaderActions({
            enabled: true,
            primary: { title: 'Run now', testID: 'primary', onPress: () => {} },
            actions: <PageHeaderMenu actions={[{ id: 'duplicate', title: 'Duplicate', onSelect: () => {} }]} />,
            onPrimaryDoesNotFit: doesNotFit,
        });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactNode };
        await act(async () => root.render(<><Publisher /><Header safeAreaEnabled={false}
            headerLeft={() => <View style={{ width: 40, height: 40 }} />}
            title={<Text numberOfLines={1}>Workflow</Text>}
            headerRight={options.headerRight} /></>));
        const layout = await measureWebLayout(host, { viewport: { width, height: 400 }, settle: replay => act(replay) });
        return { layout, doesNotFit };
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

it('hands the primary back to its page when the bar cannot draw it whole (195px: a phone at 200% text)', async () => {
    const { layout, doesNotFit } = await publishInBar(195);
    // Drawn in the bar, the action runs past the window: the page is told, so it can place it whole.
    expect(layout.rect('primary').right).toBeGreaterThan(195);
    expect(doesNotFit).toHaveBeenCalledTimes(1);
});

it('keeps the primary in the bar while it fits (390px)', async () => {
    const { layout, doesNotFit } = await publishInBar(390);
    expect(layout.rect('primary').right).toBeLessThanOrEqual(390);
    expect(doesNotFit).not.toHaveBeenCalled();
});
