import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineStorageSuggestionsListInputV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';

import { MACHINE_PAGE_COLUMN, useMachinePageListHost } from '@/components/machines/page/machinePageContext';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageItems, type MachineStorageItemsHookResult } from '@/sync/domains/machines/storage/useMachineStorageItems';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { StorageSayLine } from '@/components/storage/StorageSayLine';
import { StorageHint, StoragePageHead } from './StoragePageHead';
import {
  useStorageCollect,
  type StorageCollectController,
} from './StorageCollectToggle';
import { StorageItemRow } from './StorageItemRow';
import { StoragePileDock } from './StoragePileDock';
import { StoragePolicyNotice } from './StoragePolicyNotice';
import { StorageReadNotice } from './StorageReadNotice';
import { describeStorageVerdict, storageEvidenceLabel } from './storageReasonPresentation';
import { StorageVolumeRow } from './StorageVolumes';
import { describeStorageFailure, selectStorageHeadlineVolume } from './storageViewModel';

type Group = NonNullable<MachineStorageSuggestionsListInputV1['group']>;
const GROUPS: readonly Group[] = [
  'can-be-rebuilt',
  'old-and-unused',
  'outside-happier',
];
const GROUP_KEYS = {
  'can-be-rebuilt': 'rebuilt',
  'old-and-unused': 'unused',
  'outside-happier': 'outside',
} as const;

/**
 * Suggestions (plan 40 STO-9, lab `rs` S / Sp): only what the machine has verified, grouped Can be
 * rebuilt · Old and unused · Outside Happier (the last only after a whole-disk scan), each with its
 * evidence, size and verdict. Ticking collects; "Collect all" takes a group's Safe and Caution items.
 *
 * A machine can have thousands of verified suggestions and the page lists every one, so it is one
 * virtualized sequence: each group's sheet is cut into segments of rows and only the segments near the
 * viewport mount. The machine page hands this page its scroll (`useMachinePageListHost`) so the page's
 * header and tabs lead the list and there is one scroller.
 */
