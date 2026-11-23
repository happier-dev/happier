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
const { PageHeaderMenu, PageHeaderStateSwitch } = await import('../PageHeaderEntityParts');
const { Header } = await import('@/components/navigation/Header');

/**
 * The phone bar as a page publishes it: Back, the destination's title, its one filled action and its "⋯" last
 * (one order for every header), with an optional state switch on the bar. At 200% text a 390pt phone lays this
 * bar out in 195 CSS px (FIN-QA-LARGETEXT F1).
 */
async function publishInBar(width: number, withSwitch = false) {
    navigation.setOptions.mockClear();
    const doesNotFit = vi.fn();
    function Publisher() {
        useNavigationHeaderActions({
            enabled: true,
            primary: { title: 'Run now', testID: 'primary', onPress: () => {} },
            actions: <>
                {withSwitch ? <PageHeaderStateSwitch testID="fit-switch" label="Enabled" value onValueChange={() => {}} /> : null}
                <PageHeaderMenu actions={[{ id: 'duplicate', title: 'Duplicate', onSelect: () => {} }]} />
            </>,
            onPrimaryDoesNotFit: doesNotFit,
        });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        // The bar republishes when it gives a control up to "⋯"; a header draws the latest bar, so the second pass
        // measures what the person sees after that.
        let layout: Awaited<ReturnType<typeof measureWebLayout>> | undefined;
        for (let pass = 0; pass < 2; pass += 1) {
            const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactNode };
            await act(async () => root.render(<><Publisher /><Header safeAreaEnabled={false}
                headerLeft={() => <View style={{ width: 40, height: 40 }} />}
                title={<Text numberOfLines={1}>Workflow</Text>}
                headerRight={options.headerRight} /></>));
            layout = await measureWebLayout(host, { viewport: { width, height: 400 }, settle: replay => act(replay) });
        }
        return { layout: layout!, doesNotFit };
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
}

it('hands the primary back to its page when the bar cannot draw it and "⋯" whole (195px: a phone at 200% text)', async () => {
    const { layout, doesNotFit } = await publishInBar(195);
    // "⋯" is the bar's last control: drawn after the primary it runs past the window, so the page takes the primary.
    expect(layout.rect('page-header-actions.trigger').right).toBeGreaterThan(195);
    expect(doesNotFit).toHaveBeenCalledTimes(1);
});

it('gives up the bar\'s own switch to "⋯" before its primary, and keeps both while they fit', async () => {
    const narrow = await publishInBar(195, true);
    // Too narrow for the switch, the primary and "⋯": the switch folds first, then the primary goes to its page.
    expect(narrow.layout.rects.get('fit-switch.control') ?? []).toHaveLength(0);
    expect(narrow.doesNotFit).toHaveBeenCalledTimes(1);
    // Wide enough for Back, the title, the switch, the primary and "⋯" together.
    const wide = await publishInBar(600, true);
    expect(wide.layout.rect('fit-switch.control').right).toBeLessThanOrEqual(wide.layout.rect('primary').left);
    expect(wide.layout.rect('primary').right).toBeLessThanOrEqual(wide.layout.rect('page-header-actions.trigger').left);
    expect(wide.doesNotFit).not.toHaveBeenCalled();
});

it('keeps the primary in the bar while it fits (390px)', async () => {
    const { layout, doesNotFit } = await publishInBar(390);
    expect(layout.rect('primary').right).toBeLessThanOrEqual(390);
    expect(doesNotFit).not.toHaveBeenCalled();
});
