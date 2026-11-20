import * as React from 'react';
import { StyleSheet, type View } from 'react-native';
import { AtmosphereDissolve } from './AtmosphereDissolve';
import { useSessionFinishedRipple } from './homeAtmosphereMoments';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { useLayoutPresentationSignal } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHomeGlyphArrival } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { stepMotionTiming } from '@/components/ui/motion/stepMotion/stepMotionTiming';
import type { NearViewportTracker } from '@/components/widgets/nearViewport';
import { sessionRippleLayer } from './sessionRipple';
import { GlyphSurface, type GlyphMotion, type GlyphSurfaceReadiness } from './glyph/GlyphSurface';
import type { GlyphViewport } from './glyph/glyphSurfaceTypes';
import { glyphFieldDurationS, homeFieldStrength, planetGlyphLayer, type GlyphFieldMode, type GlyphLayer, type GlyphRect, type PlanetIntensity } from '@happier-dev/brand/glyph-scene';
import { HomeFieldPreference, useHomeGlyphField } from './glyph/useHomeGlyphField';
import { FURTHER_PLANET_MOMENT_TIMINGS } from '@happier-dev/brand/planet-moments';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import {
  homePlanetDrawnHeight,
  homeRiseFootFade,
  type HomePane,
} from './homePlanetPlacement';

export type HomePlanetHero = Readonly<{
  /** The composer's top and the bottom of what stands under it (suggestions), in the pane. */
  composerTop: number | null;
  aboveBottom: number;
  /** The first thing below the hero (the widgets' header), or null when nothing follows. */
  nextTop: number | null;
}>;

export type HomePlanetLook = Readonly<{
  pane: HomePane;
  intensity: PlanetIntensity;
  digits: boolean;
  theme: 'light' | 'dark';
  phone: boolean;
  hero: HomePlanetHero | null;
}>;

export function useHomePlanetGeometry({ pane, phone, hero }: Pick<HomePlanetLook, 'pane' | 'phone' | 'hero'>) {
  const { width, height } = pane;
  const composerTop = hero?.composerTop ?? undefined;
  return React.useMemo(() => width > 0 && height > 0
    ? horizonPlanetGeometry({ width, height }, { phone, composerTop })
    : null, [composerTop, height, phone, width]);
}

/** The ordered foot fade before the first Home section. */
export function homePlanetFootFade(look: Pick<HomePlanetLook, 'hero' | 'phone'>) {
  const { hero, phone } = look;
  return hero && hero.nextTop !== null
    ? homeRiseFootFade({ aboveBottom: hero.aboveBottom, nextTop: hero.nextTop, phone })
    : undefined;
}

/**
 * The brand dot planet as an object on Home (plan R-1): the pane crops it, it scrolls with the page,
 * and it is drawn over the content coat and under everything Home shows. It is decorative: hidden from
 * accessibility and never a target. It fades in once drawn and leaves with the send.
 */
