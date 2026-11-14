import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Animated, View } from 'react-native';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import Color from 'color';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { storage } from '@/sync/domains/state/storageStore';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { useAtmosphereBandBoundary } from './atmosphereBandBoundary';
import { atmosphereStageStore } from './atmosphereStage';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { PlanetCanvas } from './PlanetCanvas';
import { homePlanetGeometry, homePlanetSceneOptions } from './homePlanetPlacement';
import { getDeviceType } from '@/utils/platform/responsive';
import { NewSessionComposerCard } from '@/components/sessions/new/components/NewSessionComposerCard';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import type { NewSessionSimplePanelProps } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { NewSessionSimplePanel } from '@/components/sessions/new/components/NewSessionSimplePanel';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { AppShellMaterialFrame } from '@/components/navigation/shell/AppShellMaterialFrame';
import { AppShellMaterialPlane } from '@/components/navigation/shell/appShellMaterialPlane';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { pictureStore } from './pictureStore.web';

vi.mock('./pictureStore', () => import('./pictureStore.web'));

const planetPaints = vi.hoisted(() => ({ count: 0, font: {} }));
vi.mock('@shopify/react-native-skia', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
    // Native picture allocation is the physical drawing boundary.
    useTypeface: () => planetPaints.font,
    createPicture: () => { planetPaints.count++; return { dispose() {} }; },
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function Composer(props: { sending: boolean }) {
    const boundary = useAtmosphereBandBoundary();
    return <View testID="composer" ref={boundary?.ref} onLayout={boundary?.onLayout}>
        <SessionComposer sending={props.sending} onCreate={async () => {}} />
    </View>;
}

function SessionComposer(props: { sending: boolean; onCreate: () => Promise<void>; panel?: boolean; topContent?: React.ReactNode }) {
    const promptStore = React.useMemo(() => createNewSessionPromptStore('First line\nSecond line\nThird line'), []);
    const panelProps = {
        // Native refs begin unmounted; this fixture never measures the unused popover boundary.
        popoverBoundaryRef: React.useRef<View>(null) as NewSessionSimplePanelProps['popoverBoundaryRef'],
        headerHeight: 0, safeAreaTop: 0, safeAreaBottom: 0,
        newSessionTopPadding: 0, newSessionSidePadding: 0, newSessionBottomPadding: 0, containerStyle: {},
        promptStore, setSessionPrompt: promptStore.setPrompt,
        handleCreateSession: props.onCreate, canCreate: true, isCreating: props.sending,
        emptyAutocompleteKinds: [], emptyAutocompleteSuggestions: async () => [],
        agentType: 'codex', handleAgentClick: undefined, permissionMode: 'default',
        handlePermissionModeChange: undefined, modelMode: 'default', setModelMode: undefined,
        modelOptions: [], connectionStatus: undefined, machineName: undefined, selectedPath: '/repo',
        useProfiles: false, selectedProfileId: null,
        showResumePicker: false, resumeSessionId: null, isResumeSupportChecking: false,
        composerTopContent: props.topContent,
    } satisfies NewSessionSimplePanelProps;
    return props.panel ? <NewSessionSimplePanel {...panelProps} />
        : <NewSessionComposerCard panelProps={panelProps} layout="screen" attachments={false} />;
}

describe('New Session atmosphere at the real stage and focus boundary', () => {
    let previous: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previous = storage.getState();
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, planet: { ...DEFAULT_HOME_ATMOSPHERE.planet, digits: false },
        } } }));
    });
    afterEach(() => { storage.setState(previous, true); atmosphereStageStore.setSending(false); atmosphereStageStore.setPictureShown(false); setReducedMotionPreferenceOverride(null); });

    it.each([true, false])('resolves a measured surface once and gives its planet the same picture result (cached: %s)', async cached => {
        const localId = 'frame-single-read';
        if (cached) await pictureStore.put({ localId, kind: 'user', data: new Blob(['picture']) });
        storage.setState(state => ({ settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, source: 'picture',
            picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' },
        } } }));
        const gets = vi.spyOn(IDBObjectStore.prototype, 'get');
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface="new-session" focused visible showLook={false}><View /></AtmosphereSurfaceFrame>, {
            createNodeMock: () => ({ measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600) }),
        });
        try {
            await vi.waitFor(() => expect(atmosphereStageStore.get().panes.length).toBeGreaterThan(0));
            if (!cached) await vi.waitFor(() => expect(screen.findByTestId('surface-planet')).not.toBeNull());
            expect(gets.mock.calls.filter(([key]) => key === localId)).toHaveLength(1);
        } finally { await screen.unmount(); gets.mockRestore(); await pictureStore.remove(localId); }
    });

    it('preserves configured content translucency without a shell backdrop when the atmosphere is excluded', async () => {
        storage.setState(state => ({ ...state, settings: { ...state.settings, glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('clear'), content: { blur: 'off', opacity: 0.347 } },
            homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home'] },
        } }));
        const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'none', desktopWindow: true, nativeWindowMaterialLive: true }}>
            <AppShellMaterialPlane testID="shared-content-plane" group="content" color="#ffffff" translucentColor="transparent" style={{ flex: 1 }}>
            <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} focused visible showLook={false}>
                <View />
            </AtmosphereSurfaceFrame>
            </AppShellMaterialPlane>
        </GlassRuntimeEnvironmentProvider>);
        try {
            expect(Color(flattenTestStyle(screen.findHostByTestId('shared-content-plane')!.props.style).backgroundColor as string).alpha()).toBe(0.347);
        } finally { await screen.unmount(); }
    });

    it('keeps Home and Project on one reading coat through focus, inclusion and withdrawal', async () => {
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            glassSurfaceMaterials: glassPresetMaterials('everywhere'),
            homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home'] },
        } }));
        atmosphereStageStore.setPictureShown(true);
        let mounts = 0, unmounts = 0;
        function Content() {
            React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
            return <View testID="split-project-content" />;
        }
        const scene = (focusHome: boolean) => <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'band' }}>
            <AppShellMaterialPlane testID="shared-content-plane" group="content" color="#ffffff" translucentColor="transparent" style={{ flex: 1 }}>
            <AtmosphereSurfaceFrame surface="home" focused={focusHome} visible showLook={false}><View /></AtmosphereSurfaceFrame>
            <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} focused={!focusHome} visible showLook={false}>
                <Content />
            </AtmosphereSurfaceFrame>
            </AppShellMaterialPlane>
        </GlassRuntimeEnvironmentProvider>;
        const screen = await renderScreen(scene(true), { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60),
        }) });
        const alpha = () => Color(flattenTestStyle(screen.findHostByTestId('shared-content-plane')!.props.style).backgroundColor as string).alpha();
        const content = screen.findHostByTestId('split-project-content');
        try {
            expect(atmosphereStageStore.get().panes).toHaveLength(2);
            expect(alpha()).toBe(0.56);
            await screen.update(scene(false));
            expect(atmosphereStageStore.get().stage?.surface).toBe('home');
            expect(alpha()).toBe(0.56);
            await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
                homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home', 'projects'] },
            } })));
            expect(atmosphereStageStore.get().stage?.surface).toEqual({ project: { serverId: 'srv', projectKey: 'p1' } });
            expect(alpha()).toBe(0.56);
            await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
                homeAtmosphere: { ...state.settings.homeAtmosphere, showOn: ['home'] },
            } })));
            expect(atmosphereStageStore.get().stage?.surface).toBe('home');
            expect(alpha()).toBe(0.56);
            await screen.update(scene(true));
            expect(screen.findHostByTestId('split-project-content')).toBe(content);
            expect(mounts).toBe(1);
            expect(unmounts).toBe(0);
        } finally { await screen.unmount(); }
    });

    it('does no planet or band work for a retained inactive destination and resumes when presented', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        let timerFires = 0;
        const interval = globalThis.setInterval;
        vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
            interval(() => { timerFires++; callback(...args); }, delay));
        let mounts = 0;
        function Draft() {
            React.useEffect(() => { mounts++; }, []);
            return <View testID="retained-draft" />;
        }
        let currentFocus = true;
        const scene = (visible: boolean, focused = visible) => {
            currentFocus = focused && visible;
            return <DestinationInstanceContext.Provider value={{
                tabId: 'retained-project', ref: { kind: 'home', params: {} }, pathname: '/', visible, focused, isFocused: () => currentFocus,
            }}>
                <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }}>
                    <Draft />
                </AtmosphereSurfaceFrame>
            </DestinationInstanceContext.Provider>;
        };
        const screen = await renderScreen(scene(true), { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 390, 844),
        }) });
        try {
            expect(planetPaints.count).toBeGreaterThan(0);
            expect(atmosphereStageStore.get().panes).toHaveLength(1);
            await screen.update(scene(false));
            const hiddenPaints = planetPaints.count;
            await act(async () => {
                storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
                    ...state.settings.homeAtmosphere, planet: { ...state.settings.homeAtmosphere.planet, style: 'rich' },
                } } }));
                vi.advanceTimersByTime(300_000);
            });
            expect.soft(planetPaints.count - hiddenPaints).toBe(0);
            expect.soft(screen.findAllByType(PlanetCanvas)).toHaveLength(0);
            expect(atmosphereStageStore.get().panes).toHaveLength(0);
            expect(timerFires).toBe(0);
            expect(vi.getTimerCount()).toBe(0);
            // A visible split pane still paints without keyboard focus.
            await screen.update(scene(true, false));
            expect(planetPaints.count).toBeGreaterThan(hiddenPaints);
            expect(screen.findAllByType(PlanetCanvas)).toHaveLength(1);
            expect(atmosphereStageStore.get().panes).toHaveLength(1);
            expect(mounts).toBe(1);
        } finally {
            await screen.unmount();
            vi.restoreAllMocks();
            vi.useRealTimers();
        }
    });

    it('lays the Project band over the page column, not over the whole pane group that holds it', async () => {
        function Scene() {
            const column = React.useRef<View>(null);
            return <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} column={column}>
                <View testID="project-column" ref={column} />
            </AtmosphereSurfaceFrame>;
        }
        const screen = await renderScreen(<Scene />, { createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'project-column' ? done(700, 40, 400, 850) : done(300, 40, 800, 850),
        }) });
        try {
            expect(atmosphereStageStore.get().panes[0]?.geometry?.rect).toEqual({ x: 700, y: 40, width: 400, height: 850 });
        } finally {
            await screen.unmount();
        }
    });

    it('FX28 follows the shell sheet on retained New without a window resize', async () => {
        let rect = { x: 328, y: 40, width: 1104, height: 852 };
        let mounts = 0;
        function NewFrame() {
            React.useEffect(() => { mounts++; }, []);
            return <AtmosphereSurfaceFrame surface="new-session" showLook={false}><View testID="retained-new" /></AtmosphereSurfaceFrame>;
        }
        const scene = (sidebar: boolean) => <AppShellMaterialFrame showChrome dragEnabled={false}
            leftOffsetPx={sidebar ? 320 : 48} sidebarWidth={sidebar ? 272 : 0}
            titleStrip={null} rail={null} column={sidebar ? <View /> : null} peek={null}><NewFrame /></AppShellMaterialFrame>;
        const screen = await renderScreen(scene(true), { createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'app-shell-content-sheet' ? done(rect.x, rect.y, rect.width, rect.height) : done(0, 0, 1440, 900),
        }) });
        const check = () => {
            expect(atmosphereStageStore.get().stage?.geometry?.rect).toEqual(rect);
            expect(flattenTestStyle(screen.findByTestId('surface-planet')!.props.style)).toMatchObject({
                left: rect.x, top: rect.y, width: rect.width, height: rect.height, overflow: 'hidden',
            });
            const canvas = screen.findByType(PlanetCanvas);
            expect(canvas.props.options.view).toEqual({ w: rect.width, h: rect.height });
        };
        try {
            check();
            const retained = screen.findHostByTestId('retained-new');
            rect = { x: 56, y: 40, width: 1376, height: 852 };
            await screen.update(scene(false));
            // Only the actual sheet lays out. The modal/window measurement remains 1440×900.
            await act(async () => { screen.findHostByTestId('app-shell-content-sheet')!.props.onLayout?.({ nativeEvent: { layout: rect } }); });
            check();
            expect(screen.findHostByTestId('retained-new')).toBe(retained);
            expect(mounts).toBe(1);
        } finally { await screen.unmount(); }
    });

    it('tells a Project band when the planet is behind it, and not once the Project shows no atmosphere', async () => {
        const seen: Array<boolean | undefined> = [];
        function Band() {
            seen.push(useAtmosphereBandBoundary()?.planet);
            return null;
        }
        const project = { project: { serverId: 'server-a', projectKey: 'project-a' } };
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface={project} focused visible><Band /></AtmosphereSurfaceFrame>);
        try {
            expect(seen.at(-1)).toBe(true);
            await act(async () => {
                storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'none' } } }));
            });
            expect(seen.at(-1)).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('opens picture room above a Project band only for a Horizon picture: a wallpaper already covers the window', async () => {
        const seen: Array<boolean | undefined> = [];
        function Band() {
            seen.push(useAtmosphereBandBoundary()?.pictureRoom);
            return null;
        }
        const withPicture = (layout: 'horizon' | 'wallpaper') => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, layout }, showOn: ['home', 'new-session', 'projects'] } } }));
        const project = { project: { serverId: 'server-a', projectKey: 'project-a' } };
        await act(async () => { withPicture('horizon'); });
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface={project} focused visible><Band /></AtmosphereSurfaceFrame>);
        try {
            expect(seen.at(-1)).toBe(true);
            await act(async () => { withPicture('wallpaper'); });
            expect(seen.at(-1)).toBe(false);
        } finally {
            await screen.unmount();
        }
    });

    it('draws the planet over the page column when the frame is larger than that column', async () => {
        function Scene() {
            const column = React.useRef<View>(null);
            return <AtmosphereSurfaceFrame surface="new-session" column={column} columnRadius={12} showLook={false}>
                <View testID="page-column" ref={column} />
            </AtmosphereSurfaceFrame>;
        }
        // A route presented over the shell spans the window (0,0); the page sheet inside it starts at 56,40.
        const screen = await renderScreen(<Scene />, { createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'page-column' ? done(56, 40, 1376, 852) : done(0, 0, 1440, 900),
        }) });
        try {
            expect(atmosphereStageStore.get().panes[0]?.geometry?.rect).toEqual({ x: 56, y: 40, width: 1376, height: 852 });
            expect(flattenTestStyle(screen.findByTestId('surface-planet')!.props.style)).toMatchObject({
                position: 'absolute', left: 56, top: 40, width: 1376, height: 852, borderRadius: 12, overflow: 'hidden',
            });
        } finally {
            await screen.unmount();
        }
    });

    // RU2 F-3 (2026-11-11): on Project Services with the Browser open, the planet re-composed into the ~460 px column
    // and its dither ran under the service rows, illegible in dark.
    describe('a Project planet behind its tab pages', () => {
        function Scene() {
            const column = React.useRef<View>(null);
            return <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} column={column} focused visible>
                <View testID="project-column" ref={column} />
            </AtmosphereSurfaceFrame>;
        }
        // The Browser pane is open beside the Project: the column is 460 of the frame's 1060.
        const mock = { createNodeMock: (element: { props: { testID?: string } }) => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'project-column' ? done(328, 40, 460, 852) : done(328, 40, 1060, 852),
        }) };
        it('keeps its composition when the column narrows: composed at the frame and clipped to the column', async () => {
            const screen = await renderScreen(<Scene />, mock);
            try {
                await vi.waitFor(() => expect(screen.findByTestId('surface-planet')).not.toBeNull());
                const planet = screen.findAll((node) => typeof node.props?.placement === 'string' && node.props?.pane !== undefined)[0]!;
                expect(planet.props.pane).toEqual({ width: 1060, height: 852 });
                expect(flattenTestStyle(screen.findByTestId('surface-planet')!.props.style)).toMatchObject({ width: 460, overflow: 'hidden' });
            } finally {
                await screen.unmount();
            }
        });
        it('lays a calm coat between the planet and the page below its band, in the page colour', async () => {
            const screen = await renderScreen(<Scene />, mock);
            try {
                await vi.waitFor(() => expect(screen.findByTestId('surface-planet-coat')).not.toBeNull());
                const coat = flattenTestStyle(screen.findByTestId('surface-planet-coat')!.props.style) as Record<string, unknown>;
                const band = atmosphereStageStore.get().panes[0]?.geometry?.band ?? 0;
                expect(coat).toMatchObject({ position: 'absolute', top: band, left: 0, right: 0, bottom: 0 });
                const paint = Color(String(coat.backgroundColor));
                expect(paint.alpha()).toBeGreaterThanOrEqual(0.5);
                expect(paint.alpha()).toBeLessThan(1);
            } finally {
                await screen.unmount();
            }
        });
    });

    it.each(['screen', 'modal'] as const)('uses Elements in the %s New composer instead of the content or menu material', async (mode) => {
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            newSessionPresentationModeV1: mode,
            glassBlurEnabled: true,
            glassSurfaceMaterials: { ...glassPresetMaterials('clear'),
                content: { blur: 'off', opacity: 1 }, card: { blur: 'off', opacity: 0.347 }, floating: { blur: 'off', opacity: 0.02 },
            },
        } }));
        const scene = (reduceTransparency: boolean) => <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper', reduceTransparency }}>
            <SessionComposer sending={false} onCreate={async () => {}} panel />
        </GlassRuntimeEnvironmentProvider>;
        const screen = await renderScreen(scene(false));
        const alpha = () => Color(flattenTestStyle(screen.findByTestId('agent-input-material-surface')!.props.style).backgroundColor as string).alpha();
        try {
            expect(alpha()).toBe(0.347);
            await screen.update(scene(true));
            expect(alpha()).toBe(1);
        } finally {
            await screen.unmount();
        }
    });

    it.each([
        { name: 'normal motion', reducedMotion: false, send: true },
        { name: 'the disabled send moment', reducedMotion: false, send: false },
        { name: 'the reduced-motion crossfade', reducedMotion: true, send: true },
    ])('restores the Planet during pending launch with $name', async ({ reducedMotion, send }) => {
        setReducedMotionPreferenceOverride(reducedMotion);
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            homeAtmosphere: { ...state.settings.homeAtmosphere, moments: { ...state.settings.homeAtmosphere.moments, send } },
        } }));
        let launches = 0;
        function Scene(props: { settled?: boolean }) {
            const [launched, setLaunched] = React.useState(false);
            return <AtmosphereSurfaceFrame surface="new-session" focused visible>
                <SessionComposer sending={launched && !props.settled} onCreate={async () => { launches++; setLaunched(true); }} />
            </AtmosphereSurfaceFrame>;
        }
        const screen = await renderScreen(<Scene />, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(0, element.props.testID === 'composer' ? 200 : 0, 800, element.props.testID === 'composer' ? 180 : 600),
        }) });
        const fades = vi.spyOn(Animated, 'timing');
        try {
            expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true);
            await screen.pressByTestIdAsync('new-session-composer-send');
            expect(launches).toBe(1);
            if (send && !reducedMotion) {
                expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(false);
                expect(screen.findByType(AtmosphereDissolve).props.leave).toBe('climb');
                await act(async () => screen.findByType(AtmosphereDissolve).props.onHidden?.());
            }
            if (send && reducedMotion) {
                expect(fades.mock.calls.some(([, config]) => config.toValue === 0
                    && config.duration === motionTokens.atmosphere.reducedCrossFadeMs)).toBe(true);
            }
            await vi.waitFor(() => expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true));
            expect(screen.findByType(AtmosphereDissolve).props.reducedMotion).toBe(reducedMotion);
            expect(atmosphereStageStore.get().sending).toBe(true);
            await screen.update(<Scene />);
            expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true);
            await screen.update(<Scene settled />);
            expect(atmosphereStageStore.get().sending).toBe(false);
        } finally { fades.mockRestore(); await screen.unmount(); }
    });

    it.each(['corner', 'rise', 'side'] as const)('uses Home Corner across the Project pane when Home placement is %s', async (placement) => {
        // R-7 amendment (2026-10-27): the Project planet is Home's Corner object,
        // clipped to the pane; only a picture is banded at the tabs. Overview overlap is allowed.
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, planet: { ...state.settings.homeAtmosphere.planet, placement },
        } } }));
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} focused visible>
            <Composer sending={false} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'composer' ? done(0, 40, 900, 50) : done(0, 0, 900, 800),
        }) });
        try {
            const canvas = screen.findByType(PlanetCanvas);
            const pane = { width: 900, height: 800 };
            expect(canvas.props.fade).toBeUndefined();
            expect(canvas.props.height).toBe(pane.height);
            expect(canvas.props.options).toEqual(homePlanetSceneOptions(
                homePlanetGeometry('corner', pane, { phone: getDeviceType() === 'phone' }), pane,
                { theme: 'light', style: DEFAULT_HOME_ATMOSPHERE.planet.style, digits: false },
            ));
        } finally {
            await screen.unmount();
        }
    });

    it('ends the band and seats the hero at the composer itself, never at content stacked above it', async () => {
        // A New bot draft stacks its title, instructions and status above the composer; the planet's
        // limb and the band follow the input, so that copy stays on the page ground (DA R-1).
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface="new-session" focused visible>
            <SessionComposer sending={false} onCreate={async () => {}} topContent={<View testID="draft-header" />} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                element.props.testID === 'new-session-composer-band' ? done(0, 300, 800, 120) : done(0, 0, 800, 600),
        }) });
        try {
            const geometry = atmosphereStageStore.get().stage!.geometry!;
            expect(geometry.band).toBe(420);
            expect(geometry.focus.y).toBe(360);
            const band = screen.findByTestId('new-session-composer-band')!;
            expect(band.findAll(node => node.props.testID === 'draft-header')).toHaveLength(0);
            expect(band.findAll(node => node.props.testID === 'new-session-composer-input').length).toBeGreaterThan(0);
        } finally {
            await screen.unmount();
        }
    });

    it('holds the native band and focus through draft shrink and growth until blur or viewport resize', async () => {
        let composerHeight = 180;
        let paneHeight = 600;
        const screen = await renderScreen(<AtmosphereSurfaceFrame surface="new-session" focused visible>
            <Composer sending={false} />
        </AtmosphereSurfaceFrame>, { createNodeMock: element => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(0, element.props.testID === 'composer' ? 200 : 0, 800, element.props.testID === 'composer' ? composerHeight : paneHeight),
        }) });
        const initial = atmosphereStageStore.get().stage!.geometry!;
        expect(initial.band).toBe(380);
        await act(async () => screen.findByTestId('new-session-composer-input')!.props.onComposerFocus());
        const remeasure = async () => act(async () => screen.findByTestId('composer')!.props.onLayout());
        composerHeight = 70;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(initial.band);
        expect(atmosphereStageStore.get().stage!.geometry!.focus).toEqual(initial.focus);
        composerHeight = 240;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(initial.band);
        expect(atmosphereStageStore.get().stage!.geometry!.focus).toEqual(initial.focus);
        paneHeight = 500;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(440);
        composerHeight = 90;
        await remeasure();
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(440);
        await act(async () => screen.findByTestId('new-session-composer-input')!.props.onComposerBlur());
        expect(atmosphereStageStore.get().stage!.geometry!.band).toBe(290);
        await screen.unmount();
    });
});
