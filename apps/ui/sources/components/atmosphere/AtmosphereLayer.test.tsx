import 'fake-indexeddb/auto';
import Color from 'color';
import * as React from 'react';
import { View } from 'react-native';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_HOME_ATMOSPHERE } from '@happier-dev/protocol/account/settings/accountSettings';
import { flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storageStore';
import { AtmosphereLayer } from './AtmosphereLayer';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { atmosphereStageStore } from './atmosphereStage';
import { pictureStore } from './pictureStore';
import type { BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';
import { GlassAtmosphereBehindSetterProvider, GlassAtmosphereToneSetterProvider, GlassRuntimeEnvironmentProvider, useGlassRuntimeEnvironment } from '@/components/ui/glass/glassRuntimeEnvironment';
import { resolveGlassSurfacePlaneMaterial } from '@/components/ui/glass/glassSurfacePaint';
import { useGlassMaterialSettings } from '@/components/ui/glass/useGlassMaterialSettings';
import type { GlassAtmosphereTone, GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { AtmosphereSurfaceFrame } from './AtmosphereSurfaceFrame';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { useAtmosphereBandBoundary } from './atmosphereBandBoundary';
import { useHomeHeroFrame } from '@/components/hub/HomeHero';
import { ATMOSPHERE_PICTURES } from '@happier-dev/brand/atmosphere';
import { AtmospherePreview, PublicPictureBand } from './look/AtmospherePreview';
import { PublicProfilePictureDescriptorV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { storeUserAtmospherePicture } from './atmosphereSettings';
import { PageAtmosphereStage } from './PageAtmosphereStage';

const host = vi.hoisted(() => ({ emitter: null as ReturnType<typeof import('@/dev/testkit/mocks/reactNative').createReactNativeAppStateEmitter> | null }));

// Exercise the real browser drawing and device-storage adapters under their OS boundaries.
vi.mock('./BackdropCanvas', async () => import('./BackdropCanvas.web'));
vi.mock('@/components/ui/performance/LazyMountOnScreen', async () => import('@/components/ui/performance/LazyMountOnScreen.web'));
vi.mock('./WallpaperHaze', async () => import('./WallpaperHaze.web'));
vi.mock('./pictureStore', async () => import('./pictureStore.web'));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock, createReactNativeAppStateEmitter } = await import('@/dev/testkit/mocks/reactNative');
    host.emitter = createReactNativeAppStateEmitter();
    return createReactNativeWebMock({ AppState: host.emitter.appState });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

afterEach(() => { atmosphereStageStore.clearStage(-1); atmosphereStageStore.clearStage(-2); atmosphereStageStore.clearStage(-3); vi.unstubAllGlobals(); });

it.each(['window', 'profile', 'reviewed'] as const)('releases clipped %s preview canvases and paints current geometry on reveal', async kind => {
    const intersections: Array<(visible: boolean) => void> = [];
    const requests: BackdropWorkerRequest[] = [];
    vi.stubGlobal('window', { devicePixelRatio: 1, getComputedStyle: () => ({ overflowY: 'visible' }) });
    vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => true });
    vi.stubGlobal('IntersectionObserver', class {
        constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
            intersections.push(visible => callback([{ isIntersecting: visible }]));
        }
        observe() {}
        disconnect() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            requests.push(message);
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    const previous = storage.getState();
    const localId = `clipped-preview-${kind}`;
    const presentation = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture' as const,
        picture: { ref: { kind: 'user' as const, localId }, layout: 'horizon' as const } };
    const descriptor = PublicProfilePictureDescriptorV1Schema.parse({ kind: 'photo', title: 'Reviewed picture',
        horizon: {}, focus: {}, hour: 0, grades: { light: 0, dusk: 0, night: 0 }, dark: 'night',
        adaptiveHaze: false, credit: null,
        look: { effect: 'mosaic', params: {}, strength: 0.37, dissolve: { style: 'ordered', from: 0.5, to: 1 } } });
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let paints = 0;
    try {
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture']) });
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: presentation } }));
        const preview = kind === 'reviewed'
            ? <PublicPictureBand picture={{ layout: 'horizon', descriptor }} data="data:image/png;base64,YWJj" copyId="clipped-reviewed" />
            : <AtmospherePreview {...(kind === 'profile' ? { target: { publicProfile: presentation }, frame: 'band' as const } : {})} />;
        screen = await renderScreen(preview, { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData() { paints++; } }) } : { parentElement: null } });
        const layout = screen.findAllByType(View).find(node => typeof node.props.onLayout === 'function')!.props.onLayout;
        await act(async () => { layout({ nativeEvent: { layout: { width: 80, height: 60 } } }); await pictureStore.get(localId); });
        expect(screen.findAllByType('canvas')).toHaveLength(0);
        expect(requests).toHaveLength(0);
        expect(intersections).toHaveLength(1);
        await act(async () => { intersections[0]!(true); });
        await vi.waitFor(() => expect(paints).toBe(1));
        expect(screen.findAllByType('canvas')).toHaveLength(1);
        await act(async () => { intersections[0]!(false); });
        expect(screen.findAllByType('canvas')).toHaveLength(0);
        await act(async () => { layout({ nativeEvent: { layout: { width: 120, height: 90 } } }); });
        expect(requests).toHaveLength(1);
        expect(paints).toBe(1);
        await act(async () => { intersections[0]!(true); });
        await vi.waitFor(() => expect(paints).toBe(2));
        expect(requests).toHaveLength(2);
        const current = requests.at(-1)!;
        expect('request' in current && current.request.width).toBe(120);
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it.each(['horizon', 'wallpaper'] as const)('hands the planet over to a painted %s after changing source and returning from another surface', async layout => {
    let holdReplies = false;
    const replies: (() => void)[] = [];
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            const { width: w, height: h } = message.request;
            const reply = () => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } });
            if (holdReplies) replies.push(reply);
            else queueMicrotask(reply);
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'picture-handover';
    const home = { id: -1, surface: 'home' as const, geometry: {
        rect: { x: 0, y: 0, width: 80, height: 60 }, band: 35, horizonAt: 0.86, focus: { x: 40, y: 25 },
    } };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let paints = 0;
    try {
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture']) });
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE } }));
        atmosphereStageStore.setStage(home, true);
        screen = await renderScreen(<AtmosphereLayer sheetRadius={12} chrome={false} />, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() { paints++; } }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60),
            },
        });
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['home', 'new-session', 'projects', 'sessions', 'pages'],
            picture: { ref: { kind: 'user', localId }, layout },
        } } })));
        await vi.waitFor(() => expect(atmosphereStageStore.get().pictureShown).toBe(true));
        expect(paints).toBeGreaterThan(0);
        // A retained destination's effect cleanup and replacement run in one commit. The shell keeps
        // the same ready canvas: neither a fresh worker render nor a second onReady is needed.
        const painted = paints;
        // A slow launch leaves this surface in the pane after its one-shot dissolve.
        const canvasBeforeSend = screen.findAllHostsByTestId(layout === 'horizon' ? 'atmosphere-band' : 'atmosphere-wallpaper')[0];
        await act(async () => atmosphereStageStore.setSending(true));
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(false);
        await act(async () => screen!.findByType(AtmosphereDissolve).props.onHidden?.());
        expect(screen.findByType(AtmosphereDissolve).props.visible).toBe(true);
        expect(atmosphereStageStore.get().sending).toBe(true);
        expect(screen.findAllHostsByTestId(layout === 'horizon' ? 'atmosphere-band' : 'atmosphere-wallpaper')[0]).toBe(canvasBeforeSend);
        expect(paints).toBe(painted);
        await act(async () => atmosphereStageStore.setSending(false));
        await act(async () => {
            atmosphereStageStore.clearStage(home.id);
            atmosphereStageStore.setStage(home, true);
        });
        await vi.waitFor(() => expect(atmosphereStageStore.get().pictureShown).toBe(true));
        expect(paints).toBe(painted);
        const canvasId = layout === 'horizon' ? 'atmosphere-band' : 'atmosphere-wallpaper';
        const originalCanvas = screen.findAllHostsByTestId(canvasId)[0];
        // Route operands change in the persistent shell stage; the shared picture and its
        // physical canvas survive Settings/Inbox/Machines/Session navigation without I/O or paint.
        const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
        try {
            for (const surface of ['pages', 'pages', 'sessions', 'pages', 'home'] as const) {
                await act(async () => { atmosphereStageStore.setStage({ ...home, surface }, true); });
                expect(screen.findAllHostsByTestId(canvasId)[0]).toBe(originalCanvas);
            }
            expect(transaction).not.toHaveBeenCalled();
            expect(paints).toBe(painted);
        } finally { transaction.mockRestore(); }
        holdReplies = true;
        await act(async () => {
            atmosphereStageStore.clearStage(home.id);
            // A newly opened destination registers before measureInWindow settles. The window's
            // already painted canvas must survive that real route handover, not only ID changes
            // whose geometry was supplied synchronously by the test.
            atmosphereStageStore.setStage({ ...home, id: -2, geometry: null }, true);
        });
        expect(screen.findAllHostsByTestId(canvasId)[0]).toBe(originalCanvas);
        expect(atmosphereStageStore.get().pictureShown).toBe(true);
        expect(replies).toHaveLength(0);
        await act(async () => atmosphereStageStore.setStage({ ...home, id: -2 }, true));
        if (layout === 'horizon') {
            expect(screen.findAllHostsByTestId(canvasId)[0]).not.toBe(originalCanvas);
            expect(paints).toBe(painted);
            expect(replies).toHaveLength(1);
            expect(atmosphereStageStore.get().pictureShown).toBe(false);
            await act(async () => { replies.splice(0).forEach(reply => reply()); });
            expect(paints).toBe(painted + 1);
        } else {
            // Wallpaper's window canvas survives even when every pane ID changes.
            expect(screen.findAllHostsByTestId(canvasId)[0]).toBe(originalCanvas);
            expect(paints).toBe(painted);
            expect(replies).toHaveLength(0);
        }
        expect(atmosphereStageStore.get().pictureShown).toBe(true);
        await act(async () => atmosphereStageStore.clearStage(-2));
        expect(atmosphereStageStore.get().pictureShown).toBe(false);
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

