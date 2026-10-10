import * as React from 'react';
import Color from 'color';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

// The web renderer is the platform boundary; material policy, settings and reconciliation stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const runtime = await createReactNativeWebMock();
    return { ...runtime, StyleSheet: { ...runtime.StyleSheet,
        // RNW 0.21.2 enumerates even a scalar style; mirror that renderer
        // boundary rather than native flatten, which preserves scalar objects.
        flatten: (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(value => value !== null && typeof value === 'object')),
    } };
});
const themeMode = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { darkTheme } = await import('@/theme');
    const light = await createUnistylesMock();
    const dark = await createUnistylesMock({ theme: { ...darkTheme } });
    return { ...light, useUnistyles: () => themeMode.dark ? dark.useUnistyles() : light.useUnistyles() };
});

let GlassSurface: typeof import('./GlassSurface')['GlassSurface'];
let glassSurfacePlaneStyle: typeof import('./glassSurfacePaint')['glassSurfacePlaneStyle'];
let storage: typeof import('@/sync/domains/state/storage')['storage'];
let resolvePreset: typeof import('./glassMaterial')['resolveGlassPresetSettingsDelta'];
let previousState: ReturnType<typeof storage.getState>;
beforeAll(async () => {
    ({ storage } = await import('@/sync/domains/state/storage'));
    ({ GlassSurface } = await import('./GlassSurface'));
    ({ glassSurfacePlaneStyle } = await import('./glassSurfacePaint'));
    ({ resolveGlassPresetSettingsDelta: resolvePreset } = await import('./glassMaterial'));
    previousState = storage.getState();
});
afterEach(() => {
    themeMode.dark = false;
    standardCleanup();
    act(() => storage.setState(previousState, true));
});

function DraftInput() {
    const [value, setValue] = React.useState('');
    return React.createElement('DraftInput', { testID: 'draft', value, onChangeText: setValue });
}

function hasBackdrop(node: ReactTestInstance): boolean {
    if (typeof node.type !== 'string') return false;
    const style = flattenTestStyle(node.props.style) as Record<string, unknown> | null;
    const filter = style?.backdropFilter ?? style?.WebkitBackdropFilter;
    return typeof filter === 'string' && filter !== 'none';
}

/** A CSS backdrop-filter element is a backdrop root: a descendant surface can only blur what it contains. */
function backdropAncestors(node: ReactTestInstance): ReactTestInstance[] {
    const out: ReactTestInstance[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (hasBackdrop(parent)) out.push(parent);
    }
    return out;
}

function useAutoPreset() {
    act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'auto') } }));
}

