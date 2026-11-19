import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  CollectionAnatomy,
  CollectionField,
} from '@happier-dev/plugin-ui';
import { countWorkflowStepsV1 } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';
import { workflowDefinitionPreviewAgentsV1, workflowDefinitionPreviewStepsV1 } from '@happier-dev/protocol/workflows/workflowStepLabel';

import { StatusPill } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { formatRelativeTimeShort } from '@/utils/time/formatShortRelativeTime';
import { t } from '@/text';

import {
  readWorkflowStartMarks,
  WorkflowMarks,
  type WorkflowMark,
} from '../presentation/WorkflowMarks';
import { WorkflowSentencePreview } from '../sentence/WorkflowSentencePreview';
import { formatTriggerSetSummary, type TriggerSummarySource } from '../triggers/formatTriggerSummary';
import { isWorkflowTriggerSourceGone } from '../triggers/sessionTriggerGroups';
import {
  isAccountWorkflowOff,
  isAccountWorkflowReviewRequired,
} from './AccountWorkflowRowAnchor';
import type { WorkflowLibraryRow } from './useWorkflowLibraryView';
import {
  hasWorkingWorkflowLibraryRun,
  projectWorkflowRunStrip,
  WORKFLOW_RUN_STRIP_LENGTH,
  type WorkflowRunStrip,
} from './workflowRunStrip';
import { WorkflowRunStripView } from './WorkflowRunStripView';

/** The rows of "Your workflows": saved, Account, shared and plugin workflows (Built-in keeps its own section). */
export type WorkflowLibraryItem = Exclude<
  WorkflowLibraryRow,
  Readonly<{ group: 'builtin' }>
>;

/** The one state word a row says (scene 8): needs you speaks in amber; off and unavailable stay quiet; healthy says nothing. */
export type WorkflowLibraryRowState = 'needsYou' | 'running' | 'off' | 'unavailable' | null;

/**
 * Everything a workflow row, table cell or card draws, read once from the row the library owner already projected
 * (definition list header, run summaries, Account trigger set). No reads: a pure reading of the row.
 */
export type WorkflowLibraryRowFacts = Readonly<{
  triggers: readonly WorkflowTriggerFact[];
  agents: readonly PluginContributionIdentityV1[];
  /** The trigger sentence ("Every day at 02:00"); null where the row has none to say (a plugin workflow). */
  triggerLine: string | null;
  stepCount: number | null;
  /** The authored step labels for the static Sentence view. */
  steps: readonly string[];
  lastRunAt: number | null;
  /** Null where no run history is read for the row (Account workflows report only their last run). */
  strip: WorkflowRunStrip | null;
  state: WorkflowLibraryRowState;
  needsYouRunId: string | null;
}>;

const EMPTY_AGENTS: readonly PluginContributionIdentityV1[] = Object.freeze([]);
const EMPTY_STEPS: readonly string[] = Object.freeze([]);
/** A trigger as the list facts carry it: the trigger owner's summary source and whether it is on. */
export type WorkflowTriggerFact = TriggerSummarySource & Readonly<{ enabled?: boolean }>;

/** Every place that draws these facts says Off in its own state slot. */
const OFF_SAID_ELSEWHERE = Object.freeze({ offSaidElsewhere: true });

const isAccountItem = (
  row: WorkflowLibraryItem,
): row is Extract<WorkflowLibraryItem, { accountTrigger: unknown }> =>
  'accountTrigger' in row;

function readStartedAt(startedAt: string | undefined): number | null {
  if (startedAt === undefined) return null;
  const at = Date.parse(startedAt);
  return Number.isFinite(at) ? at : null;
}

