// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { View } from 'react-native';
import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

const navigation = vi.hoisted(() => ({ setOptions: vi.fn() }));
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
    const native = await import('react-native');
    return (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
        rt: { screen: { width: 390, height: 844 }, breakpoint: 'xs' },
        styleSheet: { absoluteFillObject: native.StyleSheet.absoluteFillObject },
    });
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ navigation }).module);
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const native = await import('react-native');
    const mock = createReanimatedModuleMock();
    const Animated = { ...mock.default, View: native.View, ScrollView: native.ScrollView, Text: native.Text };
    return { ...mock, ...Animated, default: Animated };
});

const { useNavigationHeaderActions } = await import('../NavigationHeaderActions');
const { PageHeaderMenu } = await import('../PageHeaderEntityParts');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');

it('fits both System Status actions and entity operations in the folded phone popup', async () => {
    installWebLayoutBridge();
    Object.defineProperties(window, { innerWidth: { configurable: true, value: 390 }, innerHeight: { configurable: true, value: 844 } });
    // RNW's real viewport adapter reads the document client box, not innerWidth.
    Object.defineProperties(document.documentElement, {
        clientWidth: { configurable: true, value: 390 }, clientHeight: { configurable: true, value: 844 },
    });
    window.dispatchEvent(new Event('resize'));
    const { Dimensions } = await import('react-native');
    expect(Dimensions.get('window').width).toBe(390);
    expect(Dimensions.get('window').height).toBe(844);
    const copy = vi.fn();
    const diagnose = vi.fn();
    const remove = vi.fn();
    const actions = <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <RoundButton testID="status-copy" size="small" title="Copy as JSON" display="secondary" onPress={copy} />
        <RoundButton testID="status-diagnose" size="small" title="Run diagnosis" display="secondary" onPress={diagnose} />
        <PageHeaderMenu openRequested actions={[{ id: 'remove', testID: 'entity-remove', title: 'Remove', onSelect: remove }]} />
    </View>;
    function Publisher() {
        useNavigationHeaderActions({ enabled: true, primary: null, actions });
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<Publisher />));
        const options = navigation.setOptions.mock.calls.at(-1)?.[0] as { headerRight: () => React.ReactNode };
        await act(async () => root.render(<><Publisher /><View style={{ alignItems: 'flex-end' }}>{options.headerRight()}</View></>));
        const layout = await measureWebLayout(document.body, { viewport: { width: 390, height: 844 }, settle: replay => act(replay) });
        const operation = document.querySelector('[data-testid="entity-remove"]');
        const popup = operation?.closest('[id^="popover-"]');
        expect(popup, 'the real popup is open').not.toBeNull();
        if (!popup) throw new Error('Missing popup');
        expect((popup as HTMLElement).style.opacity, 'the anchor is measured and popup shown').not.toBe('0');
        const popupId = 'folded-popup';
        popup.setAttribute('data-testid', popupId);
        const measured = await measureWebLayout(document.body, { viewport: { width: 390, height: 844 } });
        const bounds = measured.rect(popupId);
        expect(bounds.height).toBeGreaterThan(0);
        for (const id of ['status-copy', 'status-diagnose', 'entity-remove']) {
            const box = measured.rect(id);
            expect(box.left, id).toBeGreaterThanOrEqual(Math.max(0, bounds.left));
            expect(box.right, id).toBeLessThanOrEqual(Math.min(390, bounds.right));
            expect(box.top, id).toBeGreaterThanOrEqual(Math.max(0, bounds.top));
            expect(box.bottom, id).toBeLessThanOrEqual(Math.min(844, bounds.bottom));
            expect(box.clipped, id).toBe(false);
        }
        expect(layout.rect('status-copy').width).toBeGreaterThan(0);
        await act(async () => (document.querySelector('[data-testid="status-copy"]') as HTMLElement).click());
        await act(async () => (document.querySelector('[data-testid="status-diagnose"]') as HTMLElement).click());
        expect(copy).toHaveBeenCalledOnce();
        expect(diagnose).toHaveBeenCalledOnce();
        await act(async () => (document.querySelector('[data-testid="entity-remove"]') as HTMLElement).click());
        // Dropdown operations run after dismissal, on the owning menu's next frame.
        await act(async () => vi.waitFor(() => expect(remove).toHaveBeenCalledOnce()));
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
