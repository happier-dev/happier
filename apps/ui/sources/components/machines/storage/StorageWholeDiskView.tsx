import * as React from 'react';
import { View } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  Collection,
  type CollectionAnatomy,
  type CollectionField,
  type CollectionRowActions,
} from '@happier-dev/plugin-ui';
import {
  CapacityBar,
  HappierBreadcrumb,
  happierPageTextMetrics,
  Sunburst,
  Treemap,
  useHappierCollection,
} from '@happier-dev/plugin-ui/presentation';
import {
  STORAGE_RINGS_MIN_ARC_DEGREES,
  STORAGE_TREEMAP_LARGEST_VIEW_PX,
  STORAGE_TREEMAP_MIN_NODE_PX,
  type DiskNodeV1,
  type DiskScanStateV1,
  type DiskScanViewV1,
} from '@happier-dev/protocol/storage/storageV1';

import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { PolicyValueSelect } from '@/components/machines/policy/PolicyValueSelect';
import { openMachinePathBrowserModal } from '@/components/ui/pathBrowser/openMachinePathBrowserModal';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { parseCustomDiskThreshold } from '@/components/machines/vitals/machineAlertsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/iconRegistry.generated';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { Text } from '@/components/ui/text/Text';
import { shadowLevelStyle } from '@/shadowElevation';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { StorageScanStartNotice } from '@/components/machines/storage/StorageScanStartNotice';
import { StorageReadNotice } from './StorageReadNotice';
import { useMachineStorageScan } from '@/sync/domains/machines/storage/useMachineStorageScan';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { getPreferredLanguage, t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { copyStoragePath } from './copyStoragePath';
import { formatStorageDay } from './storageCategoryText';
import { useMachineStorageViewSetting } from './useMachineStorageViewSetting';
import {
  StorageCollectToggle,
  useStorageCollect,
  type StorageCollectController,
} from './StorageCollectToggle';
import {
  buildStorageDiskLevel,
  formatStorageDiskBytes,
  foldStorageDiskCrumbs,
  resolveStorageDiskOpenTarget,
  STORAGE_DISK_FOLDED_CRUMB_KEY,
  type StorageDiskChartNode,
  type StorageDiskCrumb,
  type StorageDiskMark,
  type StorageDiskRow,
  type StorageDiskSort,
  storageDiskNodeName,
  toStorageDiskChartPart,
  toStorageDiskCollectRow,
} from './storageDiskModel';
import { describeStorageVerdict } from './storageReasonPresentation';
import { StorageSaySection } from '@/components/storage/StorageSayLine';
import { StorageSizeBar } from '@/components/storage/StorageSizeBar';
import { StorageHint } from './StoragePageHead';
import { StoragePileDock } from './StoragePileDock';
import { storagePathContains } from './storagePileModel';
import { parseCustomStorageDays } from './storageTidyChoices';
import { StorageVolumeRow } from './StorageVolumes';
import {
  selectStorageHeadlineVolume,
  storageVolumeName,
  type StorageSummary,
  type StorageVolume,
} from './storageViewModel';

type Shape = 'list' | 'map' | 'rings';
type Files = 'folders' | 'large' | 'old';
type StorageParams = Extract<MachinePageTabParams, { id: 'storage' }>;

const MARK_ICONS: Readonly<Record<StorageDiskMark, IconName>> = {
  folder: 'folder',
  file: 'file',
  package: 'cube',
  happier: 'folder',
  protected: 'lock',
  cloud: 'cloud',
  mount: 'hard-drives',
  small: 'dots-three',
  hidden: 'circle-half',
  reserved: 'circle-half',
};
const LARGE_MIN_BYTES = [10_000_000, 100_000_000, 1_000_000_000] as const;
const OLD_MONTHS = [3, 6, 12] as const;
const OLD_AGE_GROUPS = ['year', 'months6', 'months3', 'recent', 'unknown'] as const;
const DAY_MS = 86_400_000;
/** Changed more than a year, 6–12 months or 3–6 months ago; an epoch time is "unknown age", never old (W-4). */
function describeOldAgeGroup(changedAt: number, now = Date.now()): (typeof OLD_AGE_GROUPS)[number] {
  if (changedAt <= 1_000) return 'unknown';
  const days = (now - changedAt) / DAY_MS;
  return days >= 365 ? 'year' : days >= 182 ? 'months6' : days >= 91 ? 'months3' : 'recent';
}
/** The lab's gap for a mounted disk at the top of a level. */
const MOUNT_GAP_DEGREES = 5;
const DEPTH: Readonly<Record<Shape, 1 | 2 | 3>> = { list: 1, map: 2, rings: 3 };

function scanFor(
  summary: StorageSummary,
  volume: StorageVolume | null,
): DiskScanStateV1 | null {
  const scans = summary.wholeDisk.scans;
  const own = volume
    ? scans.filter(
        (scan) =>
          'volumeId' in scan.target &&
          scan.target.volumeId === volume.volume.volumeId,
      )
    : [];
  const pool = own.length ? own : scans;
  return pool.slice().sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

/**
 * Whole disk (plan 40 STO-18–20/24, lab `rs` M / Mp / MT / MU / MV / MX / MXp / MS / MSp): opt-in per
 * machine; once scanned, one folder level at a time with a breadcrumb, as a list (where you act) and, on
 * a desktop, a Map or Rings of the same level above it. Large files and Old files are lists of the same
 * scan. Every state says what Happier reads and what waits.
 */
export const StorageWholeDiskView = React.memo(function StorageWholeDiskView(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    summary: StorageSummary;
    offline: boolean;
    params: StorageParams;
    setParams: (next: MachinePageTabParams) => void;
    onOpenAdminAccess?: () => void;
    /** The Happier view's disk sentence; a disk never scanned leads with it as Happier's does (lab `rs` MS 1). */
    sentence?: React.ReactNode;
  }>,
) {
  usePreferredLanguage();
  const { theme } = useUnistyles();
  const layout = useMachineTabCompactLayout();
  const target = { machineId: props.machineId, serverId: props.serverId };
  const policy = useMachineResourcesPolicy(target);
  const facts = useMachineTabFacts(props.serverId, props.machineId);
  const volume =
    (props.params.volumeId
      ? props.summary.volumes.find(
          (entry) => entry.volume.volumeId === props.params.volumeId,
        )
      : null) ?? selectStorageHeadlineVolume(props.summary);
  // Only an explicit volume selection narrows the scan. The default headline disk must not
  // hide a newer folder scan started from this view.
  const scan = scanFor(props.summary, props.params.volumeId ? volume : null);
  const enabled =
    policy.policy?.storage.wholeDiskEnabled ?? props.summary.wholeDisk.enabled;
  const { shape, sort, remember } = useMachineStorageViewSetting(
    props.serverId,
    props.machineId,
    layout.compact,
  );
  const files: Files = props.params.files ?? 'folders';
  const [largeMin, setLargeMin] = React.useState<number | null>(null);
  const [oldAge, setOldAge] = React.useState<Readonly<{ months: (typeof OLD_MONTHS)[number] } | { days: number }>>({ months: 3 });
  const customSize = React.useCallback(() => {
    fireAndForget((async () => {
      const raw = await Modal.prompt(t('machineStorage.disk.largerThan'), t('machineStorage.disk.customSize.body'), {
        defaultValue: largeMin === null ? '' : formatMachineBytes(largeMin, 'storage'), confirmText: t('common.save'),
      });
      if (raw === null) return;
      const value = parseCustomDiskThreshold(/^\s*\d+(?:[.,]\d+)?\s*$/u.test(raw) ? `${raw} B` : raw, null);
      if (value === null || !('freeBytes' in value)) {
        Modal.alert(t('machineStorage.disk.largerThan'), t('machineStorage.disk.customSize.invalid'));
        return;
      }
      setLargeMin(value.freeBytes);
    })(), { tag: 'StorageWholeDisk.customSize' });
  }, [largeMin]);
  const customAge = React.useCallback(() => {
    fireAndForget((async () => {
      const raw = await Modal.prompt(t('machineStorage.disk.olderThan'), t('machineStorage.tidy.customDays.body'), {
        defaultValue: 'days' in oldAge ? `${oldAge.days} d` : '', confirmText: t('common.save'),
      });
      if (raw === null) return;
      const days = parseCustomStorageDays(raw);
      if (days === null) {
        Modal.alert(t('machineStorage.disk.olderThan'), t('machineStorage.tidy.customDays.invalid'));
        return;
      }
      setOldAge({ days });
    })(), { tag: 'StorageWholeDisk.customAge' });
  }, [oldAge]);
  const view = React.useMemo(
    (): DiskScanViewV1 =>
      files === 'large'
        ? { tab: 'large', depth: 1, ...(largeMin === null ? {} : { minBytes: largeMin }) }
        : files === 'old'
          ? { tab: 'old', depth: 1, ...('days' in oldAge ? { olderThanDays: oldAge.days } : { olderThanMonths: oldAge.months }) }
          : {
              tab: 'folders',
              depth: DEPTH[shape],
              ...(props.params.nodeId ? { nodeId: props.params.nodeId } : {}),
              sort: { by: sort.by, direction: sort.direction },
            },
    [
      files,
      largeMin,
      oldAge,
      props.params.nodeId,
      shape,
      sort.by,
      sort.direction,
    ],
  );
  const scanState = useMachineStorageScan({
    ...target,
    ...(scan ? { scanId: scan.scanId, view } : {}),
  });
  const readNotice = <StorageReadNotice issues={[...(props.summary.incomplete ?? []), ...(scanState.page?.incomplete ?? [])]}
    onRetry={scanState.retry} onOpenRemedy={props.onOpenAdminAccess} />;
  const collect = useStorageCollect({ ...target, readOnly: props.offline });
  const [starting, setStarting] = React.useState(false);
  // The address as it is when the start is acknowledged, not as it was when the person pressed the control.
  const paramsRef = React.useRef(props.params);
  paramsRef.current = props.params;
  const setParamsRef = React.useRef(props.setParams);
  setParamsRef.current = props.setParams;
  const setPolicy = policy.set;
  const startScan = React.useCallback(
    (
      request: Readonly<{ volumeId: string } | { folderPath: string }>,
      resume?: boolean,
      // The machine just refused for being opted out: its policy, not this view's copy of it, is what to change.
      turnOn?: boolean,
    ) => {
      setStarting(true);
      fireAndForget(
        (async () => {
          if (!enabled || turnOn) {
            const saved = await setPolicy({
              storage: { wholeDiskEnabled: true },
            });
            if (!saved.saved) {
              setStarting(false);
              return;
            }
          }
          const started = await scanState.start({
            target: request,
            ...(resume ? { resume: true } : {}),
          });
          setStarting(false);
          // A different target is a different scan: the page's address (opened folder, file list, explicit
          // volume) belongs to the scan being left, so it returns to the new scan's root. Resume continues
          // the same scan and a refused start changes nothing.
          if (started.ok && !resume) {
            const address = paramsRef.current;
            if (address.nodeId || address.files || address.volumeId) {
              setParamsRef.current({ ...address, nodeId: undefined, files: undefined, volumeId: undefined });
            }
          }
        })(),
        { tag: 'StorageWholeDisk.start' },
      );
    },
    [enabled, scanState, setPolicy],
  );
  const startFailure = scanState.startFailure;
  const retryStart = React.useCallback(
    (turnOn: boolean) => {
      if (startFailure) startScan(startFailure.target, startFailure.resume, turnOn);
    },
    [startFailure, startScan],
  );
  const startNotice = startFailure && !props.offline ? (
    <StorageScanStartNotice
      failure={startFailure}
      machineName={props.machineName}
      onRetry={() => retryStart(false)}
      onTurnOn={() => retryStart(true)}
    />
  ) : null;
  const chooseFolder = React.useCallback(() => {
    fireAndForget((async () => {
      const path = await openMachinePathBrowserModal({ machineId: props.machineId, serverId: props.serverId,
        title: t('machineStorage.disk.chooseFolderTitle'), initialPath: facts.homeDir ?? null, selectionMode: 'directory' });
      if (path) startScan({ folderPath: path });
    })(), { tag: 'StorageWholeDisk.chooseFolder' });
  }, [facts.homeDir, props.machineId, props.serverId, startScan]);
  const volumeName = volume ? storageVolumeName(volume) : props.machineName;
  const open = React.useCallback(
    (nodeId: string | undefined) =>
      props.setParams({
        ...props.params,
        view: 'disk',
        nodeId,
        files: undefined,
      }),
    [props],
  );

  // ── States (MS) ─────────────────────────────────────────────────────────────────────────────────
  if (!scan || (!enabled && scan.status !== 'complete')) {
    return (
      <View testID="machine-storage-disk-never">
        {readNotice}
        {props.sentence}
        {props.offline ? (
          // Offline: nothing can start a scan, so the page says why in the invite's place, and nothing else.
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-disk-offline"
              kind="unavailable"
              size="line"
              title={t('machineStorage.states.offlineTitle', { machine: props.machineName })}
              reason={t('machineStorage.states.offlineReason')}
            />
          </ItemGroup>
        ) : (
          <ItemGroup>
            <SurfaceStateCard
              testID="machine-storage-disk-invite"
              kind="empty"
              icon={
                <Icon
                  name="hard-drives"
                  size={22}
                  color={theme.colors.text.secondary}
                />
              }
              title={t('machineStorage.disk.neverTitle', {
                volume: volumeName,
              })}
              reason={t('machineStorage.disk.neverBody', {
                happier: formatMachineBytes(
                  volume?.happierBytes ?? 0,
                  'storage',
                ),
                machine: props.machineName,
              })}
              action={
                volume
                  ? {
                      label: t('machineStorage.disk.scanVolume', {
                        volume: volumeName,
                      }),
                      onPress: () =>
                        startScan({ volumeId: volume.volume.volumeId }),
                      testID: 'machine-storage-disk-scan',
                    }
                  : undefined
              }
              secondaryAction={{
                label: t('machineStorage.disk.chooseFolder'),
                onPress: chooseFolder,
                testID: 'machine-storage-disk-folder',
              }}
            />
            {startNotice}
          </ItemGroup>
        )}
        {props.offline ? null : <StorageHint icon="info" text={t('machineStorage.disk.neverHint')} />}
        {props.offline ? null : (
          <ScanFolderShortcuts
            serverId={props.serverId}
            machineId={props.machineId}
            homeDir={facts.homeDir}
            shortcuts={props.summary.scanShortcuts}
            disabled={starting}
            onScan={(folderPath) => startScan({ folderPath })}
          />
        )}
        {starting ? (
          <StorageHint icon="clock" text={t('machineStorage.disk.starting')} />
        ) : null}
      </View>
    );
  }
  const rootRefusal = scan.status === 'failed'
    ? scan.unreadable.examples.find(example =>
        scanState.page?.coverage.some(coverage => !coverage.complete && coverage.path === example.path))?.reason
    : undefined;
  if (rootRefusal === 'read_only_filesystem' || rootRefusal === 'pseudo_or_cloud_filesystem') {
    return (
      <View testID="machine-storage-disk" onLayout={layout.onLayout}>
        {readNotice}
        <ItemGroup>
          <SurfaceStateCard
            testID="machine-storage-disk-root-unavailable"
            kind="unavailable"
            title={t('machineStorage.disk.startFailed.title')}
            reason={rootRefusal === 'read_only_filesystem'
              ? t('machineStorage.disk.readOnlyRoot')
              : t('machineStorage.disk.systemRoot')}
            action={props.offline ? undefined : {
              label: t('machineStorage.disk.chooseFolder'),
              onPress: chooseFolder,
              testID: 'machine-storage-disk-folder',
            }}
          />
          {startNotice}
        </ItemGroup>
      </View>
    );
  }
  const running = scan.status === 'running';
  const stopped =
    scan.status === 'failed' ||
    scan.status === 'interrupted' ||
    scan.status === 'cancelled';
  const nodes = scanState.nodes;
  const selectedRoot = scanState.page?.root ?? null;
  const level = buildStorageDiskLevel({
    nodes: files === 'folders' && selectedRoot ? [selectedRoot, ...nodes] : nodes,
    rootId: files === 'folders' ? (props.params.nodeId ?? selectedRoot?.nodeId ?? null) : null,
    pile: collect.items,
    sort,
  });
  const root = level.root;
  // A running scan that has listed nothing here yet is still reading: "Nothing here." would read as its result.
  const reading = running && level.rows.length === 0;
  const targetName = root ? storageDiskNodeName(root)
    : 'folderPath' in scan.target ? formatPathRelativeToHome(scan.target.folderPath, facts.homeDir) : volumeName;
  const targetBytes = root?.size.allocatedBytes
    ?? ('folderPath' in scan.target ? scan.progress.sizedBytes : volume ? volume.totalBytes - volume.freeBytes : null);
  const unreadable =
    scan.unreadable.counts.permission + scan.unreadable.counts.os_private;
  return (
    <View testID="machine-storage-disk" onLayout={layout.onLayout}>
      {readNotice}
      <StorageSaySection
        testID="machine-storage-disk-sentence"
        lead={volume ? t('machineStorage.sentence.free', { free: formatMachineBytes(volume.freeBytes, 'storage') }) : null}
        text={[
          running
            ? scan.progress.usedBytes !== undefined
              ? t('machineStorage.disk.scanningSentence', {
                  volume: targetName,
                  sized: formatMachineBytes(scan.progress.sizedBytes, 'storage'),
                  used: formatMachineBytes(scan.progress.usedBytes, 'storage'),
                })
              : t('machineStorage.disk.scanningSentenceOpen', {
                  volume: targetName,
                  sized: formatMachineBytes(scan.progress.sizedBytes, 'storage'),
                })
            : stopped
              ? 'folderPath' in scan.target
                ? t('machineStorage.disk.stoppedSentenceFolder', { target: targetName })
                : t('machineStorage.disk.stoppedSentence')
              : unreadable > 0
                ? t('machineStorage.disk.unreadableSentence', {
                    count: unreadable,
                    volume: targetName,
                  })
                : targetBytes !== null
                  ? t('machineStorage.disk.holds', {
                      volume: targetName,
                      used: formatMachineBytes(targetBytes, 'storage'),
                    })
                  : '',
          !running && !stopped && root?.deltaSincePrevious && scan.previousScanAt
            ? t('machineStorage.disk.grewSince', { amount: formatMachineBytes(Math.abs(root.deltaSincePrevious), 'storage'), date: formatStorageDay(scan.previousScanAt) })
            : '',
        ].filter(Boolean).join(' ')}
      />
      {volume ? (
        // Its own section like the Happier view's disk: the sentence, the disk and the scan's progress each keep the page's gap.
        <ItemGroup>
          <StorageVolumeRow volume={volume} compact={layout.compact} />
        </ItemGroup>
      ) : null}
      {running ? (
        <ScanProgress
          scan={scan}
          onCancel={() => {
            void scanState.cancel(scan.scanId);
          }}
          onSkip={
            scan.progress.currentPath && scan.progress.stuckSinceMs
              ? () => {
                  void scanState.skip(scan.scanId, scan.progress.currentPath!);
                }
              : null
          }
          machineName={props.machineName}
        />
      ) : null}
      {startNotice ? <ItemGroup>{startNotice}</ItemGroup> : null}
      {stopped ? (
        <ItemGroup>
          <SurfaceStateCard
            testID="machine-storage-disk-stopped"
            kind="error"
            title={
              scan.progress.usedBytes !== undefined && scan.progress.usedBytes > 0
                ? t('machineStorage.disk.stoppedTitle', {
                    percent: Math.round(
                      (scan.progress.sizedBytes / scan.progress.usedBytes) *
                        100,
                    ),
                  })
                : t('machineStorage.disk.stoppedTitleOpen')
            }
            reason={scan.progress.sizedBytes > 0
              ? t('machineStorage.disk.stoppedBody', { sized: formatMachineBytes(scan.progress.sizedBytes, 'storage') })
              : t('machineStorage.disk.stoppedBodyNone')}
            action={
              props.offline
                ? undefined
                : {
                    label: t('machineStorage.disk.resume'),
                    onPress: () =>
                      startScan(
                        'volumeId' in scan.target
                          ? scan.target
                          : { folderPath: scan.target.folderPath },
                        true,
                      ),
                    testID: 'machine-storage-disk-resume',
                  }
            }
          />
        </ItemGroup>
      ) : null}
      {!running &&
      (scan.fullDiskAccess.state === 'not_granted' || unreadable > 0) ? (
        <PermissionBanner
          scan={scan}
          machineName={props.machineName}
          onRecheck={scanState.retry}
        />
      ) : null}
      {scan.apfsLocalSnapshotCount !== undefined ? (
        <StorageSaySection testID="machine-storage-disk-apfs-snapshots"
          text={t('machineStorage.disk.apfsLocalSnapshots', { count: scan.apfsLocalSnapshotCount })} />
      ) : null}
      <ItemGroup surface="none" header="none">
      <View style={[styles.tools, layout.compact ? styles.toolsCompact : null]}>
        <SegmentedTabBar<Files>
          role="tablist"
          segmentSizing="content"
          accessibilityLabel={t('machineStorage.disk.filesLabel')}
          testIDPrefix="machine-storage-disk-files"
          tabs={(['folders', 'large', 'old'] as const).map((id) => ({
            id,
            label: t(`machineStorage.disk.files.${id}`),
          }))}
          activeTabId={files}
          onSelectTab={(next) =>
            props.setParams({
              ...props.params,
              view: 'disk',
              files: next === 'folders' ? undefined : next,
            })
          }
        />
        <View style={styles.grow} />
        {files === 'large' ? (
          <PolicyValueSelect
            testID="machine-storage-disk-large-min"
            label={t('machineStorage.disk.largerThan')}
            value={largeMin === null ? t('common.all') : t('machineStorage.disk.largerThanValue', {
              size: formatMachineBytes(largeMin, 'storage'),
            })}
            selectedId={largeMin === null ? 'all' : (LARGE_MIN_BYTES as readonly number[]).includes(largeMin) ? String(largeMin) : null}
            choices={[{ id: 'all', title: t('common.all') }, ...LARGE_MIN_BYTES.map((bytes) => ({
              id: String(bytes),
              title: t('machineStorage.disk.largerThanValue', {
                size: formatMachineBytes(bytes, 'storage'),
              }),
            }))]}
            onSelect={(id) => setLargeMin(id === 'all' ? null : Number(id))}
            onCustom={customSize}
          />
        ) : files === 'old' ? (
          <PolicyValueSelect
            testID="machine-storage-disk-old-months"
            label={t('machineStorage.disk.olderThan')}
            value={'days' in oldAge ? t('machineStorage.disk.olderThanDaysValue', { days: oldAge.days })
              : t('machineStorage.disk.olderThanValue', { months: oldAge.months })}
            selectedId={'months' in oldAge ? String(oldAge.months) : null}
            choices={OLD_MONTHS.map((months) => ({
              id: String(months),
              title: t('machineStorage.disk.olderThanValue', { months }),
            }))}
            onSelect={(id) => {
              const months = OLD_MONTHS.find(value => String(value) === id);
              if (months !== undefined) setOldAge({ months });
            }}
            onCustom={customAge}
          />
        ) : null}
        {/* Map and Rings draw folders; Large and Old files are lists only, so the switch leaves (lab `rs` MX). */}
        {!layout.compact && files === 'folders' ? (
          <SegmentedTabBar<Shape>
            role="radiogroup"
            segmentSizing="content"
            iconPlacement="leading"
            accessibilityLabel={t('machineStorage.disk.shapeLabel')}
            testIDPrefix="machine-storage-disk-shape"
            tabs={(
              [
                ['list', 'list-bullets'],
                ['map', 'squares-four'],
                ['rings', 'target'],
              ] as const
            ).map(([id, icon]) => ({
              id,
              label: t(`machineStorage.disk.shape.${id}`),
              icon: (
                <Icon
                  name={icon}
                  size={14}
                  color={theme.colors.text.secondary}
                />
              ),
            }))}
            activeTabId={shape}
            onSelectTab={(next) => remember({ shape: next })}
          />
        ) : null}
      </View>
      </ItemGroup>
      <ItemGroup header="none">
        {files === 'folders' ? (
          <DiskPath
            volume={volume}
            root={root}
            // A folder scan's first page may still be on its way: the path already names the folder it reads.
            targetPath={'folderPath' in scan.target ? scan.target.folderPath : null}
            homeDir={facts.homeDir}
            reading={reading}
            compact={layout.compact}
            onOpen={open}
          />
        ) : null}
        {files === 'folders' &&
        shape !== 'list' &&
        !layout.compact &&
        (level.chart.length > 0 || scanState.scanStatus === 'loading') ? (
          <DiskChart
            shape={shape}
            level={level}
            root={root}
            volumeName={volumeName}
            collect={collect}
            onOpen={open}
            onUp={() =>
              open(
                root?.parentId &&
                  volume &&
                  storagePathContains(volume.volume.mountPath, root.parentId)
                  ? root.parentId
                  : undefined,
              )
            }
          />
        ) : null}
        <DiskList
          rows={level.rows}
          files={files}
          sort={sort}
          onSort={(next) => remember({ sort: next })}
          collect={collect}
          compact={layout.compact}
          homeDir={facts.homeDir}
          loading={scanState.scanStatus === 'loading' && !scanState.page}
          {...(root ? { expectedRows: root.childCount } : {})}
          reading={reading}
          // A failed read, or one the Machine answered without the listed scan, is not an empty folder: it says so
          // and offers the read again.
          {...(scanState.scanStatus === 'error' || (scanState.page && !scanState.page.state) ? { onRetryRead: scanState.retry } : {})}
          previousScanAt={scan.previousScanAt ?? null}
          onOpen={open}
          machineName={props.machineName}
        />
      </ItemGroup>
      {props.offline ? null : (
        <ScanFolderShortcuts
          serverId={props.serverId}
          machineId={props.machineId}
          homeDir={facts.homeDir}
          shortcuts={props.summary.scanShortcuts}
          disabled={starting || running}
          waiting={running}
          onScan={(folderPath) => startScan({ folderPath })}
          onChoose={chooseFolder}
        />
      )}
      <StoragePileDock
        serverId={props.serverId}
        machineId={props.machineId}
        machineName={props.machineName}
        summary={props.summary}
        compact={layout.compact}
        readOnly={props.offline}
        readyNote={t('machineStorage.pile.readyNoteDisk')}
      />
    </View>
  );
});

function ScanProgress(
  props: Readonly<{
    scan: DiskScanStateV1;
    onCancel: () => void;
    onSkip: (() => void) | null;
    machineName: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const { progress } = props.scan;
  // Missing totals and measured zero have no percentage denominator.
  const percent =
    progress.usedBytes !== undefined && progress.usedBytes > 0
      ? Math.min(
          100,
          Math.round((progress.sizedBytes / progress.usedBytes) * 100),
        )
      : null;
  return (
    <>
      <ItemGroup>
        <View
          testID="machine-storage-disk-progress"
          style={styles.progress}
          accessibilityRole="progressbar"
          accessibilityValue={percent === null ? undefined : { min: 0, max: 100, now: percent }}
        >
          <View style={styles.progressHead}>
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            {percent === null ? null : <Text style={styles.progressPercent}>{`${percent}%`}</Text>}
            <Text style={styles.progressMeta}>
              {progress.usedBytes === undefined
                ? t('machineStorage.disk.progressMetaOpen', {
                    sized: formatMachineBytes(progress.sizedBytes, 'storage'),
                    items: progress.items.toLocaleString(getPreferredLanguage()),
                  })
                : t('machineStorage.disk.progressMeta', {
                    sized: formatMachineBytes(progress.sizedBytes, 'storage'),
                    used: formatMachineBytes(progress.usedBytes, 'storage'),
                    items: progress.items.toLocaleString(getPreferredLanguage()),
                  })}
            </Text>
            <View style={styles.grow} />
            <RoundButton
              testID="machine-storage-disk-cancel"
              size="small"
              display="inverted"
              title={t('common.cancel')}
              onPress={props.onCancel}
            />
          </View>
          {percent === null || progress.usedBytes === undefined ? null : (
            <CapacityBar
              theme={pluginTheme}
              label={t('machineStorage.disk.progressLabel')}
              value={progress.sizedBytes}
              capacity={progress.usedBytes}
              size="inline"
              showCaption={false}
              color={pluginTheme.colors.accent}
              trackColor={theme.colors.border.default}
            />
          )}
          {progress.currentPath ? (
            <View style={styles.current}>
              <Text style={styles.progressMeta}>
                {progress.stuckSinceMs
                  ? t('machineStorage.disk.stuck')
                  : t('machineStorage.disk.reading')}
              </Text>
              <Text style={styles.path} numberOfLines={1}>
                {progress.currentPath}
              </Text>
              {props.onSkip ? (
                <TextLinkButton
                  testID="machine-storage-disk-skip"
                  tone="strong"
                  label={t('machineStorage.disk.skip')}
                  onPress={props.onSkip}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </ItemGroup>
      <StorageHint
        icon="info"
        text={t('machineStorage.disk.leavePage', {
          machine: props.machineName,
        })}
      />
    </>
  );
}

function PermissionBanner(
  props: Readonly<{
    scan: DiskScanStateV1;
    machineName: string;
    onRecheck: () => void;
  }>,
) {
  const count =
    props.scan.unreadable.counts.permission +
    props.scan.unreadable.counts.os_private;
  const fda = props.scan.fullDiskAccess;
  return (
    <ItemGroup>
      <SurfaceStateCard
        testID="machine-storage-disk-permission"
        kind="unavailable"
        size="line"
        title={t('machineStorage.disk.privateTitle', { count })}
        reason={
          fda.state === 'not_granted'
            ? t('machineStorage.disk.fullDiskAccess', {
                machine: props.machineName,
                binary: fda.binary.name,
              })
            : t('machineStorage.disk.privateBody')
        }
        action={{
          label: t('machineStorage.disk.recheck'),
          onPress: props.onRecheck,
          testID: 'machine-storage-disk-recheck',
        }}
      />
    </ItemGroup>
  );
}

function DiskPath(
  props: Readonly<{
    volume: StorageVolume | null;
    root: DiskNodeV1 | null;
    /** The folder a folder scan reads, named in the path until its page names the open level. */
    targetPath: string | null;
    homeDir: string | undefined;
    /** The level is still being read: its size and count so far are not a result, so no figures yet. */
    reading: boolean;
    /** A phone folds the ancestors into one "…" that goes up a level. */
    compact: boolean;
    onOpen: (nodeId: string | undefined) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const mount = props.volume?.volume.mountPath ?? '/';
  const name = props.volume ? storageVolumeName(props.volume) : mount;
  const crumbs = React.useMemo(() => {
    const items: StorageDiskCrumb[] = [
      { key: '', label: name, nodeId: undefined },
    ];
    const levelPath = props.root?.nodeId ?? props.targetPath;
    if (levelPath) {
      const rest = levelPath.startsWith(mount)
        ? levelPath.slice(mount.length)
        : levelPath;
      const separator = levelPath.includes('\\') ? '\\' : '/';
      let acc = mount.replace(/[\\/]+$/u, '');
      for (const part of rest.split(/[\\/]/u).filter(Boolean)) {
        acc = `${acc}${separator}${part}`;
        items.push({ key: acc, label: part, nodeId: acc });
      }
    }
    return foldStorageDiskCrumbs(items, props.compact);
  }, [mount, name, props.compact, props.root, props.targetPath]);
  const last = crumbs.length - 1;
  const meta = props.root
    ? props.reading
      ? ''
      : t('machineStorage.disk.levelMeta', {
        size: formatMachineBytes(props.root.size.allocatedBytes, 'storage'),
        count: props.root.childCount,
      })
    : props.volume && !props.targetPath
      ? t('machineStorage.disk.volumeMeta', {
          used: formatMachineBytes(
            props.volume.totalBytes - props.volume.freeBytes,
            'storage',
          ),
          total: formatMachineBytes(props.volume.totalBytes, 'storage'),
        })
      : '';
  return (
    <View style={styles.pathRow}>
      <HappierBreadcrumb
        testID="machine-storage-disk-path"
        accessibilityLabel={t('machineStorage.disk.pathLabel')}
        separator={<Icon name="caret-right" size={12} color={theme.colors.text.tertiary} />}
        items={crumbs.map((crumb, index) => ({
          key: crumb.key || 'volume',
          label: crumb.label,
          ...(index < last
            ? { onPress: () => props.onOpen(crumb.nodeId) }
            : {}),
        }))}
        // The app's text roles, so the crumbs keep their ink in both themes: ancestors quiet, the open folder strong.
        renderLabel={(item) => (
          <Text numberOfLines={1} style={item.onPress ? styles.crumb : styles.crumbCurrent}>
            {item.key === STORAGE_DISK_FOLDED_CRUMB_KEY ? '…' : item.label}
          </Text>
        )}
      />
      <Text style={styles.pathMeta} numberOfLines={1}>
        {meta}
      </Text>
    </View>
  );
}

/** The Map or Rings above the list: the same nodes, the pointed-at part is its row's, Space collects it. */
function DiskChart(
  input: Readonly<{
    shape: 'map' | 'rings';
    level: ReturnType<typeof buildStorageDiskLevel>;
    root: DiskNodeV1 | null;
    volumeName: string;
    collect: StorageCollectController;
    onOpen: (nodeId: string | undefined) => void;
    onUp: () => void;
  }>,
) {
  // While the next level is read the chart keeps drawing the one on screen, so opening a part morphs it into
  // its level (lab MU) instead of the chart leaving and coming back.
  const drawn = React.useRef(input);
  if (input.level.chart.length > 0) drawn.current = input;
  const props = input.level.chart.length > 0 ? input : { ...input, level: drawn.current.level, root: drawn.current.root };
  const { theme } = useUnistyles();
  const motion = useMotionPreferences();
  const pluginTheme = usePluginUiTheme(theme);
  const [width, setWidth] = React.useState(0);
  const [pointed, setPointed] = React.useState<string | null>(null);
  const [inspected, setInspected] = React.useState<string | null>(null);
  const pointAt = (key: string | null) => {
    setPointed(key);
    // Keep the inspected item reachable when the pointer or focus moves to Copy path.
    if (key !== null) setInspected(key);
  };
  const parts = React.useMemo(
    () => props.level.chart.map(toStorageDiskChartPart),
    [props.level.chart],
  );
  const rows = React.useMemo(
    () => new Map(props.level.rows.map((row) => [row.key, row])),
    [props.level.rows],
  );
  const chartNodes = React.useMemo(() => {
    const out = new Map<string, StorageDiskChartNode>();
    const visit = (nodes: readonly StorageDiskChartNode[]) => {
      for (const node of nodes) { out.set(node.key, node); visit(node.children); }
    };
    visit(props.level.chart);
    return out;
  }, [props.level.chart]);
  const inspectedNode = inspected ? chartNodes.get(inspected)?.node : undefined;
  const inspectedPath = inspectedNode && !['small-items', 'hidden-space', 'reserved'].includes(inspectedNode.kind)
    ? inspectedNode.nodeId : null;
  // Another disk mounted here is a gap at 12 o'clock with its name, not an arc (lab MU).
  const mountRow = props.level.rows.find((row) => row.mark === 'mount') ?? null;
  const total = props.level.chart.reduce((sum, node) => sum + node.value, 0);
  const centre = props.root?.name ?? props.volumeName;
  const collectKey = (key: string) => {
    const row = rows.get(key);
    if (row) { props.collect.toggle(toCollectRow(row)); return; }
    // A tile or arc a level deeper collects through the same row as the list (Forbidden and folded parts have no box).
    const node = chartNodes.get(key);
    if (node) props.collect.toggle(toStorageDiskCollectRow(node.node));
  };
  const tooltip = (key: string) => {
    const node = chartNodes.get(key)?.node;
    if (!node) return null;
    const share =
      total > 0 ? Math.round((node.size.allocatedBytes / total) * 100) : 0;
    return (
      <View style={styles.tooltip}>
        <View style={styles.tooltipHead}>
          <Text style={styles.tooltipTitle} numberOfLines={1}>
            {storageDiskNodeName(node)}
          </Text>
          <Text style={styles.tooltipTitle}>
            {formatStorageDiskBytes(node)}
          </Text>
        </View>
        <Text style={styles.tooltipMeta}>
          {t('machineStorage.disk.share', { percent: share, folder: centre })}
        </Text>
        <Text style={styles.tooltipKeys}>
          {t('machineStorage.disk.chartKeys')}
        </Text>
      </View>
    );
  };
  const chartWidth = Math.max(0, width - 32);
  const height =
    props.shape === 'map'
      ? Math.round(
          Math.min(
            STORAGE_TREEMAP_LARGEST_VIEW_PX.height,
            (chartWidth * STORAGE_TREEMAP_LARGEST_VIEW_PX.height) /
              STORAGE_TREEMAP_LARGEST_VIEW_PX.width,
          ),
        )
      : Math.round(Math.min(408, chartWidth * 0.54));
  const label = t(
    props.shape === 'map'
      ? 'machineStorage.disk.mapLabel'
      : 'machineStorage.disk.ringsLabel',
    { folder: centre },
  );
  const open = (key: string) => {
    const target = resolveStorageDiskOpenTarget(key, rows, chartNodes);
    if (target !== null) props.onOpen(target);
  };
  // Nothing drawn yet (the first read of a level): no chart until there is something to draw.
  if (props.level.chart.length === 0) return null;
  return (
    <View
      testID={`machine-storage-disk-${props.shape}`}
      style={styles.chart}
      onLayout={(event) => {
        const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
        if (visibleWidth !== null) setWidth(Math.round(visibleWidth));
      }}
    >
      {chartWidth > 0 ? (
        props.shape === 'map' ? (
          <Treemap
            theme={pluginTheme}
            accentColor={usageSignatureAccent(theme)}
            items={parts}
            width={chartWidth}
            height={height}
            minNodePx={STORAGE_TREEMAP_MIN_NODE_PX}
            accessibilityLabel={label}
            smallerLabel={(count) =>
              t('machineStorage.disk.smaller', { count })
            }
            pointedKey={pointed}
            onPointAt={pointAt}
            onOpen={open}
            onCollect={collectKey}
            onUp={props.onUp}
            renderTooltip={tooltip}
            reducedMotion={motion.reduceMotion}
          />
        ) : (
          <Sunburst
            theme={pluginTheme}
            accentColor={usageSignatureAccent(theme)}
            items={parts}
            width={chartWidth}
            height={height}
            minArcDegrees={STORAGE_RINGS_MIN_ARC_DEGREES}
            reducedMotion={motion.reduceMotion}
            {...(mountRow ? { gapDegrees: MOUNT_GAP_DEGREES, gapLabel: { name: mountRow.node.name, note: t('machineStorage.disk.anotherDisk') } } : {})}
            centerLabel={centre}
            centerValue={formatMachineBytes(
              props.root?.size.allocatedBytes ?? total,
              'storage',
            )}
            {...(props.root
              ? {
                  upLabel: props.root.parentId
                    ? (props.root.parentId
                        .split(/[\\/]/u)
                        .filter(Boolean)
                        .pop() ?? props.volumeName)
                    : props.volumeName,
                }
              : {})}
            accessibilityLabel={label}
            smallerLabel={(count) =>
              t('machineStorage.disk.smaller', { count })
            }
            pointedKey={pointed}
            onPointAt={pointAt}
            onOpen={open}
            onCollect={collectKey}
            onUp={props.onUp}
            renderTooltip={tooltip}
          />
        )
      ) : null}
      <View style={styles.key}>
        {(
          [
            [
              'area',
              props.shape === 'map'
                ? 'machineStorage.disk.keyArea'
                : 'machineStorage.disk.keyArc',
            ],
            ['accent', 'machineStorage.disk.keyHappier'],
            ['hatch', 'machineStorage.disk.keyPile'],
            ['dots', 'machineStorage.disk.keySmaller'],
          ] as const
        ).map(([kind, key]) => (
          <View key={kind} style={styles.keyItem}>
            <View
              style={[
                styles.keySwatch,
                kind === 'accent'
                  ? { backgroundColor: usageSignatureAccent(theme), opacity: 0.6 }
                  : kind === 'area'
                    ? { backgroundColor: theme.colors.text.tertiary }
                    : {
                        borderWidth: 1,
                        borderColor: theme.colors.text.secondary,
                      },
              ]}
            />
            <Text style={styles.keyText}>{t(key)}</Text>
          </View>
        ))}
      </View>
      {inspectedPath && inspectedNode ? (
        <Item
          testID="machine-storage-disk-inspector"
          title={storageDiskNodeName(inspectedNode)}
          subtitle={inspectedPath}
          mode="info"
          showChevron={false}
          rightElement={<TextLinkButton
            testID="machine-storage-disk-inspector-copy"
            label={t('files.repositoryTree.actions.copyPath')}
            accessibilityLabel={`${t('files.repositoryTree.actions.copyPath')}: ${inspectedPath}`}
            onPress={() => copyStoragePath(inspectedPath)}
          />}
        />
      ) : null}
    </View>
  );
}

const NO_DISK_ROW_ACTIONS: CollectionRowActions = {};

/**
 * A scanned item's row actions, behind its ⋯ and a right-click (Folders, Large and Old alike): Copy path, the
 * daemon's exact path on the machine. Folded small items, hidden space and reserved space are not one path.
 */
function useDiskRowActions(row: StorageDiskRow): CollectionRowActions {
  if (row.mark === 'small' || row.mark === 'hidden' || row.mark === 'reserved') return NO_DISK_ROW_ACTIONS;
  return {
    secondaryActions: [{ id: 'copy-path', label: t('files.repositoryTree.actions.copyPath') }],
    onSecondaryAction: () => copyStoragePath(row.node.nodeId),
  };
}

function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/**
 * Quick ways into the same folder scan, beside "Choose a folder…": the machine's home folder and the folders
 * the daemon verified still exist. Each starts the one daemon scan on that folder.
 */
function ScanFolderShortcuts(
  props: Readonly<{
    serverId: string;
    machineId: string;
    homeDir: string | undefined;
    shortcuts: StorageSummary['scanShortcuts'];
    disabled: boolean;
    onScan: (folderPath: string) => void;
    /**
     * A page that already holds a scan has no invitation card to carry "Choose a folder…", so the group leads
     * with it and names itself for what it now is: another folder, not the first one.
     */
    onChoose?: () => void;
    /** The machine runs one scan at a time: while one runs the rows stay in place, off, and the group says why. */
    waiting?: boolean;
  }>,
) {
  usePreferredLanguage();
  const places = React.useMemo(() => {
    const out: { path: string; title: string; icon: IconName }[] = [];
    if (props.homeDir) out.push({ path: props.homeDir, title: t('machineStorage.disk.shortcutHome'), icon: 'house' });
    for (const shortcut of props.shortcuts ?? []) {
      if (out.some(place => place.path === shortcut.path)) continue;
      out.push({ path: shortcut.path, title: shortcut.kind === 'folder' ? folderName(shortcut.path)
        : t(shortcut.kind === 'downloads' ? 'machineStorage.disk.shortcutDownloads' : 'machineStorage.disk.shortcutCache'), icon: 'folder' });
    }
    return out;
  }, [props.homeDir, props.shortcuts]);
  if (places.length === 0 && !props.onChoose) return null;
  return (
    <ItemGroup
      title={t(props.onChoose ? 'machineStorage.disk.scanAnotherTitle' : 'machineStorage.disk.shortcutsTitle')}
      description={t(props.waiting ? 'machineStorage.disk.scanAnotherWaiting' : 'machineStorage.disk.shortcutsNote')}
    >
      {props.onChoose ? (
        <Item
          testID="machine-storage-disk-folder"
          icon={<Icon name="folder-open" />}
          title={t('machineStorage.disk.chooseFolder')}
          disabled={props.disabled}
          onPress={props.onChoose}
          showChevron={false}
          showDivider={places.length > 0}
        />
      ) : null}
      {places.map((place, index) => (
        <Item
          key={place.path}
          testID={`machine-storage-disk-shortcut-${index}`}
          icon={<Icon name={place.icon} />}
          title={place.title}
          // Home says where it is; every other folder reads from home ("~/code/happier").
          subtitle={index === 0 && place.path === props.homeDir ? place.path : formatPathRelativeToHome(place.path, props.homeDir)}
          subtitleLines={1}
          accessibilityLabel={t('machineStorage.disk.scanFolder', { folder: place.title })}
          disabled={props.disabled}
          onPress={() => props.onScan(place.path)}
          showChevron={false}
          showDivider={index < places.length - 1}
        />
      ))}
    </ItemGroup>
  );
}

/** A scan row as the pile reads it: its path names it; a node in use asks the Keep confirmation. */
function toCollectRow(row: StorageDiskRow) {
  return toStorageDiskCollectRow(row.node);
}

/** The list beneath (where you act): the Collection table on a desktop, its list on a phone. */
function DiskList(
  props: Readonly<{
    rows: readonly StorageDiskRow[];
    files: Files;
    sort: StorageDiskSort;
    onSort: (sort: StorageDiskSort) => void;
    collect: StorageCollectController;
    compact: boolean;
    homeDir: string | undefined;
    loading: boolean;
    /** The open folder's known child count: its loading rows reserve that many. */
    expectedRows?: number;
    reading: boolean;
    /** Set when the level's read failed: its empty state is the failure and this retry, never "Nothing here.". */
    onRetryRead?: () => void;
    previousScanAt: number | null;
    onOpen: (nodeId: string) => void;
    machineName: string;
  }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const { collect } = props;
  const largest = props.rows.reduce(
    (max, row) => Math.max(max, row.node.size.allocatedBytes),
    0,
  );
  const rowsRef = React.useRef(props.rows);
  rowsRef.current = props.rows;
  const onOpenChange = React.useCallback(
    (key: string | null) => {
      const row = key
        ? rowsRef.current.find((entry) => entry.key === key)
        : undefined;
      if (row?.drillable) props.onOpen(row.key);
    },
    [props],
  );
  // Old files read by how long since anything changed (lab MX 2); every other view is one ungrouped level.
  const groups = React.useMemo(() => props.files !== 'old' ? undefined : {
    axis: OLD_AGE_GROUPS.map((key) => ({ key, title: t(`machineStorage.disk.ageGroups.${key}`) })),
    groupOf: (row: StorageDiskRow) => describeOldAgeGroup(row.node.changedAt),
  }, [language, props.files]);
  const model = useHappierCollection<StorageDiskRow>({
    items: props.rows,
    keyOf: (row) => row.key,
    openKey: null,
    onOpenChange,
    ...(groups ? { groups } : {}),
  });
  // The rows as the collect controller reads them (a scan node's id is its path); Shift and keys range over them.
  const collectRows = React.useMemo(() => props.rows.map((row) => toCollectRow(row)), [props.rows]);
  const boxOf = React.useCallback((row: StorageDiskRow) => {
    const input = collectRows.find((entry) => entry.itemId === row.key) ?? toCollectRow(row);
    return collect.rowProps(input, collectRows);
  }, [collect, collectRows]);
  const describe = React.useCallback(
    (row: StorageDiskRow): string => {
      const parts: string[] = [];
      if (props.files !== 'folders' && row.node.parentId)
        parts.push(formatPathRelativeToHome(row.node.parentId, props.homeDir));
      switch (row.mark) {
        case 'protected': {
          // The machine's own tier and reason ("Keep · contains the main checkout"), else the plain mark.
          const collectRow = toStorageDiskCollectRow(row.node);
          parts.push(row.node.reason ? describeStorageVerdict(collectRow).label : t('machineStorage.disk.marks.protected'));
          break;
        }
        case 'mount':
          parts.push(t('machineStorage.disk.marks.mount'));
          break;
        case 'small':
          parts.push(t('machineStorage.disk.marks.small'));
          break;
        case 'hidden':
          parts.push(t('machineStorage.disk.marks.hidden'));
          break;
        case 'reserved':
          parts.push(t('machineStorage.disk.marks.reserved'));
          break;
        case 'cloud':
          parts.push(t('machineStorage.disk.marks.cloud'));
          break;
        case 'happier':
          parts.push(t('machineStorage.disk.marks.happier'));
          break;
        default:
          if (row.node.kind !== 'file')
            parts.push(
              t('machineStorage.disk.itemsCount', { count: row.node.items }),
            );
      }
      // The phone says its lower bound once, in the "≥" figure at the row's right; the table keeps the words.
      if (row.node.flags.atLeast && !props.compact) parts.push(t('machineStorage.disk.atLeast'));
      // A Keep row whose reason is "in use" already says so in its verdict.
      if (row.node.flags.inUse && !(row.mark === 'protected' && row.node.reason?.code === 'in_use'))
        parts.push(t('machineStorage.disk.inUse'));
      if (props.files !== 'folders')
        parts.push(
          t('machineStorage.page.changed', {
            when: formatRelativeTime(row.node.changedAt),
          }),
        );
      return parts.join(' · ');
    },
    [props.compact, props.files, props.homeDir],
  );
  const since = (row: StorageDiskRow) => {
    const delta = row.node.deltaSincePrevious;
    if (delta === undefined) return '';
    if (delta === 0) return t('machineStorage.disk.noChange');
    return `${delta > 0 ? '+' : '−'}${formatMachineBytes(Math.abs(delta), 'storage')}`;
  };
  // The folded "small items" row of a scan that did not size its small files has no size to say ("≥ 0 B" tells nothing).
  const hasSize = (row: StorageDiskRow) => !(row.node.kind === 'small-items' && row.node.size.allocatedBytes === 0);
  const sizeText = (row: StorageDiskRow) =>
    row.mark === 'mount'
      ? t('machineStorage.disk.anotherDisk')
      : hasSize(row)
        ? formatStorageDiskBytes(row.node)
        : '';
  const fields = React.useMemo(
    (): CollectionField<StorageDiskRow>[] => [
      {
        key: 'size',
        title: t('machineStorage.disk.columns.size'),
        minWidth: 170,
        priority: 3,
        align: 'end',
        sortable: true,
        render: (row) => (
          <View style={styles.sizeCell}>
            {row.mark === 'mount' ? null : (
              <View style={styles.sizeBar}>
                <StorageSizeBar
                  label={storageDiskNodeName(row.node)}
                  bytes={row.node.size.allocatedBytes}
                  largest={largest}
                  compact={false}
                  color={
                    row.mark === 'happier'
                      ? usageSignatureAccent(theme)
                      : undefined
                  }
                  hatched={
                    row.collect === 'collected' || row.collect === 'inside'
                  }
                />
              </View>
            )}
            <Text style={styles.size} numberOfLines={1}>
              {sizeText(row)}
            </Text>
          </View>
        ),
      },
      ...(props.files === 'folders' && props.previousScanAt
        ? [
            {
              key: 'since',
              title: t('machineStorage.disk.columns.since', {
                date: formatStorageDay(props.previousScanAt),
              }),
              minWidth: 96,
              priority: 2,
              align: 'end' as const,
              sortable: true,
              render: (row: StorageDiskRow) => (
                <Text style={styles.since}>{since(row)}</Text>
              ),
            },
          ]
        : []),
    ],
    [
      language,
      largest,
      props.files,
      props.previousScanAt,
      theme.colors.border.default,
      theme.colors.text.secondary,
    ],
  );
  const anatomy = React.useMemo(
    (): CollectionAnatomy<StorageDiskRow> => ({
      glyph: (row) =>
        row.collect !== 'none' ? (
          <StorageCollectToggle
            state={row.collect}
            onPress={boxOf(row).onToggle}
            onKeyDown={boxOf(row).onKeyDown}
            label={t('machineStorage.pile.collectLabel', {
              title: storageDiskNodeName(row.node),
            })}
            testID={`machine-storage-disk-${row.key}-collect`}
          />
        ) : (
          <Icon
            name={MARK_ICONS[row.mark]}
            size={16}
            color={theme.colors.text.secondary}
          />
        ),
      title: (row) => storageDiskNodeName(row.node),
      // The evidence reads quiet after the name in the table (no middle column to truncate it) and as the
      // second line of the phone's list (lab `rs` M / Mp).
      titleSuffix: (row) => describe(row),
      byline: (row) => (
        <Text style={styles.where} numberOfLines={1}>
          {describe(row)}
        </Text>
      ),
      fields,
      // Phone (lab `rs` Mp): the list has no size column, so the row says its size at the right.
      ...(props.compact
        ? {
            reason: (row: StorageDiskRow) =>
              hasSize(row) ? (
                <Text style={styles.size} numberOfLines={1}>
                  {sizeText(row)}
                </Text>
              ) : null,
          }
        : {}),
      accessibilityLabel: (row) =>
        t('machineStorage.disk.rowLabel', {
          name: storageDiskNodeName(row.node),
          size: row.mark !== 'mount' && hasSize(row)
            ? sizeText(row)
            : formatMachineBytes(row.node.size.allocatedBytes, 'storage'),
          detail: describe(row),
        }),
      testID: (row) => `machine-storage-disk-row-${row.key}`,
      columnTitles: { title: t('machineStorage.disk.columns.name') },
    }),
    [language, describe, fields, props.compact, theme.colors.text.secondary, boxOf],
  );
  const sort = React.useMemo(
    () => ({
      key: props.sort.by,
      direction:
        props.sort.direction === 'asc'
          ? ('ascending' as const)
          : ('descending' as const),
      onChange: (key: string) =>
        props.onSort({
          by: key as StorageDiskSort['by'],
          direction:
            props.sort.by === key && props.sort.direction === 'desc'
              ? 'asc'
              : 'desc',
        }),
    }),
    [props],
  );
  return (
    <CoreCollectionScope>
      <Collection<StorageDiskRow>
        testID="machine-storage-disk-list"
        model={model}
        anatomy={anatomy}
        useRowActions={useDiskRowActions}
        accessibilityLabel={t('machineStorage.disk.listLabel', {
          machine: props.machineName,
        })}
        presentation={props.compact ? 'list' : 'table'}
        detail="none"
        scroll="page"
        minListWidth={560}
        minDetailWidth={560}
        preferredListRatio={1}
        sort={sort}
        loading={props.loading}
        {...(props.expectedRows === undefined ? {} : { loadingRows: props.expectedRows })}
        selection={{ isItemActivatable: (row) => row.drillable }}
        empty={
          props.reading ? (
            <SurfaceStateCard
              testID="machine-storage-disk-list-scanning"
              kind="loading"
              size="line"
              title={t('common.loading')}
            />
          ) : props.onRetryRead ? (
            <SurfaceStateCard
              testID="machine-storage-disk-list-unreadable"
              kind="error"
              size="line"
              title={t('machineStorage.disk.levelUnreadable')}
              action={{ label: t('machineStorage.tryAgain'), onPress: props.onRetryRead }}
            />
          ) : (
            <SurfaceStateCard
              kind="empty"
              size="line"
              title={t('machineStorage.disk.emptyLevel')}
            />
          )
        }
      />
    </CoreCollectionScope>
  );
}

const styles = StyleSheet.create((theme) => ({
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
    marginTop: theme.space.s16,
  },
  toolsCompact: {
    alignItems: 'stretch',
  },
  grow: {
    flex: 1,
  },
  progress: {
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
    paddingVertical: 14,
  },
  progressHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
  },
  progressPercent: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  progressMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  current: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  path: {
    ...Typography.mono(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flex: 1,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // On a phone the figures drop under the crumbs instead of being cut to "8.8…".
    flexWrap: 'wrap',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  crumb: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.secondary,
  },
  crumbCurrent: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  pathMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  chart: {
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s8,
    gap: theme.space.s10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  key: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s16,
  },
  keyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  keySwatch: {
    width: 9,
    height: 9,
    borderRadius: 2,
  },
  keyText: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  tooltip: {
    width: 232,
    gap: 3,
    paddingHorizontal: theme.space.s12,
    paddingVertical: theme.space.s10,
    borderRadius: 10,
    backgroundColor: theme.colors.edge.cardFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.surface,
    // A floating surface: the elevation ladder's popover step, as the pile dock.
    ...shadowLevelStyle(theme.colors.shadowLevels[2]),
  },
  tooltipHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.space.s8,
  },
  tooltipTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  tooltipMeta: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  tooltipKeys: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  where: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  sizeCell: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s12,
  },
  sizeBar: {
    width: 80,
  },
  size: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    minWidth: 64,
    textAlign: 'right',
  },
  since: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
}));