export function readWorkflowLibraryRowFacts(
  row: WorkflowLibraryItem,
): WorkflowLibraryRowFacts {
  if (isAccountItem(row)) {
    const inline = row.accountTrigger.context?.inlineDefinition;
    const lastRun = row.lastRunSummary?.lastRun ?? null;
    const reviewRequired = isAccountWorkflowReviewRequired(row);
    const needsYou =
      reviewRequired ||
      lastRun?.attentionRequired === true ||
      lastRun?.invocationAttentionRequired === true;
    return {
      triggers: row.accountTrigger.triggers,
      agents: inline ? workflowDefinitionPreviewAgentsV1(inline) : EMPTY_AGENTS,
      // The projection owner's sentence; only an Off set is re-said without its Off (its state word says it).
      triggerLine:
        row.accountTrigger.triggers.length === 0
          ? null
          : isAccountWorkflowOff(row)
            ? formatTriggerSetSummary(row.accountTrigger.triggers, lastRun?.state, OFF_SAID_ELSEWHERE)
            : row.triggerSummary,
      stepCount: inline ? countWorkflowStepsV1(inline.blocks) : null,
      steps: inline
        ? workflowDefinitionPreviewStepsV1(inline.blocks)
        : EMPTY_STEPS,
      lastRunAt: readStartedAt(lastRun?.startedAt),
      strip: null,
      state: isWorkflowTriggerSourceGone(row.accountTrigger)
        ? 'unavailable'
        : needsYou
          ? 'needsYou'
          : lastRun !== null && hasWorkingWorkflowLibraryRun({ recent: [{ ...lastRun, runId: lastRun.id }] })
            ? 'running'
            : isAccountWorkflowOff(row)
              ? 'off'
              : null,
      needsYouRunId: reviewRequired
        ? null
        : needsYou
          ? (lastRun?.id ?? null)
          : null,
    };
  }
  if (row.group === 'fromPlugins') {
    const blocks = row.plugin.definition.blocks;
    return {
      triggers: [],
      agents: workflowDefinitionPreviewAgentsV1(row.plugin.definition),
      triggerLine: null,
      stepCount: countWorkflowStepsV1(blocks),
      steps: workflowDefinitionPreviewStepsV1(blocks),
      lastRunAt: null,
      strip: null,
      state: null,
      needsYouRunId: null,
    };
  }
  const { definition } = row;
  const summary = row.lastRunSummary;
  const available = definition.contentStatus === 'available';
  return {
    agents: available ? definition.previewAgents ?? EMPTY_AGENTS : EMPTY_AGENTS,
    triggers:
      definition.triggerSummaryErrorCode === undefined
        ? definition.triggers
        : [],
    triggerLine:
      definition.triggerSummaryErrorCode === undefined
        ? definition.triggers.length === 0
          ? t('automations.list.noAutomaticTriggers')
          : formatTriggerSetSummary(definition.triggers, undefined, OFF_SAID_ELSEWHERE)
        : t('common.unavailable'),
    stepCount: available ? definition.stepCount : null,
    steps: available ? (definition.previewSteps ?? EMPTY_STEPS) : EMPTY_STEPS,
    lastRunAt: readStartedAt(summary?.lastRun?.startedAt),
    strip: summary === undefined ? null : projectWorkflowRunStrip(summary),
    state: !available
      ? 'unavailable'
      : summary?.needsYouRunId
        ? 'needsYou'
        : hasWorkingWorkflowLibraryRun(summary)
          ? 'running'
          : definition.triggers.length > 0 &&
            definition.triggers.every((trigger) => trigger.enabled === false)
          ? 'off'
          : null,
    needsYouRunId: summary?.needsYouRunId ?? null,
  };
}

/**
 * The details a workflow row can draw (scene 8 View menu, "Row details"; the table names the same set "Columns"),
 * each with its default: the marks, the trigger and the run strip show, the rest are opt-in (Next run, owner 11-19).
 */
export const WORKFLOW_ROW_DETAILS = Object.freeze([
  { id: 'icons', defaultOn: true },
  { id: 'trigger', defaultOn: true },
  { id: 'steps', defaultOn: false },
  { id: 'lastRun', defaultOn: false },
  { id: 'nextRun', defaultOn: false },
  { id: 'recentRuns', defaultOn: true },
] as const);
export type WorkflowRowDetailId = (typeof WORKFLOW_ROW_DETAILS)[number]['id'];
export type WorkflowRowDetails = Readonly<Record<WorkflowRowDetailId, boolean>>;

