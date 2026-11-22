import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierReviewGlanceLine, type HappierReviewGlance } from '@happier-dev/plugin-ui/presentation';
import { useWorkTheme, WORK_HOST } from '@/components/work/map/WorkMapView';

import type { ReviewRoundQualityUnavailableReasonV1, ReviewRoundQualityV1, ReviewRoundReviewerQualityV1, ReviewRoundStateV1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { presentReviewRoundQualityV1 } from '@happier-dev/protocol/reviews/reviewQualityPresentationV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import {
  PageHeader,
  PageHeaderPlaceholder,
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
import { ItemLoadStateRows, type ItemLoadState } from '@/components/ui/lists/ItemLoadStateRows';
import { SkeletonTitle } from '@/components/ui/lists/SkeletonRows';
import { Text } from '@/components/ui/text/Text';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { ITEM_SUBTITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { Typography } from '@/constants/Typography';
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
  /** The round's reviewer score as the Host aggregated it (lowest or median, the person's setting); `null` when none was recorded. */
  quality?: ReviewRoundQualityV1 | null;
  qualityUnavailableReason?: ReviewRoundQualityUnavailableReasonV1 | null;
  qualityReviewers?: readonly ReviewRoundReviewerQualityV1[];
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

const LOADING_STATE: ItemLoadState = Object.freeze({ kind: 'loading' });

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
  // The score line speaks only with something to say: the round's score, or a partial round's reviewer scores behind
  // its "No score" (each one press away). A bare "No score" at rest is not a fact worth a line.
  const qualityReviewers = props.qualityReviewers ?? props.quality?.reviewers ?? NO_QUALITY_REVIEWERS;
  const showsQuality = Boolean(props.quality) || (props.qualityUnavailableReason === 'partial' && qualityReviewers.length > 0);
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
        {props.glance || showsQuality || props.notice ? (
          // The glance stands on the sections' sheet edge; the notice line brings that edge itself, so both glyphs align.
          <View style={styles.lead}>
            {props.glance || showsQuality ? <View style={styles.leadInset}>
              {props.glance ? <ReviewGlanceLine glance={props.glance} /> : null}
              {showsQuality ? <ReviewQualityLines quality={props.quality ?? null} reviewers={qualityReviewers} /> : null}
            </View> : null}
            {props.notice ?? null}
          </View>
        ) : null}
        {/* A round with nobody to name yet (no reviewers, no people) draws no empty section. */}
        {round && round.groups.length > 0 ? (
          <ReviewDetailRoundSection
            round={round}
            rounds={props.rounds}
            onSelectRound={props.onSelectRound}
          />
        ) : null}
        {props.submit ?? null}
        <ReviewDetailTabsLine tabs={tabs} activeTab={props.activeTab} onSelectTab={props.onSelectTab} />
        <View testID={`review-detail:panel:${props.activeTab}`}>
          {props.children}
        </View>
      </PageContentColumn>
    </ItemList>
  );
}

/** The page tabs on their hairline: the loaded page and its loading state draw the same line. */
function ReviewDetailTabsLine(props: Readonly<{
  tabs: readonly SegmentedTab<ReviewDetailTabId>[];
  activeTab: ReviewDetailTabId;
  onSelectTab: (tab: ReviewDetailTabId) => void;
}>) {
  return (
    <View style={styles.tabs}>
      <SegmentedTabBar<ReviewDetailTabId>
        tabs={props.tabs}
        activeTabId={props.activeTab}
        onSelectTab={props.onSelectTab}
        presentation="plain"
        segmentSizing="content"
        testIDPrefix="review-detail:tabs"
        overflow={{ label: t('common.more') }}
      />
    </View>
  );
}

const LOADING_TAB_IDS = ['findings', 'changes', 'runs', 'activity'] as const satisfies readonly ReviewDetailTabId[];
const ignoreTab = () => {};

/** One verdict sentence, then its facts on one quiet line (lab glance; no stat strip). */
export function ReviewGlanceLine(
  props: Readonly<{ glance: ReviewDetailGlance }>,
) {
  const workTheme = useWorkTheme();
  return <HappierReviewGlanceLine glance={props.glance} testID="review-detail:glance" factsTestID="review-detail:facts"
    theme={workTheme} host={WORK_HOST} />;
}

/**
 * The reviewers' change-quality score (ideas-1118-reviews scene 7; UI refinements ruling 2026-11-20): one quiet
 * facts line under the verdict, the score the Host combined and how ("Lowest of 3 reviewers"); each reviewer's
 * score and reason one press away. It is the reviewers' judgement, never a gate, so it stays in ink.
 */
const NO_QUALITY_REVIEWERS: readonly ReviewRoundReviewerQualityV1[] = Object.freeze([]);

