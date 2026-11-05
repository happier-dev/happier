import * as React from 'react';
import type { AtmosphereBackdrop } from './atmosphereBandBoundary';
import { atmosphereSurfaceKey, type AtmosphereSurface } from './resolveAtmosphere';

/**
 * The surface on screen that carries the atmosphere (Home now; new session and projects later) tells the
 * shell's one atmosphere layer where it is and how its hero is laid out. The layer draws the picture at
 * the shell, under the planes; the surface keeps its content. Scroll and send are high-frequency or
 * transient facts, so they live here rather than in either component's state.
 */
export type AtmosphereRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type AtmosphereStageGeometry = Readonly<{
  /** The surface's pane in window coordinates. */
  rect: AtmosphereRect;
  /** The Horizon band's height in the pane, and the picture's horizon as a fraction of it. */
  band: number;
  horizonAt: number;
  /** Where the content column's centre sits in the pane (Wallpaper's haze), pane coordinates. */
  focus: Readonly<{ x: number; y: number }>;
}>;
export type AtmosphereStage = Readonly<{
  id: number;
  surface: AtmosphereSurface;
  geometry: AtmosphereStageGeometry | null;
  /** The frame’s resolved bytes; floating surfaces never acquire the picture again. */
  backdrop?: AtmosphereBackdrop | null;
}>;
type Snapshot = Readonly<{
  stage: AtmosphereStage | null;
  panes: readonly AtmosphereStage[];
  /** Visible panes whose owner excluded artwork; the shell paints their page backing. */
  excludedPanes: readonly AtmosphereStage[];
  sending: boolean;
  pictureShown: boolean;
}>;

let snapshot: Snapshot = { stage: null, panes: [], excludedPanes: [], sending: false, pictureShown: false };
const scrollOffsets = new Map<number, number>();
let nextStageId = 1;
const stages = new Map<number, Readonly<{ stage: AtmosphereStage; focused: boolean; carriesAtmosphere: boolean }>>();
const listeners = new Set<() => void>();
const scrollListeners = new Set<() => void>();
const emit = (next: Snapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

function publishStage() {
  const candidates = [...stages.values()].filter(value => value.carriesAtmosphere);
  const selected = candidates.find(value => value.focused)
    ?? candidates.find(value => value.stage.id === snapshot.stage?.id)
    ?? candidates[0];
  const stage = selected?.stage ?? null;
  const panes = [...stages.values()].map(value => value.stage);
  const excludedPanes = [...stages.values()].filter(value => !value.carriesAtmosphere).map(value => value.stage);
  if (stage === snapshot.stage && panes.length === snapshot.panes.length
    && panes.every((pane, index) => pane === snapshot.panes[index])
    && excludedPanes.length === snapshot.excludedPanes.length
    && excludedPanes.every((pane, index) => pane === snapshot.excludedPanes[index])) return;
  // Surface cleanup/re-registration can be batched while the shell keeps its ready canvas. Only
  // the picture layer's readiness/unmount publishes pictureShown; stage selection cannot erase it.
  emit({ ...snapshot, stage, panes, excludedPanes });
}

export const atmosphereStageStore = {
  setStage(stage: AtmosphereStage, focused: boolean, carriesAtmosphere = true) {
    stages.set(stage.id, { stage, focused, carriesAtmosphere });
    publishStage();
  },
  clearStage(id: number) {
    stages.delete(id);
    if (scrollOffsets.delete(id)) scrollListeners.forEach(listener => listener());
    publishStage();
  },
  get: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getScrollY: (id: number) => scrollOffsets.get(id) ?? 0,
  subscribeScroll(listener: () => void) {
    scrollListeners.add(listener);
    return () => {
      scrollListeners.delete(listener);
    };
  },
  setScrollY(id: number, y: number) {
    if (y === (scrollOffsets.get(id) ?? 0)) return;
    scrollOffsets.set(id, y);
    scrollListeners.forEach((listener) => listener());
  },
  /** A session start from the composer on an atmosphere surface; false again when it settles. */
  setSending(sending: boolean) {
    if (snapshot.sending !== sending) emit({ ...snapshot, sending });
  },
  /** The layer reports when its picture is on screen, so Home can hand the planet over to it. */
  setPictureShown(pictureShown: boolean) {
    if (snapshot.pictureShown !== pictureShown)
      emit({ ...snapshot, pictureShown });
  },
};

function sameGeometry(
  a: AtmosphereStageGeometry | null,
  b: AtmosphereStageGeometry | null,
) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.band === b.band &&
    a.horizonAt === b.horizonAt &&
    a.focus.x === b.focus.x &&
    a.focus.y === b.focus.y &&
    a.rect.x === b.rect.x &&
    a.rect.y === b.rect.y &&
    a.rect.width === b.rect.width &&
    a.rect.height === b.rect.height
  );
}

