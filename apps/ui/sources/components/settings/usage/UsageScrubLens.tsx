import * as React from 'react';
import {
  Pressable,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  InstrumentCard,
  instrumentSelectionTick,
  useMotionPreferences,
} from '@/components/instrument';

import {
  placeLensBeside,
  resolveScrubIndex,
  resolveScrubIndexAt,
  scrubCellCenterX,
  type ScrubCenters,
  type ScrubRowLayout,
} from './usageScrubMath';

/**
 * The all-series lens for bucket charts (lab `kitstates` "Scrub lens"): a hairline crosshair on the
 * bucket under the pointer and a floating card beside it with every series' exact value.
 *
 * - Pointer: it follows hover.
 * - Touch: hold ~300ms then drag; one selection haptic per bucket crossed (motion-gated by the kit).
 * - A tap holds the lens on that bucket so its rows can be chosen (a drill); tapping the held bucket
 *   again lets it go.
 * - Keyboard: the chart's own bucket selection shows the same lens where the viewer is reading.
 *
 * Purely gesture-driven: nothing here animates on its own, so reduced motion changes nothing but the
 * haptic. It mounts either around a chart (`children`) or as an overlay on a plot (no children).
 */

export type ScrubLensRow = Readonly<{
  /** Stable identity; defaults to the label. */
  id?: string;
  label: string;
  value: string;
  /** The series' own colour, shown as its key. */
  color?: string;
  /** Choosing the row while the lens is held, with the localized name of that choice. */
  onPress?: () => void;
  pressLabel?: string;
  selected?: boolean;
}>;

export type ScrubLensContent = Readonly<{
  title: string;
  /** The bucket's own total beside its name, when every part of it is known. */
  total?: string;
  rows: ReadonlyArray<ScrubLensRow>;
  /** What the numbers mean (cost basis, coverage), said once under them. */
  footer?: string;
}>;

export type ScrubLensProps = Readonly<{
  /** A fixed cell row, or a chart's own bucket centres. */
  layout: ScrubRowLayout | ScrubCenters;
  resolveContent: (index: number) => ScrubLensContent | null;
  /** Crosshair colour, from theme tokens. */
  accentColor: string;
  /** The chart's own selected bucket (keyboard focus); shown when no pointer or hold says otherwise. */
  focusIndex?: number | null;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}>;

const LENS_WIDTH = 184;
const LENS_GAP = 8;
const LONG_PRESS_MS = 300;

type Layout = ScrubRowLayout | ScrubCenters;
const cellCount = (layout: Layout) =>
  'centers' in layout ? layout.centers.length : layout.count;
const cellAt = (x: number, layout: Layout) =>
  'centers' in layout
    ? resolveScrubIndexAt(x, layout)
    : resolveScrubIndex(x, layout);
const cellCenter = (index: number, layout: Layout) =>
  'centers' in layout
    ? (layout.centers[index] ?? 0)
    : scrubCellCenterX(index, layout);

const styles = StyleSheet.create((theme) => ({
  container: {
    position: 'relative',
  },
  crosshair: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    opacity: 0.85,
  },
  lens: {
    position: 'absolute',
    top: 4,
    width: LENS_WIDTH,
  },
  lensBody: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  lensHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    paddingBottom: 2,
  },
  lensTitle: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.primary,
  },
  lensRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 16,
  },
  lensRowHeld: {
    marginHorizontal: -6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
  },
  lensRowActive: {
    backgroundColor: theme.colors.surface.inset,
  },
  lensKey: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  lensLabel: {
    ...Typography.default(),
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.secondary,
  },
  lensLabelSelected: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  lensValue: {
    ...Typography.default('semiBold'),
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  lensFooter: {
    ...Typography.default(),
    fontSize: 11,
    lineHeight: 14,
    paddingTop: 2,
    color: theme.colors.text.tertiary,
  },
}));

