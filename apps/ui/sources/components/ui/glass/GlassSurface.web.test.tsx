import * as React from 'react';
import Color from 'color';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
import { glassContrastRatio, renderGlassOver } from '@/dev/testkit/glassBackdrop';

const browser = await vi.hoisted(async () => {
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    return installBrowserRuntimeForTests({ url: 'https://happier.test' });
});
beforeEach(() => { vi.stubGlobal('document', browser.document); });
afterAll(() => { browser.restore(); });

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
// Ink adapters stay real so faint-ink scoping is exercised through Text and Icon.
vi.unmock('@/components/ui/icons/Icon');
vi.unmock('@/components/ui/icons/iconRegistry.generated');
vi.unmock('@/components/ui/icons/iconRegistryHuge.generated');
const themeMode = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { darkTheme } = await import('@/theme');
    const light = await createUnistylesMock();
    const dark = await createUnistylesMock({ theme: { ...darkTheme } });
    return { ...light, useUnistyles: () => themeMode.dark ? dark.useUnistyles() : light.useUnistyles() };
});

// Collect the real component graph before the setup-hook deadline starts.
await import('@/sync/domains/state/storage');
await import('./GlassSurface');
await import('./glassSurfacePaint');
await import('./glassMaterial');

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
    document.body.replaceChildren();
});

function DraftInput() {
    const [value, setValue] = React.useState('');
    return React.createElement('DraftInput', { testID: 'draft', value, onChangeText: setValue });
}

