import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { Animated, Easing, View } from 'react-native';
import type { EntityDropPreviewV1 } from '@happier-dev/plugin-sdk';

import { useOptionalHappierUiAccessibility } from '../../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';
import { HappierSpinner } from '../feedback/Spinner.js';
import { HAPPIER_MOTION_V1 } from './motion.js';
import { HappierMaterialSurface, type HappierSurfaceProps } from '../layout/Surface.js';

type ReleaseMaterialProps = Pick<HappierSurfaceProps, 'gradient' | 'renderMaterialSurface'>;

/**
 * The ONE release preview (DnD lab E1): the answer to "what happens if I let go here", drawn the same
 * way by core lists, panes, Boards, the composer and plugin targets.
 *
 * - `HappierReleasePreviewCard` is the carried card: the item's identity, then the outcome strip.
 * - `HappierReleaseOutcomePill` is the outcome alone, for OS drags whose image the app cannot draw on.
 * - `HappierStagedMoveDock` docks the same strip under a list for the staged keyboard move, with its
 *   key hints.
 *
 * It owns chrome only. Which target is under the pointer, whether it admits the item and what the
 * words say all come from the host's drag owner and the domain resolver, already localized. A
 * refused outcome draws the refusal mark and the owner's reason; targets themselves light nothing.
 */

export type HappierReleaseGlyph = NonNullable<EntityDropPreviewV1['glyph']>;

export type HappierReleaseOutcome = Readonly<{
  /**
   * `allowed`: releasing does `title`. `refused`: it does nothing, `detail` says why. `pending`: a
   * released relation is waiting for its owner. `quiet`: nothing under the pointer takes it yet.
   */
  tone: 'allowed' | 'refused' | 'pending' | 'quiet';
  /** The effect's mark when allowed or pending; a refused outcome always draws `refused`. */
  glyph?: HappierReleaseGlyph;
  /** Verb and target ("Put under Fix settings modal remount"), or the refusal ("Can't put under …"). */
  title: string;
  /** The consequence and its limit ("Reports to it · both keep running"), or the reason. */
  detail?: string;
}>;

export type HappierReleasePreviewColors = Readonly<{
  surface: string;
  /** Hairline around the floating card. */
  border: string;
  divider: string;
  text: string;
  textSecondary: string;
  /** The effect mark of an allowed outcome. */
  accent: string;
  /** Strip fill behind an allowed or pending outcome. */
  allowedFill: string;
  /** Strip fill behind a refused outcome: neutral, never the danger colour. */
  refusedFill: string;
  /** Key-cap fill in the staged move's hints. */
  keycapFill: string;
  shadow: string;
}>;

export type HappierReleasePreviewHost = Readonly<{
  Text: ComponentType<Readonly<{
    children: string;
    style: HappierPortableStyle;
    numberOfLines?: number;
    testID?: string;
  }>>;
  renderGlyph: (glyph: HappierReleaseGlyph, color: string, size: number) => ReactNode;
  /** Environment-free core hosts bind their canonical spinner's preferences and activity. */
  renderPendingSpinner?: (size: number, color: string) => ReactNode;
}>;

/**
 * `pointer`: the card riding the pointer on desktop. `touch`: the phone Organize card at the finger,
 * full width with phone type. Values follow the lab's `.dd-card` / `.dd-pcard`.
 */
export type HappierReleasePreviewDensity = 'pointer' | 'touch';

/**
 * One floating material: the carried card, the OS-drag pill and the keyboard dock share one corner
 * (the floating-overlay radius), so the three never read as three different surfaces. The phone card
 * keeps the phone list's larger corner.
 */
const FLOATING_RADIUS = HAPPIER_RADIUS_V1.lg;

