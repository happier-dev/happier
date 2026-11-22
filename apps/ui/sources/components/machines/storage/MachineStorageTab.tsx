import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierSkeletonBlock,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type {
  HappierStorageCategoryIdV1,
  StorageItemV1,
} from '@happier-dev/protocol/storage/storageV1';

import type {
  MachinePageTabBarAccessoryProps,
  MachinePageTabBodyProps,
  MachinePageTabParams,
} from '@/components/machines/page/machinePageTabQuery';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { MachineOfflineNotice } from '@/components/machines/page/MachineOfflineNotice';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { useMachineStorageItems } from '@/sync/domains/machines/storage/useMachineStorageItems';
import { useMachineStorageScan } from '@/sync/domains/machines/storage/useMachineStorageScan';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { useMachineField } from '@/sync/store/hooks';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { getVersionSupportState } from '@/utils/system/versionUtils';

import { StorageBreakdown } from './StorageBreakdown';
import { StorageCategoryPage } from './StorageCategoryPage';
import { StorageDockerCleanup } from './StorageDockerCleanup';
import { useStorageCollect } from './StorageCollectToggle';
import { StorageItemRow } from './StorageItemRow';
import { StorageSaySection } from '@/components/storage/StorageSayLine';
import { StoragePileDock } from './StoragePileDock';
import { StoragePolicyNotice } from './StoragePolicyNotice';
import { StorageReadNotice } from './StorageReadNotice';
import { formatStorageDay } from './storageCategoryText';
import { StorageProtectedFoldersPage } from './StorageProtectedFoldersPage';
import {
  describeStorageVerdict,
  STORAGE_CATEGORY_ICONS,
  storageCategoryTitle,
  storageReasonLabel,
  storageEvidenceLabel,
} from './storageReasonPresentation';
import { describeStorageApplyResult } from './storageReviewModel';
import { StorageSuggestionsPage } from './StorageSuggestionsPage';
import { StorageTidySettings } from './StorageTidySettings';
import { StorageVolumes } from './StorageVolumes';
import { StorageWholeDiskView } from './StorageWholeDiskView';
import { StorageWorktreesPage } from './StorageWorktreesPage';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import {
  describeMachineAttentionWord,
  readMachinePublishedResources,
  resolveMachineReasonAction,
} from '@/components/machines/summary/machineResourceSentences';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import {
  describeStorageSentence,
  describeStorageFailure,
  describeStorageVolumeCleanupRefusal,
  readStorageCanGoBytes,
  selectStorageTabView,
  storageVolumeName,
  type StorageSentenceFacts,
  type StorageSummary,
} from './storageViewModel';

type StorageParams = Extract<MachinePageTabParams, { id: 'storage' }>;
/** The suggestions the Happier view lists in place before "All suggestions" (lab `rs` H). */
const TOP_SUGGESTIONS = 3;
/** The only kinds a recipient of a shared machine reaches: their own sessions' folders and their own Trash (D7). */
const RECIPIENT_CATEGORIES = ['sessionFolders', 'trash'] as const satisfies readonly HappierStorageCategoryIdV1[];

export const MachineStorageTab = React.memo(function MachineStorageTab(
  props: MachinePageTabBodyProps,
) {
  const params: StorageParams =
    props.params.id === 'storage' ? props.params : { id: 'storage' };
  const { setParams } = props;
  const openCategory = React.useCallback(
    (categoryId: HappierStorageCategoryIdV1) => {
      setParams(
        categoryId === 'worktrees'
          ? { id: 'storage', page: 'worktrees' }
          : { id: 'storage', page: 'category', categoryId },
      );
    },
    [setParams],
  );
  const back = React.useCallback(
    () => setParams({ id: 'storage' }),
    [setParams],
  );
  // A read the owner could not finish names its remedy: admin access, set in the Security tab by whoever manages the Machine.
  const { recipient } = useMachineTabFacts(props.serverId, props.machineId);
  const openAdminAccess = React.useCallback(
    () => setParams({ id: 'security' }),
    [setParams],
  );
  const page = {
    serverId: props.serverId,
    machineId: props.machineId,
    machineName: props.machineName,
    onBack: back,
    onOpenAdminAccess: recipient ? undefined : openAdminAccess,
  };
  if (params.page === 'category' && params.categoryId)
    return <StorageCategoryPage {...page} categoryId={params.categoryId} />;
  if (params.page === 'worktrees') return <StorageWorktreesPage {...page} />;
  if (params.page === 'suggestions')
    return <StorageSuggestionsPage {...page} />;
  if (params.page === 'protected')
    return <StorageProtectedFoldersPage {...page} />;
  return (
    <StorageMainView
      serverId={props.serverId}
      machineId={props.machineId}
      machineName={props.machineName}
      params={params}
      setParams={setParams}
      onOpenCategory={openCategory}
      onOpenAdminAccess={page.onOpenAdminAccess}
      barAccessoryShown={props.barAccessoryShown === true}
    />
  );
});

