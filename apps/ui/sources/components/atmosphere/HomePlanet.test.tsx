import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countStoreNotifications, renderScreen } from '@/dev/testkit';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { HomeBotMoons } from '@/components/hub/HomeBotMoons';
import { HomeOrbitBotMoon } from './orbit/HomeOrbitBotMoon';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot, removeServerProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { HomePlanet } from './HomePlanet';
import { GlyphSurface, type GlyphSurfaceProps } from './glyph/GlyphSurface';
import type { PlanetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { AtmosphereDissolve } from './AtmosphereDissolve';

const host = vi.hoisted(() => ({ appState: 'active', visibility: 'visible',
  appListeners: new Set<() => void>(), documentListeners: new Set<() => void>() }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ AppState: {
    get currentState() { return host.appState; },
    addEventListener: (_event: string, listener: () => void) => {
      host.appListeners.add(listener); return { remove: () => host.appListeners.delete(listener) };
    },
  } }),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const nativePictures = vi.hoisted(() => ({ count: 0, disposed: 0 }));
vi.mock('./glyph/glyphAtlas.native', async () => ({
  glyphAtlas: (await import('@/dev/testkit/mocks/reactNativeSkia')).createGlyphAtlasRasterMock,
}));
vi.mock('@shopify/react-native-skia', async () => {
  const boundary = (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaGlyphMock({
    onPicture: () => { nativePictures.count += 1; },
  });
  return {
    ...boundary,
    createPicture: (draw: Parameters<typeof boundary.createPicture>[0]) => {
      const picture = boundary.createPicture(draw);
      return { ...picture, dispose() { picture.dispose(); nativePictures.disposed += 1; } };
    },
  };
});

function planetAt(scene: GlyphSurfaceProps['scene'], seconds = 0): PlanetGlyphLayer {
  const layers = typeof scene === 'function' ? scene(seconds) : scene;
  const planet = layers.find(layer => layer.kind === 'planet');
  if (!planet) throw new Error('Home has no planet layer');
  return planet;
}

const pane = { width: 280, height: 240 };
beforeEach(() => {
  host.appState = 'active'; host.visibility = 'visible';
  vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  vi.stubGlobal('document', { documentElement: {}, fonts: { load: async () => [] },
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillText() {},
      getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    }) }),
    get visibilityState() { return host.visibility; },
    addEventListener: (event: string, listener: () => void) => { if (event === 'visibilitychange') host.documentListeners.add(listener); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Horizon foot fade', () => {
  it('draws the planet down to the end of its ordered foot fade when the hero runs past the first fold', async () => {
    const desk = { width: 990, height: 850 };
    // Two rows of suggestions and the 200 px Rise foot put the widgets' header below the fold.
    const hero = { composerTop: 330, aboveBottom: 560, nextTop: 1010 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        intensity="quiet"
        digits
        theme="light"
        phone={false}
        hero={hero}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(GlyphSurface);
    const fade = planetAt(canvas.props.scene).fade!;
    expect(fade.to).toBeGreaterThan(desk.height);
    expect(canvas.props.height).toBeGreaterThanOrEqual(fade.to);
    await screen.unmount();
  });

  it('keeps the surface at the pane height when no section follows', async () => {
    const desk = { width: 990, height: 850 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        intensity="quiet"
        digits
        theme="light"
        phone={false}
        hero={{ composerTop: 330, aboveBottom: 560, nextTop: null }}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(GlyphSurface);
    expect(canvas.props.height).toBe(desk.height);
    expect(planetAt(canvas.props.scene).fade).toBeUndefined();
    await screen.unmount();
  });
});

describe('Home glyph subscription locality', () => {
  let previous: ReturnType<typeof storage.getState>;
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    previous = storage.getState();
    nativePictures.count = 0;
    nativePictures.disposed = 0;
    storage.setState((state) => ({
      ...state,
      localSettings: { ...localSettingsDefaults },
    }));
  });
  afterEach(async () => {
    await act(async () => {
      storage.setState(previous, true);
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('FX28 mounts one ripple per canonical completion and none on retained Home return', async () => {
    const session = createSessionFixture({ id: 'canonical-finish', serverId: 'server-a',
      latestTurnId: 'canonical-turn', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now(),
      lastTurnCompletedAt: null });
    storage.getState().applySessions([session]);
    storage.getState().applyServerScopedSessionListRows('server-a', [buildSessionListRenderableFromSession(session)], { source: 'ordinary', mode: 'append' });
    const scene = (visible: boolean) => <React.Activity mode={visible ? 'visible' : 'hidden'}>
      <HomePlanet pane={pane} intensity="quiet" digits
        theme="dark" phone={false} hero={null} hidden={false} leave="fade" reducedMotion={false}
        focused answerFinishes />
    </React.Activity>;
    const screen = await renderScreen(scene(true));
    try {
      await vi.waitFor(() => expect(nativePictures.count).toBeGreaterThan(0));
      const answer = () => planetAt(screen.findByType(GlyphSurface).props.scene, 0.2).ring;
      expect(answer()).toBeUndefined();
      await act(async () => {
        vi.advanceTimersByTime(21_500);
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() } }]);
      });
      expect(answer()).toBeDefined();
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(answer()).toBeUndefined();
      await act(async () => {
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestReadyEventAt: Date.now(), latestReadyEventSeq: 2 } }]);
      });
      expect(answer()).toBeUndefined();
      await screen.update(scene(false));
      await screen.update(scene(true));
      expect(answer()).toBeUndefined();
      // Returning must not swallow a later, genuinely new completion either.
      await act(async () => {
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestTurnId: 'canonical-next-turn', latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: Date.now() } }]);
      });
      await act(async () => {
        vi.advanceTimersByTime(21_500);
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() } }]);
      });
      expect(answer()).toBeDefined();
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(answer()).toBeUndefined();
      await screen.update(scene(false));
      await screen.update(scene(true));
      expect(answer()).toBeUndefined();
    } finally { await screen.unmount(); }
  });

  it('firstOpen.01.F1.return draws once per visit, starts no settle and disposes the picture on departure', async () => {
    const home = <HomePlanet pane={pane} intensity="quiet" digits={false} theme="dark"
      phone={false} hero={null} hidden={false} leave="fade" reducedMotion={false} focused fieldAllowed />;
    const screen = await renderScreen(<>{home}</>);
    try {
      for (let visit = 1; visit <= 12; visit++) {
        await vi.waitFor(() => expect(nativePictures.count).toBe(visit));
        const { motion, scene } = screen.findByType(GlyphSurface).props as GlyphSurfaceProps;
        expect(motion).toBeNull();
        const layers = typeof scene === 'function' ? scene(0) : scene;
        expect(layers.some(layer => layer.kind === 'field')).toBe(true);
        await screen.update(<></>);
        expect(nativePictures.disposed).toBe(visit);
        if (visit < 12) await screen.update(<>{home}</>);
      }
      expect(nativePictures.count).toBe(12);
    } finally { await screen.unmount(); }
  });

  it('firstOpen.01.F1.idle60 leaves Home and its idle Bot moon without frame work', async () => {
    const previousServer = getActiveServerSnapshot().serverId;
    const server = await upsertAndActivateServer({ serverUrl: 'https://home-glyph-idle.test' });
    resetReanimatedFrameCallbacks();
    const bot = createSessionListRenderableSessionFixture({
      id: 'idle-moon', serverId: server.id, active: true, presence: 'online',
      metadata: { path: '/repo', bot: { kind: 'bot' }, name: 'Helper' }, latestTurnStatus: 'completed',
    });
    storage.getState().applyServerScopedSessionListRows(server.id, [bot], { source: 'ordinary', mode: 'replace' });
    const scene = <InjectedAuthProvider credentials={null}>
      <HomePlanet pane={pane} intensity="quiet" digits={false} theme="dark"
        phone={false} hero={null} hidden={false} leave="fade" reducedMotion={false} focused fieldAllowed />
      <HomeBotMoons planet={horizonPlanetGeometry(pane)} width={pane.width} height={pane.height}
        phone={false} shown viewport={null} />
    </InjectedAuthProvider>;
    const screen = await renderScreen(scene);
    try {
      await vi.waitFor(() => expect(nativePictures.count).toBeGreaterThan(0));
      const moon = screen.findByType(HomeOrbitBotMoon).props;
      const glyph = screen.findByType(GlyphSurface).props;
      const paints = nativePictures.count;
      let callbacks = 0;
      const requestFrame = globalThis.requestAnimationFrame;
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => requestFrame(time => {
        callbacks += 1;
        callback(time);
      }));
      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(callbacks).toBe(0);
      expect(nativePictures.count).toBe(paints);
      expect(readReanimatedFrameCallbacks().filter(record => record.handle.isActive)).toEqual([]);
      expect(screen.findByType(HomeOrbitBotMoon).props).toBe(moon);
      expect(screen.findByType(GlyphSurface).props).toBe(glyph);
    } finally {
      await screen.unmount();
      if (previousServer) await setActiveServerId(previousServer);
      await removeServerProfile(server.id);
    }
  });

  it('firstOpen.01.F1.rest redraws only the digits leaf every two seconds and pauses for writing, focus and reduced motion', async () => {
    const expectPaintsDuring = async (elapsedMs: number, paints: number) => {
      const before = nativePictures.count;
      await act(async () => { vi.advanceTimersByTime(elapsedMs); });
      expect(nativePictures.count - before).toBe(paints);
    };
    let homeRenders = 0;
    let unrelatedRenders = 0;
    function Content() {
      unrelatedRenders += 1;
      return null;
    }
    function Home(
      props: Readonly<{
        eligible?: boolean;
        writing?: boolean;
        reducedMotion?: boolean;
        hidden?: boolean;
      }>,
    ) {
      homeRenders += 1;
      return (
        <>
          <Content />
          <HomePlanet
            pane={pane}
            intensity="quiet"
            digits
            theme="dark"
            phone={false}
            hero={null}
            hidden={props.hidden === true}
            leave="fade"
            reducedMotion={props.reducedMotion ?? false}
            focused={props.eligible ?? true}
            writing={props.writing ?? false}
            answerFinishes
          />
        </>
      );
    }
    const screen = await renderScreen(<Home />);
    await vi.waitFor(() => expect(nativePictures.count).toBeGreaterThan(0));
    const initialHomeRenders = homeRenders;
    const initialContentRenders = unrelatedRenders;
    const canvasProps = screen.findByType(GlyphSurface).props;
    const dissolveProps = screen.findByType(AtmosphereDissolve).props;
    const watch = () => screen.find(node => typeof node.type === 'function' && node.type.name === 'SessionFinishWatch');
    const watchProps = watch().props;
    const notifications = countStoreNotifications(storage);
    const initialPictures = nativePictures.count;
    for (let tick = 0; tick < 30; tick++) {
      await act(async () => { vi.advanceTimersByTime(2000); });
    }
    expect(nativePictures.count - initialPictures).toBe(30);
    // Ancestor-rendered outputs stay stable while only the drawing leaf updates.
    expect.soft(screen.findByType(GlyphSurface).props === canvasProps).toBe(true);
    expect.soft(screen.findByType(AtmosphereDissolve).props === dissolveProps).toBe(true);
    expect.soft(watch().props === watchProps).toBe(true);
    expect(notifications.read()).toEqual([]);
    notifications.stop();
    expect(homeRenders).toBe(initialHomeRenders);
    expect(unrelatedRenders).toBe(initialContentRenders);
    await screen.update(<Home writing />);
    await expectPaintsDuring(4000, 0);
    await screen.update(<Home />);
    await expectPaintsDuring(2000, 1);
    await screen.update(<Home reducedMotion />);
    await expectPaintsDuring(4000, 0);
    await screen.update(<Home />);
    await expectPaintsDuring(2000, 1);
    await screen.update(<Home hidden />);
    await expectPaintsDuring(4000, 0);
    await screen.update(<Home />);
    for (const key of ['visibility', 'appState'] as const) {
      await act(async () => {
        host[key] = key === 'visibility' ? 'hidden' : 'background';
        for (const listener of key === 'visibility' ? host.documentListeners : host.appListeners) listener();
      });
      await expectPaintsDuring(4000, 0);
      await act(async () => {
        host[key] = key === 'visibility' ? 'visible' : 'active';
        for (const listener of key === 'visibility' ? host.documentListeners : host.appListeners) listener();
      });
    }
    await screen.update(<Home eligible={false} />);
    await expectPaintsDuring(2000, 0);
    await screen.update(<Home />);
    await expectPaintsDuring(2000, 1);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
