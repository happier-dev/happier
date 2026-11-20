import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet';
import { createLoadingPlanetScene } from '@happier-dev/brand/glyph-scene';
import { measureInWindow } from '@/components/ui/popover/measure';
import { GlyphSurface } from '../glyph/GlyphSurface';
import type { HomePane } from '../homePlanetPlacement';
import {
  loadingPlanetLayers,
  loadingPlanetOrigin,
  loadingPlanetPhase,
  type LoadingPlanetPhase,
  type PlanetMomentOrigin,
  type PlanetMomentTarget,
} from './planetMomentTimeline';
import type { GlyphSurfaceReadiness } from '../glyph/glyphSurfaceTypes';
import { useGlyphClock } from './useMomentClock';

type LoadingPlanetStage = 'grace' | 'waiting' | 'resolving' | 'landed';

/** Whether Home's own planet waits under a moment, and how it appears when the moment hands over. */
export type HomePlanetHold = Readonly<{
  held: boolean;
  arrive: 'fade' | 'instant';
}>;
const FREE: HomePlanetHold = { held: false, arrive: 'fade' };
const HELD: HomePlanetHold = { held: true, arrive: 'fade' };

/** What Home reports about itself: still loading, where its planet rests, and whether that planet is drawn. */
export type HomeMomentReport = Readonly<{
  waiting: boolean;
  target: PlanetMomentTarget | null;
  drawn: boolean;
}>;

type OuterMoment = Readonly<{
  playing: boolean;
  shown: boolean;
  hold: HomePlanetHold;
  report: (home: HomeMomentReport | null) => void;
}>;
type MomentSlot = Readonly<{ radius: number; place: (node: unknown) => void }>;
const OuterMomentContext = React.createContext<OuterMoment | null>(null);
const MomentSlotContext = React.createContext<MomentSlot | null>(null);

export type HomeLoadingMomentInput = Readonly<{
  /** This host's own reason Home is not ready yet (setup in progress, or Home's model loading). */
  waiting: boolean;
  /** Only a wait present when the host mounts is a cold start; the setup host also starts on its first wait. */
  start: 'mount' | 'first-wait';
  /** Home is unreachable: its own error state replaces the loader. */
  abort?: boolean;
  paused: boolean;
  reducedMotion: boolean;
  theme: 'light' | 'dark';
  pane: HomePane;
  /** Home's own facts when Home itself hosts the moment; a host above Home receives them by report. */
  home?: HomeMomentReport;
  /** The host's root, for placing the cloud on a mark slot inside it. */
  rootRef?: React.RefObject<unknown>;
  cover?: React.ReactNode;
}>;

export type HomeLoadingMoment = Readonly<{
  /** The moment's layer, for the host to place over Home's pane (null when nothing plays here). */
  layer: React.ReactNode;
  /** A Loading moment is on screen for this Home (here or in the host above it). */
  playing: boolean;
  /** Applies to Home's own planet. */
  hold: HomePlanetHold;
  /** The cloud has been on screen in this arrival: a Welcome would only repeat it. */
  shown: boolean;
  provide: (children: React.ReactNode) => React.ReactNode;
}>;

/**
 * The one Loading moment of a Home arrival (plan R-11). The Personal Home setup host and Home itself
 * can both be waiting; whichever plays the moment owns it, and Home below a playing setup host reports
 * its own readiness and planet up to it instead of starting a second cloud.
 */