function ReviewQualityLines(props: Readonly<{
  /** The settled aggregate; `null` for a partial round, which shows no number (lab scene 7 "No score"). */
  quality: ReviewRoundQualityV1 | null;
  /** Every reviewer's own score and reason, kept even when the round has no aggregate. */
  reviewers: readonly ReviewRoundReviewerQualityV1[];
}>) {
  const { quality, reviewers } = props;
  const presentation = quality ? presentReviewRoundQualityV1(quality) : null;
  const [expanded, setExpanded] = React.useState(false);
  const count = reviewers.length;
  // A partial round's notice line says who didn't finish; the score line only says there is no score.
  const basis = !quality ? null
    : count > 1 ? t(quality.aggregation === 'median' ? 'reviewWalkthrough.detail.qualityMedian'
      : 'reviewWalkthrough.detail.qualityLowest', { count }) : null;
  const disclosure = count === 0 ? null : expanded ? t('reviewWalkthrough.detail.qualityShowLess')
    : t(count > 1 ? 'reviewWalkthrough.detail.qualityShowAll' : 'reviewWalkthrough.detail.qualityShowReason');
  return (
    <View testID="review-detail:quality" style={styles.quality}>
      <View style={styles.qualityLine}>
        <Text variant="meta" style={styles.participantQuiet}>
          <Text testID="review-detail:quality-score">{presentation
            ? t('reviewWalkthrough.detail.quality', { score: presentation.displayScore })
            : t('reviewWalkthrough.detail.qualityNoScore')}</Text>
          {basis ? <>{' · '}<Text testID="review-detail:quality-basis">{basis}</Text></> : null}
          {disclosure ? ' · ' : null}
        </Text>
        {disclosure ? <TextLinkButton size="meta" testID="review-detail:quality-each" expanded={expanded} label={disclosure}
          onPress={() => setExpanded(open => !open)} /> : null}
      </View>
      {expanded ? reviewers.map((reviewer, index) => (
        <View key={reviewer.reviewerId} style={styles.qualityReviewer} testID={`review-detail:quality-reviewer:${reviewer.reviewerId}`}>
          <Text variant="meta" emphasis="medium" style={styles.qualityReviewerScore}>
            {reviewer.displayName ?? t('reviewWalkthrough.detail.qualityReviewerFallback', { n: index + 1 })}
            {' '}{t('reviewWalkthrough.detail.qualityOutOf', { score: reviewer.score })}
          </Text>
          <Text variant="meta" style={styles.qualityReviewerReason}>{reviewer.rationale}</Text>
        </View>
      )) : null}
    </View>
  );
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
                    // A group with nobody to name (reviewer ids without labels) draws no empty second line.
                    bottomElement={group.participants.length === 0 ? undefined : (
                        <View style={styles.participants}>
                            {group.participants.map(participant => (
                                // A participant with a verdict comment takes the row's width, so the comment wraps inside the sheet.
                                <View key={participant.id} testID={`review-detail:participant:${participant.id}`}
                                    style={participant.body ? styles.participantWithBody : undefined}>
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
                                  {participant.body ? <MarkdownView markdown={participant.body} textStyle={styles.participantBody} /> : null}
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
  // Loading keeps the page's shape (lab `detail-loading`): the pending title, the glance line, the tab line and the
  // findings' rows reserved, so nothing moves when the Review lands and it never reads as a Review with no findings.
  if (props.kind === 'loading')
    return (
      <ItemList testID="review-detail:loading" pageColumn="wide">
        <PageHeaderPlaceholder testID="review-detail:loading:header" />
        <PageContentColumn style={styles.column}>
          <View style={styles.lead}>
            <View style={styles.leadInset}><SkeletonTitle lineHeight={ITEM_SUBTITLE_TEXT_METRICS.comfortable.lineHeight} /></View>
          </View>
          <ReviewDetailTabsLine tabs={LOADING_TAB_IDS.map(id => ({ id, label: t(TAB_LABEL_KEYS[id]), testID: `review-detail:tab:${id}` }))}
            activeTab="findings" onSelectTab={ignoreTab} />
          <ItemGroup header="none"><ItemLoadStateRows state={LOADING_STATE} rows={3} /></ItemGroup>
        </PageContentColumn>
      </ItemList>
    );
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
    lead: { gap: theme.space.s8, paddingTop: theme.space.s16 },
    leadInset: { gap: theme.space.s8, paddingHorizontal: CONTENT_INSET_PX },
    quality: { gap: theme.space.s4 },
    qualityLine: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
    qualityReviewer: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s8, minWidth: 0 },
    qualityReviewerScore: { color: theme.colors.text.primary, fontVariant: ['tabular-nums'], flexShrink: 0 },
    qualityReviewerReason: { color: theme.colors.text.secondary, flex: 1, minWidth: 0 },
    groupDetail: { color: theme.colors.text.secondary, fontVariant: ['tabular-nums'] },
    participants: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s16, rowGap: theme.space.s4 },
    participant: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, minWidth: 0 },
    participantWithBody: { flexBasis: '100%', maxWidth: '100%', minWidth: 0, gap: theme.space.s2 },
    // The verdict comment reads at the row's description role, under the person who wrote it.
    participantBody: { ...Typography.default('regular'), ...ITEM_SUBTITLE_TEXT_METRICS.comfortable, color: theme.colors.text.secondary },
    participantName: { color: theme.colors.text.primary, flexShrink: 1 },
    participantQuiet: { color: theme.colors.text.secondary },
    tabs: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default, paddingBottom: theme.space.s8,
        marginHorizontal: CONTENT_INSET_PX },
}));
