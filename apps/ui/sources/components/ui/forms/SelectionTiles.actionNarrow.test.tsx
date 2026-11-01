import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settings = { uiFontScale: 1.3, uiItemDensity: 'cozy' as 'comfortable' | 'cozy' | 'compact' };

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(async () => {
    settings.uiItemDensity = 'cozy';
    await standardCleanup();
    vi.resetModules();
});

const OPTIONS = [
    { id: 'phone' as const, title: 'Add your phone', subtitle: 'Show a QR code', icon: 'device-mobile' as const, testID: 'tile-phone' },
    { id: 'home' as const, title: 'Add another Home', subtitle: 'Scan a QR code', icon: 'house' as const, testID: 'tile-home' },
    { id: 'scan' as const, title: 'Scan QR', subtitle: 'Link a new device', icon: 'qr-code' as const, testID: 'tile-scan' },
];

async function renderActions(onPress: (id: string) => void, presentation: 'page' | 'grouped' = 'page', footer = false) {
    // The global harness supplies in-memory MMKV at the genuine native boundary.
    // Seed the real settings domain; preference hooks and density resolution stay live.
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    getStorage().getState().applyLocalSettings(settings, { persist: false });
    const { SelectionTiles } = await import('./SelectionTiles');
    const { ListPresentationProvider } = await import('@/components/ui/lists/listPresentation');
    return renderScreen(
        <ListPresentationProvider value={presentation}>
            <SelectionTiles variant="action" accessibilityLabel="Devices" options={OPTIONS} onPress={onPress}
                renderOptionFooter={footer ? ({ option }) => <Text>{option.id} status</Text> : undefined} />
        </ListPresentationProvider>,
    );
}

async function layoutWidth(screen: Awaited<ReturnType<typeof renderScreen>>, width: number) {
    const { act } = await import('react-test-renderer');
    const measured = screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function');
    await act(async () => {
        measured[0]?.props.onLayout({ nativeEvent: { layout: { width, height: 120, x: 0, y: 0 } } });
    });
}

/**
 * The page's own rows: composite elements handed an option's title and an `onPress` directly (an `Item`),
 * one per option. The tile owner passes each option as an `option` object instead.
 */
function pageRows(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const titles = new Set(OPTIONS.map((option) => option.title));
    const props = new Set(screen.root.findAll((node) => typeof node.type !== 'string' && titles.has(node.props?.title)
        && typeof node.props?.onPress === 'function' && node.props?.option === undefined).map((node) => node.props));
    return [...props];
}

describe('SelectionTiles action variant on a page', () => {
    it('updates narrow native rows when the real device font preference changes', async () => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const screen = await renderActions(() => {});
        await layoutWidth(screen, 358);
        const titleSize = () => {
            const title = screen.findAll((node) => typeof node.type === 'string' && node.props.children === OPTIONS[0]!.title
                && node.props.style !== undefined)[0]!;
            return Number(flattenTestStyle(title.props.style).fontSize);
        };
        const previousSize = titleSize();
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { act } = await import('react-test-renderer');
        await act(async () => {
            getStorage().getState().applyLocalSettings({ uiFontScale: 1.6 }, { persist: false });
        });
        expect(titleSize()).toBeCloseTo(previousSize * 1.6 / settings.uiFontScale);
    });

    it.each(['comfortable', 'compact'] as const)('retains the app %s density in narrow action rows', async (density) => {
        settings.uiItemDensity = density;
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        const { resolvePageRowMetrics } = await import('@/components/ui/lists/pageRowMetrics');
        const expected = resolvePageRowMetrics({ density, shape: 'standard', touch: true });
        const screen = await renderActions(() => {});
        await layoutWidth(screen, 358);
        const title = screen.findAll((node) => typeof node.type === 'string' && node.props.children === OPTIONS[0]!.title
            && node.props.style !== undefined)[0]!;
        expect(flattenTestStyle(title.props.style).fontSize).toBeCloseTo(expected.title.fontSize * settings.uiFontScale);
    });

    it.each(['ios', 'web'] as const)('retains the app font face and text-scale ownership in narrow %s rows', async (platform) => {
        const { Platform } = await import('react-native');
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        const { readPluginUiHostTypography } = await import('@/components/plugins/surfaces/pluginUiThemeProjection');
        const { resolveHappierPageTextStyle } = await import('@happier-dev/plugin-ui/presentation');
        const expected = resolveHappierPageTextStyle('rowTitle', readPluginUiHostTypography());
        const screen = await renderActions(() => {});
        await layoutWidth(screen, 358);
        const title = screen.findAll((node) => typeof node.type === 'string' && node.props.children === OPTIONS[0]!.title
            && node.props.style !== undefined)[0]!;
        const style = flattenTestStyle(title.props.style);
        expect(style.fontSize).toBeCloseTo(Number(expected.fontSize) * (platform === 'ios' ? 1.3 : 1));
        expect(style.fontFamily).toBe(expected.fontFamily);
        expect(title.props.allowFontScaling).toBe(true);
    });

    it('draws the actions as rows of one group on a narrow page, each still starting its operation', async () => {
        const onPress = vi.fn();
        const screen = await renderActions(onPress);
        await layoutWidth(screen, 358);
        expect(pageRows(screen)).toHaveLength(3);
        await screen.pressByTestIdAsync('tile-home');
        expect(onPress).toHaveBeenCalledWith('home');
    });

    it('keeps all action tiles mounted and usable on a wide page', async () => {
        const onPress = vi.fn();
        const screen = await renderActions(onPress);
        await layoutWidth(screen, 704);
        expect(pageRows(screen)).toHaveLength(0);
        for (const option of OPTIONS) {
            expect(screen.findAllHostsByTestId(option.testID).length).toBeGreaterThan(0);
            await screen.pressByTestIdAsync(option.testID);
        }
        expect(onPress.mock.calls).toEqual([['phone'], ['home'], ['scan']]);
    });

    it.each(['grouped', 'footer'] as const)('keeps narrow action cards in the %s case', async (context) => {
        const onPress = vi.fn();
        const screen = await renderActions(onPress, context === 'grouped' ? 'grouped' : 'page', context === 'footer');
        await layoutWidth(screen, 358);
        expect(pageRows(screen)).toHaveLength(0);
        if (context === 'grouped') {
            await screen.pressByTestIdAsync('tile-phone');
            expect(onPress).toHaveBeenCalledWith('phone');
        } else {
            expect(screen.root.findAll((node) => typeof node.type === 'string' && node.props.role === 'group')).toHaveLength(3);
        }
    });
});