// Host-rendered Pressables have no DOM node; give their focus event a real browser target.
function createFocusedBrowserButton() {
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();
    return button;
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
    it('retains an opened layer when the containing coat disappears without another glass plane', async () => {
        const { HappierSurface } = await import('@happier-dev/plugin-ui/presentation');
        const { renderThemeMaterialSurface, GlassOpenedLayer } = await import('./GlassSurface');
        const scene = (coated: boolean) => <HappierSurface materialRole={coated ? 'card' : undefined} renderMaterialSurface={renderThemeMaterialSurface}>
            <GlassOpenedLayer><DraftInput /></GlassOpenedLayer>
        </HappierSurface>;
        const screen = await renderScreen(scene(true));
        const input = screen.findHostByTestId('draft');
        await act(async () => { screen.changeTextByTestId('draft', 'keep the opened draft'); });
        for (const coated of [false, true]) {
            await screen.update(scene(coated));
            const current = screen.findHostByTestId('draft');
            expect(current?.props.value).toBe('keep the opened draft');
            expect(current).toBe(input);
        }
    });

    it('inherits a custom tint-only Elements coat without painting it again on a nested card', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const materials = { ...glassPresetMaterials('auto'), card: { blur: 'off' as const, opacity: 0.5 } };
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: materials }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
                <GlassSurface surfaceGroup="card" nested finishRole="card">
                    <GlassSurface surfaceGroup="card" nested finishRole="card"><DraftInput /></GlassSurface>
                </GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>);
        expect(screen.findAll(hasBackdrop)).toHaveLength(0);
        const coats = screen.findAll(node => typeof node.type === 'string'
            && String(flattenTestStyle(node.props.style)?.backgroundColor).includes('--happier-glass-card-background-color'));
        expect(coats).toHaveLength(1);
        expect(screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string')).toHaveLength(1);
    });
    it('gives Elements their own backing-dependent coat and no second blur or finish inside another card', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const scene = (atmosphereBehind: 'wallpaper' | 'none') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                <GlassSurface surfaceGroup="content" finishRole={null}>
                    <GlassSurface testID="card" surfaceGroup="card" nested finishRole="card" solidColor="#221c1c">
                        <GlassSurface testID="inner-card" surfaceGroup="card" nested finishRole="card"><DraftInput /></GlassSurface>
                    </GlassSurface>
                </GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;
        const screen = await renderScreen(scene('wallpaper'));
        expect(screen.findAll(hasBackdrop)).toHaveLength(1);
        const cardPaint = screen.findAll(hasBackdrop)[0]!;
        expect(flattenTestStyle(cardPaint.props.style).backgroundColor).toContain('color-mix(in srgb,');
        expect(screen.findAll(node => typeof node.type === 'string' && typeof flattenTestStyle(node.props.style)?.backgroundImage === 'string')).toHaveLength(1);
        await act(async () => { screen.changeTextByTestId('draft', 'keep the web card draft'); });
        await screen.update(scene('none'));
        expect(screen.findAll(hasBackdrop)).toHaveLength(0);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the web card draft');
        expect(screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === '#221c1c')).toHaveLength(1);
    });
    it('backs sidebar Elements with the sidebar plane: solid unless that plane is glass over a wallpaper', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const scene = (atmosphereBehind: 'band' | 'wallpaper', preset: 'everywhere' | 'auto' | 'solid' = 'everywhere') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                <GlassSurface plane surfaceGroup="sidebar" finishRole={null} solidColor="#1b1717">
                    <GlassSurface testID="sidebar-group" surfaceGroup="card" nested finishRole="card" solidColor="#221c1c"><DraftInput /></GlassSurface>
                </GlassSurface>
                <GlassSurface plane surfaceGroup="content" finishRole={null}>
                    <GlassSurface testID="home-card" surfaceGroup="card" nested finishRole="card" solidColor="#221c1c">{null}</GlassSurface>
                </GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;
        const cardBackdrops = (screen: Awaited<ReturnType<typeof renderScreen>>) => ['sidebar-group', 'home-card']
            .flatMap(testID => screen.findHostByTestId(testID)!.findAll(hasBackdrop));
        const screen = await renderScreen(scene('band'));
        // The Home card has the band behind it; the sidebar group sits on the sidebar plane, which the band never reaches.
        expect(cardBackdrops(screen)).toHaveLength(1);
        expect(screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === '#ffffff')).toHaveLength(1);
        await act(async () => { screen.changeTextByTestId('draft', 'keep the sidebar draft'); });
        await screen.update(scene('wallpaper'));
        expect(cardBackdrops(screen)).toHaveLength(2);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the sidebar draft');
        // Auto: a shown wallpaper is backing for the browser sidebar too (owner ruling 2026-10-23), so it backs both groups.
        await screen.update(scene('wallpaper', 'auto'));
        expect(cardBackdrops(screen)).toHaveLength(2);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the sidebar draft');
        // Solid keeps the sidebar and its Elements opaque, so the wallpaper backs nothing in it.
        await screen.update(scene('wallpaper', 'solid'));
        expect(cardBackdrops(screen)).toHaveLength(0);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the sidebar draft');
    });
    it('paints sidebar-held Elements in the page colour, one quiet step above the sidebar, without the card lift', async () => {
        themeMode.dark = true;
        const { darkTheme } = await import('@/theme');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassSurface plane surfaceGroup="sidebar" finishRole={null} solidColor={darkTheme.colors.surface.inset}>
                <GlassSurface testID="sidebar-group" surfaceGroup="card" nested finishRole="card" solidColor={darkTheme.colors.edge.cardFill}>{null}</GlassSurface>
            </GlassSurface>
            <GlassSurface plane surfaceGroup="content" finishRole={null}>
                <GlassSurface testID="page-card" surfaceGroup="card" nested finishRole="card" solidColor={darkTheme.colors.edge.cardFill}>{null}</GlassSurface>
            </GlassSurface>
        </GlassMaterialSettingsProvider>);
        const paints = screen.findAll(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true')
            .map(node => flattenTestStyle(node.props.style)?.backgroundColor);
        expect(paints).toContain(darkTheme.colors.surface.base);
        // A card on the page keeps its card fill.
        expect(paints).toContain(darkTheme.colors.edge.cardFill);
    });
    it('resolves backed Elements and floating glass over the plain page to their solid paint, and compresses a bright picture', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials, resolveGlassSurfaceMaterial } = await import('./glassMaterial');
        const { darkTheme, lightTheme } = await import('@/theme');
        for (const theme of [darkTheme, lightTheme]) {
            themeMode.dark = theme.dark;
            for (const [group, atmosphereBehind, solid] of [
                ['card', 'band', theme.colors.edge.cardFill],
                ['floating', 'band', theme.colors.edge.floatingFill],
                ['floating', 'none', theme.colors.edge.floatingFill],
            ] as const) {
                // Medium paints the surface's own fill over the page; Subtle's hair of ink is covered in glassMaterial.test.
                const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 50 };
                const screen = await renderScreen(<GlassMaterialSettingsProvider value={settings}>
                    <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                        <GlassSurface surfaceGroup={group} finishRole={null} solidColor={solid}><DraftInput /></GlassSurface>
                    </GlassRuntimeEnvironmentProvider>
                </GlassMaterialSettingsProvider>);
                const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
                const coat = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) /i.exec(style.backgroundColor!)?.[1];
                expect(coat).toBeTruthy();
                // Feasibility can raise the rendered coat above its stored alpha. Read the actual
                // paint at the browser boundary rather than evaluating a coat the renderer never uses.
                const paintedPercent = /color-mix\(in srgb, (?:rgba?\([^)]*\)|#[0-9a-f]+) ([\d.]+)%/i.exec(style.backgroundColor!)?.[1];
                const opacity = paintedPercent === undefined
                    ? resolveGlassSurfaceMaterial(settings, group, { atmosphereBehind }).material.opacity
                    : Number(paintedPercent) / 100;
                const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
                const over = (backdrop: [number, number, number]) => renderGlassOver({ filter: style.backdropFilter!, coat: rgb(coat!), opacity, backdrop });
                over(rgb(theme.colors.surface.base)).forEach((value, channel) => expect(Math.abs(value - rgb(solid)[channel]!)).toBeLessThanOrEqual(1));
                if (theme.dark && atmosphereBehind === 'band') {
                    // The balloons' bright sky stays legible under white ink, with its warm hue kept.
                    const sky = over([193, 146, 143]);
                    expect(glassContrastRatio(sky, rgb(theme.colors.text.primary))).toBeGreaterThanOrEqual(4.5);
                    expect(sky[0]).toBeGreaterThan(sky[2]! + 15);
                }
                standardCleanup();
            }
        }
    });
    it('strengthens faint ink only on glass with a picture behind it, leaving ordinary pages and unbacked glass untouched', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials, resolveGlassSurfaceMaterial } = await import('./glassMaterial');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const settings = { glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 50 };
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const secondaryOverride = (node: ReactTestInstance | null | undefined) => (flattenTestStyle(node?.props.style) as Record<string, string> | null)?.['--colors-text-secondary'];
        for (const [group, atmosphereBehind, backed] of [
            ['card', 'band', true], ['floating', 'band', true], ['card', 'none', false], ['floating', 'none', false],
        ] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={settings}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                    <GlassSurface testID="glass" surfaceGroup={group} finishRole={null}><DraftInput /></GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            const override = secondaryOverride(screen.findHostByTestId('glass'));
            if (!backed) {
                expect(override).toBeUndefined();
            } else {
                // Over the balloons' brightest sky at Medium, faint ink reaches about 3:1 (Subtle passes the picture through).
                const backdrop = screen.findAll(hasBackdrop)[0]!;
                const style = flattenTestStyle(backdrop.props.style) as Record<string, string>;
                const coat = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) /i.exec(style.backgroundColor!)?.[1];
                const { opacity } = resolveGlassSurfaceMaterial(settings, group, { atmosphereBehind }).material;
                const glass = renderGlassOver({ filter: style.backdropFilter!, coat: rgb(coat!), opacity, backdrop: [193, 146, 143] });
                const mix = /color-mix\(in srgb, (#[0-9a-f]+|rgba?\([^)]*\)) (\d+(?:\.\d+)?)%, transparent\)/i.exec(override ?? '');
                expect(mix).not.toBeNull();
                const ink = rgb(mix![1]!); const share = Number(mix![2]) / 100;
                const faint = glass.map((value, channel) => ink[channel]! * share + value * (1 - share)) as [number, number, number];
                expect(glassContrastRatio(faint, glass)).toBeGreaterThanOrEqual(3);
                expect(glassContrastRatio(faint, glass)).toBeGreaterThan(glassContrastRatio(rgb(darkTheme.colors.text.secondary), glass));
            }
            standardCleanup();
        }
    });
    it('gives faint ink passed as a concrete theme value the same stronger step on backed glass', async () => {
        const { SectionActionButton } = await import('@/components/ui/lists/SectionActionButton');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const settings = { glassSurfaceMaterials: glassPresetMaterials('auto') };
        const rgba = (value: unknown) => Color(String(value)).rgb().string();
        for (const [group, atmosphereBehind, backed] of [
            ['card', 'band', true], ['floating', 'wallpaper', true], ['card', 'none', false],
        ] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={settings}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                    <GlassSurface surfaceGroup={group} finishRole={null}>
                        <SectionActionButton testID="add" title="Add member" icon="plus" onPress={() => {}} />
                    </GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            const label = screen.findAll(node => String(node.type) === 'Text' && node.props.children === 'Add member')[0];
            const labelColor = (flattenTestStyle(label?.props.style) as Record<string, unknown> | null)?.color;
            // The real Icon adapter (unmocked above) hands its glyph the resolved ink.
            const glyph = screen.findAll(node => typeof node.props.size === 'number' && typeof node.props.color === 'string' && node.props.name === undefined)[0];
            const expected = backed
                ? Color(darkTheme.colors.text.primary).alpha(0.7).rgb().string()
                : Color(darkTheme.colors.text.secondary).rgb().string();
            expect(rgba(labelColor)).toBe(expected);
            expect(rgba(glyph?.props.color)).toBe(expected);
            if (!backed) expect(labelColor).toBe(darkTheme.colors.text.secondary);
            standardCleanup();
        }
    });
    it('steps the tertiary meta and the composer\'s chip and placeholder ink inside a card up to the secondary faint ink on glass with a picture behind it, and leaves unbacked glass alone', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const rgba = (value: unknown) => Color(String(value)).rgb().string();
        const inkOf = (screen: Awaited<ReturnType<typeof renderScreen>>, text: string) => (flattenTestStyle(
            screen.findAll(node => String(node.type) === 'Text' && node.props.children === text)[0]?.props.style) as Record<string, unknown> | null)?.color;
        for (const [group, atmosphereBehind, backed] of [
            ['card', 'wallpaper', true], ['floating', 'band', true], ['card', 'none', false],
        ] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                    <GlassSurface testID="glass" surfaceGroup={group} finishRole={null}>
                        <Text style={{ color: darkTheme.colors.text.secondary }}>Secondary line</Text>
                        <Text style={{ color: darkTheme.colors.text.tertiary }}>Meta line</Text>
                        <Text style={{ color: darkTheme.colors.composer.chipTint }}>Chip line</Text>
                        <Text style={{ color: darkTheme.colors.input.placeholder }}>Placeholder line</Text>
                    </GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            const webInk = (flattenTestStyle(screen.findHostByTestId('glass')?.props.style) as Record<string, string> | null) ?? {};
            if (!backed) {
                expect(inkOf(screen, 'Meta line')).toBe(darkTheme.colors.text.tertiary);
                expect(inkOf(screen, 'Chip line')).toBe(darkTheme.colors.composer.chipTint);
                expect(webInk['--colors-composer-chip-tint']).toBeUndefined();
            } else {
                // The composer's chips and placeholder are the faintest ink it draws: they take the same faint step,
                // the one the default coat cap protects, from JavaScript and from the web stylesheet alike.
                expect(inkOf(screen, 'Chip line')).toBe(inkOf(screen, 'Secondary line'));
                expect(inkOf(screen, 'Placeholder line')).toBe(inkOf(screen, 'Secondary line'));
                expect(webInk['--colors-composer-chip-tint']).toBe(webInk['--colors-text-secondary']);
                expect(webInk['--colors-input-placeholder']).toBe(webInk['--colors-text-secondary']);
                const secondary = Color(inkOf(screen, 'Secondary line') as string);
                const tertiary = Color(inkOf(screen, 'Meta line') as string);
                // Over a picture the theme's own tertiary cannot hold its contrast: it takes the faint-ink step, the secondary's own.
                expect(rgba(tertiary)).not.toBe(rgba(darkTheme.colors.text.tertiary));
                expect(tertiary.alpha()).toBeGreaterThan(0.4);
                expect(tertiary.alpha()).toBe(secondary.alpha());
                expect(tertiary.rgb().array().slice(0, 3)).toEqual(Color(darkTheme.colors.text.primary).rgb().array().slice(0, 3));
            }
            standardCleanup();
        }
    });
    it('derives default glass from the measured picture: the theme ink keeps its contrast over a picture that runs against the theme, and custom glass applies as set', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials, GLASS_SURFACE_GROUPS, resolveGlassSurfaceMaterial } = await import('./glassMaterial');
        const { GLASS_BACKED_FAINT_INK_SHARE } = await import('./glassBackedInk');
        const { darkTheme, lightTheme } = await import('@/theme');
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const toneOf = (backdrop: [number, number, number]) => { const l = Color.rgb(backdrop).luminosity(); return { dark: l, light: l, focus: l }; };
        // Ship by Moonlight under the light theme; the bright band of Dune grass under the dark theme.
        for (const [theme, backdrop] of [[lightTheme, [22, 28, 44]], [darkTheme, [200, 145, 153]]] as const) {
            themeMode.dark = theme.dark;
            const paintOver = async (settings: Record<string, unknown>, tone: ReturnType<typeof toneOf> | undefined, group: 'card' | 'floating') => {
                const screen = await renderScreen(<GlassMaterialSettingsProvider value={settings}>
                    <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper', atmosphereTone: tone }}>
                        <GlassSurface surfaceGroup={group} finishRole={null} solidColor={group === 'card' ? theme.colors.edge.cardFill : theme.colors.edge.floatingFill}><DraftInput /></GlassSurface>
                    </GlassRuntimeEnvironmentProvider>
                </GlassMaterialSettingsProvider>);
                const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
                standardCleanup();
                return style;
            };
            const glassOf = (style: Record<string, string>, over: readonly number[], group: 'card' | 'floating') => {
                const coat = rgb(/color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) /i.exec(style.backgroundColor!)![1]!);
                // Feasibility can raise the painted coat above its stored alpha: read the paint the browser gets.
                const painted = /color-mix\(in srgb, (?:rgba?\([^)]*\)|#[0-9a-f]+) ([\d.]+)%/i.exec(style.backgroundColor!)?.[1];
                const opacity = painted === undefined
                    ? resolveGlassSurfaceMaterial({ glassSurfaceMaterials: glassPresetMaterials('auto') }, group, { atmosphereBehind: 'wallpaper' }).material.opacity
                    : Number(painted) / 100;
                return renderGlassOver({ filter: style.backdropFilter!, coat, opacity, backdrop: over as [number, number, number] });
            };
            for (const group of ['card', 'floating'] as const) {
                // The default look: Auto at the default tint.
                const style = await paintOver({ glassSurfaceMaterials: glassPresetMaterials('auto') }, toneOf([...backdrop]), group);
                const glass = glassOf(style, backdrop, group);
                const ink = rgb(theme.colors.text.primary);
                const faint = ink.map((value, channel) => value * GLASS_BACKED_FAINT_INK_SHARE + glass[channel]! * (1 - GLASS_BACKED_FAINT_INK_SHARE)) as [number, number, number];
                expect(glassContrastRatio(ink, glass)).toBeGreaterThanOrEqual(4.5);
                expect(glassContrastRatio(faint, glass)).toBeGreaterThanOrEqual(3);
                // Over the plain page the same glass still lands on its solid paint.
                const solid = group === 'card' ? theme.colors.edge.cardFill : theme.colors.edge.floatingFill;
                glassOf(style, rgb(theme.colors.surface.base), group).forEach((value, channel) => expect(Math.abs(value - Color(solid).rgb().array()[channel]!)).toBeLessThanOrEqual(2));
            }
            // A person's own glass applies exactly as set: the measured picture changes nothing.
            const custom = { glassSurfaceMaterials: Object.fromEntries(GLASS_SURFACE_GROUPS.map(group => [group, { blur: 'regular', opacity: 0.1 }])) };
            expect(await paintOver(custom, toneOf([...backdrop]), 'card')).toEqual(await paintOver(custom, undefined, 'card'));
        }
    });
    it('keeps the label of a control nested in default glass legible over the measured picture: the coat accounts for the control\'s own translucent fill', async () => {
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials, resolveGlassSurfaceMaterial } = await import('./glassMaterial');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        // The bright sky of Orange dune under the dark theme: a bordered "Review" pill on a card.
        const backdrop: [number, number, number] = [236, 162, 92];
        const l = Color.rgb(backdrop).luminosity();
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper', atmosphereTone: { dark: l, light: l, focus: l } }}>
                <GlassSurface surfaceGroup="card" finishRole={null} solidColor={darkTheme.colors.edge.cardFill}><DraftInput /></GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>);
        const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
        standardCleanup();
        const coat = rgb(/color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) /i.exec(style.backgroundColor!)![1]!);
        const painted = /color-mix\(in srgb, (?:rgba?\([^)]*\)|#[0-9a-f]+) ([\d.]+)%/i.exec(style.backgroundColor!)?.[1];
        const opacity = painted === undefined
            ? resolveGlassSurfaceMaterial({ glassSurfaceMaterials: glassPresetMaterials('auto') }, 'card', { atmosphereBehind: 'wallpaper' }).material.opacity
            : Number(painted) / 100;
        const glass = renderGlassOver({ filter: style.backdropFilter!, coat, opacity, backdrop });
        // The control's fill on glass is the material's translucent inner fill.
        const fill = Color(darkTheme.colors.surface.selected);
        const control = glass.map((value, channel) => fill.rgb().array()[channel]! * fill.alpha() + value * (1 - fill.alpha())) as [number, number, number];
        const ink = rgb(darkTheme.colors.text.primary);
        expect(glassContrastRatio(ink, glass)).toBeGreaterThanOrEqual(4.5);
        expect(glassContrastRatio(ink, control)).toBeGreaterThanOrEqual(4.5);
    });
    it('reads every ink on the Wallpaper plane in the page colour where the atmosphere chose it, and keeps the theme ink otherwise', async () => {
        const { Text } = await import('@/components/ui/text/Text');
        const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { lightTheme } = await import('@/theme');
        const rgba = (value: unknown) => Color(String(value)).rgb().string();
        const colorOf = (screen: Awaited<ReturnType<typeof renderScreen>>, text: string) => rgba((flattenTestStyle(
            screen.findAll(node => String(node.type) === 'Text' && node.props.children === text)[0]?.props.style) as Record<string, unknown> | null)?.color);
        // The atmosphere decides the plane's ink with its haze (`resolveWallpaperHaze`); the plane applies it.
        for (const [planeInk, ink] of [['page', lightTheme.colors.surface.base], ['theme', lightTheme.colors.text.primary], [undefined, lightTheme.colors.text.primary]] as const) {
            const focus = 0.2;
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper', atmosphereTone: { dark: focus, light: focus, focus, ink: planeInk } }}>
                    <GlassSurface testID="plane" plane surfaceGroup="content" finishRole={null}>
                        <Text style={{ color: lightTheme.colors.text.primary }}>Needs your attention</Text>
                        <Text style={{ color: lightTheme.colors.text.tertiary }}>4 needs you</Text>
                        <RoundButton display="secondary" size="small" title="Brief me" onPress={() => {}} />
                        <GlassSurface surfaceGroup="card" finishRole={null}>
                            <Text style={{ color: lightTheme.colors.text.primary }}>On a card</Text>
                        </GlassSurface>
                    </GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            expect(colorOf(screen, 'Needs your attention')).toBe(rgba(ink));
            expect(colorOf(screen, '4 needs you')).toBe(rgba(ink));
            // A card and a filled button are their own ground: they keep the theme ink.
            expect(colorOf(screen, 'On a card')).toBe(rgba(lightTheme.colors.text.primary));
            expect(colorOf(screen, 'Brief me')).toBe(rgba(lightTheme.colors.text.primary));
            const planeStyle = flattenTestStyle(screen.findHostByTestId('plane')?.props.style) as Record<string, string>;
            expect(rgba(planeStyle['--colors-text-primary'])).toBe(rgba(ink));
            standardCleanup();
        }
    });
    it('reads quiet head lines in the primary ink where the cleared page is the Wallpaper picture itself, and gives Elements on it their own ink', async () => {
        const { SectionActionButton } = await import('@/components/ui/lists/SectionActionButton');
        const { Text } = await import('@/components/ui/text/Text');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const rgba = (value: unknown) => Color(String(value)).rgb().string();
        const colorOf = (screen: Awaited<ReturnType<typeof renderScreen>>, text: string) => rgba((flattenTestStyle(
            screen.findAll(node => String(node.type) === 'Text' && node.props.children === text)[0]?.props.style) as Record<string, unknown> | null)?.color);
        for (const [atmosphereBehind, onPicture] of [['wallpaper', true], ['band', false], ['none', false]] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('solid') }}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                    <GlassSurface plane surfaceGroup="content" finishRole={null}>
                        <SectionActionButton testID="customize" title="Customize" icon="sliders-horizontal" onPress={() => {}} />
                        <Text style={{ color: darkTheme.colors.text.tertiary }}>Overview is yours now</Text>
                        <GlassSurface surfaceGroup="card" finishRole={null}>
                            <Text style={{ color: darkTheme.colors.text.tertiary }}>On a card</Text>
                        </GlassSurface>
                    </GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            const primary = Color(darkTheme.colors.text.primary).rgb().string();
            expect(colorOf(screen, 'Customize')).toBe(onPicture ? primary : Color(darkTheme.colors.text.secondary).rgb().string());
            expect(colorOf(screen, 'Overview is yours now')).toBe(onPicture ? primary : Color(darkTheme.colors.text.tertiary).rgb().string());
            // Solid Elements stand on their own paint, so their quiet ink stays the theme's.
            expect(colorOf(screen, 'On a card')).toBe(Color(darkTheme.colors.text.tertiary).rgb().string());
            standardCleanup();
        }
    });
    it('gives panels (dialogs and anchored panels) the page at a heavy coat at Subtle, landing on the floating paint over a plain page, while menus keep their hair of tint', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const { HappierSurface } = await import('@happier-dev/plugin-ui/presentation');
        const { renderThemeMaterialSurface } = await import('./GlassSurface');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const paint = async (surface: React.ReactNode) => {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                {surface}
            </GlassMaterialSettingsProvider>);
            const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
            standardCleanup();
            const mix = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) (\d+(?:\.\d+)?)%, transparent\)/i.exec(style.backgroundColor!);
            return { filter: style.backdropFilter!, coat: mix ? rgb(mix[1]!) : null, opacity: mix ? Number(mix[2]) / 100 : null };
        };
        const page = rgb(darkTheme.colors.surface.base);
        // A dialog declares the panel role on the material; an anchored panel declares it on the floating overlay.
        for (const panel of [
            await paint(<GlassSurface surfaceGroup="floating" floatingRole="panel"><DraftInput /></GlassSurface>),
            await paint(<FloatingOverlay role="panel" scrollEnabled={false}><DraftInput /></FloatingOverlay>),
            // A plugin's anchored panel reaches the same owner through the public material request.
            await paint(<HappierSurface materialRole="floating" floatingRole="panel" renderMaterialSurface={renderThemeMaterialSurface}><DraftInput /></HappierSurface>),
        ]) {
            expect(panel.opacity).toBeGreaterThanOrEqual(0.5);
            renderGlassOver({ filter: panel.filter, coat: panel.coat!, opacity: panel.opacity!, backdrop: page })
                .forEach((value, channel) => expect(Math.abs(value - rgb(darkTheme.colors.edge.floatingFill)[channel]!)).toBeLessThanOrEqual(1));
        }
        // Menus and popovers keep Subtle's hair, raised only as far as the fixed point needs; never a heavy mix.
        for (const menu of [
            await paint(<GlassSurface surfaceGroup="floating"><DraftInput /></GlassSurface>),
            await paint(<FloatingOverlay scrollEnabled={false}><DraftInput /></FloatingOverlay>),
            await paint(<HappierSurface materialRole="floating" renderMaterialSurface={renderThemeMaterialSurface}><DraftInput /></HappierSurface>),
        ]) expect(menu.opacity === null || menu.opacity <= 0.07).toBe(true);
    });
    it('gives a menu opened over a live picture the panel coat (the glass owner decides it for every floating surface there), so its ink stays legible over arbitrary pixels', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { GlassLivePictureBackdropContext } = await import('./livePictureBackdrop');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const { lightTheme } = await import('@/theme');
        themeMode.dark = false;
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassLivePictureBackdropContext.Provider value>
                <FloatingOverlay scrollEnabled={false}><DraftInput /></FloatingOverlay>
            </GlassLivePictureBackdropContext.Provider>
        </GlassMaterialSettingsProvider>);
        const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
        standardCleanup();
        const mix = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) (\d+(?:\.\d+)?)%, transparent\)/i.exec(style.backgroundColor!);
        expect(mix).not.toBeNull();
        const opacity = Number(mix![2]) / 100;
        expect(opacity).toBeGreaterThanOrEqual(0.5);
        // A black terminal under light-theme ink: the menu's primary ink keeps body-text contrast.
        const over = renderGlassOver({ filter: style.backdropFilter!, coat: rgb(mix![1]!), opacity, backdrop: [0, 0, 0] });
        expect(Color.rgb(over).contrast(Color(lightTheme.colors.text.primary))).toBeGreaterThanOrEqual(4.5);
    });
    it('keeps a floating bar over a document legible at the default: white paper under dark-theme ink takes the live-picture coat', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { FloatingTabBarSurface } = await import('@/components/ui/navigation/FloatingTabBarSurface');
        const { darkTheme } = await import('@/theme');
        themeMode.dark = true;
        const rgb = (value: string) => Color(value).rgb().array().slice(0, 3) as unknown as [number, number, number];
        const contrastOverPaper = async (overPicture: boolean) => {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <FloatingTabBarSurface bottomInset={0} stretch overPicture={overPicture}><DraftInput /></FloatingTabBarSurface>
            </GlassMaterialSettingsProvider>);
            const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
            standardCleanup();
            const mix = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) (\d+(?:\.\d+)?)%, transparent\)/i.exec(style.backgroundColor!);
            const over = renderGlassOver({ filter: style.backdropFilter!, coat: mix ? rgb(mix[1]!) : [0, 0, 0], opacity: mix ? Number(mix[2]) / 100 : 0, backdrop: [255, 255, 255] });
            return Color.rgb(over).contrast(Color(darkTheme.colors.text.primary));
        };
        // The PDF page (FV5p): a white page scrolls under the phone toolbar's "1 of 3".
        expect(await contrastOverPaper(true)).toBeGreaterThanOrEqual(4.5);
        // The plain bar keeps the hair of tint (the tab bars over lists and atmosphere), which is why the media page opts in.
        expect(await contrastOverPaper(false)).toBeLessThan(4.5);
        themeMode.dark = false;
    });
    it('applies a customized tint exactly as set over a live picture, as it would anywhere else (only the shipped default takes the readable coat)', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { GlassLivePictureBackdropContext } = await import('./livePictureBackdrop');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        themeMode.dark = false;
        const coatOf = async (settings: Parameters<typeof GlassMaterialSettingsProvider>[0]['value'], overLivePicture: boolean) => {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={settings}>
                <GlassLivePictureBackdropContext.Provider value={overLivePicture}>
                    <FloatingOverlay scrollEnabled={false}><DraftInput /></FloatingOverlay>
                </GlassLivePictureBackdropContext.Provider>
            </GlassMaterialSettingsProvider>);
            const style = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style) as Record<string, string>;
            standardCleanup();
            const mix = /color-mix\(in srgb, (?:rgba?\([^)]*\)|#[0-9a-f]+) (\d+(?:\.\d+)?)%, transparent\)/i.exec(style.backgroundColor!);
            return { opacity: mix ? Number(mix[1]) / 100 : null, filter: style.backdropFilter };
        };
        const materials = glassPresetMaterials('auto');
        for (const glassTintIntensity of [0, 30]) {
            const custom = { glassSurfaceMaterials: materials, glassTintIntensity };
            const over = await coatOf(custom, true);
            expect(over).toEqual(await coatOf(custom, false));
            expect(over.opacity === null || over.opacity <= 0.07).toBe(true);
        }
        // The default stays the readable coat, with the tint unset or set to the shipped value.
        for (const settings of [{ glassSurfaceMaterials: materials }, { glassSurfaceMaterials: materials, glassTintIntensity: 12 }]) {
            expect((await coatOf(settings, true)).opacity).toBeGreaterThanOrEqual(0.85 - 1e-9);
        }
    });
    it('keeps rendering glass whose paint is a live theme variable rather than a concrete colour', async () => {
        themeMode.dark = true;
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        for (const group of ['card', 'floating'] as const) {
            const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'band' }}>
                    <GlassSurface surfaceGroup={group} finishRole={null} solidColor="var(--colors-edge-card-fill)"><DraftInput /></GlassSurface>
                </GlassRuntimeEnvironmentProvider>
            </GlassMaterialSettingsProvider>);
            expect(screen.findAll(hasBackdrop)).toHaveLength(1);
            standardCleanup();
        }
    });
    it('coats a page sheet over a backdrop with the page it stands for, not its whisper of tint', async () => {
        themeMode.dark = true;
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const sectionTint = 'rgba(255,255,255,0.014)';
        const scene = (atmosphereBehind: 'wallpaper' | 'none') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto'), glassTintIntensity: 50 }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
                <GlassSurface testID="page-sheet" surfaceGroup="card" nested finishRole="card" solidColor={sectionTint}><DraftInput /></GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;
        const screen = await renderScreen(scene('wallpaper'));
        const paint = flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style).backgroundColor as string;
        // The sheet stands for its tint over the dark page (#1B1919): over that page the glass resolves to it.
        const coat = /color-mix\(in srgb, (rgba?\([^)]*\)|#[0-9a-f]+) /i.exec(paint)?.[1];
        const over = renderGlassOver({ filter: flattenTestStyle(screen.findAll(hasBackdrop)[0]!.props.style).backdropFilter as string,
            coat: Color(coat!).rgb().array().slice(0, 3) as unknown as [number, number, number], opacity: glassPresetMaterials('auto').card.opacity, backdrop: [27, 25, 25] });
        over.forEach((value, channel) => expect(Math.abs(value - [30, 28, 28][channel]!)).toBeLessThanOrEqual(1));
        expect(paint).not.toContain(sectionTint);
        await act(async () => { screen.changeTextByTestId('draft', 'keep the sheet draft'); });
        await screen.update(scene('none'));
        expect(screen.findAll(hasBackdrop)).toHaveLength(0);
        expect(screen.findAll(node => typeof node.type === 'string' && flattenTestStyle(node.props.style)?.backgroundColor === sectionTint)).toHaveLength(1);
        expect(screen.findHostByTestId('draft')?.props.value).toBe('keep the sheet draft');
    });
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
    it('uses a faint fixed-point coat for dark Clear while solid retains the exact floating paper', async () => {
        themeMode.dark = true;
        const { darkTheme } = await import('@/theme');
        act(() => storage.setState({ settings: { ...previousState.settings, ...resolvePreset(previousState.settings, 'clear') } }));
        const screen = await renderScreen(<GlassSurface surfaceGroup="floating" finishRole={null}><DraftInput /></GlassSurface>);
        // The coat is the CSS material variable, or a concrete mix when the fixed point raised its alpha.
        const paints = () => screen.findAll(node => typeof node.type === 'string' && /--happier-glass-floating-background-color|^color-mix\(/.test(String(flattenTestStyle(node.props.style)?.backgroundColor)));
        expect(paints()).toHaveLength(1);
        // The glass coat is solved so the faint coat over the page lands on the floating paper (fixed-point test above).
        expect(String(flattenTestStyle(paints()[0]!.props.style)?.backgroundColor)).not.toContain(darkTheme.colors.edge.floatingFill);
        expect(screen.findAll(hasBackdrop)).toHaveLength(1);
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
            const browserTarget = createFocusedBrowserButton();
            document.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            await act(async () => { target.props.onFocus?.({ target: browserTarget, nativeEvent: {} }); });
            expect(finishPaints()).toHaveLength(1);
            document.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
            await act(async () => { target.props.onFocus?.({ target: browserTarget, nativeEvent: {} }); });
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
                const browserTarget = createFocusedBrowserButton();
                document.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
                await act(async () => { target().props.onFocus({ target: browserTarget, nativeEvent: {} }); });
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
        for (const paint of paints) expect(String(flattenTestStyle(paint.props.style)?.backgroundColor)).toMatch(/--happier-glass-floating-background-color|^color-mix\(/);
        expect(screen.findHostByTestId('dock')?.findAll(node => node.props.children === 'Cancel')).not.toHaveLength(0);
    });
    it('keeps the independent selection rail on its authored inverse fill with one floating finish', async () => {
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
        expect(background).toContain('color-mix(in srgb,');
        expect(background).toContain(lightTheme.colors.button.primary.background);
    });
    it('paints a surface opened over a translucent dialog (a field\'s choices) on its own floating paint, even when it asks to be nested', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { GlassOpenedLayer, renderThemeMaterialSurface } = await import('./GlassSurface');
        const { HappierSurface } = await import('@happier-dev/plugin-ui/presentation');
        const { lightTheme } = await import('@/theme');
        const screen = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
            <GlassSurface surfaceGroup="floating" floatingRole="panel">
                <DraftInput />
                {/* The popover portal keeps the dialog's React context; the layer boundary is all that separates them. */}
                <GlassOpenedLayer>
                    <HappierSurface testID="choices" materialRole="floating" nested renderMaterialSurface={renderThemeMaterialSurface}>{null}</HappierSurface>
                    <GlassSurface testID="menu" surfaceGroup="floating" nested>{null}</GlassSurface>
                </GlassOpenedLayer>
            </GlassSurface>
        </GlassMaterialSettingsProvider>);
        // The dialog itself stays glass.
        expect(screen.findAll(hasBackdrop)).toHaveLength(1);
        for (const id of ['choices', 'menu']) {
            const surface = screen.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]!;
            const paint = surface.findAll(node => typeof node.type === 'string' && node.props.dataSet?.happyGlassBackdrop === 'true')[0]!;
            // Its own opaque floating paint: never the dialog's (transparent) coat, never glass stacked on glass.
            expect(flattenTestStyle(paint.props.style)?.backgroundColor).toBe(lightTheme.colors.edge.floatingFill);
            expect(hasBackdrop(paint)).toBe(false);
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
        const browserTarget = createFocusedBrowserButton();
        document.dispatchEvent(new browser.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await act(async () => { screen.findHostByTestId('card')?.props.onFocus({ target: browserTarget, nativeEvent: {} }); });
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
        // tooltip or nested popover inside this surface never paints over an empty plane.
        const draft = screen.findHostByTestId('draft');
        expect(draft).not.toBeNull();
        expect(backdropAncestors(draft!).length).toBe(0);
    });

    it('paints a floating surface opened over another floating surface solid under a named preset, so it never blurs the controls beneath it into a haze, while a Custom table applies as set', async () => {
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { FloatingOverlay } = await import('@/components/ui/overlays/FloatingOverlay');
        const backdropsIn = (screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) => screen.findAll(hasBackdrop)
            .filter(node => { for (let parent = node.parent; parent; parent = parent.parent) if (parent.props?.testID === testID) return true; return false; });
        useAutoPreset();
        const shipped = await renderScreen(
            <FloatingOverlay role="panel" scrollEnabled={false}>
                <GlassSurface testID="inner" surfaceGroup="floating"><DraftInput /></GlassSurface>
            </FloatingOverlay>,
        );
        // The Run now panel keeps its glass; the Inputs popover opened from it stands on its own paint.
        expect(shipped.findAll(hasBackdrop)).toHaveLength(1);
        expect(backdropsIn(shipped, 'inner')).toHaveLength(0);
        standardCleanup();
        // A person's own named preset (Everywhere at strong blur) follows the same rule.
        act(() => {
            const strong = { ...storage.getState().settings, glassBlurIntensity: 'strong' as const };
            storage.setState({ settings: { ...strong, ...resolvePreset(strong, 'everywhere') } });
        });
        const named = await renderScreen(<GlassSurface surfaceGroup="floating"><GlassSurface testID="inner" surfaceGroup="floating"><DraftInput /></GlassSurface></GlassSurface>);
        expect(named.findAll(hasBackdrop)).toHaveLength(1);
        expect(backdropsIn(named, 'inner')).toHaveLength(0);
        standardCleanup();
        const custom = await renderScreen(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), floating: { blur: 'light' as const, opacity: 0.2 } } }}>
            <GlassSurface surfaceGroup="floating"><GlassSurface testID="inner" surfaceGroup="floating"><DraftInput /></GlassSurface></GlassSurface>
        </GlassMaterialSettingsProvider>);
        expect(backdropsIn(custom, 'inner')).toHaveLength(1);
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
