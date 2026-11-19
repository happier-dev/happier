import * as React from 'react';
import { StyleSheet } from 'react-native-unistyles';
import { Collection, useHappierCollection } from '@happier-dev/plugin-ui';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { PageCreateAction } from '@/components/navigation/mobile/chrome/pageCreateAction';
import { MainScreenHeader } from '@/components/navigation/shell/MainScreenHeader';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useReconciledStableRows } from '@/hooks/session/reconcileStableRows';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type {
  MachinePresetCollectionRow,
  MachinePresetCollectionSection,
} from '../collection/machineCollectionModel';
import {
  machinePresetCollectionHref,
  machinePresetCollectionRowKey,
} from '../collection/machineCollectionModel';
import { useMachineCollection } from '../collection/useMachineCollection';
import { useMachinesSettingsViewModel } from '../machinesSettingsViewModel';
import type { MachinePresetQueryState } from '../managed/useMachinePresets';
import type { ManagedMachinePresetListEntryV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { usePresetTableAnatomy, type PresetTableItem } from './presetTable';
import { projectManagedPresetAllocationCounts } from '../managed/hostMachineSandboxes';
import { projectSandboxPresetHostCounts } from '@/sync/domains/machines/machineIsolationPolicy';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

/** Facts the table shows once their owner delivers them (MACH-PRESETS-DATA-1119): In use now; Last used follows its link. */
const DELIVERED_FACTS = Object.freeze({ inUse: true, lastUsed: false });
const NO_MANAGED: readonly ManagedMachineV1[] = Object.freeze([]);

/**
 * Machines → Presets (lab ideas-1118-platform scene 7): what Happier creates a cloud machine or a sandbox from, as one
 * browse-and-act table in the Services shape (bare, ruled; REFERENCE-MAP `machines`). Each Home's presets are one
 * titled group when several Homes show; archived presets fold under Archive below the table. Rows open the preset's
 * page; the only button a row carries is its image's next step (lab review 4–5).
 */
export function MachinePresetsIndex() {
  const viewModel = useMachinesSettingsViewModel();
  const teamNamesByServerId = useMachinePresetTeamNames(
    viewModel.presetsByServerId,
  );
  const collection = useMachineCollection({
    groups: viewModel.visibleMachineGroups,
    groupedByHome: viewModel.showMachinesGroupedByServer,
    managedFirstAnswerPending: viewModel.managedFirstAnswerPending,
    query: '',
    managedByServerId: viewModel.managedByServerId,
    presetsByServerId: viewModel.presetsByServerId,
    teamNamesByServerId,
  });
  // In use (MACH-PRESETS-DATA-1119): machines Happier created from a cloud preset, plus the hosts whose Isolation added
  // a sandbox preset, each from its Home's existing inventory in one pass. Zero is said only from a settled, complete read.
  const managedEntries = viewModel.managedInventory?.entries;
  const inUseByKey = React.useMemo(() => {
    const result = new Map<string, number>();
    for (const group of viewModel.visibleMachineGroups) {
      const managedSettled = managedEntries?.[group.serverId]?.status === 'ready';
      const cloud = projectManagedPresetAllocationCounts(viewModel.managedByServerId?.[group.serverId] ?? NO_MANAGED);
      const sandboxes = projectSandboxPresetHostCounts(group.machines);
      for (const preset of viewModel.presetsByServerId?.[group.serverId] ?? []) {
        const count = (cloud.get(preset.id)?.allocated ?? 0) + (sandboxes.counts.get(preset.id) ?? 0);
        if (count > 0 || (managedSettled && sandboxes.complete)) result.set(machinePresetCollectionRowKey({ serverId: group.serverId, presetId: preset.id }), count);
      }
    }
    return result;
  }, [managedEntries, viewModel.managedByServerId, viewModel.presetsByServerId, viewModel.visibleMachineGroups]);
  return (
    <MachinePresetsPage
      inUseByKey={inUseByKey}
      sections={collection.presetSections}
      states={viewModel.presetInventory?.statesByServerId}
      grouped={viewModel.showMachinesGroupedByServer}
      activeServerId={viewModel.activeServerId}
      refresh={viewModel.presetInventory?.refresh}
    />
  );
}

/** The page over its Homes' preset sections (the read owners above supply them). */
export function MachinePresetsPage(props: Readonly<{
  sections: readonly MachinePresetCollectionSection[];
  states?: Readonly<Record<string, MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]> | undefined>>;
  grouped: boolean;
  activeServerId: string | null | undefined;
  /** Each preset's In use count, keyed as its row; absent while its inventory hasn't settled. */
  inUseByKey?: ReadonlyMap<string, number>;
  refresh?: () => void;
}>) {
  const router = useRouter();
  const { sections, states } = props;
  const open = React.useCallback(
    (serverId: string, presetId: string) => {
      const result = runGuardedNavigation(() =>
        router.push(
          machinePresetCollectionHref({ serverId, presetId }) as never,
        ),
      );
      if (result !== true)
        fireAndForget(result, { tag: 'MachinePresetsIndex.open' });
    },
    [router],
  );
  // A row's next step (Rebuild, Retry) runs where its builder and approval live: the preset's page.
  const onNextStep = React.useCallback(
    (item: PresetTableItem) => {
      if (item.preset) open(item.serverId, item.preset.id);
    },
    [open],
  );
  const anatomy = usePresetTableAnatomy({
    host: 'presets',
    facts: DELIVERED_FACTS,
    onNextStep,
  });

  // New presets go to the Home in focus, else the first Home listed (each Home keeps its own presets).
  const activeServerId = props.activeServerId || sections[0]?.serverId;
  const createLabel = t('machinePresets.newPreset');
  const create = React.useMemo<PageCreateAction | null>(
    () =>
      activeServerId
        ? {
            label: createLabel,
            testID: 'machine-presets.new',
            onPress: () => {
              const result = runGuardedNavigation(() =>
                router.push(
                  `/settings/machines/presets/new?serverId=${encodeURIComponent(activeServerId)}` as never,
                ),
              );
              if (result !== true)
                fireAndForget(result, { tag: 'MachinePresetsIndex.new' });
            },
          }
        : null,
    [activeServerId, createLabel, router],
  );

  const items = useReconciledStableRows(
    React.useMemo(
      () =>
        sections.flatMap((section) =>
          section.rows.map((row) => toItem(row, section.key, props.inUseByKey)),
        ),
      [props.inUseByKey, sections],
    ),
    readKey,
  );
  const archived = useReconciledStableRows(
    React.useMemo(
      () =>
        sections.flatMap((section) =>
          section.archivedRows.map((row) => toItem(row, section.key, props.inUseByKey)),
        ),
      [props.inUseByKey, sections],
    ),
    readKey,
  );
  // The first read reserves rows; a re-read keeps what is shown (TH D12).
  const loading =
    items.length === 0 &&
    archived.length === 0 &&
    sections.some(
      (section) =>
        states?.[section.serverId]?.loading === true &&
        states[section.serverId]?.value == null,
    );
  const grouped = props.grouped;
  const groupAxis = useReconciledStableRows(
    sections.map((section) => ({
      key: section.key,
      title: grouped ? (section.title ?? '') : '',
    })),
    (group) => group.key,
  );
  const groups = React.useMemo(
    () => ({
      axis: groupAxis,
      groupOf: (item: PresetTableItem & { sectionKey: string }) =>
        item.sectionKey,
    }),
    [groupAxis],
  );
  const model = useHappierCollection({
    items,
    keyOf: readKey,
    groups,
    openKey: null,
    onOpenChange: (key: string | number | null) => {
      const item =
        key === null ? null : items.find((candidate) => candidate.key === key);
      if (item?.preset) open(item.serverId, item.preset.id);
    },
  });
  const archivedModel = useHappierCollection({
    items: archived,
    keyOf: readKey,
    openKey: null,
    onOpenChange: (key: string | number | null) => {
      const item =
        key === null
          ? null
          : archived.find((candidate) => candidate.key === key);
      if (item?.preset) open(item.serverId, item.preset.id);
    },
  });

  const header = (
    <>
      <MainScreenHeader
        testID="machine-presets.header"
        alwaysShowTitle
        title={t('machinePresets.short')}
        description={t('machinePresets.indexLead')}
        create={create}
      />
      {/* What each Home says before its rows: a read waiting for approval, or why it couldn't be read. */}
      {sections.map((section) => (
        <MachinePresetHomeNotices
          key={section.key}
          section={section}
          state={states?.[section.serverId]}
          refresh={props.refresh}
          named={grouped}
        />
      ))}
    </>
  );
  return (
    <ItemList pageColumn="wide">
      <CoreCollectionScope renderPageScroller={passThroughPageScroller}>
        <PageContentColumn>
          <Collection<PresetTableItem & { sectionKey: string }>
            testID="machine-presets.table"
            model={model}
            anatomy={anatomy}
            accessibilityLabel={t('machinePresets.short')}
            presentation="list"
            detail="none"
            scroll="page"
            minListWidth={0}
            minDetailWidth={0}
            preferredListRatio={1}
            header={header}
            loading={loading}
            loadingRows={3}
            empty={
              <EmptyState
                testID="machine-presets.empty"
                layout="line"
                title={t('machinePresets.empty')}
              />
            }
          />
          {archived.length > 0 ? (
            <ItemGroup header="none" surface="none" style={styles.after}>
              <CountedDisclosureItem
                testID="machine-presets.archived"
                title={t('managedCleanup.archiveTitle')}
                count={archived.length}
              >
                <Collection<PresetTableItem & { sectionKey: string }>
                  testID="machine-presets.archived.table"
                  model={archivedModel}
                  anatomy={anatomy}
                  accessibilityLabel={t('managedCleanup.archiveTitle')}
                  presentation="list"
                  detail="none"
                  scroll="page"
                  minListWidth={0}
                  minDetailWidth={0}
                  preferredListRatio={1}
                />
              </CountedDisclosureItem>
            </ItemGroup>
          ) : null}
        </PageContentColumn>
      </CoreCollectionScope>
    </ItemList>
  );
}

