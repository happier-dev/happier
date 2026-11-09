import * as React from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import {
  createPlanetScene,
  PLANET_MOMENT_TIMINGS,
  planetAssembly,
  type PlanetAssembly,
  type PlanetSceneDot,
  type PlanetSceneOptions,
} from '@happier-dev/brand/planet';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PlanetCanvas } from '../PlanetCanvas';
import type { HomePane } from '../homePlanetPlacement';
import { PlanetMomentCanvas } from './PlanetMomentCanvas';
import {
  loadingAssembledFrame,
  loadingPlanetOrigin,
  loadingPlanetPhase,
  loadingPlanetSource,
  loadingPlanetTravel,
  type PlanetMomentOrigin,
  type PlanetMomentTarget,
} from './planetMomentTimeline';
import { useMomentClock } from './useMomentClock';

/** `grace`: nothing shown yet; `waiting`: the cloud holds; `resolving`: Home is ready and the planet lands. */
export type LoadingPlanetStage = 'grace' | 'waiting' | 'resolving' | 'landed';

export type LoadingPlanetProps = Readonly<{
  pane: HomePane;
  /** Where the cloud gathers; the lab's centre of the pane when the host has no mark slot. */
  origin?: PlanetMomentOrigin | null;
  /** The light's orientation of Home's placement, so the cloud is already the planet it becomes. */
  orientation: Readonly<{ rotate: number; mirror: boolean }>;
  /** Home's planet once it is known; `none` when Home shows no planet. */
  target: PlanetMomentTarget | null;
  /** Home is ready to be shown. Loading resolves only on this, never on a timer. */
  ready: boolean;
  /** Nothing in progress (a decision or failure is on screen): the cloud holds still. */
  paused: boolean;
  reducedMotion: boolean;
  theme: 'light' | 'dark';
  /** The page Home is revealed from: it covers Home until ready, then fades with the brand's cover. */
  cover?: React.ReactNode;
  onStage: (stage: LoadingPlanetStage, fast: boolean) => void;
}>;

type Prepared = Readonly<{
  key: string;
  assembly: PlanetAssembly;
  haze: readonly PlanetSceneDot[];
}>;

/**
 * Loading (plan R-11, lab `MOS.loading4`): after a 0.25 s grace a cloud of faint digits appears and the
 * limb's digits drift toward their places, a proto-crescent made only of digits that cannot look
 * finished early. On ready the cover fades, the light sweeps and the planet travels on a critically
 * damped spring to Home's placement, where Home's own planet takes over. It is decorative: hidden from
 * accessibility and never a target.
 */
