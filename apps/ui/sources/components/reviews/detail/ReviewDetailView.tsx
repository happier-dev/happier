import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierReviewGlanceLine, type HappierReviewGlance } from '@happier-dev/plugin-ui/presentation';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';

import type { ReviewRoundStateV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  type PageHeaderMetaFact,
  type PageHeaderPrimaryAction,
} from '@/components/ui/layout/PageHeader';
import {
  PageHeaderMenu,
  type PageHeaderMenuAction,
} from '@/components/ui/layout/PageHeaderEntityParts';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import {
  SegmentedTabBar,
  type SegmentedTab,
} from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { t } from '@/text';

export type ReviewDetailTabId = 'findings' | 'changes' | 'runs' | 'activity';

/** Someone or something that reviewed a round: an agent, an engine, a session or a person. */
export type ReviewDetailParticipant = Readonly<{
  id: string;
  label: string;
  /** The participant's own mark (agent icon, engine icon, avatar); never a tile. */
  mark: React.ReactNode | null;
  /** What they did in this round ("Finished", "Changes requested"); `null` says nothing. */
  state: string | null;
  /** `attention`: the state needs the person (waiting for you); `failed`: it didn't finish. */
  tone?: 'attention' | 'failed' | null;
  /** Required / Optional for a requested person. */
  qualifier?: string | null;
  /** Opened prose retained with this person's verdict. */
  body?: string;
}>;

/** One group of a round's reviewers (its agents and engines, or its people), drawn as one row. */
export type ReviewDetailRoundGroup = Readonly<{
  id: string;
  title: string;
  /** The group's state on the row's right ("Waiting for you"). */
  detail?: string | null;
  detailTone?: 'attention' | 'failed' | null;
  status: 'done' | 'running' | 'waiting' | 'failed';
  participants: readonly ReviewDetailParticipant[];
}>;

export type ReviewDetailRound = Readonly<{
  ordinal: number;
  state: ReviewRoundStateV1;
  groups: readonly ReviewDetailRoundGroup[];
}>;

/** One verdict sentence and its facts: the shared Review glance (`HappierReviewGlance`). */
export type ReviewDetailGlance = HappierReviewGlance;

export type ReviewDetailTab = Readonly<{
  id: ReviewDetailTabId;
  count?: number | null;
}>;

export type ReviewDetailViewProps = Readonly<{
  title: string;
  /** The header's facts: what was reviewed, the round, when it started. */
  meta: readonly PageHeaderMetaFact[];
  /** The one primary for this view (Submit review when it is asked of you, else New round once settled). */
  primaryAction?: PageHeaderPrimaryAction | null;
  menu: readonly PageHeaderMenuAction[];
  glance: ReviewDetailGlance | null;
  quality?: import('@happier-dev/protocol/reviews/reviewArtifactV1').ReviewRoundQualityV1 | null;
  viewedFilter?: Readonly<{ hidden: boolean; onHiddenChange: (hidden: boolean) => void }>;
  /** One line under the glance when part of the round failed or the Home is offline (with its retry). */
  notice?: React.ReactNode;
  rounds: readonly ReviewDetailRound[];
  selectedRound: number;
  onSelectRound: (ordinal: number) => void;
  /** The Submit your review panel, when it is open (it replaces the header primary while open). */
  submit?: React.ReactNode;
  tabs: readonly ReviewDetailTab[];
  activeTab: ReviewDetailTabId;
  onSelectTab: (tab: ReviewDetailTabId) => void;
  /** The active tab's body: only the opened tab is mounted. */
  children: React.ReactNode;
  testID?: string;
}>;

const TAB_LABEL_KEYS = {
  findings: 'reviewWalkthrough.detail.tabFindings',
  changes: 'reviewWalkthrough.detail.tabChanges',
  runs: 'reviewWalkthrough.detail.tabRuns',
  activity: 'reviewWalkthrough.detail.tabActivity',
} as const satisfies Record<ReviewDetailTabId, string>;

