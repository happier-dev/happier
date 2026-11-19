import * as React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet';
import type { PlanetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { measureInWindow } from '@/components/ui/popover/measure';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { GlyphSurface } from '../glyph/GlyphSurface';
import type { HomePane } from '../homePlanetPlacement';
import {
  loadingPlanetLayer,
  loadingPlanetOrigin,
  loadingPlanetPhase,
  type PlanetMomentOrigin,
  type PlanetMomentTarget,
} from './planetMomentTimeline';
import { useMomentClock } from './useMomentClock';

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
    Readonly<{ stage: LoadingPlanetStage; fast: boolean }>
  >({ stage: 'grace', fast: false });
  const [shown, setShown] = React.useState(false);
  const [instant, setInstant] = React.useState(false);
  const toPlanet = home.target?.kind === 'planet';
  const onStage = React.useCallback(
    (next: LoadingPlanetStage, fast: boolean) => {
      setStage((current) =>
        current.stage === next && current.fast === fast
          ? current
          : { stage: next, fast },
      );
      if (next === 'waiting') setShown(true);
    },
    [],
  );
  if (
    status === 'playing' &&
    stage.stage === 'landed' &&
    (stage.fast || !toPlanet || input.reducedMotion || home.drawn)
  ) {
    setStatus('done');
    // Home's planet replaces the landed one in the same frame: the two are the same pixels.
    if (!stage.fast && toPlanet && !input.reducedMotion) setInstant(true);
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
      ? input.reducedMotion &&
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
  onStage: (stage: LoadingPlanetStage, fast: boolean) => void;
}>) {
  const { pane, reducedMotion, onStage } = props;
  const { GRACE, RESOLVE } = PLANET_MOMENT_TIMINGS.L4;
  const viewed = useHostActivelyViewed();
  const ready = props.ready && props.target !== null;
  const target = props.target?.kind === 'planet' ? props.target : null;
  const [landed, setLanded] = React.useState(false);
  const [painted, setPainted] = React.useState<PlanetGlyphLayer | null>(null);
  const holdAfter = ready ? undefined : GRACE + (reducedMotion ? 0 : RESOLVE);
  const t = useMomentClock(!landed, props.paused || !viewed, holdAfter);
  const readyAt = React.useRef<number | null>(null);
  if (ready && readyAt.current === null) readyAt.current = t;
  const phase = loadingPlanetPhase(t, readyAt.current, { reducedMotion, toPlanet: target !== null });
  const clockLanded = phase.kind === 'landed';
  const fast = clockLanded && phase.fast;
  const awaitingPaint = clockLanded && !fast && !reducedMotion && target !== null && painted !== target.layer;
  const stage = clockLanded && !awaitingPaint ? 'landed' : ready ? 'resolving' : phase.kind === 'none' ? 'grace' : 'waiting';
  React.useEffect(() => {
    if (clockLanded) setLanded(true);
    onStage(stage, fast);
  }, [clockLanded, fast, onStage, stage]);
  const finalLayer = target?.layer;
  const onFinalPaint = React.useCallback(() => {
    if (finalLayer) setPainted(finalLayer);
  }, [finalLayer]);
  const layer = loadingPlanetLayer(phase, pane, props.origin ?? loadingPlanetOrigin(pane), target);
  const scene = React.useMemo(() => layer ? [layer] : [], [layer]);
  const travel = phase.kind === 'travel' || (clockLanded && !fast && !reducedMotion);
  const size = travel && target ? target.pane : pane;
  const cover = phase.kind === 'assembly' || phase.kind === 'travel' ? phase.cover : 0;
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={StyleSheet.absoluteFill} testID="loading-planet">
    {props.cover && cover > 0 ? <View style={[StyleSheet.absoluteFill, { opacity: cover }]}>{props.cover}</View> : null}
    {layer && size.width > 0 && size.height > 0 ? <GlyphSurface
      width={size.width} height={size.height} theme={props.theme} scene={scene}
      style={[StyleSheet.absoluteFill, { opacity: phase.kind === 'assembly' ? phase.opacity : 1 }]}
      onPaint={awaitingPaint ? onFinalPaint : undefined}
      testID={travel ? 'loading-planet.travel' : 'loading-planet.assembly'}
    /> : null}
  </View>;
}

/**
 * The setup surface's mark: the room the Loading cloud gathers in, sized to it. Outside a Loading host
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
