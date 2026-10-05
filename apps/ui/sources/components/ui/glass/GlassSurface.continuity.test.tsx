import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
// This thin native SDK loader is the OS boundary. All material policy,
// settings subscriptions, child state and React reconciliation remain real.
vi.mock('./blurMaterial', () => {
    const BlurView = (props: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('NativeBlurView', props, props.children);
    return { getBlurViewComponent: () => BlurView };
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
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function DraftInput() {
    const [value, setValue] = React.useState('');
    return React.createElement('DraftInput', { testID: 'draft', value, onChangeText: setValue });
}

describe('native material child continuity', () => {
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