/** One selected scene, retained while a visible pane carries it even when an opaque transcript has focus. */
export function useAtmosphereStage(
  surface: AtmosphereSurface | null,
  geometry: AtmosphereStageGeometry | null,
  focused = true,
  carriesAtmosphere = true,
  backdrop: AtmosphereBackdrop | null = null,
) {
  const [id] = React.useState(() => nextStageId++);
  const surfaceKey =
    surface === null
      ? null
      : atmosphereSurfaceKey(surface);
  React.useEffect(() => {
    if (surface === null) return;
    atmosphereStageStore.setStage({ id, surface, geometry, backdrop }, focused, carriesAtmosphere);
    return () => atmosphereStageStore.clearStage(id);
    // The surface identity is its key; a new object for the same surface keeps the stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, surfaceKey]);
  React.useEffect(() => {
    if (!surface) return;
    const current = stages.get(id);
    if (current?.focused === focused && current.carriesAtmosphere === carriesAtmosphere && current.stage.backdrop === backdrop && sameGeometry(current.stage.geometry, geometry)) return;
    atmosphereStageStore.setStage({ id, surface, geometry, backdrop }, focused, carriesAtmosphere);
    // The stable surface key owns identity, rather than the object allocated by its caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, id, focused, carriesAtmosphere, surfaceKey, backdrop]);
  return id;
}

export function useAtmosphereStageSnapshot(): Snapshot {
  return React.useSyncExternalStore(
    atmosphereStageStore.subscribe,
    atmosphereStageStore.get,
    atmosphereStageStore.get,
  );
}
export function useAtmosphereScrollY(id: number): number {
  return React.useSyncExternalStore(
    atmosphereStageStore.subscribeScroll,
    () => atmosphereStageStore.getScrollY(id),
    () => atmosphereStageStore.getScrollY(id),
  );
}
/** The composer's session start, published only while an atmosphere surface is on screen. */
export function useAtmosphereSendSignal(sending: boolean) {
  React.useEffect(() => {
    if (!sending) return;
    atmosphereStageStore.setSending(true);
    return () => atmosphereStageStore.setSending(false);
  }, [sending]);
}

/** Narrow reads for a surface: it re-renders when a send starts or the picture lands, never on geometry. */
export function useAtmosphereSending(): boolean {
    return React.useSyncExternalStore(atmosphereStageStore.subscribe, () => snapshot.sending, () => false);
}
export function useAtmospherePictureShown(): boolean {
    return React.useSyncExternalStore(atmosphereStageStore.subscribe, () => snapshot.pictureShown, () => false);
}

/**
 * Whether the composer on an atmosphere surface holds text (plan UD-4: the idle resettle waits for an
 * empty composer). Its model publishes it while mounted; only the leaf that reads it renders.
 */
let composerEmpty = true;
const composerListeners = new Set<() => void>();
function setComposerEmpty(empty: boolean) {
  if (empty === composerEmpty) return;
  composerEmpty = empty;
  composerListeners.forEach((listener) => listener());
}
function subscribeComposer(listener: () => void) {
  composerListeners.add(listener);
  return () => {
    composerListeners.delete(listener);
  };
}
/** The prompt's emptiness while this composer is mounted; leaving restores the empty default. */
export function useAtmosphereComposerText(prompt: Readonly<{ getPrompt(): string; subscribe(listener: () => void): () => void }>) {
  React.useEffect(() => {
    const publish = () => setComposerEmpty(prompt.getPrompt().trim().length === 0);
    publish();
    const unsubscribe = prompt.subscribe(publish);
    return () => {
      unsubscribe();
      setComposerEmpty(true);
    };
  }, [prompt]);
}
export function useAtmosphereComposerEmpty(): boolean {
  return React.useSyncExternalStore(subscribeComposer, () => composerEmpty, () => true);
}

/**
 * The next picture is the idle resettle's: each drawing canvas that shows this picture next settles into
 * it from the frame it shows (once per canvas, by id) instead of swapping. Read at paint time only.
 */
export type AtmosphereResettle = Readonly<{ id: number; localId: string; reducedMotion: boolean }>;
let resettle: AtmosphereResettle | null = null;
let nextResettleId = 1;
let resettlePaused = true;
const resettleListeners = new Set<() => void>();
function subscribeResettle(listener: () => void) {
  resettleListeners.add(listener);
  return () => { resettleListeners.delete(listener); };
}
export const atmosphereResettleFact = {
  get: () => resettle,
  announce(localId: string, reducedMotion: boolean) {
    resettle = { id: nextResettleId++, localId, reducedMotion };
  },
  clear() {
    resettle = null;
  },
  setPaused(paused: boolean) {
    if (resettlePaused === paused) return;
    resettlePaused = paused;
    resettleListeners.forEach(listener => listener());
  },
};

/** Home's current playback posture; this stays paused when its admission leaf leaves Home. */
export function useAtmosphereResettlePaused(): boolean {
  return React.useSyncExternalStore(subscribeResettle, () => resettlePaused, () => true);
}
