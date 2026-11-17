import { HAPPIER_WORK_PANE_METRICS } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { publishMakeCoordinatorNotice } from '@/components/sessions/coordinator/MakeCoordinatorDialog';
import { SessionWorkDigestContent } from '@/components/sessions/work/SessionWorkDigest';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SessionGoalValueItem } from '@/components/sessions/workState/SessionGoalControlContent';
import { WorkFlatSheet } from '@/components/sessions/work/WorkSection';
import { Item } from '@/components/ui/lists/Item';
import type { SessionWorkStateItem } from '@/sync/domains/session/workState/sessionWorkStateTypes';
import { SessionWorkMapView } from '@/components/sessions/work/SessionWorkMapView';
import { WorkItemRow } from '@/components/sessions/work/WorkItemRow';
import { WorkSection } from '@/components/sessions/work/WorkSection';
import { projectSessionWorkMap } from '@/components/sessions/work/workMapProducer';
import {
  groupWorkByState,
  projectWork,
  type WorkItem,
  type WorkReportSessionSource,
} from '@/components/sessions/work/workProjection';
import type { SessionRecapState } from '@/components/sessions/companion/summary/useSessionRecap';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { NO_SESSION_AGENT_ACTIVITY_ATTENTION } from '@/sync/domains/session/agentActivity';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only specimen of a coordinator's Work states (coordination lab V3 P1-C, orchestration `session-A2`):
 * the Work rows and Map drawn from the real projection producers (a working report, a running subagent and
 * teammate, a settled agent the Map folds away) and the digest drawn by its real content owner in each Recap
 * state — memory synopsis, delivered-update fallback with its sender row, loading, empty and unavailable.
 * Fixture facts only; no RPC, store or send.
 */

// The rows' own times read the app clock, so the fixture is dated from it.
const NOW = Date.now();
const noop = () => {};
const idleRefresh = { sending: false, send: noop };

function report(
  sessionId: string,
  title: string,
  turn: 'in_progress' | 'completed' | 'needs_you',
  minutesAgo: number,
): WorkReportSessionSource {
  const at = NOW - minutesAgo * 60_000;
  return {
    sessionId,
    managerSessionId: 'coordinator',
    title,
    agentId: 'claude',
    facts: [],
    atMs: at,
    statusFacts: readSessionWorkStatusFacts(
      createSessionListRenderableSessionFixture({
        id: sessionId,
        active: true,
        activeAt: at,
        // A Session waiting on a person's answer, as the Inbox and Work list see one.
        ...(turn === 'needs_you'
          ? { latestTurnStatus: undefined, pendingPermissionRequestCount: 1, pendingRequestObservedAt: at }
          : { latestTurnStatus: turn, latestTurnStatusObservedAt: at }),
      }),
      NOW,
    ),
    stalled: false,
    archived: false,
  };
}

function agent(
  id: string,
  title: string,
  kind: 'subagent' | 'agent_team_member',
  status: 'running' | 'succeeded',
) {
  return {
    id,
    kind,
    status,
    title,
    metaDetail: null,
    startedAtMs: NOW - 6 * 60_000,
    endedAtMs: status === 'succeeded' ? NOW - 60_000 : null,
    provenance: 'local' as const,
    detailState: 'loaded' as const,
    parentId: null,
    runId: null,
    sidechainId: null,
    subagentId: id,
    attentionKinds: NO_SESSION_AGENT_ACTIVITY_ATTENTION,
  };
}

const projection = projectWork({
  sessionId: 'coordinator',
  reportSessions: [
    report('triage', 'Triage overnight CI failures', 'in_progress', 4),
    report('faq', 'Draft the pricing FAQ', 'needs_you', 18),
  ],
  agentEntries: [
    agent('scout', 'Scout the webkit flakes', 'subagent', 'running'),
    agent('mira', 'Mira · checkout copy', 'agent_team_member', 'running'),
    agent('runbook', 'Support runbook pass', 'subagent', 'succeeded'),
  ],
  workflowHeadlineRuns: [],
  managedRuns: [],
  ownTriggerRunIds: new Set(),
  describeAgentStatus: (entry) =>
    entry.status === 'running' ? 'Running' : 'Done',
  describeProgress: ({ completed, total }) => `${completed} of ${total}`,
});
const groups = groupWorkByState(projection);
const map = projectSessionWorkMap({
  managerSessionId: 'coordinator',
  leadTitle: 'Daily coordinator',
  leadAgentId: 'claude',
  projection,
});
const sessionItemById = new Map<string, WorkItem>(
  projection.sessions.flatMap((item) =>
    item.open.kind === 'session' ? [[item.open.sessionId, item] as const] : [],
  ),
);
const NOTHING_LISTED: ReadonlySet<string> = new Set();

const RECAP_STATES: ReadonlyArray<
  Readonly<{ id: string; label: string; state: SessionRecapState }>
