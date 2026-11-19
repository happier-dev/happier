import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countStoreNotifications, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { HomePlanet } from './HomePlanet';
import { PlanetCanvas } from './PlanetCanvas';
import { AtmosphereRipple } from './AtmosphereRipple';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
// Select the real web ring adapter for this web completion journey. Only browser
// font/Canvas2D ports below are synthetic; admission, playback and the ring stay real.
vi.mock('./AtmosphereRipple', async () => import('./AtmosphereRipple.web'));
const nativePictures = vi.hoisted(() => ({ count: 0 }));
vi.mock('@shopify/react-native-skia', async () => ({
  ...(await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock(),
  // Font readiness and native picture allocation are genuine platform boundaries.
  useTypeface: () => ({}),
  createPicture: () => { nativePictures.count += 1; return { dispose() {} }; },
}));

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

describe('Rise foot fade', () => {
  it('draws the planet down to the end of its ordered foot fade when the hero runs past the first fold', async () => {
    const desk = { width: 990, height: 850 };
    // Two rows of suggestions and the 200 px Rise foot put the widgets' header below the fold.
    const hero = { composerTop: 330, aboveBottom: 560, nextTop: 1010 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        placement="rise"
        style="balanced"
        digits
        theme="light"
        phone={false}
        hero={hero}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(PlanetCanvas);
    const fade = canvas.props.fade as { from: number; to: number };
    expect(fade.to).toBeGreaterThan(desk.height);
    expect(canvas.props.height).toBeGreaterThanOrEqual(fade.to);
    expect(canvas.props.options.view.h).toBe(canvas.props.height);
  });

  it('keeps Corner to the pane', async () => {
    const desk = { width: 990, height: 850 };
    const screen = await renderScreen(
      <HomePlanet
        pane={desk}
        placement="corner"
        style="balanced"
        digits
        theme="light"
        phone={false}
        hero={{ composerTop: 330, aboveBottom: 560, nextTop: 1010 }}
        hidden={false}
        leave="fade"
        reducedMotion={false}
      />,
    );
    const canvas = screen.findByType(PlanetCanvas);
    expect(canvas.props.height).toBe(desk.height);
    expect(canvas.props.options.view.h).toBe(desk.height);
  });
});

describe('Welcome digits subscription locality', () => {
  let previous: ReturnType<typeof storage.getState>;
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'setInterval',
        'clearInterval',
        'Date',
        'performance',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    previous = storage.getState();
    nativePictures.count = 0;
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
      <HomePlanet pane={pane} placement="corner" style="balanced" digits
        theme="dark" phone={false} hero={null} hidden={false} leave="fade" reducedMotion={false}
        focused answerFinishes />
    </React.Activity>;
    const screen = await renderScreen(scene(true));
    try {
      await act(async () => { screen.findByType(PlanetCanvas).props.onReady(); });
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(21_500);
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestTurnStatus: 'completed', latestTurnStatusObservedAt: Date.now() } }]);
      });
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
      await act(async () => {
        storage.getState().applyServerScopedSessionListRowPatches('server-a', [{ sessionId: session.id,
          patch: { latestReadyEventAt: Date.now(), latestReadyEventSeq: 2 } }]);
      });
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
      await screen.update(scene(false));
      await screen.update(scene(true));
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
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
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
      await screen.update(scene(false));
      await screen.update(scene(true));
      expect(screen.findAllByType(AtmosphereRipple)).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('redraws only the digits leaf every two seconds over settled Home, and pauses for writing, focus and reduced motion', async () => {
    let ticks = 0;
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback, delay, ...args) =>
      interval(() => { ticks += 1; callback(...args); }, delay));
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
            placement="corner"
            style="balanced"
            digits
            theme="dark"
            phone={false}
            hero={null}
            hidden={props.hidden === true}
            leave="fade"
            reducedMotion={props.reducedMotion ?? false}
            focused={props.eligible ?? true}
            writing={props.writing ?? false}
            retype
            answerFinishes
          />
        </>
      );
    }
    const screen = await renderScreen(<Home />);
    const initialHomeRenders = homeRenders;
    const initialContentRenders = unrelatedRenders;
    const canvasProps = screen.findByType(PlanetCanvas).props;
    const dissolveProps = screen.findByType(AtmosphereDissolve).props;
    const watch = () => screen.find(node => typeof node.type === 'function' && node.type.name === 'SessionFinishWatch');
    const watchProps = watch().props;
    const notifications = countStoreNotifications(storage);
    const initialPictures = nativePictures.count;
    for (let tick = 0; tick < 150; tick++) {
      await act(async () => { vi.advanceTimersByTime(2000); });
    }
    expect.soft(ticks).toBe(150);
    expect(nativePictures.count - initialPictures).toBe(150);
    // Ancestor-rendered outputs stay stable while only the drawing leaf updates.
    expect.soft(screen.findByType(PlanetCanvas).props === canvasProps).toBe(true);
    expect.soft(screen.findByType(AtmosphereDissolve).props === dissolveProps).toBe(true);
    expect.soft(watch().props === watchProps).toBe(true);
    expect(notifications.read()).toEqual([]);
    notifications.stop();
    expect(homeRenders).toBe(initialHomeRenders);
    expect(unrelatedRenders).toBe(initialContentRenders);
    await screen.update(<Home writing />);
    const held = ticks;
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(ticks).toBe(held);
    await screen.update(<Home />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(ticks).toBe(held + 1);
    await screen.update(<Home reducedMotion />);
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(ticks).toBe(held + 1);
    await screen.update(<Home />);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(ticks).toBe(held + 2);
    await screen.update(<Home hidden />);
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(ticks).toBe(held + 2);
    await screen.update(<Home />);
    for (const key of ['visibility', 'appState'] as const) {
      await act(async () => {
        host[key] = key === 'visibility' ? 'hidden' : 'background';
        for (const listener of key === 'visibility' ? host.documentListeners : host.appListeners) listener();
      });
      await act(async () => { vi.advanceTimersByTime(4000); });
      expect(ticks).toBe(held + 2);
      await act(async () => {
        host[key] = key === 'visibility' ? 'visible' : 'active';
        for (const listener of key === 'visibility' ? host.documentListeners : host.appListeners) listener();
      });
    }
    await screen.update(<Home eligible={false} />);
    const atBlur = ticks;
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(ticks).toBe(atBlur);
    await screen.update(<Home />);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(ticks).toBe(atBlur + 1);
    await screen.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
