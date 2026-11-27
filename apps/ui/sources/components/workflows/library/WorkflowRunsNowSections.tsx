import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { WorkStatusRowMark } from '@/components/work/status/WorkStatusRowMark';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';

import type { WorkflowRunCollectionRow } from './useWorkflowRunCollection';
import type {
  WorkflowRunsNow,
  WorkflowRunsNowMachine,
} from './workflowRunsNow';

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
    return (
      <>
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
