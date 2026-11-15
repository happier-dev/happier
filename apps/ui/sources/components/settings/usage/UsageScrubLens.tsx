import * as React from 'react';
import {
  Pressable,
  ScrollView,
  View,
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
import { Popover } from '@/components/ui/popover';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useDeviceType, usePresentationWindowDimensions } from '@/utils/platform/responsive';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand, type CurrentUiContextCommandInvocation } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { t } from '@/text';

import {
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
 * Interaction-driven: nothing here animates on its own, so reduced motion changes nothing but the
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
  onPress?: (context?: ActionExecutorContext, invocation?: CurrentUiContextCommandInvocation) => boolean | void | Promise<boolean | void>;
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
  /** Stable chart identity for its mounted commands; never includes a sampled value. */
  label?: string;
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
const LENS_ANCHOR_WIDTH = 2;
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

// Native gesture hosts retain callbacks beyond unmount. Build them outside the
// render frame so Hermes cannot keep resolveContent and its chart data alive.
function createScrubGesture(
  layoutRef: React.RefObject<Layout>,
  lastIndexRef: React.RefObject<number | null>,
  commandsRef: React.RefObject<ReturnType<typeof useCurrentUiContextLocalCommands>>,
) {
  const followPointer = (x: number, input: 'hover' | 'scrub') => {
    const index = cellAt(x, layoutRef.current);
    if (index !== null && index !== lastIndexRef.current) void commandsRef.current.invoke('values', { bucket: index, mode: input });
  };
  const followScrub = (x: number) => followPointer(x, 'scrub');
  const followHover = (x: number) => followPointer(x, 'hover');
  const releasePointer = () => { void commandsRef.current.invoke('dismiss', 'release'); };
  const toggleHold = (x: number) => {
    const index = cellAt(x, layoutRef.current);
    if (index !== null) void commandsRef.current.invoke('values', { bucket: index, mode: 'toggle' });
  };
  const pan = Gesture.Pan()
    .activateAfterLongPress(LONG_PRESS_MS)
    .onStart((event) => {
      runOnJS(followScrub)(event.x);
    })
    .onUpdate((event) => {
      runOnJS(followScrub)(event.x);
    })
    .onFinalize(() => {
      runOnJS(releasePointer)();
    });
  const tap = Gesture.Tap()
    .maxDuration(220)
    .onEnd((event) => {
      runOnJS(toggleHold)(event.x);
    });
  const hover = Gesture.Hover()
    .onBegin((event) => {
      runOnJS(followHover)(event.x);
    })
    .onUpdate((event) => {
      runOnJS(followHover)(event.x);
    })
    .onFinalize(() => {
      runOnJS(releasePointer)();
    });
  return Gesture.Simultaneous(hover, Gesture.Exclusive(pan, tap));
}

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
  lensAnchor: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: LENS_ANCHOR_WIDTH,
  },
  lensBody: {
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    gap: theme.space.s6,
  },
  lensHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.s8,
    paddingBottom: theme.space.s2,
  },
  lensTitle: {
    flexShrink: 1,
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
  },
  lensRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    minHeight: 16,
  },
  lensRowHeld: {
    marginHorizontal: -6,
    paddingHorizontal: theme.space.s6,
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
    flex: 1,
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  lensLabelSelected: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  lensValue: {
    ...Typography.variant('meta', 'semiBold'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  lensFooter: {
    ...Typography.variant('micro'),
    paddingTop: theme.space.s2,
    color: theme.colors.text.tertiary,
  },
}));

