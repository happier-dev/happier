import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_COLLECTION_LIST_METRICS,
  HappierPressable,
  happierDiscretePressStyle,
  happierPressTransitionStyle,
} from '@happier-dev/plugin-ui/presentation';

import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import {
  orderedBotAccessibilityLabel,
  useOrderedBotNames,
  useOrderedBots,
} from '@/components/sessions/bots/botsSummary';
import { BotFaceMarker } from '@/components/sessions/bots/BotFaceMarker';
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useHorizontalScrollEdgeMask } from '@/components/ui/scroll/useHorizontalScrollEdgeMask';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';

import { HomeHubReadingColumn } from './HomeHubSectionList';

/**
 * Where the row of faces stands. `home` is phone Home's row under the greeting (lab mnBots B); `column` is the
 * Bots rail at the top of the desktop session list and `phoneList` the same rail on the phone's Sessions tab
 * (lab session-orchestration L1): compact faces in fixed cells with names on up to two lines, so five Bots read
 * whole and the sixth sits half under the edge fade.
 */
export type HomeBotFacesPresentation = 'home' | 'column' | 'phoneList';

type FacesMetrics = Readonly<{ facePx: number; cellPx: number; nameLines: 1 | 2 }>;

const FACES_METRICS: Readonly<Record<HomeBotFacesPresentation, FacesMetrics>> = {
  home: { facePx: 44, cellPx: 60, nameLines: 1 },
  column: { facePx: 28, cellPx: 52, nameLines: 2 },
  phoneList: { facePx: 30, cellPx: 62, nameLines: 2 },
};

const MICRO_LINE_HEIGHT_PX = Number(Typography.variant('micro').lineHeight ?? 0);

/** The edge fade over a cut-off face: wide enough that the half face reads as "more", never as the end. */
const RAIL_FADE_PX = 36;

/**
 * The row of Bot faces: every Bot in roster order, one tap to its conversation, sideways when more faces than
 * fit, ending in All Bots (the one roster). The person turns it off in Appearance or the list's View menu; off, or
 * while its surface is not presented, nothing here reads the Bot projection.
 */
export const HomeBotFaces = React.memo(function HomeBotFaces(
  props: Readonly<{ visible?: boolean; presentation?: HomeBotFacesPresentation }>,
) {
  const enabled = useSetting('homeBotFacesEnabled') !== false;
  const visible = props.visible ?? true;
  // A surface that is not presented (a background tab, a hidden pane) reads no Bots; presented again, the
  // ordered projection is already in the store, so the faces come back in the same frame.
  const bots = useOrderedBots(enabled && visible);
  if (!enabled || bots.length === 0) return null;
  const presentation = props.presentation ?? 'home';
  const row = <HomeBotFacesRow bots={bots} visible={visible} presentation={presentation} />;
  if (presentation !== 'home') return row;
  return (
    <HomeHubReadingColumn>
      {/* On the reading column's edges, like the brief's entry under it. */}
      <ItemGroup surface="none">{row}</ItemGroup>
    </HomeHubReadingColumn>
  );
});