/**
 * The Review page (plan 04 U4, lab `detail-findings`, `detail-rounds`, `detail-submit`): the Review's
 * identity header, one verdict sentence with its facts, the round with who reviewed it, then the page
 * tabs (Findings, Changes, Runs, Activity). Rounds belong to the Review: New round starts here and every
 * verdict is drawn inside the round it was given in. Counts live on the tabs and the findings' chips only.
 */
export function ReviewDetailView(
  props: ReviewDetailViewProps,
): React.ReactElement {
  const tabs = React.useMemo(
    (): readonly SegmentedTab<ReviewDetailTabId>[] =>
      props.tabs.map((tab) => ({
        id: tab.id,
        label: t(TAB_LABEL_KEYS[tab.id]),
        ...(typeof tab.count === 'number' ? { count: String(tab.count) } : {}),
        testID: `review-detail:tab:${tab.id}`,
      })),
    [props.tabs],
  );
  const round =
    props.rounds.find((item) => item.ordinal === props.selectedRound) ??
    props.rounds.at(-1) ??
    null;
  return (
    <ItemList testID={props.testID ?? 'review-detail'} pageColumn="wide">
      <PageHeader
        title={props.title}
        meta={props.meta}
        {...(props.primaryAction && !props.submit
          ? { primaryAction: props.primaryAction }
          : {})}
        actions={
          props.menu.length > 0 ? (
            <PageHeaderMenu testID="review-detail:more" actions={props.menu} />
          ) : undefined
        }
        testID="review-detail:header"
      />
      <PageContentColumn style={styles.column}>
        {props.glance || props.notice ? (
          // The glance and its notice stand on the sections' sheet edge, not the column's.
          <View style={styles.lead}>
            {props.glance ? <ReviewGlanceLine glance={props.glance} /> : null}
            {props.notice ?? null}
          </View>
        ) : null}
        {round ? (
          <ReviewDetailRoundSection
            round={round}
            rounds={props.rounds}
            onSelectRound={props.onSelectRound}
          />
        ) : null}
        {props.submit ?? null}
        <View style={styles.tabs}>
          <SegmentedTabBar<ReviewDetailTabId>
            tabs={tabs}
            activeTabId={props.activeTab}
            onSelectTab={props.onSelectTab}
            presentation="plain"
            segmentSizing="content"
            testIDPrefix="review-detail:tabs"
            overflow={{ label: t('common.more') }}
          />
        </View>
        <View testID={`review-detail:panel:${props.activeTab}`}>
          {props.children}
        </View>
      </PageContentColumn>
    </ItemList>
  );
}

/** Page content that is not a section (a button, a state line) standing on the sections' sheet edge. */
export function ReviewDetailInset(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  return <View style={styles.inset}>{props.children}</View>;
}

/** One verdict sentence, then its facts on one quiet line (lab glance; no stat strip). */
export function ReviewGlanceLine(
  props: Readonly<{ glance: ReviewDetailGlance }>,
) {
  const workTheme = useWorkTheme();
  return <HappierReviewGlanceLine glance={props.glance} testID="review-detail:glance" factsTestID="review-detail:facts"
    theme={workTheme} host={WORK_HOST} />;
}

const GROUP_STATUS_ICON: Record<ReviewDetailRoundGroup['status'], IconName> = {
  done: 'check-circle',
  running: 'hourglass',
  waiting: 'circle',
  failed: 'warning-circle',
};

/**
 * The round: one page section (a round picker in its title once there are several), one row per group
 * of reviewers naming each participant with its own mark and what it did in this round.
 */
