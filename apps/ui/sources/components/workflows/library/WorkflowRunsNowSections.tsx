import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import { storage } from '@/sync/domains/state/storage';
import { sessionDisplayActions } from '@/sync/ops/sessions/sessionDisplayActions';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';

import type { WorkflowRunCollectionRow } from './useWorkflowRunCollection';
import type {
  WorkflowRunsNow,
  WorkflowRunsNowMachine,
} from './workflowRunsNow';
import { applyWorkflowRunsBotPause, projectWorkflowRunsBotPause, type WorkflowRunsBotPause } from './workflowRunsBotPause';

/**
 * How many waiting runs the hero draws as cards. The table below keeps every run (its Group by, search and filters stay
 * whole), so the rest are one scroll away: the hero is the glance tier, not a second list.
 */
const WORKFLOW_RUNS_NOW_HERO_CARDS = 3;

/**
 * The Runs page's "Now" (work-loop factory lab `queue:A:live`): what needs the person first, each waiting run with its
 * held step and the one press that opens it where its question, review or approval is answered; then how the working
 * runs sit on their Machines. Both read the Run collection's own rows through `projectWorkflowRunsNow`; healthy and
 * quiet fleets draw nothing here, so the table leads.
 */
export const WorkflowRunsNowSections = React.memo(
  function WorkflowRunsNowSections(
    props: Readonly<{
      now: WorkflowRunsNow;
      serverId: string | null;
    }>,
  ) {
    const { now } = props;
    const router = useRouter();
    const hero = now.needsYou.slice(0, WORKFLOW_RUNS_NOW_HERO_CARDS);
    const more = now.needsYou.length - hero.length;
    const anyParked = now.machines.some((machine) => machine.parked > 0);
    const botPause = useWorkflowRunsBotPause(props.serverId);
    return (
      <>
        {botPause.state.pausedBotIds.length === 0 ? null : (
          <AttentionBanner
            testID="workflow-runs:now:bots-paused"
            placement="page-section"
            tone="neutral"
            iconName="pause-circle"
            title={t('workflows.destination.now.botsPausedTitle', {
              count: botPause.state.pausedBotIds.length,
              total: botPause.state.ownBotIds.length,
            })}
            description={t('workflows.destination.now.botsPausedBody')}
            action={{
              label: t('workflows.destination.now.botsResume'),
              onPress: botPause.resume,
              loading: botPause.pending === 'resume',
              disabled: botPause.pending !== null,
              testID: 'workflow-runs:now:bots-resume',
            }}
          />
        )}
        {hero.length > 0 ? (
          <ItemGroup
            testID="workflow-runs:now:needs-you"
            surface="none"
            title={t('workflows.destination.sections.needsYou')}
            description={withCounted(
              more > 0
                ? t('workflows.destination.now.needsYouMore', {
                    count: now.needsYou.length,
                    more,
                  })
                : t('workflows.destination.now.needsYouCount', {
                    count: now.needsYou.length,
                  }),
              now,
            )}
          >
            <View style={styles.cards}>
              {hero.map((row) => (
                <WorkflowRunsNowCard
                  key={row.key}
                  row={row}
                  onOpen={() => router.push(row.route as never)}
                />
              ))}
            </View>
          </ItemGroup>
        ) : null}
        {now.machines.length > 0 ? (
          <ItemGroup
            testID="workflow-runs:now:slots"
            title={t('workflows.destination.now.slotsTitle')}
            {...(botPause.state.ownBotIds.length > botPause.state.pausedBotIds.length ? {
              action: (
                <SectionActionButton
                  testID="workflow-runs:now:bots-pause-all"
                  icon="pause"
                  title={t('workflows.destination.now.botsPauseAll')}
                  accessibilityLabel={t('workflows.destination.now.botsPauseAllLabel')}
                  accessibilityHint={t('workflows.destination.now.botsPauseAllHint')}
                  loading={botPause.pending === 'pause'}
                  disabled={botPause.pending !== null}
                  onPress={botPause.pauseAll}
                />
              ),
            } : {})}
            description={withCounted(
              anyParked
                ? t('workflows.destination.now.slotsSummaryParked', {
                    count: now.workingCount,
                  })
                : t('workflows.destination.now.slotsSummary', {
                    count: now.workingCount,
                  }),
              now,
            )}
          >
            {now.machines.map((machine) => (
              <WorkflowRunsNowMachineRow
                key={machine.machineId}
                machine={machine}
                serverId={props.serverId}
              />
            ))}
          </ItemGroup>
        ) : null}
      </>
    );
  },
);

