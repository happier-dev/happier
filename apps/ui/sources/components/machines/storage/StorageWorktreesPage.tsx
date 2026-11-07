import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';

import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { useMachineStorageItems } from '@/sync/domains/machines/storage/useMachineStorageItems';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

import { StoragePageHead, StorageSayLine } from './StoragePageHead';
import {
  StorageCollectToggle,
  useStorageCollect,
  type StorageCollectController,
} from './StorageCollectToggle';
import { StorageItemRow } from './StorageItemRow';
import { StoragePileDock } from './StoragePileDock';
import { StoragePolicyNotice } from './StoragePolicyNotice';
import { StorageReadNotice } from './StorageReadNotice';
import { describeStorageVerdict, storageEvidenceLabel } from './storageReasonPresentation';
import { toStorageItemRef } from '@/sync/domains/machines/storage/pileRef';
import { storageVerdictStartsTicked } from '@/sync/domains/machines/storage/storageVerdictSelection';
import { StorageVolumeRow } from './StorageVolumes';
import { describeStorageFailure, selectStorageHeadlineVolume } from './storageViewModel';

type Filter = 'all' | 'canDelete' | 'keep';
type Sort = 'size' | 'used' | 'name';
/** Rows shown per Project before "Show all"; the rest stay one press away. */
const GROUP_PREVIEW_ROWS = 12;

/** A worktree's Project: the repository its `.dev/worktree` folder sits in (the main checkout is itself). */
export function repositoryOf(path: string): string {
  const match = /^(.*?)[\\/]\.dev[\\/]worktree[\\/]/u.exec(path);
  return (match ? match[1]! : path).replace(/[\\/]+$/u, '');
}
function nameOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}
const canDelete = (item: StorageItemV1) =>
  item.verdict === 'safe' || item.verdict === 'caution';

/**
 * Worktrees (plan 40 STO-7/8, lab `rs` W / Wp): every Happier-created worktree grouped by Project,
 * largest first, each with exactly one reason — Keep (main checkout, in use, changed files, unpushed
 * commits, unsaved edits, open PR), Can delete, or Check first with "Check now". Ticking collects; a
 * Project header collects all that can go. The disk's bar stays above so its ghost is in view.
 */