describe('web glass material', () => {
    it('tones the floating backdrop for legible defaults while custom and solid keep their authored material', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        for (const dark of [false, true]) {
            themeMode.dark = dark;
            for (const preset of ['auto', 'everywhere', 'clear', 'solid', 'custom'] as const) {
                const table = preset === 'custom'
                    ? { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.013 } }
                    : glassPresetMaterials(preset);
                const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: table }}>
                    <GlassSurface surfaceGroup="floating" finishRole={null}><DraftInput /></GlassSurface>
                </GlassMaterialSettingsProvider>);
                const backdrops = screen.findAll(hasBackdrop);
                const filters = backdrops.map(node => String(flattenTestStyle(node.props.style)?.backdropFilter));
                if (preset === 'solid') expect(filters).toEqual([]);
                else if (preset === 'custom') {
                    expect(filters).toHaveLength(1);
                    expect(filters[0]).not.toMatch(/brightness|contrast|saturate/);
                    expect(filters[0]).toContain('5px');
                } else {
                    expect(filters).toHaveLength(1);
                    expect(filters[0]).toMatch(/brightness\(/);
                    expect(filters[0]).toMatch(/saturate\(/);
                    expect(filters[0]).toContain('24px');
                }
                standardCleanup();
            }
        }
    });
    it('does not let an authored menu container fill bypass its floating material', async () => {
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        for (const preset of ['everywhere', 'solid'] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
                <FloatingOverlay containerStyle={{ backgroundColor: '#112233', padding: 7 }} scrollEnabled={false}><React.Fragment /></FloatingOverlay>
            </GlassMaterialSettingsProvider>);
            const opaque = screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === '#112233');
            expect(opaque.length > 0).toBe(preset === 'solid');
            standardCleanup();
        }
    });
    it('uses a low content-ink tint for dark Clear while solid retains the exact floating paper', async () => {
        themeMode.dark = true;
        const { darkTheme } = await import('@/theme');
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        const screen = await renderScreen(<GlassSurface surfaceGroup="floating" finishRole={null}><DraftInput /></GlassSurface>);
        const paints = () => screen.findAll(node => typeof node.type === 'string' && String(flattenTestStyle(node.props.style)?.backgroundColor).includes('--happier-glass-floating-background-color'));
        expect(paints()).toHaveLength(1);
        expect(String(flattenTestStyle(paints()[0]!.props.style)?.backgroundColor)).toContain(darkTheme.colors.text.primary);
        act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, 'solid') } }));
        expect(String(flattenTestStyle(paints()[0]!.props.style)?.backgroundColor)).toContain(darkTheme.colors.edge.floatingFill);
    });
    it('preserves the final background paint from non-enumerable Unistyles styles without flattening their layout metadata', async () => {
        const first = Object.defineProperty({}, 'backgroundColor', { value: '#112233', enumerable: false });
        const muted = Object.defineProperty({}, 'backgroundColor', { value: '#334455', enumerable: false });
        const screen = await renderScreen(<GlassSurface surfaceGroup="content" finishRole={null} enabled={false} style={[first, muted]}><DraftInput /></GlassSurface>);
        expect(screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === '#334455')).toHaveLength(1);
    });
    it('gives the anchored tooltip bubble the floating finish without touching its label semantics', async () => {
        const { AnchoredTooltipBubble } = await import('@/components/ui/overlays/AnchoredTooltip');
        const screen = await renderScreen(<AnchoredTooltipBubble label="Next file" testID="tooltip" />);
        expect(screen.findHostByTestId('tooltip')?.props.role).toBe('tooltip');
        expect(screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string')).toHaveLength(1);
    });
    it('flattens toolbar, floating and circular primary finish through their canonical focus state without removing their authored fill', async () => {
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        const { FAB } = await import('@/components/ui/buttons/FAB');
        const { PrimaryCircleIconButton } = await import('@/components/ui/buttons/PrimaryCircleIconButton');
        const { lightTheme } = await import('@/theme');
        const finishInk = lightTheme.colors.edge.primaryFinishGradient!.colors[0];
        const fixtures = [
            <ToolbarButton label="Continue" tone="primary" onPress={() => {}} accessibilityLabel="focus action" />,
            <FAB onPress={() => {}} accessibilityLabel="focus action" />,
            <PrimaryCircleIconButton active onPress={() => {}} accessibilityLabel="focus action"><React.Fragment /></PrimaryCircleIconButton>,
        ];
        for (const fixture of fixtures) {
            const screen = await renderScreen(fixture);
            const paints = () => screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
            const finishPaints = () => paints().filter(node => String(flattenTestStyle(node.props.style)?.backgroundImage).includes(finishInk));
            expect(finishPaints()).toHaveLength(1);
            const target = screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'focus action')[0]!;
            await act(async () => { target.props.onFocus?.({ nativeEvent: {} }); });
            expect(finishPaints()).toHaveLength(0);
            if (fixture.type === FAB || fixture.type === PrimaryCircleIconButton) expect(paints()).toHaveLength(1);
            await screen.unmount();
        }
    });
    it('keeps declared-void toolbar, floating and circle callbacks actionable when JavaScript returns an unresolved promise', async () => {
        const { ToolbarButton } = await import('@/components/ui/buttons/ToolbarButton');
        const { FAB } = await import('@/components/ui/buttons/FAB');
        const { PrimaryCircleIconButton } = await import('@/components/ui/buttons/PrimaryCircleIconButton');
        const { lightTheme } = await import('@/theme');
        const finishInk = lightTheme.colors.edge.primaryFinishGradient!.colors[0];
        let settle = () => {};
        const pending = new Promise<void>(resolve => { settle = resolve; });
        const callback = vi.fn(() => pending);
        const fixtures = [
            <ToolbarButton label="Continue" tone="primary" onPress={callback} accessibilityLabel="void action" />,
            <FAB onPress={callback} accessibilityLabel="void action" />,
            <PrimaryCircleIconButton active onPress={callback} accessibilityLabel="void action"><React.Fragment /></PrimaryCircleIconButton>,
        ];
        try {
            for (const fixture of fixtures) {
                callback.mockClear();
                const screen = await renderScreen(fixture);
                const target = () => screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'void action')[0]!;
                await act(async () => { target().props.onPress({ nativeEvent: {} }); });
                expect(target().props.accessibilityState?.busy).toBe(false);
                expect(target().props.disabled).toBe(false);
                await act(async () => { target().props.onPress({ nativeEvent: {} }); });
                expect(callback).toHaveBeenCalledTimes(2);
                await act(async () => { target().props.onFocus({ nativeEvent: {} }); });
                expect(screen.findAll(node => typeof node.type === 'string' && String(flattenTestStyle(node.props.style)?.backgroundImage).includes(finishInk))).toHaveLength(0);
                await screen.unmount();
            }
        } finally { await act(async () => { settle(); }); }
    });
    it('routes carried previews and keyboard docks through the same floating material while keeping their labels and hints intact', async () => {
        const { EntityReleasePreviewCard, EntityReleaseOutcomePill, EntityStagedMoveDock } = await import('@/components/ui/treeDragDrop/ui/EntityReleasePreview');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const outcome = { tone: 'allowed', title: 'Move Review' } as const;
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                <EntityReleasePreviewCard identity={{ title: 'Review' }} outcome={outcome} testID="preview" />
                <EntityReleaseOutcomePill outcome={outcome} testID="pill" />
                <EntityStagedMoveDock outcome={outcome} hints={[{ keys: ['esc'], label: 'Cancel' }]} testID="dock" />
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const paints = screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
        expect(paints).toHaveLength(3);
        for (const paint of paints) expect(flattenTestStyle(paint.props.style)?.backgroundColor).toContain('var(--happier-glass-floating-background-color');
        expect(screen.findHostByTestId('dock')?.findAll(node => node.props.children === 'Cancel')).not.toHaveLength(0);
    });
    it('keeps the independent selection rail glassy using its authored inverse fill and its own floating finish', async () => {
        const { SelectionActionBar } = await import('@/components/ui/selection/SelectionActionBar');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { lightTheme } = await import('@/theme');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                <SelectionActionBar visible label="2 selected" actions={[]} dismiss={{ label: 'Clear selection', onPress: () => {} }} />
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const paints = screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
        expect(paints).toHaveLength(1);
        const background = String(flattenTestStyle(paints[0]!.props.style)?.backgroundColor);
        expect(background).toContain('var(--happier-glass-floating-background-color');
        expect(background).toContain(lightTheme.colors.button.primary.background);
    });
    it('gives the browser marking tray one floating coat and retains an edited comment through material tier changes', async () => {
        const { AnnotationEditorOverlay } = await import('@/components/browser/annotation/AnnotationEditorOverlay');
        function Editor() {
            const [comment, setComment] = React.useState('');
            return <AnnotationEditorOverlay testID="anno" captureCapability={{ available: true, fidelity: 'nativeCallback' }} markCount={0} marks={[]} comment={comment} onCommentChange={setComment}
                onSelectElement={() => {}} onAddRegion={() => {}} onAddStroke={() => {}} onRemoveMark={() => {}} onAttach={() => {}} onCancel={() => {}} />;
        }
        const screen = await renderScreen(<Editor />);
        const toolbar = () => screen.findAll(node => typeof node.type === 'string' && node.props.accessibilityRole === 'toolbar')[0]!;
        const paints = () => toolbar().findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
        // Attach/Cancel own their button roles; only the direct tray plane is floating.
        expect(toolbar().children.filter(child => typeof child === 'object' && typeof flattenTestStyle(child.props.style)?.backgroundImage === 'string')).toHaveLength(1);
        await act(async () => { screen.changeTextByTestId('anno-comment', 'keep the comment'); });
        const field = screen.findHostByTestId('anno-comment');
        for (const preset of ['solid', 'auto'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(screen.findHostByTestId('anno-comment')).toBe(field);
            expect(screen.findHostByTestId('anno-comment')?.props.value).toBe('keep the comment');
            expect(paints().length).toBeGreaterThanOrEqual(1);
        }
    });
    it('lets secondary action ink sit on the containing translucent material instead of an opaque slab', async () => {
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
                <GlassSurface surfaceGroup="floating"><RoundButton display="secondary" title="Cancel" /></GlassSurface>
            </GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>);
        const pill = screen.findAll(node => String(node.type) === 'Animated.View')[0]!;
        const fill = flattenTestStyle(pill.props.style)?.backgroundColor;
        if (typeof fill !== 'string') throw new Error('Expected a resolved material color');
        expect(Color(fill).alpha()).toBeGreaterThan(0);
        expect(Color(fill).alpha()).toBeLessThan(1);
        expect(flattenTestStyle(pill.props.style)?.backgroundImage).toContain('rgba');
    });
    it('keeps an actionable core card to one coat and drops its finish while focused or flat even under a shared theme', async () => {
        const { SurfaceCard } = await import('@/components/ui/cards/SurfaceCard');
        const { HappierUiEnvironmentProvider } = await import('@happier-dev/plugin-ui/environment');
        const { projectPluginUiTheme } = await import('@/components/plugins/surfaces/pluginUiThemeProjection');
        const { lightTheme } = await import('@/theme');
        const scene = (tone: 'surface' | 'flat') => <HappierUiEnvironmentProvider environment={{
            theme: projectPluginUiTheme(lightTheme),
            localization: { locale: 'en', direction: 'ltr', translate: key => key },
            platform: { platform: 'web', colorScheme: 'light' },
            accessibility: { contrast: 'normal', textScale: 1, reducedMotion: false, screenReaderEnabled: false },
            insets: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 } },
        }}><SurfaceCard testID="card" tone={tone} onPress={() => {}}><DraftInput /></SurfaceCard></HappierUiEnvironmentProvider>;
        const screen = await renderScreen(scene('surface'));
        const paints = () => screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
        expect(paints()).toHaveLength(1);
        await act(async () => { screen.findHostByTestId('card')?.props.onFocus({ nativeEvent: {} }); });
        expect(paints()).toHaveLength(0);
        await screen.update(scene('flat'));
        expect(paints()).toHaveLength(0);
    });
    it('lays one translucent finish on a nested plane and lets an uncoated shell retain independent role finishes', async () => {
        useAutoPreset();
        const screen = await renderScreen(<GlassSurface surfaceGroup="content" finishRole={null}>
            <GlassSurface surfaceGroup="content" finishRole="card" nested>
                <GlassSurface surfaceGroup="content" finishRole="card" nested><DraftInput /></GlassSurface>
            </GlassSurface>
            <GlassSurface surfaceGroup="content" finishRole="composer" nested><React.Fragment /></GlassSurface>
        </GlassSurface>);
        const paints = screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string');
        expect(paints).toHaveLength(2);
        for (const paint of paints) {
            const style = flattenTestStyle(paint.props.style);
            expect(style.backgroundColor).toContain('var(--happier-glass-content-nested-');
            expect(style.backgroundImage).toContain('rgba');
        }
        await act(async () => { screen.changeTextByTestId('draft', 'retain the draft'); });
        await act(async () => { screen.update(<GlassSurface surfaceGroup="content" finishRole={null}>
            <GlassSurface surfaceGroup="content" finishRole="card" nested>
                <GlassSurface surfaceGroup="content" finishRole="card" nested><DraftInput /></GlassSurface>
            </GlassSurface>
            <GlassSurface surfaceGroup="content" finishRole="composer" nested><React.Fragment /></GlassSurface>
        </GlassSurface>); });
        expect(screen.findHostByTestId('draft')?.props.value).toBe('retain the draft');
    });
    it('gives themed floating forms the selected glass material while retaining their edited input across tiers', async () => {
        useAutoPreset();
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const screen = await renderScreen(<FloatingOverlay surfaceChrome="theme" scrollEnabled={false}><DraftInput /></FloatingOverlay>);
        expect(screen.findAll(hasBackdrop).length).toBeGreaterThan(0);
        await act(async () => { screen.changeTextByTestId('draft', 'keep the form draft'); });
        const field = screen.findHostByTestId('draft');
        for (const preset of ['solid', 'clear'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(screen.findHostByTestId('draft')).toBe(field);
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the form draft');
            expect(screen.findAll(hasBackdrop).length > 0).toBe(preset === 'clear');
        }
    });
    it('keeps an explicitly solid floating form opaque even with the auto glass preset', async () => {
        useAutoPreset();
        const screen = await renderScreen(<GlassSurface enabled={false} solidColor="#fefefe" surfaceGroup="floating"><DraftInput /></GlassSurface>);
        expect(screen.findAll(hasBackdrop)).toHaveLength(0);
        const paints = screen.findAll((node) => typeof node.type === 'string'
            && flattenTestStyle(node.props.style)?.backgroundColor === '#fefefe');
        expect(paints).toHaveLength(1);
    });
    it('blurs behind a floating surface without making its content a backdrop root', async () => {
        useAutoPreset();
        const screen = await renderScreen(
            <GlassSurface testID="outer" surfaceGroup="floating">
                <GlassSurface testID="inner" surfaceGroup="floating"><DraftInput /></GlassSurface>
            </GlassSurface>,
        );
        // The material really blurs on web (the floating group keeps its blur in a browser)...
        expect(screen.findAll(hasBackdrop).length).toBeGreaterThan(0);
        // ...yet neither the content nor a nested floating surface sits inside a backdrop root, so a menu,
        // tooltip or nested popover inside this surface blurs the page behind it, not an empty plane.
        const draft = screen.findHostByTestId('draft');
        expect(draft).not.toBeNull();
        expect(backdropAncestors(draft!).length).toBe(0);
    });

    it('keeps the content mounted when the user turns blur off and back on', async () => {
        useAutoPreset();
        const screen = await renderScreen(<GlassSurface surfaceGroup="floating"><DraftInput /></GlassSurface>);
        await act(async () => { screen.changeTextByTestId('draft', 'keep this draft'); });
        for (const preset of ['solid', 'auto'] as const) {
            act(() => storage.setState({ settings: { ...storage.getState().settings, ...resolvePreset(storage.getState().settings, preset) } }));
            expect(screen.findHostByTestId('draft')?.props.value).toBe('keep this draft');
            expect(screen.findAll(hasBackdrop).length > 0).toBe(preset === 'auto');
        }
    });

    it('never turns a shell plane into a backdrop root for the surfaces it holds', () => {
        // A base plane lies on the window canvas: there is nothing behind it a CSS blur could reach (the
        // window material is native), so a backdrop-filter there only cuts its descendants off the page.
        for (const group of ['chrome', 'sidebar', 'content'] as const) {
            const style = glassSurfacePlaneStyle('#ffffff', group) as Record<string, unknown>;
            expect(style.backdropFilter ?? 'none').toBe('none');
            expect(style.WebkitBackdropFilter ?? 'none').toBe('none');
        }
    });
});