export const ScrubLens: React.FC<ScrubLensProps> = ({
  layout,
  resolveContent,
  accentColor,
  focusIndex = null,
  children,
  style,
  testID,
}) => {
  useUnistyles();
  const motion = useMotionPreferences();
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const [heldIndex, setHeldIndex] = React.useState<number | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const lastIndexRef = React.useRef<number | null>(null);
  // Read from gesture callbacks without re-creating the gestures.
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const heldRef = React.useRef(heldIndex);
  heldRef.current = heldIndex;
  const rowPressAtRef = React.useRef(0);
  const count = cellCount(layout);

  // A held bucket that no longer exists (a period change) is let go rather than pointing elsewhere.
  React.useEffect(() => {
    if (heldIndex !== null && heldIndex >= count) setHeldIndex(null);
  }, [heldIndex, count]);

  const onContainerLayout = React.useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width);
  }, []);

  const hapticsEnabled = motion.hapticsEnabled;
  const follow = React.useCallback(
    (x: number, detent: boolean) => {
      const index = cellAt(x, layoutRef.current);
      if (index === null || index === lastIndexRef.current) return;
      if (detent && lastIndexRef.current !== null)
        instrumentSelectionTick(hapticsEnabled);
      lastIndexRef.current = index;
      setActiveIndex(index);
    },
    [hapticsEnabled],
  );
  const followScrub = React.useCallback(
    (x: number) => follow(x, true),
    [follow],
  );
  const followHover = React.useCallback(
    (x: number) => follow(x, false),
    [follow],
  );
  const release = React.useCallback(() => {
    lastIndexRef.current = null;
    setActiveIndex(null);
  }, []);
  const hold = React.useCallback((x: number) => {
    // A press on one of the held lens' own rows is that row's, not a new hold.
    if (Date.now() - rowPressAtRef.current < 400) return;
    const index = cellAt(x, layoutRef.current);
    if (index === null) return;
    setHeldIndex(heldRef.current === index ? null : index);
  }, []);

  const gesture = React.useMemo(() => {
    const pan = Gesture.Pan()
      .activateAfterLongPress(LONG_PRESS_MS)
      .onStart((event) => {
        runOnJS(followScrub)(event.x);
      })
      .onUpdate((event) => {
        runOnJS(followScrub)(event.x);
      })
      .onFinalize(() => {
        runOnJS(release)();
      });
    const tap = Gesture.Tap()
      .maxDuration(220)
      .onEnd((event) => {
        runOnJS(hold)(event.x);
      });
    const hover = Gesture.Hover()
      .onBegin((event) => {
        runOnJS(followHover)(event.x);
      })
      .onUpdate((event) => {
        runOnJS(followHover)(event.x);
      })
      .onFinalize(() => {
        runOnJS(release)();
      });
    return Gesture.Simultaneous(hover, Gesture.Exclusive(pan, tap));
  }, [followHover, followScrub, hold, release]);

  // A hold stays put so its rows can be reached; otherwise the pointer leads, then keyboard focus.
  const shownIndex =
    heldIndex ??
    activeIndex ??
    (focusIndex !== null && focusIndex < count ? focusIndex : null);
  const content = shownIndex !== null ? resolveContent(shownIndex) : null;
  const held = shownIndex !== null && shownIndex === heldIndex;
  const anchorX =
    shownIndex !== null ? cellCenter(shownIndex, layout) : 0;
  const lensLeft = placeLensBeside(
    anchorX,
    LENS_WIDTH,
    containerWidth || anchorX + LENS_GAP + LENS_WIDTH,
    LENS_GAP,
  );

  return (
    // Web: the page keeps its vertical scroll over the plot; a held horizontal drag is the scrub.
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        testID={testID}
        style={[styles.container, style]}
        onLayout={onContainerLayout}
      >
        {children}
        {shownIndex !== null && content ? (
          <>
            <View
              pointerEvents="none"
              style={[
                styles.crosshair,
                { left: anchorX - 0.5, backgroundColor: accentColor },
              ]}
            />
            {/* Passive while it follows the pointer; its rows take presses only once held. */}
            <View
              pointerEvents={held ? 'box-none' : 'none'}
              style={[styles.lens, { left: lensLeft }]}
            >
              <InstrumentCard
                variant="popover"
                testID={testID ? `${testID}-lens` : undefined}
              >
                <View style={styles.lensBody} accessibilityLiveRegion="polite">
                  <View style={styles.lensHead}>
                    <Text style={styles.lensTitle} numberOfLines={1}>
                      {content.title}
                    </Text>
                    {content.total ? (
                      <Text style={styles.lensValue} numberOfLines={1}>
                        {content.total}
                      </Text>
                    ) : null}
                  </View>
                  {content.rows.map((row) => {
                    const key = row.id ?? row.label;
                    const body = (
                      <>
                        {row.color ? (
                          <View
                            style={[
                              styles.lensKey,
                              { backgroundColor: row.color },
                            ]}
                          />
                        ) : null}
                        <Text
                          style={[
                            styles.lensLabel,
                            row.selected ? styles.lensLabelSelected : null,
                          ]}
                          numberOfLines={1}
                        >
                          {row.label}
                        </Text>
                        <Text style={styles.lensValue} numberOfLines={1}>
                          {row.value}
                        </Text>
                      </>
                    );
                    return held && row.onPress ? (
                      <Pressable
                        key={key}
                        testID={
                          testID ? `${testID}-lens-row-${key}` : undefined
                        }
                        accessibilityRole="button"
                        accessibilityLabel={row.pressLabel ?? row.label}
                        onPressIn={() => {
                          rowPressAtRef.current = Date.now();
                        }}
                        onPress={row.onPress}
                        style={(state) => [
                          styles.lensRow,
                          styles.lensRowHeld,
                          state.pressed ||
                          (state as { hovered?: boolean }).hovered
                            ? styles.lensRowActive
                            : null,
                        ]}
                      >
                        {body}
                      </Pressable>
                    ) : (
                      <View key={key} style={styles.lensRow}>
                        {body}
                      </View>
                    );
                  })}
                  {content.footer ? (
                    <Text style={styles.lensFooter} numberOfLines={2}>
                      {content.footer}
                    </Text>
                  ) : null}
                </View>
              </InstrumentCard>
            </View>
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
};