export const StorageSuggestionsPage = React.memo(
  function StorageSuggestionsPage(
    props: Readonly<{
      serverId: string;
      machineId: string;
      machineName: string;
      onBack: () => void;
      onOpenAdminAccess?: () => void;
    }>,
  ) {
    const layout = useMachineTabCompactLayout();
    const host = useMachinePageListHost();
    const target = { machineId: props.machineId, serverId: props.serverId };
    const summary = useMachineStorageSummary(target);
    const collect = useStorageCollect({ ...target, readOnly: summary.offline });
    const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
    const rebuilt = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'can-be-rebuilt',
    });
    const unused = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'old-and-unused',
    });
    const outside = useMachineStorageItems({
      ...target,
      list: 'suggestions',
      group: 'outside-happier',
    });
    const lists = {
      'can-be-rebuilt': rebuilt,
      'old-and-unused': unused,
      'outside-happier': outside,
    };
    const { count, total, largest } = React.useMemo(() => {
      let counted = 0;
      let freed = 0;
      let biggest = 0;
      for (const list of [rebuilt, unused, outside]) {
        for (const item of list.page?.items ?? []) {
          counted += 1;
          freed += item.size.freesBytes;
          biggest = Math.max(biggest, item.size.allocatedBytes);
        }
      }
      return { count: counted, total: freed, largest: biggest };
    }, [rebuilt, unused, outside]);
    const ready = GROUPS.every((group) => lists[group].page !== null);
    const headline = summary.summary
      ? selectStorageHeadlineVolume(summary.summary)
      : null;
    // Offline wins over a failed or unreported read: the machine is away, nothing to retry yet.
    const allOffline = GROUPS.every((group) => !lists[group].page && lists[group].offline);
    const loading = !ready && GROUPS.every((group) => lists[group].status !== 'error' && lists[group].status !== 'policy_unavailable' && !lists[group].offline);
    const empty = ready && count === 0;
    const policyNoticeGroup = GROUPS.find((candidate) => lists[candidate].status === 'policy_unavailable' && !lists[candidate].page);
    const listing = !allOffline && !loading && !empty;
    const entries = React.useMemo(
      (): readonly SuggestionEntry[] => listing
        ? GROUPS.flatMap((group) => buildGroupEntries({
            group,
            state: { 'can-be-rebuilt': rebuilt, 'old-and-unused': unused, 'outside-happier': outside }[group],
            policyNotice: group === policyNoticeGroup,
            largest,
            collect,
            compact: layout.compact,
            homeDir,
          }))
        : [],
      [listing, rebuilt, unused, outside, policyNoticeGroup, largest, collect, layout.compact, homeDir],
    );
    const header = (
      <>
        {host?.chrome}
        <StoragePageHead title={t('machineStorage.suggestions.title')} onBack={props.onBack}>
          {ready ? (
            <StorageSayLine
              lead={t('machineStorage.suggestions.lead', { amount: formatMachineBytes(total, 'storage') })}
              text={t('machineStorage.suggestions.about', { count })}
            />
          ) : null}
        </StoragePageHead>
        <StorageReadNotice issues={[...(rebuilt.page?.incomplete ?? []), ...(unused.page?.incomplete ?? []), ...(outside.page?.incomplete ?? [])]}
          onRetry={() => { rebuilt.retry(); unused.retry(); outside.retry(); }} onOpenRemedy={props.onOpenAdminAccess} />
        {headline ? (
          <ItemGroup header="none">
            <StorageVolumeRow volume={headline} compact={layout.compact} />
          </ItemGroup>
        ) : null}
        {allOffline ? (
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-suggestions-offline"
              kind="unavailable"
              size="line"
              title={t('machineStorage.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineStorage.states.offlineReason')}
            />
          </ItemGroup>
        ) : loading ? (
          <ItemGroup>
            <SurfaceStateCard
              kind="loading"
              size="line"
              title={t('machineStorage.page.loading')}
            />
          </ItemGroup>
        ) : empty ? (
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-suggestions-empty"
              kind="empty"
              size="line"
              title={t('machineStorage.suggestions.none')}
            />
          </ItemGroup>
        ) : null}
      </>
    );
    const dockDrawn = summary.summary !== null && summary.status !== 'policy_unavailable';
    return (
      <View testID="machine-storage-suggestions" onLayout={layout.onLayout} style={styles.page}>
        <VirtualizedItemList
          testID="machine-storage-suggestions-list"
          pageColumn={MACHINE_PAGE_COLUMN}
          data={entries}
          keyExtractor={(entry) => entry.key}
          renderItem={renderEntry}
          ListHeaderComponent={header}
          ListFooterComponent={
            <StorageHint icon="shield-check" text={t('machineStorage.suggestions.hint', { machine: props.machineName })} />
          }
          // The pile stays on screen over the list, at the page column's width, however far the list is scrolled.
          bottomOverlay={summary.summary && dockDrawn ? (
            <StoragePileDock
              serverId={props.serverId}
              machineId={props.machineId}
              machineName={props.machineName}
              summary={summary.summary}
              compact={layout.compact}
              readOnly={summary.offline}
            />
          ) : null}
          refreshControl={host?.refreshControl}
          keyboardShouldPersistTaps="handled"
          estimatedItemSize={SUGGESTION_ROWS_PER_SEGMENT * 60}
        />
      </View>
    );
  },
);

function describeSuggestionEvidence(
  item: StorageItemV1,
  homeDir: string | undefined,
): string {
  return (
    item.evidence.length > 0
      ? item.evidence.map(storageEvidenceLabel)
      : [formatPathRelativeToHome(item.path, homeDir)]
  ).join(' · ');
}

/** One piece of the page's recycled sequence: a run of a group's sheet, or a notice standing in a group's place. */
type SuggestionEntry = Readonly<{ key: string; render: () => React.ReactElement }>;

const renderEntry = ({ item }: Readonly<{ item: SuggestionEntry }>) => item.render();

/** A group's rows per recycled segment: one continuous piece of its sheet. */
const SUGGESTION_ROWS_PER_SEGMENT = 12;