export function LoadingPlanet(props: LoadingPlanetProps) {
  const { pane, target, reducedMotion } = props;
  const activelyViewed = useHostActivelyViewed();
  const presented = useLayoutPresentationActive();
  const [landed, setLanded] = React.useState<Readonly<{
    fast: boolean;
  }> | null>(null);
  const ready = props.ready && target !== null;
  const t = useMomentClock(landed === null, props.paused || !activelyViewed,
    reducedMotion && !ready ? PLANET_MOMENT_TIMINGS.L4.GRACE : undefined);
  const readyAt = React.useRef<number | null>(null);
  if (readyAt.current === null && ready)
    readyAt.current = t;
  const toPlanet = target?.kind === 'planet';
  const phase = loadingPlanetPhase(t, readyAt.current, {
    reducedMotion,
    toPlanet,
  });

  const dpr = PixelRatio.get();
  const origin = props.origin ?? loadingPlanetOrigin(pane);
  const { rotate, mirror } = props.orientation;
  const theme = props.theme;
  const source = React.useMemo(
    () => loadingPlanetSource({ cx: origin.cx, cy: origin.cy, R: origin.R }, { rotate, mirror }, { theme, pane, dpr }),
    [dpr, mirror, origin.R, origin.cx, origin.cy, pane, rotate, theme],
  );
  // The assembly is prepared after the first frame, inside the grace, so Home's first frame never waits on it.
  const sourceKey = JSON.stringify(source);
  const [prepared, setPrepared] = React.useState<Prepared | null>(null);
  React.useEffect(() => {
    if (landed || !activelyViewed || !presented || props.paused || pane.width <= 0 || pane.height <= 0) return;
    if (prepared?.key === sourceKey) return;
    const frame = requestAnimationFrame(() => {
      setPrepared({
        key: sourceKey,
        assembly: planetAssembly(source),
        haze: createPlanetScene({ ...source, rise: 1 }).haze,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [activelyViewed, presented, props.paused, landed, pane.height, pane.width, source, sourceKey, prepared]);

  // The clock can finish before the canvas (for example while the browser loads its fonts).
  // Settlement belongs to the final painted travel frame, before Home replaces that canvas.
  const targetOptions = target?.kind === 'planet' ? target.options : null;
  const travelProgress = phase.kind === 'travel' ? phase.k : 1;
  const travelOptions = React.useMemo(() => targetOptions
    ? loadingPlanetTravel(source, targetOptions, travelProgress)
    : null, [source, targetOptions, travelProgress]);
  const [travelDrawn, setTravelDrawn] = React.useState(false);
  const [travelFailed, setTravelFailed] = React.useState(false);
  // A failed decorative paint gives way to Home's already-painted canvas; the parent still
  // requires Home's own drawn fact, so a font error cannot strand this moment awaiting a reply.
  const onTravelError = React.useCallback(() => setTravelFailed(true), []);
  const [paintedTravel, setPaintedTravel] = React.useState<Readonly<{
    options: PlanetSceneOptions; from?: number; to?: number;
  }> | null>(null);
  const fadeFrom = target?.kind === 'planet' ? target.fade?.from : undefined;
  const fadeTo = target?.kind === 'planet' ? target.fade?.to : undefined;
  const onTravelReady = React.useCallback(() => {
    setTravelDrawn(true);
    if (travelOptions && travelOptions === targetOptions) setPaintedTravel({ options: travelOptions, from: fadeFrom, to: fadeTo });
  }, [travelOptions, targetOptions, fadeFrom, fadeTo]);
  const finalTravelPainted = target?.kind === 'planet' && paintedTravel?.options === target.options
    && paintedTravel.from === fadeFrom && paintedTravel.to === fadeTo;
  const awaitingFinalPaint = phase.kind === 'landed' && !phase.fast && toPlanet && !reducedMotion && !finalTravelPainted && !travelFailed;
  const stage: LoadingPlanetStage =
    phase.kind === 'landed' && !awaitingFinalPaint
      ? 'landed'
      : readyAt.current !== null
        ? 'resolving'
        : phase.kind === 'none'
          ? 'grace'
          : 'waiting';
  const clockLanded = phase.kind === 'landed';
  const fast = clockLanded && phase.fast;
  const onStage = React.useRef(props.onStage);
  onStage.current = props.onStage;
  React.useEffect(() => {
    if (clockLanded) setLanded((current) => current ?? { fast });
    onStage.current(stage, fast);
  }, [clockLanded, fast, stage]);

  // The travelling planet's first crisp frame replaces the assembled one only once it is drawn.
  const travelling =
    phase.kind === 'travel' ||
    (phase.kind === 'landed' && !phase.fast && toPlanet && !reducedMotion);
  const assembly = prepared?.key === sourceKey ? prepared : null;
  const cover =
    phase.kind === 'assembly' || phase.kind === 'travel' ? phase.cover : 0;

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={StyleSheet.absoluteFill}
      testID="loading-planet"
    >
      {props.cover && cover > 0 ? (
        <View style={[StyleSheet.absoluteFill, { opacity: cover }]}>
          {props.cover}
        </View>
      ) : null}
      {assembly &&
      (phase.kind === 'assembly' || (travelling && !travelDrawn)) ? (
        <PlanetMomentCanvas
          width={pane.width}
          height={pane.height}
          dpr={dpr}
          assembly={assembly.assembly}
          haze={assembly.haze}
          frame={
            phase.kind === 'assembly'
              ? phase.frame
              : loadingAssembledFrame()
          }
          opacity={phase.kind === 'assembly' ? phase.opacity : 1}
          style={styles.layer}
          testID="loading-planet.assembly"
        />
      ) : null}
      {travelling && target?.kind === 'planet' && travelOptions ? (
        <PlanetCanvas
          width={travelOptions.view?.w ?? pane.width}
          height={travelOptions.view?.h ?? pane.height}
          options={travelOptions}
          fade={target.fade}
          onReady={onTravelReady}
          onError={onTravelError}
          style={styles.layer}
          testID="loading-planet.travel"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, top: 0 },
});
