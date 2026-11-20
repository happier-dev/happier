import * as React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet as RNStyleSheet,
  View,
} from 'react-native';
import Svg, { Circle as SvgCircle, Line as SvgLine, Path, Text as SvgText } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';

import { GlyphSurface } from '@/components/atmosphere/glyph/GlyphSurface';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { workStatusGlyphColor } from '@/components/work/status/workStatusTreatment';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { t } from '@/text';

import { HomeOrbitBotMoon } from './HomeOrbitBotMoon';
import { placeOrbitMoonLabel, type HomeOrbitScene } from './homeOrbitScene';

// react-native-svg's web WebShape forwards CSS style; its native Circle/Line declarations omit it.
const Circle = SvgCircle as React.ComponentType<React.ComponentProps<typeof SvgCircle> & { style?: React.CSSProperties }>;
const Line = SvgLine as React.ComponentType<React.ComponentProps<typeof SvgLine> & { style?: React.CSSProperties }>;

/** Dots outside a preview fade to this strength; the previewed ones grow (lab L4 "reach map hover"). */
const PREVIEW_FADED_OPACITY = 0.16;
/** Ring marks and tethers outside a preview recede to this strength (lab hm-A "others recede to 22%"). */
const RING_PREVIEW_FADED_OPACITY = 0.22;
/** A mark with no tether (off, or not added yet) stands faded on the ring. */
const RING_UNTETHERED_OPACITY = 0.38;
const PREVIEW_DOT_SCALE = 1.7;
/** A moon's press target: the canonical pointer baseline around a few-px moon. */
const MOON_HIT_PX = 28;

export type HomeOrbitMapProps = Readonly<{
  scene: HomeOrbitScene;
  /** Moon key → machine name, drawn beside each moon. */
  labels?: Readonly<Record<string, string>>;
  /** Preview: dots not in the set fade (a hovered or focused row or card). */
  highlightKeys?: ReadonlySet<string> | null;
  /** A moon press (the machine filter). */
  onBodyPress?: (bodyKey: string) => void;
  /**
   * One-shot travel when a fact changes (Turn on sends skills out): the named dots leave the planet
   * for their orbits one after another, once per `id`; never looping, never on arrival.
   */
  travel?: Readonly<{ id: string; dotKeys: readonly string[] }> | null;
  /** A ring scene's mark, drawn centred on its place (an MCP server's mark, the "+N" count). */
  renderRingMark?: (key: string) => React.ReactNode;
  /**
   * A Bot scene's live inputs (`scene.bots`, lab R6 "Bots orbit Home"): each moon's face drawn into the
   * mark slot, its name, and where a press goes. Moons are the map's only targets.
   */
  bots?: HomeOrbitBotsProps;
  /** The map is art; the legend and the present sentence carry its facts. */
  accessibilityLabel: string;
  small?: boolean;
  testID?: string;
}>;

/**
 * The Home orbit map: orbits behind, the settled Horizon planet, then the dots and moons in
 * front. Static at rest; a preview fades the dots outside
 * it. Hidden from assistive technology: callers render the same facts as words.
 */