/** A Home's pending read approval (opens Inbox) and its read failure (Access lost, Couldn't load) with Retry. */
function MachinePresetHomeNotices(
  props: Readonly<{
    section: MachinePresetCollectionSection;
    state?: MachinePresetQueryState<readonly ManagedMachinePresetListEntryV1[]>;
    refresh?: () => void;
    named: boolean;
  }>,
) {
  const router = useRouter();
  const serverId = props.section.serverId;
  const approval = useActionApprovalContinuation({
    scopeKey: JSON.stringify([serverId, props.state?.approval]),
    serverId,
    onExecuted: () => {},
  });
  React.useEffect(() => {
    if (props.state?.approval) approval.requestApproval(props.state.approval);
  }, [props.state?.approval, approval.requestApproval]);
  const error = props.state?.error;
  if (!approval.approvalId && !error) return null;
  const denied = error === 'permission_denied' || error === 'signed_out';
  return (
    <ItemGroup header="none" surface="none">
      {approval.approvalId ? (
        <Item
          testID={`machine-presets.approval.${serverId}`}
          title={t('approvals.status.open')}
          subtitle={
            props.named ? (props.section.title ?? undefined) : undefined
          }
          onPress={() => {
            const result = runGuardedNavigation(() =>
              router.push(
                `/inbox/approvals/${encodeURIComponent(approval.approvalId!)}?serverId=${encodeURIComponent(serverId)}` as never,
              ),
            );
            if (result !== true)
              fireAndForget(result, { tag: 'MachinePresetsIndex.approval' });
          }}
        />
      ) : null}
      {error ? (
        <SurfaceStateCard
          testID={`machine-presets.error.${serverId}`}
          size="line"
          kind={denied ? 'denied' : 'unavailable'}
          title={
            denied
              ? t('machinePresets.accessLost')
              : t('machinePresets.loadFailed')
          }
          detail={props.named ? (props.section.title ?? undefined) : undefined}
          diagnosticCode={error}
          action={
            props.refresh
              ? { label: t('common.retry'), onPress: props.refresh }
              : undefined
          }
        />
      ) : null}
    </ItemGroup>
  );
}

