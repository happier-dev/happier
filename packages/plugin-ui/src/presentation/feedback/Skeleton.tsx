import { useContext, useEffect, useRef, type ReactNode } from 'react';
import { Animated, Platform, View, type ViewStyle } from 'react-native';

import { useOptionalHappierUiAccessibility, useOptionalHappierUiPalette } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierBodyEdgeContext } from '../layout/columnEdge.js';
import type { HappierDimension, HappierStyleProp } from '../portableTypes.js';

/**
 * The single implementation owner for Happier's loading skeleton (UI-T27).
 *
 * Extracted from `apps/ui/sources/components/ui/selectionList/SelectionListSkeletonRow.tsx`
 * with its measured behaviour intact — an opacity pulse between 0.4 and 0.8
 * over 800 ms in a yoyo loop, and a static 0.4 bar under reduced motion — so the
 * host's selection lists, the host's plugin-surface fallback and every plugin's
 * `LoadingState rows` draw one placeholder rather than three that drift.
 *
 * Web runs the pulse as a compositor CSS animation (`happierSkeletonPulse` in
 * `apps/ui/sources/theme.css`, beside the status-dot pulse); native runs it on
 * the native driver. Neither is a JavaScript-driven loop, and `animationEnabled`
 * lets a surface that is hidden or inactive stop it.
 */
export const HAPPIER_SKELETON_PULSE_V1 = Object.freeze({
  durationMs: 800,
  opacityLow: 0.4,
  opacityHigh: 0.8,
});

export type HappierSkeletonBlockProps = Readonly<{
  color: string;
  width: HappierDimension;
  height: number;
  radius?: number;
  /** Stops the pulse while the owning surface is hidden or inactive. */
  animationEnabled?: boolean;
  /** Resolved reduced-motion preference; defaults to the environment value. */
  reducedMotion?: boolean;
  style?: HappierStyleProp;
  testID?: string;
}>;

/** A loading shape's motion, shared by individual bars and composed placeholders. */
export type HappierSkeletonPulseProps = Readonly<{
  children?: ReactNode;
  animationEnabled?: boolean;
  reducedMotion?: boolean;
  style?: HappierStyleProp;
  testID?: string;
}>;

type WebPulseStyle = ViewStyle & {
  animationDirection?: 'alternate';
  animationDuration?: string;
  animationIterationCount?: string;
  animationName?: string;
  animationTimingFunction?: string;
};

const webPulseStyle: WebPulseStyle = {
  animationDirection: 'alternate',
  animationDuration: `${HAPPIER_SKELETON_PULSE_V1.durationMs}ms`,
  animationIterationCount: 'infinite',
  animationName: 'happierSkeletonPulse',
  animationTimingFunction: 'ease-in-out',
};

function blockStyle(props: HappierSkeletonBlockProps) {
  return {
    width: props.width,
    height: props.height,
    borderRadius: props.radius ?? Math.min(6, props.height / 2),
    backgroundColor: props.color,
  };
}

/** One pulsing placeholder bar. Always hidden from assistive technology. */
export function HappierSkeletonBlock(props: HappierSkeletonBlockProps) {
  return <HappierSkeletonPulse
    animationEnabled={props.animationEnabled}
    reducedMotion={props.reducedMotion}
    testID={props.testID}
    style={[blockStyle(props), props.style]}
  />;
}

/** Pulse an existing loading shape without scheduling React work on each web frame. */
export function HappierSkeletonPulse(props: HappierSkeletonPulseProps) {
  const environmentAccessibility = useOptionalHappierUiAccessibility();
  const reducedMotion = props.reducedMotion ?? environmentAccessibility?.reducedMotion ?? false;
  const animate = props.animationEnabled !== false && !reducedMotion;
  if (!animate) {
    return (
      <View
        testID={props.testID}
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ opacity: HAPPIER_SKELETON_PULSE_V1.opacityLow }, props.style]}
      >{props.children}</View>
    );
  }
  if (Platform.OS === 'web') {
    return (
      <View
        testID={props.testID}
        aria-hidden
        style={[{ opacity: HAPPIER_SKELETON_PULSE_V1.opacityHigh }, webPulseStyle, props.style]}
      >{props.children}</View>
    );
  }
  return <NativeSkeletonPulse {...props} />;
}