export const HomeOrbitMap = React.memo(function HomeOrbitMap(
  props: HomeOrbitMapProps,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { scene, highlightKeys } = props;
  const ink = theme.colors.text.primary;
  const card = theme.colors.edge.cardFill;
  const amber = workStatusGlyphColor(theme.colors, 'attention');
  const canvasSize = scene.canvas?.size ?? 0;
  const planet = React.useMemo(
    () => [planetGlyphLayer({
      geometry: horizonPlanetGeometry({ width: canvasSize, height: canvasSize }, {
        radius: scene.pr,
        limb: canvasSize / 2 - scene.pr,
      }),
      intensity: 'quiet',
      digits: false,
    })],
    [canvasSize, scene.pr],
  );
  const f = (value: number) => Number(value.toFixed(1));
  const previewing = highlightKeys != null;
  // Entering a preview takes the fast role; leaving is quicker (popover exit). Reduced motion: none.
  // react-native-svg forwards `style` to the DOM node on web; its CSS transition is not a ViewStyle key.
  const transition: SvgWebStyle =
    Platform.OS === 'web' && !reducedMotion
      ? ({
          transition: `opacity ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ${motionTokens.easingCss.standard}, r ${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms ${motionTokens.easingCss.standard}`,
        } as SvgWebStyle)
      : undefined;
  // The same fade for the ring's marks, which are views (react-native-web transition style keys).
  const markTransition =
    Platform.OS === 'web' && !reducedMotion
      ? ({
          transitionProperty: 'opacity',
          transitionDuration: `${previewing ? motionTokens.durationMs.fast : motionTokens.overlay.popover.exitMs}ms`,
          transitionTimingFunction: motionTokens.easingCss.standard,
        } as object)
      : null;
  const travelStyle = useTravelStyle(props.travel ?? null, scene, reducedMotion);
  const labelStyle = Typography.variant('meta');
  const labelFontSize = labelStyle.fontSize ?? 12;
  const placedLabels = React.useMemo(() => {
    const placed: Record<string, ReturnType<typeof placeOrbitMoonLabel>> = {};
    for (const moon of scene.moons) {
      const label = props.labels?.[moon.key];
      if (label) placed[moon.key] = placeOrbitMoonLabel(moon, label, scene, labelFontSize);
    }
    return placed;
  }, [labelFontSize, props.labels, scene]);
  return (
    <View
      testID={props.testID}
      pointerEvents="box-none"
      style={[styles.scene, { width: scene.width, height: scene.height }]}
    >
      <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={RNStyleSheet.absoluteFill}
      >
        <Svg
          width={scene.width}
          height={scene.height}
          style={RNStyleSheet.absoluteFill}
        >
          {scene.orbits.map((orbit, index) => (
            <Circle
              key={index}
              cx={scene.px}
              cy={scene.py}
              r={orbit.r}
              fill="none"
              stroke={ink}
              strokeOpacity={orbit.off ? 0.15 : 0.26}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeDasharray={orbit.off ? '0 7' : '0 4.2'}
            />
          ))}
          {scene.bots?.paths.map((d, index) => (
            <Path
              key={`bot-orbit:${index}`}
              d={d}
              fill="none"
              stroke={ink}
              strokeOpacity={0.26}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeDasharray="0 4.2"
            />
          ))}
        </Svg>
        {scene.canvas ? (
          <GlyphSurface
            width={scene.canvas.size}
            height={scene.canvas.size}
            scene={planet}
            style={{
              position: 'absolute',
              left: scene.canvas.left,
              top: scene.canvas.top,
            }}
          />
        ) : null}
        <Svg
          width={scene.width}
          height={scene.height}
          style={RNStyleSheet.absoluteFill}
        >
          {scene.ring?.marks.map((mark) => {
            if (mark.tether === 'none') return null;
            const lit = !previewing || highlightKeys.has(mark.key);
            const attention = mark.tether === 'attention';
            return (
              <Line
                key={`tether:${mark.key}`}
                x1={f(mark.from.x)}
                y1={f(mark.from.y)}
                x2={f(mark.to.x)}
                y2={f(mark.to.y)}
                stroke={attention ? amber : ink}
                strokeOpacity={attention ? 0.9 : previewing && lit ? 0.8 : 0.34}
                strokeWidth={attention ? 1.4 : 1.2}
                strokeLinecap="round"
                strokeDasharray={mark.tether === 'machine' ? '0 4' : attention ? '4 3.4' : undefined}
                opacity={lit ? 1 : RING_PREVIEW_FADED_OPACITY}
                style={transition}
              />
            );
          })}
          {scene.ring?.marks.map((mark) =>
            mark.tether === 'attention' ? (
              <Circle
                key={`beacon:${mark.key}`}
                cx={f(mark.x + 9)}
                cy={f(mark.y - 9)}
                r={2.6}
                fill={amber}
                opacity={!previewing || highlightKeys.has(mark.key) ? 1 : RING_PREVIEW_FADED_OPACITY}
                style={transition}
              />
            ) : null,
          )}
          {scene.dots.map((dot) => {
            const lit = !previewing || highlightKeys.has(dot.key);
            const grow = previewing && lit ? PREVIEW_DOT_SCALE : 1;
            const opacity = lit ? 1 : PREVIEW_FADED_OPACITY;
            const key = `${dot.bodyKey}:${dot.key}`;
            const style = travelStyle(dot) ?? transition;
            if (dot.tone === 'attention') {
              return (
                <React.Fragment key={key}>
                  <Circle
                    cx={f(dot.x)}
                    cy={f(dot.y)}
                    r={6}
                    fill={amber}
                    fillOpacity={0.22}
                    opacity={opacity}
                    style={style}
                  />
                  <Circle
                    cx={f(dot.x)}
                    cy={f(dot.y)}
                    r={2.7 * grow}
                    fill={amber}
                    opacity={opacity}
                    style={style}
                  />
                </React.Fragment>
              );
            }
            if (dot.tone === 'hollow') {
              return (
                <Circle
                  key={key}
                  cx={f(dot.x)}
                  cy={f(dot.y)}
                  r={1.9 * grow}
                  fill={card}
                  stroke={ink}
                  strokeOpacity={0.5}
                  strokeWidth={0.9}
                  opacity={opacity}
                  style={style}
                />
              );
            }
            return (
              <Circle
                key={key}
                cx={f(dot.x)}
                cy={f(dot.y)}
                r={(dot.tone === 'active' ? 2.2 : 1.9) * grow}
                fill={ink}
                fillOpacity={dot.tone === 'active' ? 0.7 : 0.26}
                opacity={opacity}
                style={style}
              />
            );
          })}
          {scene.moons.map((moon) => (
            <React.Fragment key={moon.key}>
              {moon.off ? (
                <Circle
                  cx={f(moon.x)}
                  cy={f(moon.y)}
                  r={moon.r}
                  fill={card}
                  stroke={ink}
                  strokeOpacity={0.34}
                  strokeWidth={1.1}
                  strokeDasharray="1.4 1.6"
                />
              ) : (
                // The card-coloured ring parts the orbit around the moon; its body is ink over the card.
                <>
                  <Circle
                    cx={f(moon.x)}
                    cy={f(moon.y)}
                    r={moon.r}
                    fill={card}
                    stroke={card}
                    strokeWidth={1.5}
                  />
                  <Circle
                    cx={f(moon.x)}
                    cy={f(moon.y)}
                    r={moon.r}
                    fill={ink}
                    fillOpacity={0.62}
                  />
                </>
              )}
              {placedLabels[moon.key] ? (
                <SvgText
                  x={placedLabels[moon.key]!.x}
                  textAnchor={placedLabels[moon.key]!.textAnchor}
                  y={f(moon.y + 4)}
                  fill={ink}
                  fillOpacity={moon.off ? 0.45 : 0.72}
                  fontFamily={labelStyle.fontFamily as string | undefined}
                  fontSize={labelStyle.fontSize}
                >
                  {placedLabels[moon.key]!.text}
                </SvgText>
              ) : null}
            </React.Fragment>
          ))}
        </Svg>
      </View>
      {scene.ring && props.renderRingMark ? (
        <View
          pointerEvents="none"
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={RNStyleSheet.absoluteFill}
        >
          {scene.ring.marks.map((mark) => {
            const lit = !previewing || highlightKeys.has(mark.key);
            const opacity = !lit
              ? RING_PREVIEW_FADED_OPACITY
              : mark.faded && !(previewing && lit)
                ? RING_UNTETHERED_OPACITY
                : 1;
            const size = scene.ring!.markSize;
            return (
              <View
                key={mark.key}
                style={[
                  styles.ringMark,
                  {
                    left: mark.x - size / 2,
                    top: mark.y - size / 2,
                    width: size,
                    height: size,
                    opacity,
                  },
                  markTransition,
                ]}
              >
                {props.renderRingMark!(mark.key)}
              </View>
            );
          })}
        </View>
      ) : null}
      {scene.bots && props.bots
        ? scene.bots.moons.map((moon) => (
            <HomeOrbitBotMoon
              key={moon.key}
              moon={moon}
              cx={scene.px}
              cy={scene.py}
              pr={scene.pr}
              eligible={props.bots!.eligible}
              continuous={props.bots!.continuous}
              mark={(size, done) => props.bots!.renderMark(moon.key, size, done)}
              label={props.bots!.labels[moon.key] ?? null}
              accessibilityLabel={props.bots!.accessibilityLabels[moon.key] ?? moon.key}
              onPress={() => props.bots!.onPress(moon.key)}
              spark={props.bots!.sparks[moon.key] ?? 0}
              ink={ink}
              testID={props.testID ? `${props.testID}.bot.${moon.key}` : undefined}
            />
          ))
        : null}
      {scene.bots?.more && props.bots?.onMore ? (
        // The Bots with no room in the hero: one "+N" that opens the Bots list.
        <Pressable
          testID={props.testID ? `${props.testID}.more` : undefined}
          accessibilityRole="button"
          accessibilityLabel={t('bots.roster.moreOnHomeA11y', { count: scene.bots.more.count })}
          onPress={props.bots.onMore}
          style={[
            styles.more,
            {
              left: scene.bots.more.x - scene.bots.more.size / 2,
              top: scene.bots.more.y - scene.bots.more.size / 2,
              width: scene.bots.more.size,
              height: scene.bots.more.size,
              borderRadius: scene.bots.more.size / 2,
              backgroundColor: theme.colors.surface.base,
              borderColor: theme.colors.border.default,
            },
          ]}
        >
          <Text variant="micro" emphasis="medium" numberOfLines={1}>
            {t('bots.roster.moreOnHome', { count: scene.bots.more.count })}
          </Text>
        </Pressable>
      ) : null}
      {props.onBodyPress
        ? scene.moons.map((moon) => (
            <Pressable
              key={moon.key}
              testID={
                props.testID ? `${props.testID}.moon.${moon.key}` : undefined
              }
              accessibilityRole="button"
              accessibilityLabel={props.labels?.[moon.key] ?? moon.key}
              onPress={() => props.onBodyPress?.(moon.key)}
              style={[
                styles.moonHit,
                {
                  left: moon.x - MOON_HIT_PX / 2,
                  top: moon.y - MOON_HIT_PX / 2,
                },
              ]}
            />
          ))
        : null}
    </View>
  );
});