/** The row details as the person set them in the one display owner, defaults filled. */
export function resolveWorkflowRowDetails(stored: Readonly<Record<string, boolean>> | undefined): WorkflowRowDetails {
  return Object.fromEntries(WORKFLOW_ROW_DETAILS.map(detail => [detail.id, stored?.[detail.id] ?? detail.defaultOn])) as WorkflowRowDetails;
}

export function workflowRowDetailTitle(id: WorkflowRowDetailId): string {
  switch (id) {
    case 'icons': return t('workflows.destination.columns.icons');
    case 'trigger': return t('workflows.destination.columns.trigger');
    case 'steps': return t('workflows.destination.columns.steps');
    case 'lastRun': return t('workflows.destination.columns.lastRun');
    case 'nextRun': return t('automations.detail.overview.nextRunTitle');
    case 'recentRuns': return t('workflows.destination.columns.recentRuns', { count: WORKFLOW_RUN_STRIP_LENGTH });
  }
}

/** What a workflow uses, as marks: what starts it, then the Agents once the list owner carries them. */
export function readWorkflowLibraryRowMarks(
  facts: WorkflowLibraryRowFacts,
  row: WorkflowLibraryItem,
): readonly WorkflowMark[] {
  // A plugin workflow's start is not in its list facts: it draws no start mark rather than claiming "Manual".
  return readWorkflowStartMarks(facts.triggers, facts.agents, row.group !== 'fromPlugins');
}

/** The state word in its one place (a table's State cell, a card's top right, a phone row's line 2 lead). */
export const WorkflowLibraryStateWord = React.memo(
  function WorkflowLibraryStateWord(
    props: Readonly<{
      state: WorkflowLibraryRowState;
      needsYouRunId: string | null;
      onOpenRun?: (runId: string) => void;
      testID?: string;
    }>,
  ) {
    if (props.state === null) return null;
    if (props.state === 'needsYou') {
      const pill = (
        <StatusPill
          variant="attention"
          chrome="plain"
          label={t('workflows.destination.sections.needsYou')}
          labelVariant="phrase"
        />
      );
      const runId = props.needsYouRunId;
      if (runId === null || props.onOpenRun === undefined)
        return <View testID={props.testID}>{pill}</View>;
      const open = props.onOpenRun;
      // The run that waits is one press away: the word is its own control beside the row's press target.
      return (
        <Pressable
          testID={props.testID}
          accessibilityRole="link"
          onPress={() => open(runId)}
          style={styles.statePress}
        >
          {pill}
        </Pressable>
      );
    }
    return (
      <Text
        testID={props.testID}
        variant="meta"
        numberOfLines={1}
        style={styles.quietState}
      >
        {props.state === 'off'
          ? t('workflows.destination.off')
          : props.state === 'running'
            ? t('workflows.destination.sections.running')
            : t('common.unavailable')}
      </Text>
    );
  },
);

function formatLastRun(at: number | null): string | null {
  return at === null ? null : formatRelativeTimeShort(at, Date.now());
}

/**
 * The table's columns for "Your workflows" (scene 8 table): Uses, Trigger, Steps, Last run, the run strip and State.
 * Next run is the opt-in column (owner 11-19) the caller adds. Column visibility is the Columns menu's
 * (`collectionColumnPreferencesV1`); this only declares and draws.
 */
