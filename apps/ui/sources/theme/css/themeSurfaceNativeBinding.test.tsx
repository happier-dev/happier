import * as React from 'react';
import Color from 'color';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { installExpoGlassEffectRequireStub } from '@/dev/testkit/mocks/expoGlassEffect';

const boundary = vi.hoisted(() => ({ theme: null as Record<string, unknown> | null }));
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const mock = await createUnistylesMock();
    boundary.theme = mock.useUnistyles().theme;
    return mock;
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: (props: Record<string, unknown>) => React.createElement('LinearGradient', props) }));
const restoreGlass = installExpoGlassEffectRequireStub({ isAvailable: () => true });
afterAll(restoreGlass);
const { renderScreen, flattenTestStyle, standardCleanup } = await import('@/dev/testkit');
const { prepareThemeCss } = await import('./prepareThemeCss');
const prepared = prepareThemeCss(`
    [data-surface="composer"][data-part="root"] { background-color: #123456; border-radius: 18px; }
    [data-surface="composer"][data-part="root"][data-state="disabled"] { background-color: #654321; }
    [data-surface="composer"][data-part="toolbar"] { background-color: rgba(12, 34, 56, 0.4); }
    [data-surface="sidebar"][data-part="root"] { background-color: #234567; padding: 9px; }
    [data-surface="user-bubble"][data-part="root"] { background-color: #345678; border-radius: 21px; }
`);
await import('react-native-unistyles');
Object.assign(boundary.theme!, { surfaces: prepared.light });
const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
const { UserMessageBubble } = await import('@/components/sessions/transcript/UserMessageBubble');
afterEach(standardCleanup);

function hex(value: unknown) {
    return typeof value === 'string' ? Color(value).hex().toLowerCase() : null;
}

describe('compiled native surface styles at their painted owners', () => {
    it('applies semantic state and geometry to the material and its clip, with no leak to an unaddressed surface', async () => {
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassSurface testID="disabled-composer" themeSurface={{ surface: 'composer', part: 'root', state: 'disabled' }} style={{ borderRadius: 40 }}><></></GlassSurface>
            <GlassSurface testID="translucent-surface" themeSurface={{ surface: 'composer', part: 'toolbar' }}><></></GlassSurface>
            <GlassSurface testID="ordinary-surface" style={{ borderRadius: 40 }}><></></GlassSurface>
        </GlassMaterialSettingsProvider>);
        const root = screen.findHostByTestId('disabled-composer')!;
        expect(flattenTestStyle(root.props.style).borderTopLeftRadius).toBe(18);
        const glass = root.findByType('GlassView');
        expect(flattenTestStyle(glass.props.style).borderTopLeftRadius).toBe(18);
        const materialFills = root.findAll(node => typeof node.type === 'string' && node.props.pointerEvents === 'none')
            .map(node => hex(flattenTestStyle(node.props.style).backgroundColor));
        expect(materialFills).toContain('#654321');
        const translucent = screen.findHostByTestId('translucent-surface')!;
        expect(flattenTestStyle(translucent.props.style).backgroundColor).toBe('transparent');
        const translucentCoats = translucent.findAll(node => typeof node.type === 'string' && node.props.pointerEvents === 'none')
            .map(node => flattenTestStyle(node.props.style).backgroundColor)
            .filter((value): value is string => typeof value === 'string' && Color(value).alpha() === 0.4);
        expect(translucentCoats).toHaveLength(1);
        expect(flattenTestStyle(screen.findHostByTestId('ordinary-surface')!.props.style).borderRadius).toBe(40);
    });

    it('applies the same preparation to a sidebar plane and both user-bubble roots', async () => {
        const screen = await renderScreen(<>
            <GlassSurface testID="sidebar" plane surfaceGroup="sidebar" themeSurface={{ surface: 'sidebar', part: 'root', state: 'default' }}><></></GlassSurface>
            <UserMessageBubble testID="bubble"><></></UserMessageBubble>
            <UserMessageBubble testID="attention-bubble" attention={{ sessionAddress: null, radius: 21 }}><></></UserMessageBubble>
        </>);
        expect(flattenTestStyle(screen.findHostByTestId('sidebar')!.props.style).paddingTop).toBe(9);
        for (const id of ['bubble', 'attention-bubble']) {
            const style = flattenTestStyle(screen.findHostByTestId(id)!.props.style);
            expect(hex(style.backgroundColor)).toBe('#345678');
            expect(style.borderTopLeftRadius).toBe(21);
        }
    });
});