export type HomeOrbitBotsProps = Readonly<{
  /** The mark slot: a Bot's face at the moon's size; `done` while its spark plays. */
  renderMark: (key: string, size: number, done: boolean) => React.ReactNode;
  /** Drawn under a moon (working and needs-you moons are named; quiet ones rest unnamed). */
  labels: Readonly<Record<string, string>>;
  accessibilityLabels: Readonly<Record<string, string>>;
  onPress: (key: string) => void;
  /** Opens the Bots list from the hero's "+N" (the Bots with no room in it). */
  onMore?: () => void;
  /** The map is on screen, the app viewed and reduced motion off: only then does a moon move. */
  eligible: boolean;
  /** Reactions only retains finite parks/sparks while the working orbit rests. */
  continuous?: boolean;
  /** Each Bot's completion count since this map mounted: a new value drops one spark. */
  sparks: Readonly<Record<string, number>>;
}>;

/** A web-only CSS style on an SVG element (transition, transform-box), typed as the element's style prop. */
type SvgWebStyle = React.CSSProperties | undefined;

type TravelPhase = Readonly<{ id: string; at: 'from' | 'go' }> | null;

/**
 * The travel moment on web: each named dot starts at the planet's centre, small and clear, and moves
 * out to its orbit on the travel spring's duration, `successMoment.fillStaggerMs` after the one before
 * (P5 §4.6). Reduced motion keeps the places and cross-fades the dots in instead. The phase ends
 * after the last dot lands, so a later render never replays it.
 */