function NativeSkeletonPulse(props: HappierSkeletonPulseProps) {
  const opacity = useRef(new Animated.Value(HAPPIER_SKELETON_PULSE_V1.opacityLow)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: HAPPIER_SKELETON_PULSE_V1.opacityHigh,
          duration: HAPPIER_SKELETON_PULSE_V1.durationMs,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: HAPPIER_SKELETON_PULSE_V1.opacityLow,
          duration: HAPPIER_SKELETON_PULSE_V1.durationMs,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [opacity]);
  return (
    <Animated.View
      testID={props.testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ opacity }, props.style]}
    >{props.children}</Animated.View>
  );
}

/** Consecutive rows read as real content of different lengths, not a uniform bar. */
const SKELETON_TITLE_WIDTHS: readonly HappierDimension[] = ['62%', '48%', '71%', '55%', '66%', '44%'];
/** The meta line under a two-line row's title. */
const SKELETON_META_WIDTH: HappierDimension = '34%';
/** One quiet bar: the lab's thin line (8 px, radius 4), the same for title and meta. */
const SKELETON_BAR = Object.freeze({ height: 8, radius: 4 });
/** The glyph placeholder: the small glyph step, on the one small radius. */
const SKELETON_GLYPH = Object.freeze({ size: 16, radius: 4 });

/** Where a row's content sits: the host row's insets, glyph column and gap, so loaded rows land in place. */
export type HappierSkeletonRowGeometry = Readonly<{
  insetStart: number;
  insetEnd: number;
  /** The leading glyph column's width; `0` draws no glyph. */
  glyphColumn: number;
  /** The glyph square's size (the host's mark); defaults to the small glyph step. */
  glyphSize?: number;
  gap: number;
}>;

export type HappierSkeletonRowsProps = Readonly<{
  rows: number;
  theme: HappierUiTheme;
  /** The bars' ink. Omit it for the host palette's skeleton ink (or the snapshot's control fill). */
  color?: string;
  /** Each row's exact height (the collection's own row metric). Omit it for a two-line list row from the theme's roles. */
  rowHeight?: number;
  /**
   * A row that sizes like the host's own: its least height and vertical padding around the line boxes
   * (a page row, a navigation row). Used instead of `rowHeight`.
   */
  rowBox?: Readonly<{ minHeight: number; paddingVertical: number }>;
  /** `2` adds the quieter meta line under the title. Defaults to `2`. */
  lines?: 1 | 2;
  /**
   * The loaded row's line heights (title, then meta): each bar stands centred in its own line box, so the
   * row takes the loaded row's height. Its length sets the number of lines.
   */
  lineHeights?: readonly [number] | readonly [number, number];
  /** The hairline the collection draws: under each row, or only between rows (a page section's sheet). */
  dividerColor?: string;
  dividerPlacement?: 'below' | 'between';
  /** The first row's index, for a host that renders one placeholder row per virtualized cell. */
  firstIndex?: number;
  /** The host row's geometry. Omit it for the theme's list row (medium inset, small gap, glyph column). */
  geometry?: HappierSkeletonRowGeometry;
  /**
   * What is loading. Present: the placeholder is announced once as a busy
   * progress region with this name. Absent: it is decoration and hidden.
   */
  accessibilityLabel?: string;
  animationEnabled?: boolean;
  reducedMotion?: boolean;
  testID?: string;
  /** Each row's test id (or one per row index); defaults to `${testID}:skeleton-row`. */
  rowTestID?: string | ((index: number) => string | undefined);
  style?: HappierStyleProp;
}>;

/**
 * The one placeholder for rows that are coming (list columns, collections, loading states, pane
 * fallbacks): each row stands in its host's geometry — its height, insets, glyph column and hairline —
 * with a glyph square, a title bar of varied length and, for two-line rows, a quieter meta bar. Nothing
 * moves when the real rows land. The bars pulse through {@link HappierSkeletonBlock}.
 */