const METRICS = {
  pointer: {
    width: 304,
    radius: FLOATING_RADIUS,
    padX: 12,
    idPadY: 9,
    idGap: 10,
    mark: 20,
    stripPadTop: 8,
    stripPadBottom: 9,
    stripGap: 9,
    glyph: 16,
    title: { fontSize: 13, lineHeight: 17, fontWeight: '600' },
    subtitle: { fontSize: 11.5, lineHeight: 15 },
    outcomeTitle: { fontSize: 12.5, lineHeight: 17, fontWeight: '600' },
    outcomeDetail: { fontSize: 11.5, lineHeight: 15 },
  },
  touch: {
    width: undefined,
    radius: 14,
    padX: 14,
    idPadY: 12,
    idGap: 12,
    mark: 19,
    stripPadTop: 10,
    stripPadBottom: 11,
    stripGap: 10,
    glyph: 17,
    title: { fontSize: 15.5, lineHeight: 20, fontWeight: '600' },
    subtitle: { fontSize: 13, lineHeight: 17 },
    outcomeTitle: { fontSize: 14, lineHeight: 19, fontWeight: '600' },
    outcomeDetail: { fontSize: 12.5, lineHeight: 17 },
  },
} as const satisfies Record<HappierReleasePreviewDensity, Readonly<Record<string, unknown>>>;

/** Exported so a host can size its overlay before the card lays out. */
export const HAPPIER_RELEASE_PREVIEW_METRICS = Object.freeze({
  pointerWidth: METRICS.pointer.width,
  pillMaxWidth: 300,
  dockWidth: 300,
  radius: FLOATING_RADIUS,
});

/** The staged move's key row (lab `.dd-keys`): key caps sit inside the dock's own inset. */
const HINT_METRICS = {
  rowGap: 4,
  columnGap: 12,
  padX: METRICS.pointer.padX,
  padTop: 8,
  padBottom: 10,
  itemGap: 5,
  keycap: { size: 18, padX: 4, radius: 5 },
  keyText: { fontSize: 10.5, lineHeight: 14, fontWeight: '600' },
  label: { fontSize: METRICS.pointer.subtitle.fontSize, lineHeight: 16 },
} as const;

/** The carried card leans a hair away from the pointer, so it reads as lifted; never under reduced motion. */
const CARRIED_TILT_DEG = -0.5;
const ENTER_FROM_SCALE = 0.96;
const STANDARD_EASING = Easing.bezier(...HAPPIER_MOTION_V1.standardBezier);

function useEnterProgress(reducedMotion: boolean): Animated.Value {
  const progress = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  useEffect(() => {
    if (reducedMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: HAPPIER_MOTION_V1.fastMs,
      easing: STANDARD_EASING,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reducedMotion]);
  return progress;
}

function floatingChrome(colors: HappierReleasePreviewColors, radius: number) {
  return {
    borderRadius: radius,
    backgroundColor: colors.surface,
    borderWidth: 0.5,
    borderColor: colors.border,
    overflow: 'hidden' as const,
    shadowColor: colors.shadow,
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  };
}

/** The outcome strip: the effect mark, then verb + target, then the consequence or the reason. */
export function HappierReleaseOutcomeStrip(props: Readonly<{
  outcome: HappierReleaseOutcome;
  colors: HappierReleasePreviewColors;
  host: HappierReleasePreviewHost;
  density?: HappierReleasePreviewDensity;
  reducedMotion?: boolean;
  /** Draw the hairline above the strip (inside the card under the identity). */
  divided?: boolean;
  testID?: string;
}>) {
  const metrics = METRICS[props.density ?? 'pointer'];
  const { outcome, colors, host } = props;
  const Text = host.Text;
  const fill = outcome.tone === 'refused'
    ? colors.refusedFill
    : outcome.tone === 'quiet' ? 'transparent' : colors.allowedFill;
  const markColor = outcome.tone === 'allowed' ? colors.accent : colors.textSecondary;
  return (
    <View
      testID={props.testID}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: metrics.stripGap,
        paddingHorizontal: metrics.padX,
        paddingTop: metrics.stripPadTop,
        paddingBottom: metrics.stripPadBottom,
        backgroundColor: fill,
        ...(props.divided ? { borderTopWidth: 1, borderTopColor: colors.divider } : {}),
      }}
    >
      <View style={{ width: metrics.glyph + 4, height: metrics.outcomeTitle.lineHeight, alignItems: 'center', justifyContent: 'center' }}>
        {outcome.tone === 'pending'
          ? host.renderPendingSpinner
            ? host.renderPendingSpinner(metrics.glyph, colors.textSecondary)
            : <HappierSpinner size={metrics.glyph} color={colors.textSecondary} reducedMotion={props.reducedMotion} />
          : host.renderGlyph(outcome.tone === 'refused' ? 'refused' : (outcome.glyph ?? 'add'), markColor, metrics.glyph)}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ ...metrics.outcomeTitle, color: colors.text }}>{outcome.title}</Text>
        {outcome.detail ? <Text style={{ ...metrics.outcomeDetail, color: colors.textSecondary }}>{outcome.detail}</Text> : null}
      </View>
    </View>
  );
}