function useTravelStyle(
  travel: Readonly<{ id: string; dotKeys: readonly string[] }> | null,
  scene: HomeOrbitScene,
  reducedMotion: boolean,
) {
  const [phase, setPhase] = React.useState<TravelPhase>(null);
  const travelId = travel?.id ?? null;
  const count = travel?.dotKeys.length ?? 0;
  React.useLayoutEffect(() => {
    if (Platform.OS !== 'web' || travelId === null || count === 0) return;
    setPhase({ id: travelId, at: 'from' });
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setPhase({ id: travelId, at: 'go' }));
    });
    const doneMs = reducedMotion
      ? motionTokens.successMoment.reducedCrossFadeMs
      : motionTokens.spring.travel.durationMs +
        motionTokens.successMoment.fillStaggerMs * (count - 1);
    const done = setTimeout(() => setPhase(null), doneMs + 50);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(done);
    };
  }, [count, reducedMotion, travelId]);
  const order = React.useMemo(
    () => new Map((travel?.dotKeys ?? []).map((key, index) => [key, index])),
    [travel?.dotKeys],
  );
  return React.useCallback(
    (dot: Readonly<{ key: string; x: number; y: number }>): SvgWebStyle => {
      if (!phase || phase.id !== travelId) return undefined;
      const index = order.get(dot.key);
      if (index === undefined) return undefined;
      if (reducedMotion) {
        return phase.at === 'from'
          ? { opacity: 0 }
          : ({
              transition: `opacity ${motionTokens.successMoment.reducedCrossFadeMs}ms ${motionTokens.easingCss.standard}`,
            } as SvgWebStyle);
      }
      if (phase.at === 'from') {
        return {
          transform: `translate(${scene.px - dot.x}px, ${scene.py - dot.y}px) scale(0.4)`,
          opacity: 0,
          transformBox: 'fill-box',
          transformOrigin: 'center',
        } as SvgWebStyle;
      }
      const delay = index * motionTokens.successMoment.fillStaggerMs;
      return {
        transform: 'translate(0px, 0px) scale(1)',
        transformBox: 'fill-box',
        transformOrigin: 'center',
        transition: `transform ${motionTokens.spring.travel.durationMs}ms ${motionTokens.easingCss.standard} ${delay}ms, opacity ${motionTokens.durationMs.fast}ms ${motionTokens.easingCss.standard} ${delay}ms`,
      } as SvgWebStyle;
    },
    [order, phase, reducedMotion, scene.px, scene.py, travelId],
  );
}

const styles = StyleSheet.create(() => ({
  scene: { position: 'relative', flexShrink: 0, overflow: 'hidden' },
  ringMark: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  more: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: RNStyleSheet.hairlineWidth,
  },
  moonHit: {
    position: 'absolute',
    width: MOON_HIT_PX,
    height: MOON_HIT_PX,
    borderRadius: MOON_HIT_PX / 2,
  },
}));