function ReviewDetailRoundSection(props: Readonly<{
    round: ReviewDetailRound;
    rounds: readonly ReviewDetailRound[];
    onSelectRound: (ordinal: number) => void;
}>) {
    const { theme } = useUnistyles();
    const roundTabs = React.useMemo((): readonly SegmentedTab<string>[] => props.rounds.map(item => ({
        id: String(item.ordinal), label: t('reviewWalkthrough.detail.round', { round: item.ordinal }),
        testID: `review-detail:round:${item.ordinal}`,
    })), [props.rounds]);
    const onSelect = props.onSelectRound;
    const select = React.useCallback((id: string) => onSelect(Number(id)), [onSelect]);
    const title = props.rounds.length > 1 ? (
        <SegmentedTabBar<string>
            role="radiogroup"
            tabs={roundTabs}
            activeTabId={String(props.round.ordinal)}
            onSelectTab={select}
            segmentSizing="content"
            testIDPrefix="review-detail:rounds"
            accessibilityLabel={t('reviewWalkthrough.detail.rounds')}
        />
    ) : t('reviewWalkthrough.detail.round', { round: props.round.ordinal });
    return (
        <ItemGroup testID="review-detail:round" title={title}>
            {props.round.groups.map(group => (
                <Item
                    key={group.id}
                    testID={`review-detail:group:${group.id}`}
                    title={group.title}
                    icon={<Icon name={GROUP_STATUS_ICON[group.status]} size={ICON_SIZE.sm}
                        color={group.status === 'failed' ? theme.colors.state.danger.textForeground : theme.colors.text.secondary} />}
                    rightElement={group.detail ? (
                        <Text variant="meta" style={[styles.groupDetail, toneStyle(group.detailTone ?? null, theme)]} numberOfLines={1}>
                            {group.detail}
                        </Text>
                    ) : undefined}
                    bottomElementInset="text"
                    bottomElement={(
                        <View style={styles.participants}>
                            {group.participants.map(participant => (
                                <View key={participant.id} testID={`review-detail:participant:${participant.id}`}>
                                  <View style={styles.participant}>
                                    {participant.mark}
                                    <Text variant="body" emphasis="medium" style={styles.participantName} numberOfLines={1}>{participant.label}</Text>
                                    {participant.qualifier ? <Text variant="body" style={styles.participantQuiet}>{participant.qualifier}</Text> : null}
                                    {participant.state ? (
                                        <Text variant="body" style={[styles.participantQuiet, toneStyle(participant.tone ?? null, theme)]}>
                                            {participant.state}
                                        </Text>
                                    ) : null}
                                  </View>
                                  {participant.body ? <MarkdownView markdown={participant.body} /> : null}
                                </View>
                            ))}
                        </View>
                    )}
                />
            ))}
        </ItemGroup>
    );
}

function toneStyle(
  tone: 'attention' | 'failed' | null,
  theme: ReturnType<typeof useUnistyles>['theme'],
) {
  if (tone === 'attention')
    return { color: theme.colors.state.warning.textForeground };
  if (tone === 'failed')
    return { color: theme.colors.state.danger.textForeground };
  return null;
}

/** The detail's loading, failed and missing states at page size, under the same header shape. */
export function ReviewDetailState(
  props: Readonly<{
    kind: 'loading' | 'failed' | 'missing';
    onRetry?: () => void;
    reason?: string;
  }>,
): React.ReactElement {
  if (props.kind === 'loading')
    return <View testID="review-detail:loading" style={styles.loading} />;
  return (
    <SurfaceStateCard
      testID={`review-detail:${props.kind}`}
      kind={props.kind === 'failed' ? 'error' : 'empty'}
      title={
        props.kind === 'failed'
          ? t('reviewWalkthrough.detail.failedTitle')
          : t('artifacts.notFound')
      }
      reason={props.reason}
      action={
        props.kind === 'failed' && props.onRetry
          ? { label: t('common.retry'), onPress: props.onRetry }
          : undefined
      }
      replacesContent
    />
  );
}

/** The sections' sheet edge inside the page column: page-level lines align with the sheets below them. */
const CONTENT_INSET_PX = resolveItemGroupContentHorizontalInsetPx();

const styles = StyleSheet.create((theme) => ({
    column: { gap: theme.space.s16, paddingBottom: theme.space.s32 },
    lead: { gap: theme.space.s8, paddingHorizontal: CONTENT_INSET_PX, paddingTop: theme.space.s16 },
    inset: { paddingHorizontal: CONTENT_INSET_PX, alignItems: 'flex-start' },
    groupDetail: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
    participants: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s4 },
    participant: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minWidth: 0 },
    participantName: { color: theme.colors.text.primary, flexShrink: 1 },
    participantQuiet: { color: theme.colors.text.secondary },
    tabs: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default, paddingBottom: theme.space.s8,
        marginHorizontal: CONTENT_INSET_PX },
    loading: { minHeight: theme.space.s48 * 6 },
}));