export function useHomeLoadingMoment(
  input: HomeLoadingMomentInput,
): HomeLoadingMoment {
  const outer = React.useContext(OuterMomentContext);
  const delegated = outer !== null && outer.playing;
  const [status, setStatus] = React.useState<'idle' | 'playing' | 'done'>(() =>
    input.waiting && !input.abort && !delegated
      ? 'playing'
      : input.start === 'mount'
        ? 'done'
        : 'idle',
  );
  if (status === 'idle' && input.waiting && !input.abort && !delegated)
    setStatus('playing');
  if (status === 'playing' && (input.abort || delegated)) setStatus('done');

  const [reported, setReported] = React.useState<HomeMomentReport | null>(null);
  const home: HomeMomentReport = input.home ??
    reported ?? { waiting: false, target: { kind: 'none' }, drawn: false };
  const [stage, setStage] = React.useState<
    Readonly<{ stage: LoadingPlanetStage; fast: boolean; still: boolean }>
  >({ stage: 'grace', fast: false, still: input.reducedMotion });
  const [shown, setShown] = React.useState(false);
  const [instant, setInstant] = React.useState(false);
  const toPlanet = home.target?.kind === 'planet';
  const onStage = React.useCallback(
    (next: LoadingPlanetStage, fast: boolean, still: boolean) => {
      setStage((current) =>
        current.stage === next && current.fast === fast && current.still === still
          ? current
          : { stage: next, fast, still },
      );
      if (next === 'waiting') setShown(true);
    },
    [],
  );
  if (
    status === 'playing' &&
    stage.stage === 'landed' &&
    (stage.fast || !toPlanet || stage.still || home.drawn)
  ) {
    setStatus('done');
    // Home's planet replaces the landed one in the same frame: the two are the same pixels.
    if (!stage.fast && toPlanet && !stage.still) setInstant(true);
  }
  // The hand-over's instant arrival applies to that one arrival only.
  React.useEffect(() => {
    if (instant) setInstant(false);
  }, [instant]);

  // Home under a host reports up; the report is withdrawn when Home leaves.
  const report = outer?.report;
  const ownHome = input.home;
  React.useEffect(() => {
    if (report && ownHome) report(ownHome);
  }, [ownHome, report]);
  React.useEffect(() => () => report?.(null), [report]);

  const [origin, setOrigin] = React.useState<PlanetMomentOrigin | null>(null);
  const radius = loadingPlanetOrigin(input.pane).R;
  const rootRef = input.rootRef;
  const place = React.useCallback(
    (node: unknown) => {
      void Promise.all([
        measureInWindow(node),
        measureInWindow(rootRef?.current),
      ]).then(([slot, root]) => {
        if (!slot || !root) return;
        const next = {
          cx: Math.round(slot.x - root.x + slot.width / 2),
          cy: Math.round(slot.y - root.y + slot.height / 2),
          R: radius,
        };
        setOrigin((current) =>
          current &&
          current.cx === next.cx &&
          current.cy === next.cy &&
          current.R === next.R
            ? current
            : next,
        );
      });
    },
    [radius, rootRef],
  );

  const playing = status === 'playing';
  const hold = delegated
    ? outer.hold
    : playing
      ? stage.still &&
        stage.stage !== 'grace' &&
        stage.stage !== 'waiting'
        ? FREE
        : HELD
      : instant
        ? { held: false, arrive: 'instant' as const }
        : FREE;
  const outerValue = React.useMemo<OuterMoment>(
    () => ({ playing, shown, hold, report: setReported }),
    [hold, playing, shown],
  );
  const slot = React.useMemo<MomentSlot>(
    () => ({ radius, place }),
    [place, radius],
  );
  const provide = React.useCallback(
    (children: React.ReactNode) => (
      <OuterMomentContext.Provider value={outerValue}>
        <MomentSlotContext.Provider value={slot}>
          {children}
        </MomentSlotContext.Provider>
      </OuterMomentContext.Provider>
    ),
    [outerValue, slot],
  );

  const layer = playing ? (
    <HomeLoadingGlyph
      pane={input.pane}
      origin={origin}
      target={home.waiting ? null : home.target}
      ready={!input.waiting && !home.waiting}
      paused={input.paused}
      reducedMotion={input.reducedMotion}
      theme={input.theme}
      cover={input.cover}
      onStage={onStage}
    />
  ) : null;
  return { layer, playing: delegated || playing, hold, shown: delegated ? outer.shown : shown, provide };
}