function ProjectTabs() {
    const boundary = useAtmosphereBandBoundary();
    return <View testID="project-tabs" ref={boundary?.ref} onLayout={boundary?.onLayout} />;
}

it.each(['page', 'Project'] as const)('keeps an excluded %s opaque beside Home through focus and inclusion changes without remounting', async kind => {
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = `split-excluded-${kind}`;
    let mounts = 0, unmounts = 0, paints = 0;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    function Content() {
        React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
        return <View testID="excluded-content" />;
    }
    const pathname = kind === 'page' ? '/inbox' : '/projects/p1';
    function Shell(props: { focusHome: boolean }) {
        const rightColumn = React.useRef<View>(null);
        const [atmosphereBehind, setBehind] = React.useState<NonNullable<GlassMaterialEnvironment['atmosphereBehind']>>('none');
        return <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
            <GlassAtmosphereBehindSetterProvider value={setBehind}>
                <AtmosphereLayer sheetRadius={12} chrome={false} />
                <DestinationInstanceContext.Provider value={{ tabId: 'home', ref: { kind: 'home', params: {} }, pathname: '/',
                    visible: true, focused: props.focusHome, isFocused: () => props.focusHome }}>
                    <PageAtmosphereStage pathname="/" params={{}}>
                        <AtmosphereSurfaceFrame surface="home" showLook={false}><View /></AtmosphereSurfaceFrame>
                    </PageAtmosphereStage>
                </DestinationInstanceContext.Provider>
                <DestinationInstanceContext.Provider value={{ tabId: 'right', ref: { kind: 'x', params: {} }, pathname,
                    visible: true, focused: !props.focusHome, isFocused: () => !props.focusHome }}>
                    <PageAtmosphereStage pathname={pathname} params={{}}>
                        {kind === 'page' ? <Content /> : <AtmosphereSurfaceFrame
                            surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} column={rightColumn} showLook={false}>
                            <View ref={rightColumn} testID="right-column"><Content /></View>
                        </AtmosphereSurfaceFrame>}
                    </PageAtmosphereStage>
                </DestinationInstanceContext.Provider>
            </GlassAtmosphereBehindSetterProvider>
        </GlassRuntimeEnvironmentProvider>;
    }
    const select = async (included: boolean) => act(async () => storage.setState(state => ({ ...state,
        settings: { ...state.settings, homeAtmosphere: { ...state.settings.homeAtmosphere,
            showOn: included ? ['home', kind === 'page' ? 'pages' : 'projects'] : ['home'],
        } },
    })));
    // The shell's backing owns exclusion; page bodies deliberately paint no coat.
    const masks = () => screen!.findAllHostsByTestId('atmosphere-excluded-pane');
    const expectOpaque = () => {
        expect(masks()).toHaveLength(1);
        expect(flattenTestStyle(masks()[0]!.props.style)).toMatchObject({ left: 80, top: 0, width: 80, height: 60 });
        expect(Color(flattenTestStyle(masks()[0]!.props.style).backgroundColor as string).alpha()).toBe(1);
    };
    try {
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture']) });
        storage.setState(state => ({ ...state, settings: { ...state.settings, glassBlurEnabled: true,
            glassSurfaceMaterials: glassPresetMaterials('auto'), homeAtmosphere: {
                ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', showOn: ['home'],
                picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' },
            },
        } }));
        screen = await renderScreen(<Shell focusHome />, { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData() { paints++; } }) }
            : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(element.props.testID === 'right-column'
                    || element.props.testID === 'page-atmosphere-coat' ? 80 : 0, 0, 80, 60) },
        });
        await vi.waitFor(() => expect(atmosphereStageStore.get().pictureShown).toBe(true));
        expect(atmosphereStageStore.get().panes).toHaveLength(2);
        const content = screen.findHostByTestId('excluded-content');
        const canvas = screen.findAllHostsByTestId('atmosphere-wallpaper')[0];
        expectOpaque();
        await screen.update(<Shell focusHome={false} />);
        expect(atmosphereStageStore.get().stage?.surface).toBe('home');
        expectOpaque();
        expect(screen.findAllHostsByTestId('atmosphere-wallpaper')[0]).toBe(canvas);
        await select(true);
        await vi.waitFor(() => expect(masks()).toHaveLength(0));
        await select(false);
        expect(atmosphereStageStore.get().stage?.surface).toBe('home');
        // Removing the focused pane's demand hands the shell back to Home asynchronously.
        // Check its explicit opaque coat after that picture is shown, as on initial arrival.
        await vi.waitFor(() => expect(atmosphereStageStore.get().pictureShown).toBe(true));
        expectOpaque();
        await screen.update(<Shell focusHome />);
        await vi.waitFor(() => expect(atmosphereStageStore.get().pictureShown).toBe(true));
        expect(screen.findHostByTestId('excluded-content')).toBe(content);
        expect(screen.findAllHostsByTestId('atmosphere-window-layer')).toHaveLength(1);
        expect(paints).toBeGreaterThan(0);
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it.each(['host', 'presentation'] as const)('defers automatic picture acquisition while %s is hidden and paints the latest selection on reveal', async hiddenOwner => {
    let visibilityState = 'visible';
    const decode = vi.fn(async () => ({ width: 80, height: 60, close() {} }));
    const encode = vi.fn((done: (blob: Blob) => void, mime: string) => done(new Blob(['prepared pixels'], { type: mime })));
    const fetchPicture = vi.fn(async (_input: RequestInfo | URL) => new Response(new Blob(['remote pixels'])));
    vi.stubGlobal('fetch', fetchPicture);
    vi.stubGlobal('createImageBitmap', decode);
    vi.stubGlobal('document', {
        get visibilityState() { return visibilityState; },
        hasFocus: () => false,
        createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: encode }),
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4).fill(125), w, h } } }));
        }
        terminate() {}
    });
    const first = ATMOSPHERE_PICTURES.find(picture => picture.id === 'white-rocks-open-sea')!;
    const latest = ATMOSPHERE_PICTURES.find(picture => picture.id === 'calm-sea')!;
    const previous = storage.getState();
    const home = { id: -1, surface: 'home' as const, geometry: {
        rect: { x: 0, y: 0, width: 80, height: 60 }, band: 35, horizonAt: 0.86, focus: { x: 40, y: 25 },
    } };
    const scene = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={false} presentationActive={presented}>
        <AtmosphereLayer sheetRadius={12} chrome={false} />
        <AtmosphereSurfaceFrame surface="new-session" focused={false} visible showLook={false}><ProjectTabs /></AtmosphereSurfaceFrame>
        <AtmospherePreview />
    </PluginSurfaceFocusEligibilityProvider>;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let paints = 0;
    let added: string | null = null;
    const select = async (id: string) => {
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, source: 'picture', picture: { ref: { kind: 'builtin', id }, layout: 'horizon' },
        } } })));
        // Complete an actual IndexedDB read after the resolver's acquisition read, rather than
        // using a guessed delay to conclude that no physical fetch/bitmap preparation started.
        await act(async () => { await pictureStore.get(`builtin:${id}`); });
    };
    try {
        await pictureStore.remove(`builtin:${first.id}`);
        await pictureStore.remove(`builtin-thumb:${first.id}`);
        await pictureStore.remove(`builtin:${latest.id}`);
        await pictureStore.remove(`builtin-thumb:${latest.id}`);
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, planet: { ...DEFAULT_HOME_ATMOSPHERE.planet, digits: false },
            moments: { ...DEFAULT_HOME_ATMOSPHERE.moments, idleResettle: false },
        } } }));
        atmosphereStageStore.setStage(home, false);
        screen = await renderScreen(scene(true), { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData() { paints++; } }) }
            : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60) } });
        const stage = atmosphereStageStore.get().stage;
        if (hiddenOwner === 'host') {
            visibilityState = 'hidden';
            // Exercise the canonical host watch through its real platform event boundary. AppState
            // stays active: document visibility, not focus or destination withdrawal, is the cause.
            await act(async () => host.emitter!.emit('active'));
        } else await screen.update(scene(false));
        await select(first.id);
        await select(latest.id);
        expect(atmosphereStageStore.get().stage).toBe(stage);
        expect(fetchPicture).not.toHaveBeenCalled();
        expect(decode).not.toHaveBeenCalled();
        expect(encode).not.toHaveBeenCalled();
        expect(paints).toBe(0);
        // An explicit admitted add uses the existing ingress even with no automatic presentation
        // demand; hiding the host must not turn pictureStore into another admission authority.
        await act(async () => { added = await storeUserAtmospherePicture(new Blob(['chosen user pixels']), () => true); });
        expect(added).not.toBeNull();
        expect(decode).toHaveBeenCalledTimes(1);
        expect(fetchPicture).not.toHaveBeenCalled();
        decode.mockClear(); encode.mockClear();
        visibilityState = 'visible';
        await act(async () => host.emitter!.emit('active'));
        await screen.update(scene(true));
        await vi.waitFor(() => expect(paints).toBeGreaterThan(0));
        expect(atmosphereStageStore.get().pictureShown).toBe(true);
        expect(fetchPicture).toHaveBeenCalledTimes(2);
        expect(decode).toHaveBeenCalledTimes(2);
        expect(encode).toHaveBeenCalledTimes(2);
        const fetched = fetchPicture.mock.calls.map(([input]) => {
            const url = new URL(String(input)); url.searchParams.delete('happier-atmosphere'); return url.href;
        });
        expect(fetched.sort()).toEqual([latest.src.full, latest.src.thumb].sort());
        expect(await pictureStore.get(`builtin:${first.id}`)).toBeUndefined();
    } finally {
        await screen?.unmount();
        visibilityState = 'visible';
        await act(async () => host.emitter!.emit('active'));
        storage.setState(previous, true);
        if (added) await pictureStore.remove(added);
        await pictureStore.remove(`builtin:${first.id}`);
        await pictureStore.remove(`builtin-thumb:${first.id}`);
        await pictureStore.remove(`builtin:${latest.id}`);
        await pictureStore.remove(`builtin-thumb:${latest.id}`);
    }
});

