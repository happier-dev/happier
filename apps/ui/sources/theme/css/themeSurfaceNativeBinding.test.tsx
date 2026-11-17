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
const { prepareThemeCssAsync } = await import('./prepareThemeCss');
const prepared = await prepareThemeCssAsync(`
    [data-surface="composer"][data-part="root"] { background-color: #123456; border-radius: 18px; }
    [data-surface="composer"][data-part="root"][data-state="disabled"] { background-color: #654321; }
    [data-surface="composer"][data-part="toolbar"] { background-color: rgba(12, 34, 56, 0.4); }
    [data-surface="sidebar"][data-part="root"] { background-color: #234567; padding: 9px; }
    [data-surface="user-bubble"][data-part="root"] { background-color: #345678; border-radius: 21px; }
    [data-surface="composer"][data-part="send"] { background-color: rgba(18, 52, 86, 0.4); border-radius: 9px; }
`);
await import('react-native-unistyles');
Object.assign(boundary.theme!, { surfaces: prepared.light });
const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
const { UserMessageBubble } = await import('@/components/sessions/transcript/UserMessageBubble');
const { PrimaryCircleIconButton } = await import('@/components/ui/buttons/PrimaryCircleIconButton');
const { HappierThemeSurfaceScope } = await import('@happier-dev/plugin-ui/presentation');
const { useThemeColorInspector } = await import('./useThemeColorInspector');
afterEach(standardCleanup);

function hex(value: unknown) {
    return typeof value === 'string' ? Color(value).hex().toLowerCase() : null;
}

describe('compiled native surface styles at their painted owners', () => {
    it('measures the real native send paint host and claims its gesture instead of activating Send', async () => {
        const picked = vi.fn(); const sent = vi.fn();
        let inspector!: ReturnType<typeof useThemeColorInspector>;
        const measurement = { pending: null as ((x: number, y: number, width: number, height: number) => void) | null, deferred: false };
        const host = { measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
            if (measurement.deferred) measurement.pending = callback;
            else callback(4, 8, 32, 32);
        } };
        function Harness() {
            inspector = useThemeColorInspector({ paintMap: [{ address: { surface: 'composer', part: 'send' }, selector: '', label: 'Send',
                paintRoles: [{ facet: 'background', source: { kind: 'fixed' } }] }], onPick: picked });
            return <PrimaryCircleIconButton active testID="native-inspection-send" accessibilityLabel="Send" onPress={sent}
                themeSurface={{ surface: 'composer', part: 'send' }}><></></PrimaryCircleIconButton>;
        }
        const screen = await renderScreen(<Harness />, {
            createNodeMock: () => host,
        });
        const painted = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.dataSet?.surface === 'composer'
            && node.props.dataSet?.part === 'send')[0]!;
        expect(painted.props.collapsable).toBe(false);
        await React.act(async () => { inspector.activate(); });
        await React.act(async () => {
            // Native's responder boundary delivers release to the winning View;
            // an enclosing Pressable receives it only when the View declines.
            if (!painted.props.onStartShouldSetResponder()) {
                screen.findHostByTestId('native-inspection-send')!.props.onPress();
            }
        });
        expect(picked).toHaveBeenCalledTimes(1);
        expect(picked.mock.calls[0]![0]).toMatchObject({ address: { surface: 'composer', part: 'send' }, rect: { x: 4, y: 8, width: 32, height: 32 }, host });
        expect(sent).not.toHaveBeenCalled();
        measurement.deferred = true;
        await React.act(async () => { painted.props.onStartShouldSetResponder(); });
        await React.act(async () => { inspector.cancel(); });
        await React.act(async () => { measurement.pending?.(4, 8, 32, 32); });
        expect(picked).toHaveBeenCalledTimes(1);
        expect(painted.props.onStartShouldSetResponder()).toBe(false);
    });
    it('retains ordinary native paint inside the existing recovery scope', async () => {
        const screen = await renderScreen(<HappierThemeSurfaceScope enabled={false}>
            <GlassSurface testID="recovery-surface" themeSurface={{ surface: 'composer', part: 'root' }} style={{ borderRadius: 40 }}><></></GlassSurface>
            <UserMessageBubble testID="recovery-bubble"><></></UserMessageBubble>
            <UserMessageBubble testID="recovery-attention-bubble" attention={{ sessionAddress: null, radius: 40 }}><></></UserMessageBubble>
        </HappierThemeSurfaceScope>);
        const surface = flattenTestStyle(screen.findHostByTestId('recovery-surface')!.props.style);
        expect(surface.borderRadius).toBe(40);
        expect(surface.borderTopLeftRadius).toBeUndefined();
        for (const id of ['recovery-bubble', 'recovery-attention-bubble']) {
            expect(flattenTestStyle(screen.findHostByTestId(id)!.props.style).borderTopLeftRadius).toBeUndefined();
        }
    });

    it('reshapes the composer send at its painted circle without painting the authored alpha twice', async () => {
        const screen = await renderScreen(<PrimaryCircleIconButton active accessibilityLabel="Send" onPress={() => {}}
            themeSurface={{ surface: 'composer', part: 'send' }}><></></PrimaryCircleIconButton>);
        const painted = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.dataSet?.surface === 'composer'
            && node.props.dataSet?.part === 'send');
        expect(painted).toHaveLength(1);
        expect(flattenTestStyle(painted[0]!.props.style).borderTopLeftRadius).toBe(9);
        expect(hex(flattenTestStyle(painted[0]!.props.style).backgroundColor)).toBe('#123456');
        expect(painted[0]!.findAllByType('Stop')).toHaveLength(0);
    });

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