export const StorageWorktreesPage = React.memo(function StorageWorktreesPage(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    onBack: () => void;
    onOpenAdminAccess?: () => void;
  }>,
) {
  const language = usePreferredLanguage();
  const layout = useMachineTabCompactLayout();
  const target = { machineId: props.machineId, serverId: props.serverId };
  const summary = useMachineStorageSummary(target);
  const list = useMachineStorageItems({ ...target, list: 'worktrees' });
  const cleanup = useMachineStorageCleanup(target);
  const collect = useStorageCollect({ ...target, readOnly: summary.offline });
  const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [sort, setSort] = React.useState<Sort>('size');
  const [query, setQuery] = React.useState('');
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const items = list.page?.items ?? [];
  const counts = React.useMemo(
    () => ({
      all: items.length,
      canDelete: items.filter(canDelete).length,
      keep: items.filter((item) => !canDelete(item)).length,
    }),
    [items],
  );
  const groups = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = items.filter(
      (item) =>
        (filter === 'all' || (filter === 'canDelete') === canDelete(item)) &&
        (!needle ||
          item.title.toLowerCase().includes(needle) ||
          item.evidence.some((line) => storageEvidenceLabel(line).toLowerCase().includes(needle))),
    );
    const order = (a: StorageItemV1, b: StorageItemV1) =>
      sort === 'name'
        ? a.title.localeCompare(b.title)
        : sort === 'used'
          ? (a.lastUsedAt ?? a.lastChangedAt ?? 0) -
            (b.lastUsedAt ?? b.lastChangedAt ?? 0)
          : b.size.allocatedBytes - a.size.allocatedBytes;
    const byRepo = new Map<string, StorageItemV1[]>();
    for (const item of shown) {
      const key = repositoryOf(item.path);
      byRepo.set(key, [...(byRepo.get(key) ?? []), item]);
    }
    return [...byRepo.entries()]
      .map(([repo, rows]) => ({
        repo,
        rows: rows.sort(order),
        bytes: rows.reduce((sum, row) => sum + row.size.allocatedBytes, 0),
      }))
      .sort((a, b) => b.bytes - a.bytes);
  }, [filter, items, language, query, sort]);
  const largest = items.reduce(
    (max, item) => Math.max(max, item.size.allocatedBytes),
    0,
  );
  const total = items.reduce((sum, item) => sum + item.size.allocatedBytes, 0);
  const headline = summary.summary
    ? selectStorageHeadlineVolume(summary.summary)
    : null;
  const checkNow = React.useCallback(
    (item: StorageItemV1) => {
      void cleanup
        .check([toStorageItemRef(item)])
        .then(() => list.retry());
    },
    [cleanup, list],
  );
  const number = (value: number) =>
    value.toLocaleString(language);

  return (
    <View testID="machine-storage-worktrees" onLayout={layout.onLayout}>
      <StoragePageHead title={t('machineStorage.categories.worktrees.title')} onBack={props.onBack}>
        {list.page ? (
          <StorageSayLine
            testID="machine-storage-worktrees-sentence"
            lead={t('machineStorage.worktrees.lead', { size: formatMachineBytes(total, 'storage'), count: items.length })}
            text={t('machineStorage.worktrees.about', { count: counts.canDelete })}
          />
        ) : null}
      </StoragePageHead>
      <StorageReadNotice issues={list.page?.incomplete} onRetry={list.retry} onOpenRemedy={props.onOpenAdminAccess} />
      {headline ? (
        <ItemGroup header="none">
          <StorageVolumeRow volume={headline} compact={layout.compact} />
        </ItemGroup>
      ) : null}
      <ItemGroup surface="none" header="none">
        <View
          style={[styles.tools, layout.compact ? styles.toolsCompact : null]}
        >
          <View style={styles.find}>
            <CompactSearchField
              testID="machine-storage-worktrees-find"
              value={query}
              onChangeText={setQuery}
              placeholder={t('machineStorage.worktrees.find')}
              placement="page"
            />
          </View>
          <SegmentedTabBar<Filter>
            role="radiogroup"
            segmentSizing="content"
            accessibilityLabel={t('machineStorage.worktrees.filterLabel')}
            testIDPrefix="machine-storage-worktrees-filter"
            tabs={(['all', 'canDelete', 'keep'] as const).map((id) => ({
              id,
              label: t(`machineStorage.worktrees.filters.${id}`),
              count: number(counts[id]),
            }))}
            activeTabId={filter}
            onSelectTab={setFilter}
          />
          {!layout.compact ? (
            <PolicyValueSelect
              testID="machine-storage-worktrees-sort"
              label={t('machineStorage.worktrees.sortLabel')}
              value={t(`machineStorage.worktrees.sort.${sort}`)}
              selectedId={sort}
              choices={(['size', 'used', 'name'] as const).map((id) => ({
                id,
                title: t(`machineStorage.worktrees.sort.${id}`),
              }))}
              onSelect={(id) => setSort(id as Sort)}
            />
          ) : null}
        </View>
      </ItemGroup>
      {!list.page && list.offline ? (
        // Offline wins over a failed or unreported read: the machine is away, nothing to retry yet.
        <ItemGroup>
          <SurfaceStateCard
            testID="machine-storage-worktrees-offline"
            kind="unavailable"
            size="line"
            title={t('machineStorage.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineStorage.states.offlineReason')}
          />
        </ItemGroup>
      ) : !list.page && list.status === 'policy_unavailable' ? (
        <StoragePolicyNotice onRetry={list.retry} />
      ) : !list.page ? (
        <ItemGroup>
          <SurfaceStateCard
            testID="machine-storage-worktrees-state"
            kind={
              list.status === 'error'
                ? 'error'
                : list.status === 'not_reported'
                  ? 'unavailable'
                  : 'loading'
            }
            size="line"
            title={
              list.status === 'error'
                ? t('machineStorage.page.error')
                : list.status === 'not_reported'
                  ? t('machineStorage.states.notReported', {
                      machine: props.machineName,
                    })
                  : t('machineStorage.page.loading')
            }
            {...describeStorageFailure(list.failure)}
            action={
              list.status === 'error' && !list.offline
                ? { label: t('machineStorage.tryAgain'), onPress: list.retry, testID: 'machine-storage-worktrees-retry' }
                : undefined
            }
          />
        </ItemGroup>
      ) : groups.length === 0 ? (
        <ItemGroup>
          <SurfaceStateCard
            testID="machine-storage-worktrees-empty"
            kind="empty"
            size="line"
            title={t('machineStorage.worktrees.none')}
          />
        </ItemGroup>
      ) : (
        groups.map((group) => (
          <WorktreeGroup
            key={group.repo}
            repo={group.repo}
            rows={group.rows}
            bytes={group.bytes}
            largest={largest}
            collect={collect}
            compact={layout.compact}
            expanded={expanded.has(group.repo) || query.length > 0}
            onExpand={() =>
              setExpanded((current) => new Set([...current, group.repo]))
            }
            onCheckNow={checkNow}
            homeDir={homeDir}
          />
        ))
      )}
      {summary.summary && summary.status !== 'policy_unavailable' ? (
        <StoragePileDock
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          summary={summary.summary}
          compact={layout.compact}
          readOnly={summary.offline}
        />
      ) : null}
    </View>
  );
});

