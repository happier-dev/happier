import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { useStorageCollect } from '@/components/machines/storage/StorageCollectToggle';
import { StorageItemRow } from '@/components/machines/storage/StorageItemRow';
import { storageEvidenceLabel } from '@/components/machines/storage/storageReasonPresentation';
import { repositoryOf } from '@/components/machines/storage/StorageWorktreesPage';
import {
  VitalsSubLine,
  VitalsValue,
} from '@/components/machines/vitals/VitalsSheet';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageItems } from '@/sync/domains/machines/storage/useMachineStorageItems';
import { getPreferredLanguage, t } from '@/text';

import {
  MachineWidgetSectionLabel,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetFreshness,
  type MachineWidgetTarget,
} from './machineWidgetKit';

/** Rows of the largest deletable worktrees per size (lab `rw` WT: Wide 3, Medium and Full 4). */
const LIST_ROWS: Readonly<Record<WidgetSizeV1, number>> = {
  small: 0,
  wide: 3,
  medium: 4,
  full: 4,
  tall: 4,
  large: 4,
};
const canDelete = (item: StorageItemV1) =>
  item.verdict === 'safe' || item.verdict === 'caution';
const WORKTREES_TAB: MachinePageTabParams = {
  id: 'storage',
  page: 'worktrees',
};

/**
 * Worktrees (plan 60 EU-6, lab `rw` WT): how many of a machine's worktrees can go, how much they hold
 * and why. Small, Medium, Wide and Full only. Data is plan 40's worktree list (the Worktrees page's own
 * read, optionally one Project); Review collects the ones that can go into the machine's pile and opens
 * the Worktrees page. Nothing is deleted here; a worktree with changes, commits or a live session is kept.
 */
export function MachineWorktreesWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.storage.noMachine')}
        testID={props.testID}
      />
    );
  const project =
    typeof props.input.project === 'string' && props.input.project
      ? props.input.project
      : null;
  return (
    <MachineWorktreesWidgetBody
      target={target}
      project={project}
      testID={props.testID}
    />
  );
}