export function HappierSkeletonRows(props: HappierSkeletonRowsProps) {
  const { theme } = props;
  const palette = useOptionalHappierUiPalette(theme);
  const color = props.color ?? palette?.skeleton ?? theme.colors.control;
  const lineHeights = props.lineHeights;
  const lines = lineHeights?.length ?? props.lines ?? 2;
  const firstIndex = props.firstIndex ?? 0;
  const dividerPlacement = props.dividerPlacement ?? 'below';
  // The theme's list row stands on a widget body's edge (as `HappierListItem` does), so the real rows land in place.
  const bodyEdge = useContext(HappierBodyEdgeContext);
  const geometry = props.geometry ?? {
    insetStart: bodyEdge ? 0 : theme.spacing.medium,
    insetEnd: bodyEdge ? 0 : theme.spacing.medium,
    glyphColumn: SKELETON_GLYPH.size,
    gap: theme.spacing.small,
  };
  const rowSize = props.rowHeight !== undefined
    ? { height: props.rowHeight }
    : props.rowBox !== undefined
      ? { minHeight: props.rowBox.minHeight, paddingTop: props.rowBox.paddingVertical, paddingBottom: props.rowBox.paddingVertical }
      : { height: theme.typography.label.lineHeight + theme.typography.body.lineHeight + 2 * theme.spacing.small + theme.spacing.xsmall };
  const glyphSize = geometry.glyphSize ?? SKELETON_GLYPH.size;
  const rowTestID = props.rowTestID ?? (props.testID === undefined ? undefined : `${props.testID}:skeleton-row`);
  const rows = Array.from({ length: Math.max(0, Math.floor(props.rows)) }, (_, index) => firstIndex + index);
  const testIDFor = (index: number) => typeof rowTestID === 'function' ? rowTestID(index) : rowTestID;
  const bar = (index: number, line: 0 | 1) => (
    <HappierSkeletonBlock
      {...common}
      width={line === 0 ? SKELETON_TITLE_WIDTHS[index % SKELETON_TITLE_WIDTHS.length]! : SKELETON_META_WIDTH}
      height={SKELETON_BAR.height}
      radius={SKELETON_BAR.radius}
    />
  );
  const common = {
    color,
    ...(props.animationEnabled === undefined ? {} : { animationEnabled: props.animationEnabled }),
    ...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion }),
  };
  return (
    <View
      testID={props.testID}
      {...(props.accessibilityLabel
        ? {
            accessibilityRole: 'progressbar' as const,
            role: 'progressbar',
            accessibilityLabel: props.accessibilityLabel,
            'aria-label': props.accessibilityLabel,
            'aria-busy': true,
            accessibilityState: { busy: true },
          }
        : {
            'aria-hidden': true,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
          })}
      style={[{ width: '100%', minWidth: 0 }, props.style]}
    >
      {rows.map((index) => (
        <View
          key={index}
          {...(testIDFor(index) === undefined ? {} : { testID: testIDFor(index) })}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            ...rowSize,
            flexDirection: 'row',
            alignItems: 'center',
            gap: geometry.gap,
            paddingLeft: geometry.insetStart,
            paddingRight: geometry.insetEnd,
            ...(props.dividerColor === undefined ? {} : dividerPlacement === 'below'
              ? { borderBottomWidth: 1, borderBottomColor: props.dividerColor }
              : index > firstIndex ? { borderTopWidth: 1, borderTopColor: props.dividerColor } : {}),
          }}
        >
          {geometry.glyphColumn > 0 ? (
            <View style={{ width: geometry.glyphColumn, alignItems: 'flex-start', justifyContent: 'center' }}>
              <HappierSkeletonBlock {...common} width={glyphSize} height={glyphSize} radius={SKELETON_GLYPH.radius} />
            </View>
          ) : null}
          {lineHeights ? (
            <View style={{ flex: 1, minWidth: 0 }}>
              {lineHeights.map((lineHeight, line) => (
                <View key={line} style={{ height: lineHeight, justifyContent: 'center' }}>{bar(index, line === 0 ? 0 : 1)}</View>
              ))}
            </View>
          ) : (
            <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
              {bar(index, 0)}
              {lines === 2 ? bar(index, 1) : null}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}