it('paints Home Horizon after a zero-size layout and a real resize, then restores it after retention', async () => {
    let jobs = 0, paints = 0, width = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    function Home() {
        const frame = useHomeHeroFrame({ active: true, focused: true, phone: false });
        return <View ref={frame.paneRef} onLayout={frame.measure} testID="home-measure">
            <View ref={frame.headlineRef} /><View ref={frame.composerRef} />
        </View>;
    }
    let currentFocus = true;
    const scene = (visible: boolean) => {
        currentFocus = visible;
        return <>
            <AtmosphereLayer sheetRadius={12} chrome={false} />
            <DestinationInstanceContext.Provider value={{ tabId: 'perf-home', ref: { kind: 'home', params: {} },
                pathname: '/home', visible, focused: visible, isFocused: () => currentFocus }}><Home /></DestinationInstanceContext.Provider>
        </>;
    };
    const previous = storage.getState();
    const localId = 'home-horizon-recovery';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture']) });
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } }));
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        screen = await renderScreen(scene(true), { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData() { paints++; } }) }
            : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, width, 60) } });
        await act(async () => { screen!.findByTestId('home-measure')!.props.onLayout(); });
        expect(jobs).toBe(0);
        width = 80;
        await act(async () => { screen!.findByTestId('home-measure')!.props.onLayout(); });
        await act(async () => { vi.advanceTimersByTime(120); });
        await vi.waitFor(() => expect(paints).toBeGreaterThan(0));
        const painted = paints;
        await screen.update(scene(false));
        expect(screen.findAllHostsByTestId('atmosphere-band')).toHaveLength(0);
        await screen.update(scene(true));
        await vi.waitFor(() => expect(paints).toBeGreaterThan(painted));
    } finally {
        await screen?.unmount();
        vi.useRealTimers();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('does not remeasure a shared band render when another pane projects the same pixels', async () => {
    let bufferReads = 0;
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            const rgba = new Uint8ClampedArray(w * h * 4);
            // Measure reads of the real worker result, including tone sampling; no domain logic stub.
            const result = { w, h, get rgba() { bufferReads++; return rgba; } };
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'band-tone-cost';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture']) });
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } }));
        const geometry = { rect: { x: 0, y: 0, width: 80, height: 60 }, band: 35, horizonAt: 0.86, focus: { x: 40, y: 25 } };
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry }, true);
        screen = await renderScreen(<AtmosphereLayer sheetRadius={12} chrome={false} />, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 80, 60),
            },
        });
        expect(bufferReads).toBeGreaterThan(1);
        bufferReads = 0;
        // The extra projection lies inside the existing scene: its pixels and tone are unchanged.
        await act(async () => atmosphereStageStore.setStage({ id: -2, surface: 'new-session', geometry: {
            ...geometry, rect: { ...geometry.rect, x: 40, width: 40 },
        } }, false));
        expect(screen.findAllHostsByTestId('atmosphere-band')).toHaveLength(2);
        expect(jobs).toBe(1);
        // One read copies the buffer into the new canvas. No repeated tone sampling is needed.
        expect(bufferReads).toBe(1);
        const survivor = screen.findAllHostsByTestId('atmosphere-band')[1];
        const readiness: boolean[] = [];
        const unsubscribe = atmosphereStageStore.subscribe(() => readiness.push(atmosphereStageStore.get().pictureShown));
        try {
            // Replacing one pane must not withdraw the pixels still presented by the other pane.
            await act(async () => {
                atmosphereStageStore.clearStage(-1);
                atmosphereStageStore.setStage({ id: -3, surface: 'home', geometry }, true);
            });
            expect(screen.findAllHostsByTestId('atmosphere-band')[0]).toBe(survivor);
            expect(atmosphereStageStore.get().pictureShown).toBe(true);
            expect(readiness).not.toContain(false);
            expect(jobs).toBe(1);
        } finally {
            unsubscribe();
        }
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('withdraws a hidden retained Project band without worker jobs or paints, and restores it on activation', async () => {
    let jobs = 0;
    let paints = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'retained-project-band';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    let currentFocus = true;
    const scene = (visible: boolean) => {
        currentFocus = visible;
        return <>
            <AtmosphereLayer sheetRadius={12} chrome={false} />
            <DestinationInstanceContext.Provider value={{ tabId: 'retained-project', ref: { kind: 'project', params: {} },
                pathname: '/projects/p1', visible, focused: visible, isFocused: () => currentFocus }}>
                <AtmosphereSurfaceFrame surface={{ project: { serverId: 'srv', projectKey: 'p1' } }} showLook={false}>
                    <ProjectTabs />
                </AtmosphereSurfaceFrame>
            </DestinationInstanceContext.Provider>
        </>;
    };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } }));
        screen = await renderScreen(scene(true), { createNodeMock: element => element.type === 'canvas'
            ? { getContext: () => ({ putImageData() { paints++; } }) }
            : { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) =>
                done(0, 0, 390, element.props.testID === 'project-tabs' ? 110 : 844) },
        });
        await vi.waitFor(() => {
            expect(jobs).toBeGreaterThan(0);
            expect(paints).toBeGreaterThan(0);
        });
        await screen.update(scene(false));
        const hiddenJobs = jobs, hiddenPaints = paints;
        const downloads = vi.fn(async () => new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', downloads);
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, picture: { ref: { kind: 'builtin', id: 'calm-sea' }, layout: 'horizon' },
        } } })));
        await act(async () => { vi.advanceTimersByTime(300_000); });
        await act(async () => {
            // IndexedDB schedules transaction completion on real Node task turns.
            for (let turn = 0; turn < 8; turn++) await new Promise<void>(resolve => setImmediate(resolve));
        });
        expect(screen.findAllHostsByTestId('atmosphere-band')).toHaveLength(0);
        expect(jobs - hiddenJobs).toBe(0);
        expect(paints - hiddenPaints).toBe(0);
        expect(downloads).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } })));
        await screen.update(scene(true));
        await vi.waitFor(() => {
            expect(screen!.findAllHostsByTestId('atmosphere-band')).toHaveLength(1);
            expect(paints).toBeGreaterThan(hiddenPaints);
        });
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...state.settings.homeAtmosphere, picture: { ref: { kind: 'builtin', id: 'calm-sea' }, layout: 'horizon' },
        } } })));
        await vi.waitFor(() => expect(downloads).toHaveBeenCalled());
    } finally {
        await screen?.unmount();
        vi.useRealTimers();
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('keeps a retained Project\'s glass asleep while another tab hides it and when it shows again', async () => {
    const { GlassMaterialRuntime } = await import('@/components/ui/glass/GlassMaterialRuntime');
    const previous = storage.getState();
    let renders = 0;
    let behind: string | undefined;
    function Ink() { renders++; behind = useGlassRuntimeEnvironment().atmosphereBehind; return null; }
    const ink = <Ink />;
    const project = { project: { serverId: 'srv', projectKey: 'p1' } };
    const destination = (tabId: string, visible: boolean, children: React.ReactNode) => <DestinationInstanceContext.Provider
        value={{ tabId, ref: { kind: 'project', params: {} }, pathname: `/${tabId}`, visible, focused: visible, isFocused: () => visible }}>{children}</DestinationInstanceContext.Provider>;
    // A retained Project tab and a tab without an atmosphere (Discussions) take turns in one window.
    const scene = (projectShown: boolean) => <GlassMaterialRuntime>
        <AtmosphereLayer sheetRadius={12} chrome={false} />
        {destination('retained-project', projectShown, <AtmosphereSurfaceFrame surface={project} showLook={false}><ProjectTabs />{ink}</AtmosphereSurfaceFrame>)}
        {destination('discussions', !projectShown, <View />)}
    </GlassMaterialRuntime>;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, showOn: ['home', 'projects'],
        } } }));
        screen = await renderScreen(scene(true), { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 390, 844),
        }) });
        await vi.waitFor(() => expect(behind).toBe('band'));
        renders = 0;
        await screen.update(scene(false));
        await act(async () => {});
        expect(atmosphereStageStore.get().stage).toBeNull();
        expect(renders).toBe(0);
        await screen.update(scene(true));
        await vi.waitFor(() => expect(atmosphereStageStore.get().stage?.surface).toEqual(project));
        await act(async () => {});
        expect(behind).toBe('band');
        expect(renders).toBe(0);
    } finally {
        await screen?.unmount();
        storage.setState(previous, true);
    }
});

