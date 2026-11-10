import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useLocalServiceInventoryRunningCount } from '@/sync/domains/local/services/inventory/useLocalServiceInventoryRunningCount';
import { t } from '@/text';

import {
  projectSessionAgentPlan,
  type SessionAgentPlan,
} from '../plan/sessionAgentPlan';
import { SessionElapsedClock } from '../summary/SessionSummaryStatusLine';
import { useSessionSummaryAwareness } from '../summary/useSessionSummaryAwareness';
import {
  formatRunningSectionCount,
  resolveRunningSectionRows,
  type RunningSectionAgentInput,
} from './glanceModels';
import { useOpenSessionCompanionPane } from './PaneLinkRow';

const stylesheet = StyleSheet.create((theme) => ({
  clock: {
    ...Typography.tabular(),
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
  steps: { paddingStart: theme.space.s24 },
}));
const NO_AGENTS: readonly RunningSectionAgentInput[] = Object.freeze([]);

type RunningGlanceProps = Readonly<{
  session: Session;
  sessionId: string;
  serverId: string | null;
  frameStyle: WidgetFrameStyle;
  presentation?: 'frame' | 'body';
  menu?: React.ReactNode;
  /** A configured copy outside the Session opens its Session instead of a pane beside the chat. */
  onOpenPane?: (paneId: string) => void;
  measurementOnly: boolean;
  testID: string;
}>;

/**
 * The Running section (lab crows B): the plan's step, the agents working now with their running clock
 * (Conductor's Lineage), and the pushed services count. Named services and their live feeds belong to
 * the Services pane or the explicit Local services glance; this default section acquires no daemon watch.
 */
export function RunningGlance(props: RunningGlanceProps) {
  if (props.measurementOnly) return null;
  return <RunningLiveGlance {...props} />;
}

function RunningLiveGlance(props: RunningGlanceProps) {
  const { theme } = useUnistyles();
  const { awarenessSource } = useSessionSummaryAwareness({
    session: props.session,
    serverId: props.serverId,
  });
  const plan = projectSessionAgentPlan(awarenessSource.todos);
  const activity = useSessionAgentActivity({
    sessionId: props.sessionId,
    ...(props.serverId ? { serverId: props.serverId } : {}),
    session: props.session,
  });
  const agents = React.useMemo(
    () =>
      activity.entries.length === 0
        ? NO_AGENTS
        : activity.entries.map((entry): RunningSectionAgentInput => {
            const presentation = resolveSessionAgentActivityPresentation({
              entry,
              subagent: activity.readSubagentForEntry(entry.id),
            });
            return {
              id: entry.id,
              title: presentation.title,
              agentId: presentation.agentId,
              phase: presentation.phase,
              startedAtMs: presentation.startedAtMs,
            };
          }),
    [activity],
  );
  const machineId = useSessionMachineTarget(props.sessionId, props.serverId)?.machineId ?? null;
  const runningServiceCount = useLocalServiceInventoryRunningCount({
    sessionId: props.sessionId,
    serverId: resolveMachineDaemonReadServerId(props.serverId),
    machineId,
    enabled: false,
  });
  const rows = React.useMemo(
    () => resolveRunningSectionRows({ agents }),
    [agents],
  );
  const openSessionPane = useOpenSessionCompanionPane(
    props.sessionId,
    props.serverId,
  );
  const openPane = props.onOpenPane ?? openSessionPane;
  const [planOpen, setPlanOpen] = React.useState(false);
  if (
    !plan &&
    rows.agents.length === 0 &&
    rows.moreAgents === 0 &&
    !(runningServiceCount !== null && runningServiceCount > 0)
  )
    return null;
  const glyph = (name: IconName) => (
    <Icon name={name} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
  );
  return (
    <WidgetFrame
      testID={props.testID}
      presentation={props.presentation}
      frameStyle={props.frameStyle}
      placement="companion"
      mark="play"
      title={t('sessionCompanion.sections.running')}
      meta={formatRunningSectionCount({
        agents: rows.agents.length + rows.moreAgents,
      })}
      menu={props.menu}
      body={{
        kind: 'content',
        children: (
          <>
            {plan ? (
              <PlanRow
                plan={plan}
                open={planOpen}
                onToggle={() => setPlanOpen((open) => !open)}
                icon={glyph('list-checks')}
                testID={`${props.testID}.plan`}
              />
            ) : null}
            {rows.agents.map((agent) => (
              <Item
                key={agent.id}
                testID={`${props.testID}.agent`}
                density="compact"
                icon={
                  agent.agentId ? (
                    <AgentIcon agentId={agent.agentId} size={ICON_SIZE.sm} />
                  ) : (
                    glyph('robot')
                  )
                }
                title={agent.title}
                titleMeta={
                  agent.startedAtMs !== null ? (
                    <SessionElapsedClock
                      sinceMs={agent.startedAtMs}
                      testID={`${props.testID}.agent.clock`}
                      style={stylesheet.clock}
                    />
                  ) : undefined
                }
                onPress={() => openPane('agents')}
              />
            ))}
            {rows.moreAgents > 0 ? (
              <Item
                testID={`${props.testID}.moreAgents`}
                density="compact"
                icon={glyph('robot')}
                title={t('sessionCompanion.sections.more', {
                  count: rows.moreAgents,
                })}
                onPress={() => openPane('agents')}
              />
            ) : null}
            {runningServiceCount !== null && runningServiceCount > 0 ? (
              <Item
                testID={`${props.testID}.services`}
                density="compact"
                icon={glyph('hard-drives')}
                title={t('sessionCompanion.sections.servicesCount', {
                  count: runningServiceCount,
                })}
                onPress={() => openPane('services')}
              />
            ) : null}
          </>
        ),
      }}
    />
  );
}

/** The plan's current step and its progress; it opens in place to the steps. */
function PlanRow(
  props: Readonly<{
    plan: SessionAgentPlan;
    open: boolean;
    onToggle: () => void;
    icon: React.ReactNode;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const current =
    props.plan.steps.find((step) => step.status === 'current') ??
    props.plan.steps.find((step) => step.status === 'todo') ??
    null;
  const progress = { done: props.plan.doneCount, total: props.plan.total };
  return (
    <>
      <Item
        testID={props.testID}
        density="compact"
        icon={props.icon}
        title={current?.text ?? t('sessionCompanion.plan.title')}
        titleMeta={t('sessionCompanion.plan.progress', progress)}
        rightElement={
          <Icon
            name={props.open ? 'caret-up' : 'caret-down'}
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
        }
        accessibilityLabel={t('sessionCompanion.plan.progressA11y', progress)}
        accessibilityExpanded={props.open}
        onPress={props.onToggle}
      />
      {props.open ? (
        <View style={stylesheet.steps} testID={`${props.testID}.steps`}>
          {props.plan.steps.map((step) => (
            <Item
              key={step.id}
              density="tight"
              mode="info"
              title={step.text}
              icon={
                <Icon
                  name={
                    step.status === 'done'
                      ? 'check'
                      : step.status === 'current'
                        ? 'arrow-right'
                        : 'circle'
                  }
                  size={ICON_SIZE.xs}
                  color={
                    step.status === 'todo'
                      ? theme.colors.text.tertiary
                      : theme.colors.text.secondary
                  }
                />
              }
            />
          ))}
        </View>
      ) : null}
    </>
  );
}