/** Team names for the Homes whose presets a Team owns, from the Teams directory the collection already reads. */
export function useMachinePresetTeamNames(
  presetsByServerId:
    | Readonly<Record<string, readonly ManagedMachinePresetListEntryV1[]>>
    | undefined,
) {
  const teamServerIds = React.useMemo(
    () =>
      Object.entries(presetsByServerId ?? {})
        .filter(([, presets]) =>
          presets.some((preset) => preset.owner.kind === 'team'),
        )
        .map(([serverId]) => serverId),
    [presetsByServerId],
  );
  const teams = useTeamsDirectory({
    serverIds: teamServerIds,
    enabled: teamServerIds.length > 0,
    archived: 'all',
  });
  return React.useMemo(() => {
    const names: Record<string, Record<string, string>> = {};
    for (const row of [...teams.rows, ...teams.archivedRows])
      (names[row.address.serverId] ??= {})[row.team.id] = row.team.name;
    return names;
  }, [teams.rows, teams.archivedRows]);
}

function toItem(
  row: MachinePresetCollectionRow,
  sectionKey: string,
  inUseByKey: ReadonlyMap<string, number> | undefined,
): PresetTableItem & { sectionKey: string } {
  const key = machinePresetCollectionRowKey(row);
  const inUse = inUseByKey?.get(key);
  return {
    key,
    ...(inUse === undefined ? {} : { inUse }),
    sectionKey,
    serverId: row.serverId,
    preset: row.preset,
    title: row.title,
    audience:
      row.preset.owner.kind === 'team'
        ? {
            kind: 'team',
            teamId: row.preset.owner.teamId,
            ...(row.teamName ? { knownName: row.teamName } : {}),
          }
        : { kind: 'account', label: row.audience },
  };
}

function readKey(item: PresetTableItem): string {
  return item.key;
}

function passThroughPageScroller(children: React.ReactNode): React.ReactNode {
  return children;
}

const styles = StyleSheet.create(() => ({
  after: {
    paddingTop: PAGE_LIST_METRICS.sectionGapPx,
  },
}));