function picturePosition(node: ReactTestInstance) {
    let x = 0, y = 0;
    for (let current: ReactTestInstance | null = node; current; current = current.parent) {
        if (typeof current.type !== 'string') continue;
        const style = flattenTestStyle(current.props.style);
        x += Number(style.left ?? 0) + Number(style.marginLeft ?? 0);
        y += Number(style.top ?? 0) + Number(style.marginTop ?? 0);
        if (Array.isArray(style.transform)) for (const transform of style.transform) {
            y += Number(transform.translateY ?? 0);
        }
    }
    return { x, y };
}

it('clears the content plane for the Planet under Solid and restores it when the background is removed', async () => {
    const previous = storage.getState();
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    function PaintProbe() {
        const environment = useGlassRuntimeEnvironment();
        const settings = useGlassMaterialSettings();
        const material = resolveGlassSurfacePlaneMaterial(settings, 'content', environment);
        return React.createElement('PaintProbe', { testID: 'atmosphere-content-paint', material });
    }
    function Shell() {
        const [atmosphereBehind, setBehind] = React.useState<NonNullable<GlassMaterialEnvironment['atmosphereBehind']>>('none');
        return <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind }}>
            <GlassAtmosphereBehindSetterProvider value={setBehind}>
                <AtmosphereLayer sheetRadius={12} chrome={false} />
                <PaintProbe />
            </GlassAtmosphereBehindSetterProvider>
        </GlassRuntimeEnvironmentProvider>;
    }
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings,
            glassBlurEnabled: false, homeAtmosphere: DEFAULT_HOME_ATMOSPHERE,
        } }));
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: {
            rect: { x: 0, y: 0, width: 800, height: 600 }, band: 350, horizonAt: 0.86, focus: { x: 400, y: 250 },
        } }, true);
        screen = await renderScreen(<Shell />, { createNodeMock: () => ({
            measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600),
        }) });
        expect(screen.findHostByTestId('atmosphere-content-paint')!.props.material).toEqual({ blur: 'off', opacity: 0 });
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
            homeAtmosphere: { ...DEFAULT_HOME_ATMOSPHERE, source: 'none' },
        } })));
        expect(screen.findHostByTestId('atmosphere-content-paint')!.props.material).toEqual({ blur: 'off', opacity: 1 });
    } finally {
        await screen?.unmount();
        await act(async () => storage.setState(previous, true));
    }
});