export type HappierReleasePreviewIdentity = Readonly<{
  title: string;
  /** One quiet line: its state and where it lives ("Needs you · happier · Studio"). */
  subtitle?: string;
  /** Drawn before the subtitle (an attention dot), in the subtitle line. */
  renderSubtitleLeading?: () => ReactNode;
  /** The item's own mark (agent, folder, file). */
  renderMark?: (size: number) => ReactNode;
}>;

export function HappierReleasePreviewCard(props: Readonly<{
  identity: HappierReleasePreviewIdentity;
  /** `null` while nothing under the pointer would take the item: the card shows only what it carries. */
  outcome: HappierReleaseOutcome | null;
  colors: HappierReleasePreviewColors;
  host: HappierReleasePreviewHost;
  density?: HappierReleasePreviewDensity;
  /** Which side of the pointer the card sits on; it leans away from the pointer. */
  side?: 'right' | 'left';
  reducedMotion?: boolean;
  testID?: string;
  style?: HappierStyleProp;
}> & ReleaseMaterialProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  const reducedMotion = props.reducedMotion ?? accessibility?.reducedMotion ?? false;
  const density = props.density ?? 'pointer';
  const metrics = METRICS[density];
  const progress = useEnterProgress(reducedMotion);
  const { identity, colors, host } = props;
  const Text = host.Text;
  const tilt = reducedMotion || density === 'touch' ? 0 : (props.side === 'left' ? -CARRIED_TILT_DEG : CARRIED_TILT_DEG);
  return (
    <Animated.View
      testID={props.testID}
      pointerEvents="none"
      {...({ dataSet: { outcome: props.outcome?.tone ?? 'none' } } as Record<string, unknown>)}
      style={[
        {
          ...(metrics.width !== undefined ? { width: metrics.width } : {}),
          opacity: progress,
          transform: [
            { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [ENTER_FROM_SCALE, 1] }) },
            { rotate: `${tilt}deg` },
          ],
        },
        props.style,
      ] as HappierStyleProp}
    >
      <HappierMaterialSurface materialRole="floating" finishRole="floating" gradient={props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={floatingChrome(colors, metrics.radius)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: metrics.idGap, paddingHorizontal: metrics.padX, paddingVertical: metrics.idPadY }}>
        {identity.renderMark ? (
          <View style={{ width: metrics.mark, height: metrics.mark, alignItems: 'center', justifyContent: 'center' }}>
            {identity.renderMark(metrics.mark - 3)}
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ ...metrics.title, color: colors.text }}>{identity.title}</Text>
          {identity.subtitle ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, minWidth: 0 }}>
              {identity.renderSubtitleLeading?.() ?? null}
              <Text numberOfLines={1} style={{ ...metrics.subtitle, color: colors.textSecondary }}>{identity.subtitle}</Text>
            </View>
          ) : null}
        </View>
      </View>
      {props.outcome ? (
        <HappierReleaseOutcomeStrip outcome={props.outcome} colors={colors} host={host} density={density} reducedMotion={reducedMotion} divided />
      ) : null}
      </HappierMaterialSurface>
    </Animated.View>
  );
}