export const ScrubLens: React.FC<ScrubLensProps> = ({
  label,
  layout,
  resolveContent,
  accentColor,
  focusIndex = null,
  children,
  style,
  testID,
}) => {
  useUnistyles();
  const tooltipId = React.useId();
  // On a phone the lens takes the screen's width inside the page gutters, under the crosshair, so its
  // rows keep their names whole; beside a wide chart it stays a narrow card next to the crosshair.
  const phone = useDeviceType() === 'phone';
  const windowWidth = usePresentationWindowDimensions().width;
  const lensWidth = phone
    ? Math.min(HAPPIER_PAGE_METRICS.dialogWidthPx.narrow, windowWidth - 2 * HAPPIER_PAGE_METRICS.sheetInsetPx)
    : LENS_WIDTH;
  const motion = useMotionPreferences();
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const [heldIndex, setHeldIndex] = React.useState<number | null>(null);
  const lastIndexRef = React.useRef<number | null>(null);
  // Read from gesture callbacks without re-creating the gestures.
  const layoutRef = React.useRef(layout);
  layoutRef.current = layout;
  const heldRef = React.useRef(heldIndex);
  heldRef.current = heldIndex;
  const count = cellCount(layout);
  const buckets = React.useMemo(() => Array.from({ length: count }, (_, index) => resolveContent(index)), [count, resolveContent]);

  // A held bucket that no longer exists (a period change) is let go rather than pointing elsewhere.
  React.useEffect(() => {
    if (heldIndex !== null && heldIndex >= count) setHeldIndex(null);
  }, [heldIndex, count]);

  const hapticsEnabled = motion.hapticsEnabled;
  const follow = React.useCallback(
    (index: number, detent: boolean) => {
      if (index === lastIndexRef.current) return;
      if (detent && lastIndexRef.current !== null)
        instrumentSelectionTick(hapticsEnabled);
      lastIndexRef.current = index;
      setActiveIndex(index);
    },
    [hapticsEnabled],
  );
  const release = React.useCallback(() => {
    lastIndexRef.current = null;
    setActiveIndex(null);
  }, []);
  // The press that let a held lens go may be a tap on its own bucket: that tap is the letting go, not a new hold.
  const letGoRef = React.useRef<{ index: number; at: number } | null>(null);
  const letGo = React.useCallback(() => {
    if (heldRef.current !== null) letGoRef.current = { index: heldRef.current, at: Date.now() };
    setHeldIndex(null);
  }, []);
  const hold = React.useCallback((index: number) => {
    const letGone = letGoRef.current;
    letGoRef.current = null;
    if (letGone?.index === index && Date.now() - letGone.at < 400) return;
    setHeldIndex(heldRef.current === index ? null : index);
  }, []);

  // A hold stays put so its rows can be reached; otherwise the pointer leads, then keyboard focus.
  const shownIndex =
    heldIndex ??
    activeIndex ??
    (focusIndex !== null && focusIndex < count ? focusIndex : null);
  const content = shownIndex !== null ? buckets[shownIndex] ?? null : null;
  const held = shownIndex !== null && shownIndex === heldIndex;
  // Chart-owned focus stays with the chart; this lens dismisses its own hover and held selections.
  const localSelectionActive = heldIndex !== null || activeIndex !== null;
  const commandTitle = (title: string) => label ? `${label}: ${title}` : title;
  // Declarations describe operations, not samples. The mounted command owner keeps their
  // ids stable while routing invocation to these latest bucket/selection closures.
  const definitions: CurrentUiContextLocalCommand[] = [{
    key: 'values', title: commandTitle(t('usage.board.charts.commandValues')),
    description: t('usage.board.charts.commandValuesInput'),
    invoke: input => {
      if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) return false;
      const index = input?.bucket;
      const mode = input?.mode ?? 'read';
      if (mode !== 'read' && mode !== 'select' && mode !== 'hover' && mode !== 'scrub' && mode !== 'toggle') return false;
      if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index) || !buckets[index])) return false;
      if (index === undefined && mode !== 'read') return false;
      if (typeof index === 'number') {
        if (mode === 'hover' || mode === 'scrub') follow(index, mode === 'scrub');
        else if (mode === 'toggle') hold(index);
        else if (mode === 'select') setHeldIndex(index);
      }
      const readBucket = (bucket: ScrubLensContent, bucketIndex: number) => ({
        index: bucketIndex, title: bucket.title,
        ...(bucket.total !== undefined ? { total: bucket.total } : {}),
        ...(bucket.footer !== undefined ? { footer: bucket.footer } : {}),
        rows: bucket.rows.map(row => ({ id: row.id ?? row.label, label: row.label, value: row.value,
          selectable: Boolean(row.onPress), ...(row.pressLabel !== undefined ? { pressLabel: row.pressLabel } : {}),
          ...(row.selected !== undefined ? { selected: row.selected } : {}) })),
      });
      const values = typeof index === 'number' ? [readBucket(buckets[index]!, index)]
        : buckets.flatMap((bucket, bucketIndex) => bucket ? [readBucket(bucket, bucketIndex)] : []);
      return { ok: true, result: { buckets: values } };
    },
  }, {
    key: 'dismiss', title: commandTitle(t('common.close')),
    invoke: input => {
      release();
      if (input !== 'release') letGo();
    },
  }, {
    key: 'choose', title: commandTitle(t('usage.board.charts.commandChoose')),
    description: t('usage.board.charts.commandChooseInput'),
    invoke: (input, context, invocation) => {
      if (!held || !content || input === null || typeof input !== 'object' || Array.isArray(input)) return false;
      const row = content.rows.find(row => (row.id ?? row.label) === input.row);
      return row?.onPress ? row.onPress(context, invocation) : false;
    },
  }];
  const commands = useCurrentUiContextLocalCommands(definitions);
  const commandsRef = React.useRef(commands);
  commandsRef.current = commands;
  const gesture = React.useMemo(() => createScrubGesture(layoutRef, lastIndexRef, commandsRef), []);
  const anchorX =
    shownIndex !== null ? cellCenter(shownIndex, layout) : 0;
  // The crosshair anchors the lens. Each bucket is a new anchor, so the popover re-places beside it.
  const crosshairRef = React.useMemo(
    () => React.createRef<View>(),
    [shownIndex],
  );

  return (
    // Web: the page keeps its vertical scroll over the plot; a held horizontal drag is the scrub.
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <View
        testID={testID}
        aria-describedby={content ? tooltipId : undefined}
        style={[styles.container, style]}
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
            {/* The popover's anchor: the crosshair's span (a 1px view is not a measurable anchor). */}
            <View
              ref={crosshairRef}
              collapsable={false}
              pointerEvents="none"
              style={[styles.lensAnchor, { left: anchorX - LENS_ANCHOR_WIDTH / 2 }]}
            />
            {/* Floats above every card and clip: beside the crosshair while it fits, before it otherwise,
                inside the window always. Passive while it follows the pointer; its rows take presses
                only once held. */}
            <Popover
              open
              anchorRef={crosshairRef}
              backdrop={false}
              passive={!held}
              dismissWhenAnchorHidden={localSelectionActive}
              onRequestClose={localSelectionActive ? () => { void commands.invoke('dismiss'); } : undefined}
              // A held lens lets go on Escape or a press anywhere else; that press still lands (a bucket holds anew).
              {...(held ? { consumeOutsidePointerDown: false } : {})}
              placement={phone ? 'bottom' : 'right'}
              gap={LENS_GAP}
              maxWidthCap={lensWidth}
              minWidth={lensWidth}
              edgePadding={{ vertical: LENS_GAP }}
              portal={{
                web: true,
                native: true,
                matchAnchorWidth: false,
                anchorAlignVertical: 'start',
                sizeToContent: true,
              }}
            >
              {({ maxHeight, maxWidth }) => (
              <InstrumentCard
                variant="popover"
                style={{ width: Math.min(lensWidth, maxWidth), maxHeight }}
                testID={testID ? `${testID}-lens` : undefined}
              >
                <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
                <View style={styles.lensBody} accessibilityLiveRegion="polite" nativeID={tooltipId} role="tooltip">
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
                        onPress={() => { void commands.invoke('choose', { row: key }); }}
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
                </ScrollView>
              </InstrumentCard>
              )}
            </Popover>
          </>
        ) : null}
      </View>
    </GestureDetector>
  );
};