it('projects one continuous picture in a scrolling Home beside stationary Project tabs across focus changes', async () => {
    let jobs = 0;
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true,
                result: { rgba: new Uint8ClampedArray(w * h * 4), w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'split-scroll-test';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    const home = { id: -1, surface: 'home' as const, geometry: {
        rect: { x: 0, y: 0, width: 500, height: 600 }, band: 350, horizonAt: 0.86, focus: { x: 250, y: 250 },
    } };
    const project = { id: -2, surface: { project: { serverId: 'home-a', projectKey: 'project-a' } }, geometry: {
        rect: { x: 508, y: 0, width: 500, height: 600 }, band: 110, horizonAt: 0.86, focus: { x: 250, y: 55 },
    } };
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'horizon' },
        } } }));
        atmosphereStageStore.setStage(home, true);
        atmosphereStageStore.setStage(project, false);
        const screen = await renderScreen(<AtmosphereLayer sheetRadius={12} chrome={false} />, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 1008, 600),
            },
        });
        const positions = () => screen.findAllHostsByTestId('atmosphere-band').map(picturePosition);
        expect(positions()).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
        await act(async () => atmosphereStageStore.setScrollY(home.id, 137));
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        await act(async () => {
            atmosphereStageStore.setStage(home, false);
            atmosphereStageStore.setStage(project, true);
        });
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        await act(async () => {
            atmosphereStageStore.setStage(project, false);
            atmosphereStageStore.setStage(home, true);
        });
        expect(positions()).toEqual([{ x: 0, y: -137 }, { x: 0, y: 0 }]);
        expect(jobs).toBe(1);
        await act(async () => storage.setState(state => ({ ...state, settings: { ...state.settings,
            glassBlurEnabled: false, homeAtmosphere: { ...state.settings.homeAtmosphere,
                picture: { ...state.settings.homeAtmosphere.picture, layout: 'wallpaper' },
            },
        } })));
        expect(screen.findHostByTestId('atmosphere-wallpaper')).not.toBeNull();
        expect(screen.findAllHostsByTestId('atmosphere-band')).toHaveLength(0);
        await screen.unmount();
    } finally {
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('measures the tone again where the content settles, without waiting for another render of the picture', async () => {
    let jobs = 0;
    // A picture dark at the top and light at the bottom: where the head lines stand decides their tone.
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            jobs++;
            const { width: w, height: h } = message.request;
            const rgba = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const at = (y * w + x) * 4;
                rgba[at] = rgba[at + 1] = rgba[at + 2] = Math.round((y / (h - 1)) * 255);
                rgba[at + 3] = 255;
            }
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: { rgba, w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'settling-geometry-test';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const tones: (GlassAtmosphereTone | undefined)[] = [];
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' },
        } } }));
        // Home first lays out with its head lines high on the page, then settles them lower.
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y: 60 } } }, true);
        const screen = await renderScreen(<GlassAtmosphereToneSetterProvider value={tone => { tones.push(tone); }}>
            <AtmosphereLayer sheetRadius={12} chrome={false} />
        </GlassAtmosphereToneSetterProvider>, { createNodeMock: element =>
            element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
                measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600),
            },
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        const early = tones.at(-1);
        expect(early?.focus).toBeLessThan(0.1);
        const rendered = jobs;
        await act(async () => atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y: 520 } } }, true));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(jobs).toBe(rendered);
        expect(tones.at(-1)?.focus).toBeGreaterThan(0.5);
        await screen.unmount();
    } finally {
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('holds the tone through a live resize and measures it once where the content comes to rest', async () => {
    vi.stubGlobal('Worker', class {
        onmessage: ((event: { data: BackdropWorkerResponse }) => void) | null = null;
        postMessage(message: BackdropWorkerRequest) {
            if (!('request' in message)) return;
            const { width: w, height: h } = message.request;
            const rgba = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                const at = (y * w + x) * 4;
                rgba[at] = rgba[at + 1] = rgba[at + 2] = Math.round((y / (h - 1)) * 255);
                rgba[at + 3] = 255;
            }
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result: { rgba, w, h } } }));
        }
        terminate() {}
    });
    vi.stubGlobal('ImageData', class {
        constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
    });
    const previous = storage.getState();
    const localId = 'live-resize-tone-test';
    await pictureStore.put({ localId, kind: 'user', data: new Blob(['prepared picture'], { type: 'image/webp' }) });
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    const tones: (GlassAtmosphereTone | undefined)[] = [];
    const nodeMock = (element: { type: unknown }) => element.type === 'canvas' ? { getContext: () => ({ putImageData() {} }) } : {
        measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(0, 0, 800, 600),
    };
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    const place = (y: number) => act(async () => atmosphereStageStore.setStage(
        { id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y } } }, true));
    const recordTone = (tone: GlassAtmosphereTone | undefined) => { tones.push(tone); };
    const tree = (resizing: boolean) => <GlassAtmosphereToneSetterProvider value={recordTone}>
        <AtmosphereLayer sheetRadius={12} chrome={false} resizing={resizing} />
    </GlassAtmosphereToneSetterProvider>;
    try {
        storage.setState(state => ({ ...state, settings: { ...state.settings, homeAtmosphere: {
            ...DEFAULT_HOME_ATMOSPHERE, source: 'picture', picture: { ref: { kind: 'user', localId }, layout: 'wallpaper' },
        } } }));
        atmosphereStageStore.setStage({ id: -1, surface: 'home', geometry: { rect, band: 350, horizonAt: 0.86, focus: { x: 400, y: 60 } } }, true);
        const screen = await renderScreen(tree(false), { createNodeMock: nodeMock });
        await settle();
        expect(tones.at(-1)?.focus).toBeLessThan(0.1);
        const publishedBeforeDrag = tones.length;

        // A sidebar drag moves the content on every frame; every glass surface would re-tone with it.
        await screen.update(tree(true));
        for (const y of [160, 260, 360, 460, 520]) { await place(y); await settle(); }
        expect(tones.length - publishedBeforeDrag).toBe(0);

        // Released, the tone is measured once, where the content now stands.
        await screen.update(tree(false));
        await settle();
        expect(tones.length - publishedBeforeDrag).toBe(1);
        expect(tones.at(-1)?.focus).toBeGreaterThan(0.5);
        await screen.unmount();
    } finally {
        storage.setState(previous, true);
        await pictureStore.remove(localId);
    }
});