export function HappierReleaseOutcomePill(props: Readonly<{
  outcome: HappierReleaseOutcome;
  colors: HappierReleasePreviewColors;
  host: HappierReleasePreviewHost;
  reducedMotion?: boolean;
  testID?: string;
  style?: HappierStyleProp;
}> & ReleaseMaterialProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  const progress = useEnterProgress(props.reducedMotion ?? accessibility?.reducedMotion ?? false);
  return (
    <Animated.View
      testID={props.testID}
      pointerEvents="none"
      style={[
        { maxWidth: HAPPIER_RELEASE_PREVIEW_METRICS.pillMaxWidth, alignSelf: 'flex-start', opacity: progress },
        props.style,
      ] as HappierStyleProp}
    >
      <HappierMaterialSurface materialRole="floating" finishRole="floating" gradient={props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={floatingChrome(props.colors, FLOATING_RADIUS)}>
      <HappierReleaseOutcomeStrip outcome={props.outcome} colors={props.colors} host={props.host} reducedMotion={props.reducedMotion} />
      </HappierMaterialSurface>
    </Animated.View>
  );
}

export type HappierStagedMoveHint = Readonly<{
  /** Key caps, already localized where a key has a name ("esc"). */
  keys: readonly string[];
  label: string;
}>;

export function HappierStagedMoveDock(props: Readonly<{
  outcome: HappierReleaseOutcome;
  hints: readonly HappierStagedMoveHint[];
  colors: HappierReleasePreviewColors;
  host: HappierReleasePreviewHost;
  reducedMotion?: boolean;
  testID?: string;
  style?: HappierStyleProp;
}> & ReleaseMaterialProps) {
  const accessibility = useOptionalHappierUiAccessibility();
  const progress = useEnterProgress(props.reducedMotion ?? accessibility?.reducedMotion ?? false);
  const { colors, host } = props;
  const Text = host.Text;
  return (
    <Animated.View
      testID={props.testID}
      pointerEvents="none"
      style={[
        { opacity: progress },
        props.style,
      ] as HappierStyleProp}
    >
      <HappierMaterialSurface materialRole="floating" finishRole="floating" gradient={props.gradient} renderMaterialSurface={props.renderMaterialSurface} style={floatingChrome(colors, FLOATING_RADIUS)}>
      <HappierReleaseOutcomeStrip outcome={props.outcome} colors={colors} host={host} reducedMotion={props.reducedMotion} />
      {props.hints.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: HINT_METRICS.columnGap,
            rowGap: HINT_METRICS.rowGap,
            paddingHorizontal: HINT_METRICS.padX,
            paddingTop: HINT_METRICS.padTop,
            paddingBottom: HINT_METRICS.padBottom,
            borderTopWidth: 1,
            borderTopColor: colors.divider,
          }}
        >
          {props.hints.map((hint) => (
            <View key={`${hint.keys.join('+')}:${hint.label}`} style={{ flexDirection: 'row', alignItems: 'center', gap: HINT_METRICS.itemGap }}>
              {hint.keys.map((key) => (
                <View
                  key={key}
                  style={{
                    minWidth: HINT_METRICS.keycap.size,
                    height: HINT_METRICS.keycap.size,
                    paddingHorizontal: HINT_METRICS.keycap.padX,
                    borderRadius: HINT_METRICS.keycap.radius,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: colors.keycapFill,
                  }}
                >
                  <Text style={{ ...HINT_METRICS.keyText, color: colors.text }}>{key}</Text>
                </View>
              ))}
              <Text style={{ ...HINT_METRICS.label, color: colors.textSecondary }}>{hint.label}</Text>
            </View>
          ))}
        </View>
      ) : null}
      </HappierMaterialSurface>
    </Animated.View>
  );
}