const WorktreeGroup = React.memo(function WorktreeGroup(
  props: Readonly<{
    repo: string;
    rows: readonly StorageItemV1[];
    bytes: number;
    largest: number;
    collect: StorageCollectController;
    compact: boolean;
    expanded: boolean;
    onExpand: () => void;
    onCheckNow: (item: StorageItemV1) => void;
    homeDir: string | undefined;
  }>,
) {
  const { collect } = props;
  const name = nameOf(props.repo);
  const groupState = collect.groupOf(props.rows);
  const sweep = props.rows.filter(
    (row) => storageVerdictStartsTicked(row.verdict) && collect.stateOf(row) === 'available',
  ).length;
  const shown = props.expanded
    ? props.rows
    : props.rows.slice(0, GROUP_PREVIEW_ROWS);
  const hidden = props.rows.length - shown.length;
  const meta = t('machineStorage.worktrees.groupMeta', {
    count: props.rows.length,
    size: formatMachineBytes(props.bytes, 'storage'),
  });
  return (
    <ItemGroup
      title={name}
      titleLeading={
        groupState ? (
          <StorageCollectToggle
            state={`group-${groupState}`}
            label={t('machineStorage.worktrees.collectGroup', { name })}
            onPress={() => collect.collectAll(props.rows)}
            testID={`machine-storage-worktrees-group-${name}-collect`}
          />
        ) : undefined
      }
      titleAccessory={<Text style={styles.meta}>{meta}</Text>}
      action={
        !props.compact && sweep > 0 ? (
          <TextLinkButton
            testID={`machine-storage-worktrees-group-${name}-all`}
            tone="strong"
            label={t('machineStorage.worktrees.collectAll', { count: sweep })}
            onPress={() => collect.collectAll(props.rows)}
          />
        ) : undefined
      }
    >
      {shown.map((row, index) => {
        const used = row.lastUsedAt ?? row.lastChangedAt;
        const evidence = [
          ...row.evidence.map(storageEvidenceLabel),
          ...(used !== undefined
            ? [
                t('machineStorage.page.used', {
                  when: formatRelativeTime(used),
                }),
              ]
            : []),
        ].join(' · ');
        return (
          <StorageItemRow
            key={row.itemId}
            testID={`machine-storage-worktree-${row.itemId}`}
            title={row.title}
            evidence={evidence}
            bytes={row.size.allocatedBytes}
            atLeast={row.size.atLeast}
            largest={props.largest}
            freesBytes={row.size.freesBytes}
            chip={describeStorageVerdict(row)}
            compact={props.compact}
            collect={collect.rowProps(row, shown)}
            trailing={
              row.verdict === 'check' ? (
                <TextLinkButton
                  testID={`machine-storage-worktree-${row.itemId}-check`}
                  tone="strong"
                  label={t('machineStorage.worktrees.checkNow')}
                  onPress={() => props.onCheckNow(row)}
                />
              ) : undefined
            }
            showDivider={index < shown.length - 1 || hidden > 0}
          />
        );
      })}
      {hidden > 0 ? (
        <View style={styles.more}>
          <Text style={styles.meta}>
            {t('machineStorage.worktrees.more', { count: hidden, name })}
          </Text>
          <TextLinkButton
            testID={`machine-storage-worktrees-group-${name}-show-all`}
            tone="strong"
            label={t('machineStorage.worktrees.showAll')}
            onPress={props.onExpand}
          />
        </View>
      ) : null}
    </ItemGroup>
  );
});

const styles = StyleSheet.create((theme) => ({
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
  },
  toolsCompact: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  find: {
    flex: 1,
    minWidth: 200,
  },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    gap: theme.space.s12,
  },
}));