function buildGroupEntries(
  input: Readonly<{
    group: Group;
    state: MachineStorageItemsHookResult;
    policyNotice: boolean;
    largest: number;
    collect: StorageCollectController;
    compact: boolean;
    homeDir: string | undefined;
  }>,
): readonly SuggestionEntry[] {
  const { group, state } = input;
  // An offline group without an answer says nothing of its own: the page's offline line covers it.
  if (!state.page && state.offline) return [];
  if (state.status === 'policy_unavailable' && !state.page) {
    // One notice for the page, not one per group.
    return input.policyNotice
      ? [{ key: `${group}:policy`, render: () => <StoragePolicyNotice onRetry={state.retry} /> }]
      : [];
  }
  if (state.status === 'error' && !state.page) {
    return [{
      key: `${group}:error`,
      render: () => (
        <ItemGroup>
          <SurfaceStateCard
            testID={`machine-storage-suggestions-${group}-error`}
            kind="error"
            size="line"
            title={t('machineStorage.page.error')}
            {...describeStorageFailure(state.failure)}
            action={{ label: t('machineStorage.tryAgain'), onPress: state.retry, testID: `machine-storage-suggestions-${group}-retry` }}
          />
        </ItemGroup>
      ),
    }];
  }
  const items = state.page?.items ?? [];
  const entries: SuggestionEntry[] = [];
  for (let start = 0; start < items.length; start += SUGGESTION_ROWS_PER_SEGMENT) {
    const first = start === 0;
    const last = start + SUGGESTION_ROWS_PER_SEGMENT >= items.length;
    const segment = items.slice(start, start + SUGGESTION_ROWS_PER_SEGMENT);
    entries.push({
      key: first ? `${group}:head` : `${group}:${segment[0]!.itemId}`,
      render: () => (
        <SuggestionSegment
          group={group}
          items={items}
          segment={segment}
          first={first}
          last={last}
          largest={input.largest}
          collect={input.collect}
          compact={input.compact}
          homeDir={input.homeDir}
        />
      ),
    });
  }
  return entries;
}

/**
 * A run of one group's sheet. The first run carries the group's header (its name, size and Collect all), which
 * counts what Collect all would take: only while that run is on screen.
 */
const SuggestionSegment = React.memo(function SuggestionSegment(
  props: Readonly<{
    group: Group;
    /** The whole group: a range tick and Collect all reach past this run. */
    items: readonly StorageItemV1[];
    segment: readonly StorageItemV1[];
    first: boolean;
    last: boolean;
    largest: number;
    collect: StorageCollectController;
    compact: boolean;
    homeDir: string | undefined;
  }>,
) {
  const { collect } = props;
  return (
    <ItemGroup
      virtualizedSegment={{ first: props.first, last: props.last }}
      {...(props.first ? describeGroupHeader(props) : {})}
    >
      {props.segment.map((item, offset) => (
        <StorageItemRow
          key={item.itemId}
          testID={`machine-storage-suggestion-${item.itemId}`}
          title={item.title}
          evidence={describeSuggestionEvidence(item, props.homeDir)}
          bytes={item.size.allocatedBytes}
          atLeast={item.size.atLeast}
          largest={props.largest}
          freesBytes={item.size.freesBytes}
          chip={describeStorageVerdict(item)}
          compact={props.compact}
          collect={collect.rowProps(item, props.items)}
          showDivider={!(props.last && offset === props.segment.length - 1)}
        />
      ))}
    </ItemGroup>
  );
});

/** A group sheet's header: its name, how much it holds, and Collect all for what can go without a second look. */
function describeGroupHeader(
  props: Readonly<{
    group: Group;
    items: readonly StorageItemV1[];
    collect: StorageCollectController;
    compact: boolean;
  }>,
) {
  const { collect } = props;
  const sweep = props.items.filter(
    (item) => collect.stateOf(item) === 'available',
  ).length;
  const bytes = props.items.reduce(
    (sum, item) => sum + item.size.freesBytes,
    0,
  );
  const key = GROUP_KEYS[props.group];
  return {
    title: t(`machineStorage.suggestions.groups.${key}`),
    titleAccessory: (
      <Text style={styles.meta}>
        {props.group === 'outside-happier'
          ? t('machineStorage.suggestions.fromScan')
          : t('machineStorage.suggestions.groupMeta', {
              count: props.items.length,
              size: formatMachineBytes(bytes, 'storage'),
            })}
      </Text>
    ),
    action:
      !props.compact && sweep > 0 ? (
        <TextLinkButton
          tone="strong"
          testID={`machine-storage-suggestions-${key}-all`}
          label={t('machineStorage.suggestions.collectAll', { count: sweep })}
          onPress={() => collect.collectAll(props.items)}
        />
      ) : undefined,
  };
}

const styles = StyleSheet.create((theme) => ({
  page: {
    flex: 1,
    minHeight: 0,
  },
  meta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
