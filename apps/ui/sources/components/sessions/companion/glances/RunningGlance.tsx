import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveSessionAgentActivityPresentation } from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { StatusDot } from '@/components/ui/status/StatusDot';
import {
  WidgetFrame,
  type WidgetFrameStyle,
} from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { useSessionAgentActivity } from '@/hooks/session/useSessionAgentActivity';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';

import {
  projectSessionAgentPlan,
  type SessionAgentPlan,
} from '../plan/sessionAgentPlan';
import { SessionElapsedClock } from '../summary/SessionSummaryStatusLine';
import { useSessionSummaryAwareness } from '../summary/useSessionSummaryAwareness';
import {
  resolveRunningSectionRows,
  type RunningSectionAgentInput,
} from './glanceModels';
import { useSessionLocalServicesGlance } from './LocalServicesGlance';
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
const NO_SERVICES: readonly never[] = Object.freeze([]);

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
 * (Conductor's Lineage), and the services up now. Everything that is not live is one "n more" row per kind
 * that opens its pane. Each fact comes from its owner: the Session's plan, the merged agent roster and its
 * presentation owner, and the Local services feeds the pane mounts. A measuring pass starts no feed.
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
  const services = useSessionLocalServicesGlance({
    sessionId: props.sessionId,
    serverId: props.serverId,
  });
  const serviceRows =
    services.state.kind === 'ready' ? services.state.rows : NO_SERVICES;
  const rows = React.useMemo(
    () => resolveRunningSectionRows({ agents, services: serviceRows }),
    [agents, serviceRows],
  );
  const openSessionPane = useOpenSessionCompanionPane(
    props.sessionId,
    props.serverId,
  );
  const openPane = props.onOpenPane ?? openSessionPane;
  const openService = services.open;
  const [planOpen, setPlanOpen] = React.useState(false);
  if (
    !plan &&
    rows.agents.length === 0 &&
    rows.moreAgents === 0 &&
    rows.services.length === 0 &&
    rows.moreServices === 0
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
            {rows.services.map((service) => {
              const target = service.openTarget;
              return (
                <Item
                  key={service.id}
                  testID={`${props.testID}.service`}
                  density="compact"
                  icon={
                    <StatusDot color={theme.colors.status.connected} size={7} />
                  }
                  title={service.title}
                  titleQualifier={service.detail}
                  {...(target
                    ? {
                        rightElement: (
                          <Icon
                            name="arrow-square-out"
                            size={ICON_SIZE.xs}
                            color={theme.colors.text.tertiary}
                          />
                        ),
                        onPress: () => openService(target),
                      }
                    : { onPress: () => openPane('services') })}
                />
              );
            })}
            {rows.moreServices > 0 ? (
              <Item
                testID={`${props.testID}.moreServices`}
                density="compact"
                icon={glyph('hard-drives')}
                title={t('sessionCompanion.sections.more', {
                  count: rows.moreServices,
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