function HomeBotFacesRow(
  props: Readonly<{ bots: readonly OrderedBot[]; visible: boolean; presentation: HomeBotFacesPresentation }>,
) {
  const { bots, visible, presentation } = props;
  const metrics = FACES_METRICS[presentation];
  const names = useOrderedBotNames(bots);
  const navigateToSession = useNavigateToSession();
  const roster = useOptionalBotsRosterRuntime();
  const rail = presentation !== 'home';
  const mask = useHorizontalScrollEdgeMask({ fadePx: RAIL_FADE_PX, style: rail ? styles.railScroller : undefined });
  return mask.wrapScroller(
    <ScrollView
      testID="home-bot-faces"
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel={t('bots.title')}
      style={mask.scrollerStyle}
      contentContainerStyle={rail ? styles.railRow : styles.row}
      onScroll={mask.onScroll}
      onLayout={mask.onViewportLayout}
      onContentSizeChange={mask.onContentSizeChange}
      scrollEventThrottle={16}
    >
      {bots.map((bot, index) => {
        const name = names[index] ?? '';
        return (
          <FaceCell
            key={bot.key}
            testID={`home-bot-faces.${bot.key}`}
            accessibilityLabel={orderedBotAccessibilityLabel(bot, name)}
            onPress={() => {
              void navigateToSession(bot.sessionId, { serverId: bot.serverId });
            }}
            metrics={metrics}
            rail={rail}
            name={name}
            emphasized={rail && bot.activity === 'needsYou'}
          >
            {/* The face says working with its mouth; needs-you adds the attention dot, as every row of faces does. */}
            <BotFaceMarker
              facts={bot.face}
              size={metrics.facePx}
              activity={bot.activity}
              motion
              visible={visible}
              testID={`home-bot-faces.${bot.key}.face`}
            />
          </FaceCell>
        );
      })}
      {roster ? (
        <FaceCell
          testID="home-bot-faces.all"
          accessibilityLabel={t('bots.roster.all')}
          onPress={roster.open}
          metrics={metrics}
          rail={rail}
          name={t('bots.roster.all')}
          emphasized={false}
        >
          <AllBotsMark sizePx={metrics.facePx} />
        </FaceCell>
      ) : null}
    </ScrollView>,
  );
}

function FaceCell(
  props: Readonly<{
    testID: string;
    accessibilityLabel: string;
    onPress: () => void;
    metrics: FacesMetrics;
    /** The list rail's cells carry a hover chip; phone Home's faces stand on their own. */
    rail: boolean;
    name: string;
    emphasized: boolean;
    children: React.ReactNode;
  }>,
) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const { metrics } = props;
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={props.onPress}
      style={(state) => [
        props.rail ? styles.railCell : styles.homeCell,
        { width: metrics.cellPx },
        state.hovered ? styles.cellHovered : null,
        happierPressTransitionStyle(state.pressed, ['transform', 'background-color'], reducedMotion),
        happierDiscretePressStyle(state.pressed, reducedMotion),
        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
      ]}
    >
      {props.children}
      <Text
        variant="micro"
        emphasis={props.emphasized ? 'medium' : undefined}
        numberOfLines={metrics.nameLines}
        style={[
          styles.name,
          props.emphasized ? styles.nameEmphasized : null,
          // Two-line names keep both lines' height, so a short name never lifts its face off the row's line.
          metrics.nameLines === 2 ? styles.nameTwoLines : null,
        ]}
      >
        {props.name}
      </Text>
    </HappierPressable>
  );
}

/** All Bots stands where a face would, as a quiet round mark, so the row ends on the roster instead of a count. */
function AllBotsMark(props: Readonly<{ sizePx: number }>) {
  const { theme } = useUnistyles();
  return (
    <View style={[styles.allBots, { width: props.sizePx, height: props.sizePx, borderRadius: props.sizePx / 2 }]}>
      <Icon name={BOTS_GLYPH} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    gap: theme.space.s12,
    paddingVertical: theme.space.s8,
  },
  // The rail sits on the list's row gutter, so a face's hover chip lines up with the rows' chips under it.
  railScroller: {
    marginHorizontal: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
    flexGrow: 0,
  },
  // No hairline under the rail: the space before the first group separates it (lab L1).
  railRow: {
    flexDirection: 'row',
    paddingTop: theme.space.s2,
    paddingBottom: theme.space.s8,
  },
  homeCell: {
    alignItems: 'center',
    gap: theme.space.s4,
  },
  railCell: {
    alignItems: 'center',
    gap: theme.space.s4,
    paddingTop: theme.space.s6,
    paddingBottom: theme.space.s4,
    paddingHorizontal: theme.space.s2,
    borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
  },
  cellHovered: {
    backgroundColor: theme.colors.surface.hover,
  },
  name: {
    color: theme.colors.text.secondary,
    // The name keeps to its face's cell and truncates there, so neighbours never overlap.
    alignSelf: 'stretch',
    textAlign: 'center',
  },
  nameEmphasized: {
    color: theme.colors.text.primary,
  },
  nameTwoLines: {
    minHeight: 2 * MICRO_LINE_HEIGHT_PX,
  },
  allBots: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.elevated,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
  },
}));