function MachineWorktreesWidgetBody(
  props: Readonly<{
    target: MachineWidgetTarget;
    project: string | null;
    testID: string;
  }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const open = useOpenMachinePage(props.target);
  const list = useMachineStorageItems({
    ...props.target,
    list: 'worktrees',
    ...(props.project ? { projectId: props.project } : {}),
  });
  const page = list.page;
  const freshness: MachineWidgetFreshness = list.offline
    ? { kind: 'offline' }
    : page && list.status === 'error'
      ? { kind: 'stale', at: null }
      : { kind: 'live' };
  useMachineWidgetFreshness(freshness, props.testID);
  const items = page?.items;
  const counts = React.useMemo(() => {
    const all = items ?? [];
    const deletable = all
      .filter(canDelete)
      .sort((a, b) => b.size.allocatedBytes - a.size.allocatedBytes);
    return {
      all,
      deletable,
      deletableBytes: deletable.reduce(
        (sum, item) => sum + item.size.freesBytes,
        0,
      ),
      totalBytes: all.reduce((sum, item) => sum + item.size.allocatedBytes, 0),
      projects: new Set(all.map((item) => repositoryOf(item.path))).size,
    };
  }, [items]);
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (!page) {
    if (list.status === 'not_reported')
      return (
        <MachineWidgetState
          kind="not_reported"
          machineName={facts.name}
          testID={props.testID}
        />
      );
    if (list.offline)
      return (
        <MachineWidgetState
          kind="offline"
          machineName={facts.name}
          lastSeenAt={facts.lastSeenAt}
          testID={props.testID}
        />
      );
    if (list.status === 'error')
      return (
        <MachineWidgetState
          kind="error"
          onRetry={list.retry}
          testID={props.testID}
        />
      );
    return <MachineWidgetState kind="loading" rows={2} testID={props.testID} />;
  }
  if (counts.deletable.length === 0) {
    return (
      <MachineWidgetState
        kind="empty"
        testID={props.testID}
        title={t('machines.widgets.body.worktrees.nothingTitle')}
        reason={
          counts.all.length > 0
            ? t('machines.widgets.body.worktrees.nothingBody', {
                count: counts.all.length,
                size: formatMachineBytes(counts.totalBytes, 'storage'),
              })
            : undefined
        }
      />
    );
  }
  const number = (value: number) =>
    value.toLocaleString(getPreferredLanguage());
  const hero = (
    <View testID={`${props.testID}.hero`} style={styles.hero}>
      <View style={styles.valueRow}>
        <VitalsValue
          value={number(counts.deletable.length)}
          unit={t('machines.widgets.body.worktrees.canBeDeleted')}
        />
      </View>
      <VitalsSubLine>
        {t('machines.widgets.body.worktrees.heroDetail', {
          size: formatMachineBytes(counts.deletableBytes, 'storage'),
          total: number(counts.all.length),
          projects: counts.projects,
        })}
      </VitalsSubLine>
    </View>
  );
  const actions = facts.recipient ? (
    <Text testID={`${props.testID}.recipient`} style={styles.caption}>
      {t('machines.widgets.body.common.recipient')}
    </Text>
  ) : list.offline ? null : (
    <WorktreesReviewAction
      target={props.target}
      rows={counts.deletable}
      open={open}
      note={size !== 'wide'}
      testID={props.testID}
    />
  );
  const rows = LIST_ROWS[size];
  const largest = counts.deletable[0]?.size.allocatedBytes ?? 0;
  const rowsNode =
    rows > 0 ? (
      <View testID={`${props.testID}.rows`} style={styles.rows}>
        {counts.deletable.slice(0, rows).map((item, index, shown) => (
          <StorageItemRow
            key={item.itemId}
            testID={`${props.testID}.row.${item.itemId}`}
            title={item.title}
            evidence={(size === 'full'
              ? item.evidence
              : item.evidence.slice(0, 1)
            ).map(storageEvidenceLabel).join(' · ')}
            bytes={item.size.allocatedBytes}
            atLeast={item.size.atLeast}
            largest={largest}
            chip={null}
            compact
            showDivider={index < shown.length - 1}
          />
        ))}
      </View>
    ) : null;
  if (size === 'small')
    return (
      <View testID={props.testID} style={styles.column}>
        {hero}
        <View style={styles.end}>{actions}</View>
      </View>
    );
  if (size === 'wide') {
    return (
      <View testID={props.testID} style={styles.fill}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {hero}
              <View style={styles.end}>{actions}</View>
            </>
          }
          rest={rowsNode}
        />
      </View>
    );
  }
  const labelled = (
    <>
      <MachineWidgetSectionLabel
        label={t('machines.widgets.body.worktrees.largest')}
        meta={t('machines.widgets.body.worktrees.size')}
      />
      {rowsNode}
    </>
  );
  if (size === 'full' || size === 'large') {
    return (
      <View testID={props.testID} style={styles.fill}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {hero}
              <Text style={styles.caption}>
                {t('machines.widgets.body.worktrees.why', {
                  kept: number(counts.all.length - counts.deletable.length),
                })}
              </Text>
              <View style={styles.end}>{actions}</View>
            </>
          }
          rest={labelled}
        />
      </View>
    );
  }
  return (
    <View testID={props.testID} style={styles.column}>
      {hero}
      {labelled}
      <View style={styles.end}>{actions}</View>
    </View>
  );
}

/**
 * Review: the deletable worktrees go into the machine's one pile (add only, through the pile's own
 * collect owner) and the Worktrees page opens with them collected. Mounted only where it is offered.
 */
function WorktreesReviewAction(
  props: Readonly<{
    target: MachineWidgetTarget;
    rows: readonly StorageItemV1[];
    open: (tab?: MachinePageTabParams) => void;
    note: boolean;
    testID: string;
  }>,
) {
  const collect = useStorageCollect({
    serverId: props.target.serverId,
    machineId: props.target.machineId,
  });
  const { rows, open } = props;
  const review = React.useCallback(() => {
    if (collect.groupOf(rows) !== 'checked') collect.collectAll(rows);
    open(WORKTREES_TAB);
  }, [collect, open, rows]);
  const note = props.note ? t('machines.widgets.body.storage.trashFirst') : null;
  return (
    <View style={styles.actions}>
      <RoundButton
        testID={`${props.testID}.review`}
        size="small"
        display="secondary"
        title={t('machines.widgets.body.worktrees.review')}
        onPress={review}
      />
      {note ? (
        <Text style={styles.caption} numberOfLines={1}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flexGrow: 1, minWidth: 0 },
  column: { flexGrow: 1, minWidth: 0, gap: 14 },
  hero: { gap: theme.space.s2 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s6 },
  rows: { minWidth: 0 },
  end: { marginTop: 'auto' },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
  },
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
