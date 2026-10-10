import * as React from 'react';
import type { OpaqueColorValue } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { darkTheme } = await import('@/theme');
    return createUnistylesMock({ theme: darkTheme });
});
const blur = vi.hoisted(() => ({ available: true }));
// This thin native SDK loader is the OS boundary. All material policy,
// settings subscriptions, child state and React reconciliation remain real.
vi.mock('./blurMaterial', () => {
    const BlurView = (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('NativeBlurView', props, props.children);
    return { getBlurViewComponent: () => blur.available ? BlurView : null };
});
const liquid = vi.hoisted(() => ({ available: false }));
vi.mock('./liquidGlass', () => ({
    useLiquidGlassAvailable: () => liquid.available,
    getGlassViewComponent: () => (props: Record<string, unknown>) => React.createElement('NativeGlassView', props),
}));

let GlassSurface: typeof import('./GlassSurface')['GlassSurface'];
let storage: typeof import('@/sync/domains/state/storage')['storage'];
let previousState: ReturnType<typeof storage.getState>;
let resolvePreset: typeof import('./glassMaterial')['resolveGlassPresetSettingsDelta'];
beforeAll(async () => {
    ({ storage } = await import('@/sync/domains/state/storage'));
    ({ GlassSurface } = await import('./GlassSurface'));
    ({ resolveGlassPresetSettingsDelta: resolvePreset } = await import('./glassMaterial'));
    previousState = storage.getState();
});
afterEach(() => {
    liquid.available = false;
    blur.available = true;
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function DraftInput() {
    const [value, setValue] = React.useState('');
    return React.createElement('DraftInput', { testID: 'draft', value, onChangeText: setValue });
}

describe('native material child continuity', () => {
    it('preserves a native opaque toolbar color and its action through Clear and Solid', async () => {
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        // iOS PlatformColor emits this opaque object at the OS boundary (PlatformColorValueTypes.ios).
        const nativeColor = { semantic: ['systemBackgroundColor'] } as unknown as OpaqueColorValue;
        const onPress = vi.fn();
        const screen = await renderScreen(<GlassSurface><ToolbarButton testID="native-color-toolbar" label="Continue" style={{ backgroundColor: nativeColor }} onPress={onPress} /></GlassSurface>);
        for (const preset of ['clear', 'solid'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            const target = screen.findHostByTestId('native-color-toolbar');
            expect(flattenTestStyle(target?.props.style).backgroundColor).toBe(nativeColor);
            await act(async () => target?.props.onPress({ nativeEvent: {} }));
        }
        expect(onPress).toHaveBeenCalledTimes(2);
    });
    it('keeps Clear outer arrow and fade paint solid when the native SDK is unavailable', async () => {
        const { useGlassSurfaceColor } = await import('./useGlassSurfaceColor');
        function OuterPaint() {
            const color = useGlassSurfaceColor('#292b2d', 'floating', false);
            return React.createElement('OuterPaint', { testID: 'outer-paint', color });
        }
        blur.available = false;
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        const screen = await renderScreen(<OuterPaint />);
        expect(screen.findHostByTestId('outer-paint')?.props.color).toBe('#292b2d');
    });
    it('projects an authored overlay container through the rendered native tier', async () => {
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        for (const available of [true, false]) {
            blur.available = available;
            const screen = await renderScreen(<FloatingOverlay containerStyle={{ backgroundColor: '#112233' }} scrollEnabled={false}><DraftInput /></FloatingOverlay>);
            const opaque = screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === '#112233');
            expect(opaque.length > 0).toBe(!available);
            standardCleanup();
        }
    });
    it('retains the original solid color when Clear has no native blur SDK', async () => {
        blur.available = false;
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        const screen = await renderScreen(<GlassSurface testID="unavailable" solidColor="#292b2d"><DraftInput /></GlassSurface>);
        expect(screen.findAllByType('NativeBlurView')).toHaveLength(0);
        expect(flattenTestStyle(screen.findHostByTestId('unavailable')?.props.style)?.backgroundColor).toBe('#292b2d');
    });
    it('does not treat a nested control as glass when its containing iOS plane fell back solid', async () => {
        blur.available = false;
        const { CompactSearchField } = await import('@/components/ui/forms/CompactSearchField');
        const { darkTheme } = await import('@/theme');
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        const screen = await renderScreen(<GlassSurface>
            <GlassSurface nested><CompactSearchField testID="nested-field" value="draft" placeholder="Search" onChangeText={() => {}} /></GlassSurface>
        </GlassSurface>);
        const solidFields = screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === darkTheme.colors.edge.fill);
        expect(solidFields.length).toBeGreaterThan(0);
    });
    it('settles a real native toolbar finish from the shared focus fact without losing its control', async () => {
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        const screen = await renderScreen(<ToolbarButton testID="toolbar" label="Continue" tone="primary" onPress={() => {}} />);
        const target = screen.findHostByTestId('toolbar');
        expect(screen.findAllByType('Rect')).toHaveLength(1);
        await act(async () => { target?.props.onFocus({ nativeEvent: {} }); });
        expect(screen.findAllByType('Rect')).toHaveLength(0);
        expect(screen.findHostByTestId('toolbar')).toBe(target);
        await act(async () => { target?.props.onBlur({ nativeEvent: {} }); });
        expect(screen.findAllByType('Rect')).toHaveLength(1);
    });
    it('composites an existing primary fill and its finish in one native drawing layer', async () => {
        const { GradientSurface } = await import('@/components/ui/surfaces/GradientSurface');
        const fill = { colors: ['#2244ee', '#1133cc'] as const };
        const overlay = { colors: ['rgba(255,255,255,0.14)', 'rgba(255,255,255,0)'] as const };
        const screen = await renderScreen(<GradientSurface fallbackColor="#2244ee" gradient={fill} overlay={overlay} borderRadius={12}><DraftInput /></GradientSurface>);
        expect(screen.findAllByType('Svg')).toHaveLength(1);
        expect(screen.findAllByType('Rect')).toHaveLength(2);
        expect(screen.findAllByType('Stop').map(node => node.props.stopColor)).toEqual([...fill.colors, ...overlay.colors]);
        await act(async () => { screen.changeTextByTestId('draft', 'keep the primary draft'); });
        await screen.update(<GradientSurface fallbackColor="#2244ee" gradient={fill} overlay={null} borderRadius={12}><DraftInput /></GradientSurface>);
        expect(screen.findAllByType('Svg')).toHaveLength(1);
        expect(screen.findAllByType('Rect')).toHaveLength(1);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the primary draft');
    });
    it('does not let a same-group uncoated shell suppress a native card or composer finish', async () => {
        const screen = await renderScreen(<GlassSurface surfaceGroup="content" finishRole={null}>
            <GlassSurface surfaceGroup="content" nested finishRole="card"><DraftInput /></GlassSurface>
            <GlassSurface surfaceGroup="content" nested finishRole="composer"><React.Fragment /></GlassSurface>
        </GlassSurface>);
        expect(screen.findAllByType('Rect')).toHaveLength(2);
    });
    it('retains one ink overlay through Liquid Glass, blur and solid tiers without coating nested content twice', async () => {
        const screen = await renderScreen(<GlassSurface testID="plane">
            <GlassSurface testID="nested" nested><DraftInput /></GlassSurface>
        </GlassSurface>);
        const overlays = () => screen.findAllByType('Rect');
        expect(overlays()).toHaveLength(1);
        expect(screen.findAllByType('NativeBlurView')).toHaveLength(1);
        expect(flattenTestStyle(screen.findHostByTestId('plane')?.props.style)?.backgroundColor).toBe('transparent');
        expect(flattenTestStyle(screen.findHostByTestId('nested')?.props.style)?.backgroundColor).toBe('transparent');
        await act(async () => { screen.changeTextByTestId('draft', 'keep the native draft'); });
        for (const preset of ['solid', 'auto'] as const) {
            liquid.available = preset === 'auto';
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(overlays()).toHaveLength(1);
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the native draft');
            expect(screen.findAllByType('NativeGlassView')).toHaveLength(preset === 'auto' ? 1 : 0);
            if (preset === 'auto') expect(flattenTestStyle(screen.findHostByTestId('plane')?.props.style)?.backgroundColor).toBe('transparent');
        }
    });
    it('projects each group strength distinctly even when Liquid Glass is available', async () => {
        liquid.available = true;
        const { glassPresetMaterials } = await import('./glassMaterial');
        act(() => storage.setState({ settings: { ...previousState.settings, glassBlurEnabled: true, glassSurfaceMaterials: {
            ...glassPresetMaterials('everywhere'), floating: { blur: 'light', opacity: 0 },
        } } }));
        const screen = await renderScreen(<GlassSurface><DraftInput /></GlassSurface>);
        await act(async () => { screen.changeTextByTestId('draft', 'keep this draft'); });
        expect(screen.findByType('NativeGlassView').props.glassEffectStyle).toBe('clear');
        for (const blur of ['regular', 'strong', 'off'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, glassSurfaceMaterials: {
                ...glassPresetMaterials('everywhere'), floating: { blur, opacity: 0 },
            } } }));
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep this draft');
            if (blur === 'regular') expect(screen.findByType('NativeGlassView').props.glassEffectStyle).toBe('regular');
            if (blur === 'strong') {
                expect(screen.findAllByType('NativeGlassView')).toHaveLength(0);
                expect(screen.findByType('NativeBlurView').props.intensity).toBe(80);
            }
            if (blur === 'off') expect(screen.findAllByType('NativeBlurView')).toHaveLength(0);
        }
    });

    it('preserves an edited input when the native blur tier becomes solid and returns', async () => {
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'auto') } }));
        const screen = await renderScreen(<GlassSurface><DraftInput /></GlassSurface>);
        expect(screen.findAllByType('NativeBlurView')).toHaveLength(1);
        await act(async () => { screen.changeTextByTestId('draft', 'keep this draft'); });
        for (const preset of ['solid', 'auto'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep this draft');
        }
    });
});