export const HomePlanet = React.memo(function HomePlanet(
  props: Readonly<{
    pane: HomePane;
    intensity: PlanetIntensity;
    digits: boolean;
    theme: 'light' | 'dark';
    phone: boolean;
    hero: HomePlanetHero | null;
    /** Hidden while a send dissolves the page or a picture has taken over. */
    hidden: boolean;
    leave: 'climb' | 'fade';
    /** A moment that landed on this planet hands over in the same frame. */
    arrive?: 'fade' | 'instant';
    reducedMotion: boolean;
    writing?: boolean;
    /** Each time the planet's canvas has drawn. */
    onDrawn?: () => void;
    /** The departure finished; the surface owns any pending-launch restoration. */
    onHidden?: () => void;
    /** The session-finished ripple (UD-4): on while Home's source is the planet and the moment is on. */
    answerFinishes?: boolean;
    /** Home is the focused page; with the app in front, a finish it sees is answered. */
    focused?: boolean;
    planet?: boolean;
    fieldAllowed?: boolean;
    fieldHost?: React.RefObject<View | null>;
    fieldTap?: React.RefObject<((x: number, y: number) => void) | null>;
    fieldScrollY?: React.RefObject<number>;
    fieldQuiet?: readonly GlyphRect[];
    viewport?: NearViewportTracker;
  }>,
) {
  const { pane, digits, intensity, theme, writing, focused, hidden, reducedMotion, planet = true, fieldAllowed } = props;
  const geometry = useHomePlanetGeometry(props);
  const fade = homePlanetFootFade(props);
  const homeArrival = useHomeGlyphArrival();
  const arrival = planet && !reducedMotion ? homeArrival : null;
  const [preference, setPreference] = React.useState<GlyphFieldMode>('off');
  const mode = !fieldAllowed || !pane.width ? 'off' : reducedMotion || hidden || focused === false || arrival?.building ?
    preference === 'off' ? 'off' : 'still' : preference;
  const height = homePlanetDrawnHeight(pane.height, fade);
  const planetBottom = fade?.to ?? height;
  const showBackdrop = mode !== 'off';
  const viewport = React.useMemo<GlyphViewport | undefined>(() => {
    const tracker = props.viewport;
    if (!tracker) return;
    const get: GlyphViewport['get'] = () => {
      const window = tracker.getVisibleWindow();
      // The first frame can warm before layout. Digit time starts with a measured viewport.
      if (!window) return 'backdrop';
      if (window.bottom <= 0 || window.top >= height) return 'hidden';
      if (planet && window.top < planetBottom) return 'all';
      return showBackdrop ? 'backdrop' : 'hidden';
    };
    return { get, subscribe(listener) {
      let visible = get();
      return tracker.subscribeVisibleWindow(() => {
        const next = get();
        if (visible === next) return;
        visible = next;
        listener();
      });
    } };
  }, [height, planet, planetBottom, props.viewport, showBackdrop]);
  const presentation = useLayoutPresentationSignal();
  const canStir = React.useCallback(() => presentation.get() && viewport?.get() !== 'hidden', [presentation, viewport]);
  const { epoch: fieldEpoch, layer: fieldLayer, readDurationS, settle: settleField } = useHomeGlyphField({
    mode, arriving: !hidden && props.arrive === 'instant',
    quiet: props.fieldQuiet, host: props.fieldHost, nativeTap: props.fieldTap, scrollY: props.fieldScrollY,
    strength: homeFieldStrength(intensity, { phone: props.phone }), planet: planet ? geometry ?? undefined : undefined,
    canStir,
  });
  const [drawn, setDrawn] = React.useState(false);
  // Home remounts its planet on every return, so its first draw is a return, not an arrival: it shows
  // at once. Only a reveal after this mount held it hidden (a moment's hand-over, a picture leaving, the
  // send's return) arrives as `arrive` says. A fade replayed per return cost a pane-sized compositing
  // surface WebKit never returned, ~190 MB per 12 visits on desktop (P03-DESKTOP-MEMORY-3).
  const heldHidden = React.useRef(false);
  if (props.hidden) heldHidden.current = true;
  const onDrawn = React.useRef(props.onDrawn);
  onDrawn.current = props.onDrawn;
  const onReady = React.useCallback(() => {
    setDrawn(true);
    onDrawn.current?.();
  }, []);
  const [answerEpoch, setAnswerEpoch] = React.useState<number | null>(null);
  const onAnswer = React.useCallback(() => {
    if (presentation.get() && (!viewport || viewport.get() === 'all')) setAnswerEpoch(performance.now());
  }, [presentation, viewport]);
  const finishAnswer = React.useCallback(() => setAnswerEpoch(null), []);
  const answer = !planet || hidden || focused === false || writing || arrival?.building ? null : answerEpoch;
  const arrivalEpoch = arrival?.building ? null : arrival?.settleEpoch ?? null;
  const starts = [fieldEpoch, answer, arrivalEpoch].filter(start => start !== null);
  const epoch = starts.length ? Math.min(...starts) : null;
  const ringDuration = FURTHER_PLANET_MOMENT_TIMINGS.RIP.DUR;
  const fromField = fieldEpoch === null || epoch === null ? 0 : (fieldEpoch - epoch) / 1000;
  const fromAnswer = answer === null || epoch === null ? 0 : (answer - epoch) / 1000;
  const settleStart = arrivalEpoch === null || epoch === null ? 0 : (arrivalEpoch - epoch) / 1000;
  const end = React.useCallback(() => Math.max(
    fieldEpoch === null ? 0 : fromField + readDurationS(),
    answer === null ? 0 : fromAnswer + ringDuration,
    arrivalEpoch === null ? 0 : settleStart + stepMotionTiming.homeSettleS,
  ), [answer, arrivalEpoch, fieldEpoch, fromAnswer, fromField, readDurationS, ringDuration, settleStart]);
  const settle = React.useCallback(() => {
    settleField();
    finishAnswer();
    if (!arrival?.building) arrival?.finish();
  }, [arrival, finishAnswer, settleField]);
  const { from: fadeFrom, to: fadeTo } = fade ?? {};
  const scene = React.useMemo(() => {
    if (!geometry) return [];
    const fade = fadeFrom !== undefined && fadeTo !== undefined ? { from: fadeFrom, to: fadeTo } : undefined;
    const settle = arrivalEpoch === null ? undefined : { startS: settleStart, durationS: stepMotionTiming.homeSettleS };
    return (seconds: number, _readiness?: GlyphSurfaceReadiness, digitTimeS = 0) => {
      const layers: GlyphLayer[] = [];
      const field = fieldLayer(Math.max(0, seconds - fromField));
      if (field) layers.push(field);
      if (!planet) return layers;
      const options = { geometry, intensity: arrival?.building ? 'full' as const : intensity, digits, fade, soft: props.phone, settle, digitTimeS };
      if (answer === null || seconds < fromAnswer) {
        layers.push(planetGlyphLayer(options));
        return layers;
      }
      layers.push(sessionRippleLayer(options, (seconds - fromAnswer) * 1000, { width: pane.width, theme, reducedMotion }));
      return layers;
    };
  }, [answer, arrival?.building, arrivalEpoch, digits, fadeFrom, fadeTo, fieldLayer, fromAnswer, fromField, geometry,
    intensity, pane.width, planet, props.phone, reducedMotion, settleStart, theme]);
  const motion = React.useMemo<GlyphMotion>(() => epoch === null ? null : (
    { kind: 'field-calm', epoch, durationS: glyphFieldDurationS, readDurationS: end, onSettled: settle }
  ), [end, epoch, settle]);
  const digitCadence = planet && digits && !reducedMotion && !hidden && !writing && !arrival?.building && focused === true;
  React.useEffect(() => { if (answerEpoch !== null && answer === null) finishAnswer(); }, [answer, answerEpoch, finishAnswer]);
  return <>
    {fieldAllowed ? <HomeFieldPreference onMode={setPreference} /> : null}
    {geometry && (planet || mode !== 'off') ? (
    <AtmosphereDissolve
      visible={drawn && !props.hidden}
      leave={props.leave}
      arrive={heldHidden.current ? props.arrive : 'instant'}
      height={height}
      reducedMotion={props.reducedMotion}
      onHidden={props.onHidden}
      style={[styles.layer, { width: pane.width, height }]}
    >
      <GlyphSurface
        width={pane.width}
        height={height}
        scene={scene}
        theme={theme}
        motion={motion}
        viewport={viewport}
        digitCadence={digitCadence}
        onReady={onReady}
        testID="home-planet"
      />
      {props.answerFinishes && drawn ? (
        <SessionFinishWatch visible={props.focused === true && !props.hidden} onAnswer={onAnswer} />
      ) : null}
    </AtmosphereDissolve>) : null}
  </>;
});

/**
 * The session observation, mounted only while the planet can answer: the Activity source's changes
 * render this leaf, never the planet.
 */
function SessionFinishWatch(props: Readonly<{ visible: boolean; onAnswer: () => void }>) {
  const active = useHostActivelyViewed();
  const answers = useSessionFinishedRipple({ enabled: true, visible: props.visible && active });
  const { onAnswer } = props;
  const forwarded = React.useRef(0);
  React.useEffect(() => {
    // Activity reconnects effects with retained hook state. Only a new admitted
    // answer wakes playback; returning Home does not forward the old count again.
    if (answers <= forwarded.current) return;
    forwarded.current = answers;
    onAnswer();
  }, [answers, onAnswer]);
  return null;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, top: 0 },
});