> = [
  {
    id: 'synopsis',
    label: 'From memory',
    state: {
      status: 'ready',
      recap: {
        source: 'synopsis',
        atMs: NOW - 18 * 60_000,
        text: 'Two things need you. Four sessions moved overnight; the rest are quiet. The pricing FAQ asks whether to mention refunds.',
      },
    },
  },
  {
    id: 'update',
    label: 'Delivered update, with its sender',
    state: {
      status: 'ready',
      recap: {
        source: 'worker_update',
        atMs: NOW - 12 * 60_000,
        text: 'needs you · asks whether to mention refunds',
        workerSessionId: 'faq',
      },
    },
  },
  {
    id: 'update-body',
    label: 'Delivered update with a body',
    state: {
      status: 'ready',
      recap: {
        source: 'worker_update',
        atMs: NOW - 3 * 60_000,
        text: 'finished',
        body: 'The support runbook converged in one round; overnight triage found 3 flaky tests, all in webkit.',
      },
    },
  },
  {
    id: 'loading',
    label: 'Loading',
    state: { status: 'loading', recap: null },
  },
  {
    id: 'empty',
    label: 'Nothing yet',
    state: { status: 'empty', recap: null },
  },
  {
    id: 'unavailable',
    label: 'Locked or unavailable',
    state: { status: 'unavailable', recap: null },
  },
];

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface.inset },
  content: {
    padding: theme.space.s24,
    gap: theme.space.s24,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  },
  // The Work pane's own surface, as the live pane draws it: a column, not a bordered card, so the Map's
  // lead and child cards are never read as cards inside a card.
  pane: {
    width: 360,
    backgroundColor: theme.colors.surface.base,
  },
  paneWide: { width: 500 },
  paneBody: {
    paddingHorizontal: HAPPIER_WORK_PANE_METRICS.contentInsetPx,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s16,
    gap: 18,
  },
  caption: { ...Typography.variant('meta'), color: theme.colors.text.tertiary },
}));

/** The Goal value row through its real owner: not set, active, and owner-only blocked work. */
const GOAL_ENTRY = { available: true, open: noop };
function goal(status: SessionWorkStateItem['status']): SessionWorkStateItem {
  return { id: `goal-${status}`, kind: 'goal', origin: 'happier', status, title: 'Keep my sessions moving', updatedAt: NOW };
}
const GOALS: ReadonlyArray<Readonly<{ id: string; goal: SessionWorkStateItem | null }>> = [
  { id: 'not-set', goal: null },
  { id: 'active', goal: goal('active') },
  { id: 'blocked', goal: goal('blocked') },
];

function TopRows() {
  return (
    <WorkFlatSheet testID="specimen-work-top">
      <Item title="Managed by" detail="Top level" density="compact" onPress={noop} />
      {GOALS.map((entry) => (
        <SessionGoalValueItem key={entry.id} goal={entry.goal} entry={GOAL_ENTRY} testID={`specimen-goal-${entry.id}`} />
      ))}
    </WorkFlatSheet>
  );
}

function WorkPane(props: Readonly<{ wide?: boolean }>) {
  return (
    <View style={[styles.pane, props.wide ? styles.paneWide : null]}>
      <View style={styles.paneBody}>
        <TopRows />
        {groups.working.length > 0 ? (
          <WorkSection
            testID="specimen-work-working"
            title="Working"
            count={groups.working.length}
            countMode="quiet"
          >
            {groups.working
              .filter((item) => item.kind === 'session')
              .map((item) => (
                <WorkItemRow key={item.key} item={item} onOpen={noop} />
              ))}
          </WorkSection>
        ) : null}
        <SessionWorkMapView
          map={map}
          projection={projection}
          showFacts={props.wide === true}
          testIDPrefix="specimen-work-map"
          onOpenItem={noop}
        />
        {RECAP_STATES.map((entry) => (
          <View key={entry.id} testID={`specimen-recap-${entry.id}`}>
            <Text style={styles.caption}>{entry.label}</Text>
            <SessionWorkDigestContent
              state={entry.state}
              nowMs={NOW}
              refresh={idleRefresh}
              sessionItemById={sessionItemById}
              listedQuietSessionIds={NOTHING_LISTED}
              onOpenItem={noop}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

/** The notice a finished Make coordinator leaves when no rule is on (lab V3 P3), through the dialog's own publisher. */
const showNoRuleNotice = () =>
  publishMakeCoordinatorNotice({ serverId: 'specimen', sessionId: 'coordinator', name: 'Daily coordinator', ruleOn: false });

export function WorkStatesSpecimen() {
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <RoundButton testID="specimen-coordinator-notice" size="small" display="secondary"
        title="Show the no-rule coordinator notice" onPress={showNoRuleNotice} />
      <WorkPane />
      <WorkPane wide />
    </ScrollView>
  );
}