function HomeLoadingGlyph(props: Readonly<{
  pane: HomePane;
  origin: PlanetMomentOrigin | null;
  target: PlanetMomentTarget | null;
  ready: boolean;
  paused: boolean;
  reducedMotion: boolean;
  theme: 'light' | 'dark';
  cover: React.ReactNode;
  onStage: (stage: LoadingPlanetStage, fast: boolean, still: boolean) => void;
}>) {
  const { pane, onStage } = props;
  const { GRACE } = PLANET_MOMENT_TIMINGS.L4;
  const ready = props.ready && props.target !== null;
  const target = props.target?.kind === 'planet' ? props.target : null;
  const [backend, setBackend] = React.useState<GlyphSurfaceReadiness | null>(null);
  const still = props.reducedMotion || backend === 'still';
  const [kind, setKind] = React.useState<LoadingPlanetPhase['kind']>('none');
  const elapsed = React.useRef(0);
  const phase = React.useRef<LoadingPlanetPhase>({ kind: 'none' });
  const drawAtRef = React.useRef<((seconds: number) => void) | null>(null);
  const readyAt = React.useRef<number | null>(null);
  if (ready && readyAt.current === null) readyAt.current = elapsed.current;

  const coverOpacity = useSharedValue(0);
  const planetOpacity = useSharedValue(1);
  const coverStyle = useAnimatedStyle(() => ({ opacity: coverOpacity.value }));
  const planetStyle = useAnimatedStyle(() => ({ opacity: planetOpacity.value }));
  const sample = React.useCallback((seconds: number) => {
    elapsed.current = seconds;
    const next = loadingPlanetPhase(seconds, readyAt.current, { reducedMotion: still, toPlanet: target !== null });
    const previous = phase.current;
    phase.current = next;
    const previousCover = previous.kind === 'assembly' || previous.kind === 'travel' ? previous.cover : 0;
    const nextCover = next.kind === 'assembly' || next.kind === 'travel' ? next.cover : 0;
    if (previousCover !== nextCover) coverOpacity.value = nextCover;
    const previousOpacity = previous.kind === 'assembly' ? previous.opacity : 1;
    const nextOpacity = next.kind === 'assembly' ? next.opacity : 1;
    if (previousOpacity !== nextOpacity) planetOpacity.value = nextOpacity;

    if (previous.kind !== next.kind) {
      setKind(next.kind);
      if (next.kind === 'assembly' && !ready) onStage('waiting', false, still);
    }
    if (next.kind === 'landed') {
      if (next.fast || still || !target) onStage('landed', next.fast, still);
      return;
    }
    if (!still && previous.kind === next.kind) drawAtRef.current?.(seconds);
  }, [coverOpacity, onStage, planetOpacity, ready, still, target]);
  const durationS = !ready && still ? GRACE : Infinity;
  const paused = props.paused || kind === 'landed';
  const motion = React.useMemo(() => ({ kind: 'elapsed' as const, durationS, paused }), [durationS, paused]);
  useGlyphClock(motion, 'ready', sample);

  React.useEffect(() => {
    if (ready && phase.current.kind !== 'landed') onStage('resolving', false, still);
  }, [onStage, ready, still]);
  const loadingScene = React.useMemo(createLoadingPlanetScene, []);
  const scene = React.useCallback((_seconds: number, readiness?: GlyphSurfaceReadiness) => {
    const visualPhase = readiness === 'still'
      ? loadingPlanetPhase(GRACE, null, { reducedMotion: true, toPlanet: target !== null })
      : phase.current;
    return loadingPlanetLayers(loadingScene, visualPhase, props.origin ?? loadingPlanetOrigin(pane), target);
  }, [GRACE, loadingScene, pane, props.origin, target]);
  const onFinalPaint = React.useCallback(() => { onStage('landed', false, still); }, [onStage, still]);
  const travel = kind === 'travel' || kind === 'landed';
  const size = travel && target ? target.pane : pane;
  const hasPlanet = kind === 'assembly' || kind === 'travel'
    || (phase.current.kind === 'landed' && !phase.current.fast && target !== null && !still);
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={StyleSheet.absoluteFill} testID="loading-planet">
    {props.cover && kind !== 'none' && kind !== 'landed'
      ? <Animated.View style={[StyleSheet.absoluteFill, coverStyle]}>{props.cover}</Animated.View>
      : null}
    {hasPlanet && size.width > 0 && size.height > 0 ? <Animated.View style={[StyleSheet.absoluteFill, planetStyle]}>
      <GlyphSurface
        width={size.width} height={size.height} theme={props.theme} scene={scene}
        style={StyleSheet.absoluteFill} drawAtRef={drawAtRef} onReady={setBackend}
        onPaint={kind === 'landed' ? onFinalPaint : undefined}
        testID={travel ? 'loading-planet.travel' : 'loading-planet.assembly'}
      />
    </Animated.View> : null}
  </View>;
}

/**
 * The setup surface's mark: the room for the loading planet, sized to it. Outside a Loading host
 * it keeps a fixed room so the copy below it does not move.
 */
export function LoadingPlanetSlot(props: Readonly<{ fallbackSize: number; style?: StyleProp<ViewStyle>; testID?: string }>) {
  const slot = React.useContext(MomentSlotContext);
  const ref = React.useRef<View>(null);
  const size = slot ? Math.round(slot.radius * 2) : props.fallbackSize;
  const place = slot?.place;
  const onLayout = React.useCallback(() => place?.(ref.current), [place]);
  return (
    <View
      ref={ref}
      onLayout={onLayout}
      testID={props.testID}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[props.style, { width: size, height: size }]}
    />
  );
}