/** "Sized 10:41 · Size again" (or the scan's age on Whole disk) and Happier | Whole disk, at the end of the tab bar on a wide page. */
export const StorageTabBarAccessory = React.memo(
  function StorageTabBarAccessory(props: MachinePageTabBarAccessoryProps) {
    if (
      !props.params ||
      props.params.id !== 'storage' ||
      !props.setParams ||
      props.params.page === 'protected'
    )
      return null;
    return (
      <StorageTabControls
        serverId={props.serverId}
        machineId={props.machineId}
        params={props.params}
        setParams={props.setParams}
      />
    );
  },
);

function StorageTabControls(
  props: Readonly<{
    serverId: string;
    machineId: string;
    params: StorageParams;
    setParams: (next: MachinePageTabParams) => void;
    /** In the body (a phone): the age leads on the left and the switch ends the line (lab `rs` Hp). */
    inBody?: boolean;
  }>,
) {
  const { recipient } = useMachineTabFacts(props.serverId, props.machineId);
  const storage = useMachineStorageSummary({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const disk = props.params.view === 'disk';
  const [sizing, setSizing] = React.useState(false);
  const { sizeAgain } = storage;
  const onSizeAgain = React.useCallback(() => {
    setSizing(true);
    fireAndForget(
      sizeAgain().finally(() => setSizing(false)),
      { tag: 'MachineStorageTab.sizeAgain' },
    );
  }, [sizeAgain]);
  if (!storage.summary) return null;
  return (
    <View style={[styles.controls, props.inBody ? styles.controlsInBody : null]}>
      {disk ? (
        <ScanFreshness
          serverId={props.serverId}
          machineId={props.machineId}
          summary={storage.summary}
          offline={storage.offline}
        />
      ) : (
        <StorageFreshnessLine
          sizedAt={storage.summary.sizedAt}
          offline={storage.offline}
          stale={storage.status === 'error' && !storage.offline}
          failure={storage.failure}
          sizing={sizing}
          onSizeAgain={storage.offline ? null : onSizeAgain}
        />
      )}
      {!recipient ? (
        <SegmentedTabBar<'happier' | 'disk'>
          role="radiogroup"
          segmentSizing="content"
          accessibilityLabel={t('machineStorage.scope.label')}
          testIDPrefix="machine-storage-scope"
          tabs={[
            { id: 'happier', label: t('machineStorage.scope.happier') },
            { id: 'disk', label: t('machineStorage.scope.disk') },
          ]}
          activeTabId={disk ? 'disk' : 'happier'}
          onSelectTab={(next) =>
            props.setParams(
              next === 'disk'
                ? { id: 'storage', view: 'disk' }
                : { id: 'storage' },
            )
          }
        />
      ) : null}
    </View>
  );
}

/** "Scanned today 10:41 · Scan again" for the whole-disk view; nothing while a scan runs (its progress speaks). */
function ScanFreshness(
  props: Readonly<{
    serverId: string;
    machineId: string;
    summary: StorageSummary;
    offline: boolean;
  }>,
) {
  const scan =
    props.summary.wholeDisk.scans
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
  const control = useMachineStorageScan({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  // Only a finished scan has an age; a stopped one is said, with Resume, by the view itself.
  if (!scan || scan.status !== 'complete' || !scan.finishedAt) return null;
  return (
    <SurfaceFreshnessLine
      testID="machine-storage-scan-freshness"
      presentation="chip"
      signal={props.offline ? 'quiet' : undefined}
      reason={t(
        props.offline
          ? 'machineStorage.disk.scannedOffline'
          : 'machineStorage.disk.scanned',
        { time: formatAsOfTime(scan.finishedAt) },
      )}
      action={props.offline ? undefined : {
        label: t('machineStorage.disk.scanAgain'),
        testID: 'machine-storage-scan-again',
        onPress: () => control.start({ target: scan.target }),
      }}
    />
  );
}

function StorageMainView(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    params: StorageParams;
    setParams: (next: MachinePageTabParams) => void;
    onOpenCategory: (categoryId: HappierStorageCategoryIdV1) => void;
    onOpenAdminAccess: (() => void) | undefined;
    barAccessoryShown: boolean;
  }>,
) {
  const { recipient } = useMachineTabFacts(props.serverId, props.machineId);
  const cliVersion = useMachineField(props.machineId, 'metadata', 'happyCliVersion', { serverId: props.serverId });
  const storage = useMachineStorageSummary({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const view = selectStorageTabView({
    status: storage.status,
    enabled: storage.enabled,
    summary: storage.summary,
    offline: storage.offline,
    recipient,
    failure: storage.failure,
  });
  const layout = useMachineTabCompactLayout();
  const { retry } = storage;

  // The page header says it is offline; with nothing read yet, the tab says what that means here (one notice per tab).
  if (view.kind === 'offline_empty') {
    return <MachineOfflineNotice testID="machine-storage-offline_empty" title={t('machineStorage.states.offlineReason')} />;
  }
  if (view.kind === 'not_reported' || view.kind === 'waiting') {
    return (
      // The page's tab strip already leaves the gap before a tab's first block.
      <ItemGroup header="none">
        <SurfaceStateCard
          testID={`machine-storage-${view.kind}`}
          kind="unavailable"
          size="line"
          title={t(view.kind === 'not_reported' ? 'machineStorage.states.notReported' : 'projects.checkouts.waiting',
            { machine: props.machineName })}
        />
      </ItemGroup>
    );
  }
  if (view.kind === 'policy_unavailable') return <StoragePolicyNotice onRetry={retry} />;
  if (view.kind === 'error') {
    const failure = describeStorageFailure(view.failure);
    const reason = view.failure?.error && getVersionSupportState(cliVersion ?? undefined) === 'unsupported'
      ? `${failure.reason} ${t('sessionInfo.updateCliInstructions')}`
      : failure.reason;
    return (
      <ItemGroup header="none">
        <SurfaceStateCard
          testID="machine-storage-error"
          kind="error"
          size="line"
          {...failure}
          reason={reason}
          title={t('machineStorage.states.error', {
            machine: props.machineName,
          })}
          action={{
            label: t('machineStorage.tryAgain'),
            onPress: retry,
            testID: 'machine-storage-retry',
          }}
        />
      </ItemGroup>
    );
  }
  const disk =
    props.params.view === 'disk' && view.kind === 'ready' && !view.recipient;
  return (
    <View testID="machine-storage" onLayout={layout.onLayout}>
      {!props.barAccessoryShown ? (
        <ItemGroup surface="none" header="none">
          <StorageTabControls
            serverId={props.serverId}
            machineId={props.machineId}
            params={props.params}
            setParams={props.setParams}
            inBody
          />
        </ItemGroup>
      ) : null}
      {view.kind === 'ready' && !disk ? <StorageReadNotice issues={view.summary.incomplete} onRetry={retry} onOpenRemedy={props.onOpenAdminAccess} /> : null}
      {view.kind === 'loading' ? (
        <StorageLoading serverId={props.serverId} machineId={props.machineId} machineName={props.machineName} setParams={props.setParams} />
      ) : disk ? (
        <StorageWholeDiskView
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          summary={view.summary}
          offline={view.offline}
          params={props.params}
          setParams={props.setParams}
          onOpenAdminAccess={props.onOpenAdminAccess}
          sentence={
            <StorageSentence
              facts={describeStorageSentence(view.summary, {
                recipient: false,
                policyUnavailable: view.policyUnavailable,
              })}
              tidy={isStorageNothingToClear(view.summary, { recipient: false, policyUnavailable: view.policyUnavailable })}
              machineName={props.machineName}
            />
          }
        />
      ) : (
        <StorageHappierView
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          summary={view.summary}
          offline={view.offline}
          recipient={view.recipient}
          policyUnavailable={view.policyUnavailable}
          onRetry={retry}
          onSizeAgain={storage.sizeAgain}
          compact={layout.compact}
          lowDiskVolumeId={
            props.params.prepare === 'lowDisk'
              ? (props.params.volumeId ?? null)
              : null
          }
          onOpenCategory={props.onOpenCategory}
          setParams={props.setParams}
        />
      )}
    </View>
  );
}

/** "All tidy.": the custodian's sized storage has nothing that can go and nothing to suggest. */
function isStorageNothingToClear(
  summary: StorageSummary,
  scope: Readonly<{ recipient: boolean; policyUnavailable: boolean }>,
): boolean {
  return !scope.recipient && !scope.policyUnavailable && !summary.incomplete?.length && readStorageCanGoBytes(summary) === 0 && summary.suggestionsTop.length === 0;
}

/** The Happier view (lab `rs` H / Hp / HR / RD / LD): what Happier keeps, what can go, and the pile. */
function StorageHappierView(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    summary: StorageSummary;
    offline: boolean;
    recipient: boolean;
    /** Protection and cleanup await the machine's resources policy: sizes only, nothing that offers to clear. */
    policyUnavailable: boolean;
    onRetry: () => void;
    onSizeAgain: () => Promise<unknown>;
    compact: boolean;
    lowDiskVolumeId: string | null;
    onOpenCategory: (categoryId: HappierStorageCategoryIdV1) => void;
    setParams: (next: MachinePageTabParams) => void;
  }>,
) {
  const lowDisk = props.lowDiskVolumeId && !props.policyUnavailable
    ? (props.summary.volumes.find(
        (volume) => volume.volume.volumeId === props.lowDiskVolumeId,
      ) ?? null)
    : null;
  const custodian = !props.recipient;
  const nothingToClear = isStorageNothingToClear(props.summary, props);
  return (
    <>
      {lowDisk && custodian ? null : (
        <StorageSentence
          facts={describeStorageSentence(props.summary, {
            recipient: props.recipient,
            policyUnavailable: props.policyUnavailable,
          })}
          tidy={nothingToClear}
          machineName={props.machineName}
        />
      )}
      {props.policyUnavailable ? <StoragePolicyNotice onRetry={props.onRetry} /> : null}
      {custodian && !lowDisk ? (
        <StorageDiskAttention
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          summary={props.summary}
          offline={props.offline}
          setParams={props.setParams}
        />
      ) : null}
      {lowDisk && custodian ? (
        <StorageLowDisk
          serverId={props.serverId}
          machineId={props.machineId}
          machineName={props.machineName}
          volumeId={lowDisk.volume.volumeId}
          volumeName={storageVolumeName(lowDisk)}
          summary={props.summary}
          compact={props.compact}
          offline={props.offline}
        />
      ) : null}
      <StorageVolumes summary={props.summary} compact={props.compact} />
      {/* What just happened reads under the disk it changed (lab `rs` RD): the disk stays the view's first block. */}
      <StorageResultSection
        serverId={props.serverId}
        machineId={props.machineId}
      />
      {props.recipient ? (
        <RecipientStorageEntries
          machineName={props.machineName}
          onOpenCategory={props.onOpenCategory}
        />
      ) : (
        <>
          <StorageBreakdown
            serverId={props.serverId}
            machineId={props.machineId}
            summary={props.summary}
            compact={props.compact}
            cleanupHidden={props.policyUnavailable}
            onOpenCategory={props.onOpenCategory}
          />
          {props.summary.docker && !props.policyUnavailable ? (
            <StorageDockerCleanup
              serverId={props.serverId}
              machineId={props.machineId}
              machineName={props.machineName}
              docker={props.summary.docker}
              offline={props.offline}
              onSizeAgain={props.onSizeAgain}
              compact={props.compact}
            />
          ) : null}
          {nothingToClear ? (
            <ItemGroup>
              <SurfaceStateCard
                testID="machine-storage-nothing"
                kind="success"
                title={t('machineStorage.nothing.title')}
                reason={t('machineStorage.nothing.body')}
                secondaryAction={
                  props.offline
                    ? undefined
                    : {
                        label: t('machineStorage.invite.scanWholeDisk'),
                        onPress: () =>
                          props.setParams({ id: 'storage', view: 'disk' }),
                      }
                }
              />
            </ItemGroup>
          ) : lowDisk || props.policyUnavailable ? null : (
            <StorageTopSuggestions
              serverId={props.serverId}
              machineId={props.machineId}
              items={props.summary.suggestionsTop}
              compact={props.compact}
              offline={props.offline}
              onOpenAll={() =>
                props.setParams({ id: 'storage', page: 'suggestions' })
              }
            />
          )}
          {!props.summary.wholeDisk.scans.some(
            (scan) => scan.status === 'complete',
          ) &&
          !props.offline &&
          !props.policyUnavailable &&
          !nothingToClear ? (
            <StorageInvite
              summary={props.summary}
              machineName={props.machineName}
              onScan={() => props.setParams({ id: 'storage', view: 'disk' })}
            />
          ) : null}
          <StorageTidySettings
            serverId={props.serverId}
            machineId={props.machineId}
            machineName={props.machineName}
            summary={props.summary}
            onOpenProtected={() =>
              props.setParams({ id: 'storage', page: 'protected' })
            }
          />
          {props.policyUnavailable ? null : (
            <StoragePileDock
              serverId={props.serverId}
              machineId={props.machineId}
              machineName={props.machineName}
              summary={props.summary}
              compact={props.compact}
              readOnly={props.offline}
              {...(lowDisk
                ? {
                    readyNote: t('machineStorage.lowDisk.pileNote', {
                      volume: storageVolumeName(lowDisk, 'sentence'),
                    }),
                  }
                : {})}
            />
          )}
        </>
      )}
    </>
  );
}

/**
 * A disk the machine says is nearly full (or full), in amber, with its one way out: the published attention
 * reason and its action (`resolveMachineReasonAction`) are the same ones the Inbox and the page header use,
 * so "Free up space" here opens the same prepared low-disk view.
 */
function StorageDiskAttention(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    summary: StorageSummary;
    offline: boolean;
    setParams: (next: MachinePageTabParams) => void;
  }>,
) {
  const resources = useMachineField(props.machineId, 'daemonState', 'resources', { serverId: props.serverId });
  const reason = React.useMemo(
    () => readMachinePublishedResources({ resources })?.attention.reasons.find(
      (entry) => entry.kind === 'disk_nearly_full' || entry.kind === 'disk_full',
    ) ?? null,
    [resources],
  );
  if (!reason || (reason.kind !== 'disk_nearly_full' && reason.kind !== 'disk_full')) return null;
  const volume = props.summary.volumes.find((entry) => entry.volume.volumeId === reason.volumeId);
  // A disk the owner says Happier cannot clean says why, and offers no clean action.
  const refusal = volume ? describeStorageVolumeCleanupRefusal(volume) : null;
  const action = props.offline || refusal ? null : resolveMachineReasonAction(reason);
  const usedPct = volume && volume.totalBytes > 0
    ? Math.round((1 - volume.freeBytes / volume.totalBytes) * 100)
    : null;
  const detail = reason.kind === 'disk_full'
    ? t('machines.widgets.body.storage.fullDetail', { machine: props.machineName })
    : volume && usedPct !== null
      ? t('machines.widgets.body.storage.nearlyFullDetail', {
          percent: usedPct,
          total: formatMachineBytes(volume.totalBytes, 'storage'),
          happier: formatMachineBytes(volume.happierBytes, 'storage'),
        })
      : undefined;
  return (
    <ItemGroup header="none">
      <SurfaceStateCard
        testID="machine-storage-disk-attention"
        kind="warning"
        size="line"
        title={describeMachineAttentionWord(reason)}
        {...(detail || refusal ? { reason: [detail, refusal].filter(Boolean).join(' ') } : {})}
        {...(action ? {
          action: {
            label: action.label,
            testID: 'machine-storage-disk-attention-action',
            onPress: () => {
              beginMachinePageTabIntent({ serverId: props.serverId, machineId: props.machineId }, action.tab);
              props.setParams(action.tab);
            },
          },
        } : {})}
      />
    </ItemGroup>
  );
}

/** "Easy to get back": the three biggest verified suggestions, tickable in place (lab `rs` H). */
function StorageTopSuggestions(
  props: Readonly<{
    serverId: string;
    machineId: string;
    items: readonly StorageItemV1[];
    compact: boolean;
    offline: boolean;
    onOpenAll: () => void;
  }>,
) {
  const collect = useStorageCollect({
    serverId: props.serverId,
    machineId: props.machineId,
    readOnly: props.offline,
  });
  if (props.items.length === 0) return null;
  const shown = props.items.slice(0, TOP_SUGGESTIONS);
  const total = props.items.reduce(
    (sum, item) => sum + item.size.freesBytes,
    0,
  );
  const largest = shown.reduce(
    (max, item) => Math.max(max, item.size.allocatedBytes),
    0,
  );
  return (
    <ItemGroup
      title={t('machineStorage.suggestions.easy')}
      titleAccessory={
        <Text style={styles.accessory}>
          {props.compact
            ? formatMachineBytes(total, 'storage')
            : t('machineStorage.suggestions.easyMeta', {
                amount: formatMachineBytes(total, 'storage'),
              })}
        </Text>
      }
      action={
        <TextLinkButton
          testID="machine-storage-all-suggestions"
          label={t('machineStorage.suggestions.all')}
          onPress={props.onOpenAll}
        />
      }
    >
      {shown.map((item, index) => (
        <StorageItemRow
          key={item.itemId}
          testID={`machine-storage-top-suggestion-${item.itemId}`}
          title={item.title}
          evidence={item.evidence.map(storageEvidenceLabel).join(' · ')}
          bytes={item.size.allocatedBytes}
          atLeast={item.size.atLeast}
          largest={largest}
          chip={describeStorageVerdict(item)}
          compact={props.compact}
          freesBytes={item.size.freesBytes}
          collect={collect.rowProps(item, shown)}
          showDivider={index < shown.length - 1}
        />
      ))}
    </ItemGroup>
  );
}

/**
 * The low-disk moment (STO-23, lab `rs` LD / LDp): the quickest verified Safe items for the disk. The
 * entry the person tapped ("Free up space") already put them in the pile (`beginMachinePageTabIntent`);
 * this only shows the prepared pile, each still untickable, and the disk's ghost. It writes nothing.
 */
function StorageLowDisk(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    volumeId: string;
    volumeName: string;
    summary: StorageSummary;
    compact: boolean;
    offline: boolean;
  }>,
) {
  const quickest = useMachineStorageItems({
    machineId: props.machineId,
    serverId: props.serverId,
    list: 'suggestions',
    quickestForVolume: props.volumeId,
  });
  const collect = useStorageCollect({
    serverId: props.serverId,
    machineId: props.machineId,
    readOnly: props.offline,
  });
  const items = React.useMemo(
    () =>
      (quickest.page?.items ?? []).filter((item) => item.verdict === 'safe'),
    [quickest.page],
  );
  const volume = props.summary.volumes.find(
    (entry) => entry.volume.volumeId === props.volumeId,
  );
  const frees = items.reduce((sum, item) => sum + item.size.freesBytes, 0);
  const pct = (free: number) =>
    volume && volume.totalBytes > 0
      ? Math.round(((volume.totalBytes - free) / volume.totalBytes) * 100)
      : 0;
  const largest = items.reduce(
    (max, item) => Math.max(max, item.size.allocatedBytes),
    0,
  );
  return (
    <>
      <StorageSaySection
        testID="machine-storage-lowdisk-sentence"
        lead={t('machineStorage.lowDisk.lead', { amount: formatMachineBytes(frees, 'storage'), volume: props.volumeName })}
        text={volume
          ? t('machineStorage.lowDisk.about', {
              from: pct(volume.freeBytes),
              to: pct(volume.freeBytes + frees),
            })
          : ''}
      />
      {quickest.page && items.length === 0 ? (
        <ItemGroup>
          <SurfaceStateCard
            kind="empty"
            size="line"
            title={t('machineStorage.lowDisk.none', {
              volume: props.volumeName,
            })}
          />
        </ItemGroup>
      ) : (
        <ItemGroup
          title={t('machineStorage.lowDisk.title', {
            amount: formatMachineBytes(frees, 'storage'),
          })}
          description={t('machineStorage.lowDisk.description', {
            count: items.length,
            machine: props.machineName,
          })}
        >
          {items.map((item, index) => (
            <StorageItemRow
              key={item.itemId}
              testID={`machine-storage-lowdisk-${item.itemId}`}
              title={item.title}
              evidence={item.evidence.map(storageEvidenceLabel).join(' · ')}
              bytes={item.size.allocatedBytes}
              atLeast={item.size.atLeast}
              largest={largest}
              chip={describeStorageVerdict(item)}
              compact={props.compact}
              freesBytes={item.size.freesBytes}
              collect={collect.rowProps(item, items)}
              showDivider={index < items.length - 1}
            />
          ))}
        </ItemGroup>
      )}
    </>
  );
}

/**
 * What a person who uses a shared machine without managing it can tidy: their own session folders and
 * what they moved to the Trash (D7). The breakdown of everything else stays with those who manage it.
 */
function RecipientStorageEntries(
  props: Readonly<{
    machineName: string;
    onOpenCategory: (categoryId: HappierStorageCategoryIdV1) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { onOpenCategory } = props;
  return (
    <ItemGroup
      testID="machine-storage-recipient"
      title={t('machineStorage.breakdown.recipientTitle')}
      description={t('machineStorage.breakdown.recipient', {
        machine: props.machineName,
      })}
    >
      {RECIPIENT_CATEGORIES.map((categoryId, index) => (
        <Item
          key={categoryId}
          testID={`machine-storage-category-${categoryId}`}
          icon={
            <Icon
              name={STORAGE_CATEGORY_ICONS[categoryId]}
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          title={storageCategoryTitle(categoryId)}
          showChevron
          showDivider={index < RECIPIENT_CATEGORIES.length - 1}
          onPress={() => onOpenCategory(categoryId)}
        />
      ))}
    </ItemGroup>
  );
}

/** "Just now": what the last review did not act on, each with its reason (lab `rs` RD). */
function StorageResultSection(
  props: Readonly<{ serverId: string; machineId: string }>,
) {
  const { theme } = useUnistyles();
  const { receipt } = useMachineStorageCleanup({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  if (receipt?.kind !== 'applied') return null;
  const counts = describeStorageApplyResult(receipt.result);
  if (counts.notActed.length === 0) return null;
  const name = (itemId: string) =>
    (receipt.paths[itemId] ?? itemId).split(/[\\/]/u).filter(Boolean).pop() ??
    itemId;
  const time = formatAsOfTime(receipt.at);
  return (
    <ItemGroup
      title={t('machineStorage.result.title')}
      titleAccessory={
        <Text style={styles.accessory}>
          {t('machineStorage.result.meta', {
            acted: counts.acted,
            skipped: counts.skipped + counts.refused + counts.failed,
            mode: receipt.result.mode,
          })}
        </Text>
      }
    >
      {counts.notActed.map((outcome, index) => (
        <Item
          key={outcome.itemId}
          testID={`machine-storage-result-${outcome.itemId}`}
          mode="info"
          showChevron={false}
          icon={
            <Icon
              name="warning-circle"
              size={18}
              color={theme.colors.state.attention.textForeground}
            />
          }
          title={t(
            `machineStorage.result.${outcome.status === 'skipped' ? 'skipped' : outcome.status === 'refused' ? 'refused' : 'failed'}`,
            { name: name(outcome.itemId) },
          )}
          subtitle={
            outcome.reason ? storageReasonLabel(outcome.reason) : undefined
          }
          detail={time}
          showDivider={index < counts.notActed.length - 1}
        />
      ))}
    </ItemGroup>
  );
}

/** "Everything else on leeroy-mbp": the invitation to the whole disk (lab `rs` H, Hp). */
function StorageInvite(
  props: Readonly<{
    summary: StorageSummary;
    machineName: string;
    onScan: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const elsewhere = props.summary.volumes.reduce(
    (sum, volume) =>
      sum +
      Math.max(0, volume.totalBytes - volume.freeBytes - volume.happierBytes),
    0,
  );
  return (
    <ItemGroup>
      <Item
        testID="machine-storage-invite"
        mode="info"
        showChevron={false}
        accessoryLayout="adaptive"
        icon={
          <Icon
            name="hard-drives"
            size={20}
            color={theme.colors.text.secondary}
          />
        }
        title={t('machineStorage.invite.title', { machine: props.machineName })}
        subtitle={t('machineStorage.invite.body', {
          amount: formatMachineBytes(elsewhere, 'storage'),
        })}
        rightElement={
          <TextLinkButton
            testID="machine-storage-invite-scan"
            tone="strong"
            label={t('machineStorage.invite.scanWholeDisk')}
            onPress={props.onScan}
          />
        }
      />
    </ItemGroup>
  );
}

/** "Sized 10:41 · Size again", "Sizing…", "Offline · as of 10:41", or the failed re-size with its retry. */
function StorageFreshnessLine(
  props: Readonly<{
    sizedAt: number;
    offline: boolean;
    stale: boolean;
    failure?: ReturnType<typeof useMachineStorageSummary>['failure'];
    sizing: boolean;
    onSizeAgain: (() => void) | null;
  }>,
) {
  const time = formatAsOfTime(props.sizedAt);
  const label = props.sizing
    ? t('machineStorage.sizing')
    : props.offline
      ? t('machineStorage.offlineAsOf', { time })
      : t('machineStorage.sized', { time });
  const failed = props.stale && !props.sizing;
  const failure = describeStorageFailure(props.failure);
  return (
    <SurfaceFreshnessLine
      testID="machine-storage-freshness"
      presentation="chip"
      busy={props.sizing}
      signal={props.offline ? 'quiet' : undefined}
      tone={failed ? 'warning' : 'neutral'}
      reason={failed ? `${label} · ${failure.reason ?? t('machineStorage.sizeAgainFailed')}` : label}
      action={props.onSizeAgain && !props.sizing ? {
        label: props.stale ? t('machineStorage.tryAgain') : t('machineStorage.sizeAgain'),
        testID: 'machine-storage-size-again',
        onPress: props.onSizeAgain,
      } : undefined}
    />
  );
}

/** "412 GB free. Happier uses 96 GB of Macintosh HD. About 49 GB of that can go." — or "All tidy." when nothing can. */
function StorageSentence(
  props: Readonly<{
    facts: StorageSentenceFacts;
    tidy: boolean;
    machineName: string;
  }>,
) {
  const { facts } = props;
  const happier = formatMachineBytes(facts.happierBytes, 'storage');
  if (props.tidy) {
    return (
      <StorageSaySection
        testID="machine-storage-sentence"
        lead={t('machineStorage.nothing.lead')}
        text={t('machineStorage.nothing.sentence', {
          happier,
          machine: props.machineName,
        })}
      />
    );
  }
  const uses =
    facts.where.kind === 'volume'
      ? t('machineStorage.sentence.uses', {
          happier,
          volume: facts.where.label,
        })
      : facts.where.kind === 'across'
        ? t('machineStorage.sentence.usesAcross', {
            happier,
            count: facts.where.count,
          })
        : t('machineStorage.sentence.usesNoVolume', { happier });
  const canGo =
    facts.canGoBytes === null
      ? null
      : facts.canGoBytes > 0
        ? t('machineStorage.sentence.canGo', {
            amount: formatMachineBytes(facts.canGoBytes, 'storage'),
          })
        : t('machineStorage.sentence.nothingCanGo');
  return (
    <StorageSaySection
      testID="machine-storage-sentence"
      lead={facts.freeBytes !== null ? t('machineStorage.sentence.free', { free: formatMachineBytes(facts.freeBytes, 'storage') }) : null}
      text={
        // After a move to Trash the space is not back yet: say what returns and when, not what can go (lab RD).
        facts.trashBytes > 0
          ? facts.trashEmptiesAt !== null
            ? t('machineStorage.sentence.trashReturns', { amount: formatMachineBytes(facts.trashBytes, 'storage'), date: formatStorageDay(facts.trashEmptiesAt) })
            : t('machineStorage.sentence.trashReturnsLater', { amount: formatMachineBytes(facts.trashBytes, 'storage') })
          : [uses, canGo].filter(Boolean).join(' ')
      }
    />
  );
}

/**
 * The first sizing (never sized): what is running, in words, with a way to read it again, then a disk and
 * the breakdown rows at their final size. A busy machine can take minutes; the tab never waits wordlessly.
 */
function StorageLoading(props: Readonly<{
  serverId: string;
  machineId: string;
  machineName: string;
  setParams: (next: MachinePageTabParams) => void;
}>) {
  // Reading again would only join the machine's running measurement; the one step that helps a busy
  // machine is its own published attention action (a swapping machine: Review processes).
  const resources = useMachineField(props.machineId, 'daemonState', 'resources', { serverId: props.serverId });
  const action = React.useMemo(() => {
    for (const reason of readMachinePublishedResources({ resources })?.attention.reasons ?? []) {
      const resolved = reason.kind === 'memory_pressure' ? resolveMachineReasonAction(reason) : null;
      if (resolved) return resolved;
    }
    return null;
  }, [resources]);
  const { theme } = useUnistyles();
  const color = theme.colors.surface.skeleton;
  return (
    <View
      testID="machine-storage-loading"
      accessibilityLabel={t('machineStorage.states.loading')}
      accessibilityRole="progressbar"
    >
      <ItemGroup header="none">
        <SurfaceStateCard
          testID="machine-storage-sizing"
          kind="loading"
          size="line"
          title={t('machineStorage.states.sizingOn', { machine: props.machineName })}
          reason={t('machineStorage.states.sizingReason')}
          {...(action ? {
            action: {
              label: action.label,
              testID: 'machine-storage-sizing-action',
              onPress: () => props.setParams(action.tab),
            },
          } : {})}
        />
      </ItemGroup>
      <ItemGroup>
        <View style={styles.skeletonVolume}>
          <HappierSkeletonBlock color={color} width="30%" height={16} />
          <HappierSkeletonBlock color={color} width="100%" height={8} />
          <HappierSkeletonBlock color={color} width="45%" height={12} />
        </View>
      </ItemGroup>
      <ItemGroup title={t('machineStorage.states.loading')}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={styles.skeletonRow}>
            <HappierSkeletonBlock color={color} width="36%" height={14} />
            <HappierSkeletonBlock color={color} width="52%" height={12} />
          </View>
        ))}
      </ItemGroup>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: theme.space.s12,
    marginLeft: 'auto',
  },
  controlsInBody: {
    justifyContent: 'space-between',
    marginLeft: 0,
  },
  accessory: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  skeletonVolume: {
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s16,
  },
  skeletonRow: {
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: 14,
  },
}));