/**
 * The person's own Bots on this Home and their pause (work-loop factory lab `queue:A`): Pause all stops new
 * scheduled, Event and message work for every own Bot, Resume lifts it. The state is each Bot's pushed
 * `botPausedAt`; only the in-flight press is held here.
 */
function useWorkflowRunsBotPause(serverId: string | null): Readonly<{
  state: WorkflowRunsBotPause;
  pending: 'pause' | 'resume' | null;
  pauseAll: () => void;
  resume: () => void;
}> {
  const rows = storage((state) => (serverId === null ? undefined : state.sessionListBotRowsByServerId[serverId]));
  const previous = React.useRef<WorkflowRunsBotPause | undefined>(undefined);
  const botPause = React.useMemo(() => {
    previous.current = projectWorkflowRunsBotPause(rows, previous.current);
    return previous.current;
  }, [rows]);
  const [pending, setPending] = React.useState<'pause' | 'resume' | null>(null);
  const apply = useEventCallback(async (intent: 'pause' | 'resume') => {
    if (pending !== null || serverId === null) return;
    setPending(intent);
    try {
      const { failed } = await applyWorkflowRunsBotPause({
        pause: botPause, intent, now: Date.now(),
        write: (sessionId, pausedAt) => sessionDisplayActions.setBotPausedAt(sessionId, pausedAt, { serverId }),
      });
      if (failed > 0) {
        publishPresentationNotice({
          key: 'workflow-runs:bots-pause',
          message: intent === 'pause'
            ? t('workflows.destination.now.botsPauseFailed')
            : t('workflows.destination.now.botsResumeFailed'),
        });
      }
    } finally {
      setPending(null);
    }
  });
  const pauseAll = useEventCallback(() => { void apply('pause'); });
  const resume = useEventCallback(() => { void apply('resume'); });
  return { state: botPause, pending, pauseAll, resume };
}

/**
 * Says when the counts read only the loaded runs: no Machine publishes its slot occupancy, so while older runs stay
 * unloaded a count could be short and the reader is told what it covers.
 */
function withCounted(summary: string, now: WorkflowRunsNow): string {
  return now.counted.kind === 'all'
    ? summary
    : `${summary} ${t('workflows.destination.now.countedLoaded', { count: now.counted.loadedCount })}`;
}

/** One waiting run: its held step leads, the workflow it belongs to follows, and its one way forward opens it. */
const WorkflowRunsNowCard = React.memo(function WorkflowRunsNowCard(
  props: Readonly<{
    row: WorkflowRunCollectionRow;
    onOpen: () => void;
  }>,
) {
  const { row } = props;
  const held = row.run.summary?.heldStep ?? null;
  const status = row.status;
  const description = [held?.label ?? status?.word ?? null, row.workflow.title]
    .filter(Boolean)
    .join(' · ');
  return (
    <AttentionBanner
      testID={`workflow-runs:now:needs-you:${row.key}`}
      placement="inline"
      tone="warning"
      title={row.title}
      description={description}
      icon={
        status ? (
          <WorkStatusRowMark
            testIDSuffix={`workflow-runs-now-${row.key}`}
            status={status}
          />
        ) : undefined
      }
      action={{
        label:
          held?.kind === 'waiting_for_review'
            ? t('workflows.run.review')
            : t('workflows.destination.now.open'),
        onPress: props.onOpen,
        testID: `workflow-runs:now:needs-you:${row.key}:open`,
      }}
    />
  );
});

/** A Machine running automation now: how many runs hold its slots, and the asks that gave theirs back. */
const WorkflowRunsNowMachineRow = React.memo(function WorkflowRunsNowMachineRow(
  props: Readonly<{
    machine: WorkflowRunsNowMachine;
    serverId: string | null;
  }>,
) {
  const { machine } = props;
  const { theme } = useUnistyles();
  const name = useServerScopedMachineLabel(props.serverId, machine.machineId);
  return (
    <Item
      testID={`workflow-runs:now:slots:${machine.machineId}`}
      icon={
        <Icon
          name="desktop"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
      }
      title={name ?? t('workflows.destination.now.unnamedMachine')}
      {...(machine.parked > 0
        ? {
            subtitle: t('workflows.destination.now.machineParked', {
              count: machine.parked,
            }),
          }
        : {})}
      rightElement={
        <Text variant="meta" style={styles.count}>
          {t('workflows.destination.now.machineWorking', {
            count: machine.working,
          })}
        </Text>
      }
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  cards: {
    gap: theme.space.s8,
  },
  count: {
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