it('decides the Wallpaper veil at the window\'s middle for every surface, so Home and a Project read as one look', async () => {
    const { wallpaperToneRegions } = await import('./AtmosphereLayer');
    const frame = { x: 0, y: 0, width: 1440, height: 1000 };
    const rect = { x: 440, y: 40, width: 1000, height: 960 };
    // Home stands its head lines mid-window; a Project stands its tabs at the top.
    const home = wallpaperToneRegions(frame, { rect, band: 0, horizonAt: 0.86, focus: { x: 500, y: 400 } });
    const project = wallpaperToneRegions(frame, { rect, band: 110, horizonAt: 0.86, focus: { x: 500, y: 45 } });
    expect(project.look).toEqual(home.look);
    expect(project.at).toEqual(home.at);
    // The veil still holds the Project's own head lines: its reach spans from the middle to their band.
    for (const regions of [home, project]) {
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(regions.heads.y0 + 1e-9);
        expect(regions.at.y + regions.reach.y).toBeGreaterThanOrEqual(regions.heads.y1 - 1e-9);
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(regions.look.y0 + 1e-9);
    }
});

it('veils the whole column where cards come to rest, wherever a surface stands its head lines', async () => {
    const { wallpaperToneRegions } = await import('./AtmosphereLayer');
    const frame = { x: 0, y: 0, width: 1440, height: 1000 };
    const rect = { x: 440, y: 40, width: 1000, height: 960 };
    // The Wallpaper stays put while the page scrolls, so a card can rest anywhere in the pane's column: over the
    // picture's bright horizon in the lower half too, not only around the head lines (FA22 GL1e).
    for (const focusY of [400, 45, 600]) {
        const regions = wallpaperToneRegions(frame, { rect, band: 0, horizonAt: 0.86, focus: { x: 500, y: focusY } });
        expect(regions.at.y - regions.reach.y).toBeLessThanOrEqual(rect.y / frame.height + 1e-9);
        expect(regions.at.y + regions.reach.y).toBeGreaterThanOrEqual((rect.y + rect.height) / frame.height - 1e-9);
        expect(regions.reach.x).toBeCloseTo(rect.width / frame.width / 2);
    }
});
