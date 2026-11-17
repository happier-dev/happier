import { HAPPIER_FRESHNESS_LINE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View, type ScrollViewProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { PluginUiScrollActivityProvider } from '@happier-dev/plugin-ui/advanced';
import { createScrollViewNearViewportTracker } from '@/components/widgets/nearViewport';

import {
  ActionListSection,
  type ActionListItem,
} from '@/components/ui/lists/ActionListSection';
import { useGlassSurfaceColor } from '@/components/ui/glass/useGlassSurfaceColor';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

const ROSTER_LIST_FADE_SIZE_PX = 18;

/**
 * The list's frame: it takes what the popover's height leaves after the header, any line above it and
 * the action rows (which vary with the freshness line and two-line actions), and scrolls inside it. Where
 * rows continue past an edge the list fades into the popover's own fill, so a row is never cut mid-text
 * against the rows beneath it without saying there is more.
 */
export function RailPopoverRosterList(
  props: Readonly<{ testID: string; children: React.ReactNode }>
    & Pick<ScrollViewProps, 'keyboardShouldPersistTaps'>,
) {
  const { theme } = useUnistyles();
  const fades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true } });
  const scrollRef = React.useRef<ScrollView>(null);
  const tracker = React.useMemo(() => createScrollViewNearViewportTracker(scrollRef, false, { overscan: false }), []);
  // The same fill the floating panel paints behind this list, so the fade dissolves into it.
  const fadeColor = useGlassSurfaceColor(theme.colors.edge.floatingFill, 'floating', false);
  return (
    <View style={styles.listHost}>
      <ScrollView
        ref={scrollRef}
        testID={props.testID}
        style={styles.list}
        keyboardShouldPersistTaps={props.keyboardShouldPersistTaps ?? 'always'}
        scrollEventThrottle={32}
        onLayout={event => { fades.onViewportLayout(event); tracker.onLayout(event); }}
        onContentSizeChange={(width, height) => { fades.onContentSizeChange(width, height); tracker.onContentSizeChange(width, height); }}
        onScroll={event => { fades.onScroll(event); tracker.onScroll(event); }}
        onMomentumScrollEnd={fades.onMomentumScrollEnd}
      >
        <PluginUiScrollActivityProvider tracker={tracker}>{props.children}</PluginUiScrollActivityProvider>
      </ScrollView>
      {(['Top', 'Bottom'] as const).map((edge) => {
        const visible = edge === 'Top' ? fades.visibility.top : fades.visibility.bottom;
        return (
          <View
            key={edge}
            testID={`${props.testID}.fade${edge}`}
            pointerEvents="none"
            style={[styles.fade, edge === 'Top' ? styles.fadeTop : styles.fadeBottom, { opacity: visible ? 1 : 0 }]}
          >
            <ScrollEdgeFades
              color={fadeColor}
              size={ROSTER_LIST_FADE_SIZE_PX}
              edges={edge === 'Top' ? { top: true } : { bottom: true }}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * The one anatomy of a rail roster popover (Bots, Machines): what it lists and a quiet summary of
 * those things on one line (or on a second header line), the list itself, a hairline, then the rows
 * that add to it. The list owns
 * its scrolling: put it in `RailPopoverRosterList` so it shrinks within `maxHeight`.
 */
export function RailPopoverRoster(
  props: Readonly<{
    testID: string;
    /** The popover's height: the header and the action rows stay whole, the list gives way. */
    maxHeight: number;
    title: string;
    /** What the listed things are doing, at the end of the title line. */
    summary?: React.ReactNode;
    /** A second header line under the title (Machines: presence and work counts, then All machines). */
    subheader?: React.ReactNode;
    children?: React.ReactNode;
    actions: ReadonlyArray<ActionListItem | null>;
  }>,
) {
  return (
    <View testID={props.testID} style={{ maxHeight: props.maxHeight }}>
      <View style={styles.header}>
        {/* A sentence title ("edge-1's system disk is nearly full") reads whole on two lines (F4). */}
        <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>
          {props.title}
        </Text>
        {props.summary}
      </View>
      {props.subheader ? (
        <View style={styles.subheader}>{props.subheader}</View>
      ) : null}
      {props.children}
      {/* A roster used to pick one of its things (choose a Bot) has no actions of its own beneath it. */}
      {props.actions.length > 0 ? <>
        <View style={styles.divider} />
        <ActionListSection style={styles.actions} actions={props.actions} />
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  listHost: { flexShrink: 1, minHeight: 0 },
  list: { flexShrink: 1, minHeight: 0 },
  fade: { position: 'absolute', left: 0, right: 0, height: ROSTER_LIST_FADE_SIZE_PX },
  fadeTop: { top: 0 },
  fadeBottom: { bottom: 0 },
  header: {
    flexDirection: 'row',
    // The trailing menu stays on the title's first line when the title wraps.
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  subheader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s6,
    // The line may become the freshness chip ("As of 10:42 · Retry"): the header keeps the chip's height so
    // nothing beneath it moves when the counts turn stale.
    minHeight: HAPPIER_FRESHNESS_LINE_METRICS.chip.minHeightPx + theme.space.s6,
  },
  title: {
    // The roster's name leads its rows: the section-title step, one above the rows' meta and summary line.
    flexShrink: 1,
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: theme.space.s12,
    backgroundColor: theme.colors.border.default,
  },
  actions: {
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s4,
  },
}));