export function buildWorkflowLibraryFields(
  readFacts: (row: WorkflowLibraryItem) => WorkflowLibraryRowFacts,
  openRun: (runId: string) => void,
): readonly CollectionField<WorkflowLibraryItem>[] {
  return [
    {
      key: 'uses',
      title: t('workflows.destination.columns.uses'),
      minWidth: 76,
      maxWidth: 96,
      priority: 3,
      render: (row) => (
        <WorkflowMarks
          layout="row"
          marks={readWorkflowLibraryRowMarks(readFacts(row), row)}
        />
      ),
    },
    {
      key: 'trigger',
      title: t('workflows.destination.columns.trigger'),
      minWidth: 140,
      maxWidth: 320,
      priority: 6,
      render: (row) => readFacts(row).triggerLine,
    },
    {
      key: 'steps',
      title: t('workflows.destination.columns.steps'),
      minWidth: 44,
      priority: 2,
      align: 'end',
      render: (row) => readFacts(row).stepCount,
    },
    {
      key: 'lastRun',
      title: t('workflows.destination.columns.lastRun'),
      minWidth: 88,
      maxWidth: 120,
      priority: 4,
      render: (row) => formatLastRun(readFacts(row).lastRunAt),
    },
    {
      key: 'recentRuns',
      title: t('workflows.destination.columns.recentRuns', {
        count: WORKFLOW_RUN_STRIP_LENGTH,
      }),
      minWidth: 76,
      priority: 5,
      render: (row) => {
        const strip = readFacts(row).strip;
        return strip === null ? null : (
          <WorkflowRunStripView
            strip={strip}
            testID={`workflows-home:row:${row.key}:strip`}
          />
        );
      },
    },
    {
      key: 'state',
      title: t('workflows.destination.columns.state'),
      minWidth: 96,
      priority: 7,
      align: 'end',
      control: true,
      render: (row) => {
        const facts = readFacts(row);
        return (
          <WorkflowLibraryStateWord
            state={facts.state}
            needsYouRunId={facts.needsYouRunId}
            onOpenRun={openRun}
            testID={`workflows-home:row:${row.key}:${facts.state === 'needsYou' ? 'needsYou' : 'state'}`}
          />
        );
      },
    },
  ];
}

/**
 * A workflow card (scene 8 D4): the name with its state word, the static Sentence view, then the marks on the left
 * and the last run with the run strip on the right. Cards are wide only; a phone lists.
 */
export function buildWorkflowLibraryCard(
  readFacts: (row: WorkflowLibraryItem) => WorkflowLibraryRowFacts,
  openRun: (runId: string) => void,
  /** The person's Row details; the card's sentence always shows (D4), its marks and strip follow these. */
  details: WorkflowRowDetails = resolveWorkflowRowDetails(undefined),
): NonNullable<CollectionAnatomy<WorkflowLibraryItem>['card']> {
  return {
    headerRight: (row) => {
      const facts = readFacts(row);
      return (
        <WorkflowLibraryStateWord
          state={facts.state}
          needsYouRunId={facts.needsYouRunId}
          onOpenRun={openRun}
          testID={`workflows-home:card:${row.key}:state`}
        />
      );
    },
    body: {
      render: (row) => {
        const facts = readFacts(row);
        return (
          <WorkflowSentencePreview
            triggers={facts.triggers}
            steps={facts.steps}
            testID={`workflows-home:card:${row.key}:sentence`}
          />
        );
      },
    },
    facts: (row) => {
      const facts = readFacts(row);
      const lastRun = formatLastRun(facts.lastRunAt);
      return (
        <View style={styles.cardFoot}>
          {details.icons ? (
            <WorkflowMarks layout="row" marks={readWorkflowLibraryRowMarks(facts, row)} />
          ) : null}
          <View style={styles.cardFootSpacer} />
          {lastRun === null ? null : (
            <Text variant="meta" numberOfLines={1} style={styles.cardFootText}>
              {t('workflows.destination.lastRun', { age: lastRun })}
            </Text>
          )}
          {facts.strip === null || !details.recentRuns ? null : (
            <WorkflowRunStripView strip={facts.strip} />
          )}
        </View>
      );
    },
  };
}

const styles = StyleSheet.create((theme) => ({
  quietState: {
    color: theme.colors.text.tertiary,
  },
  statePress: {
    alignSelf: 'flex-end',
  },
  cardFoot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minWidth: 0,
    alignSelf: 'stretch',
  },
  cardFootSpacer: {
    flex: 1,
  },
  cardFootText: {
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
}));
