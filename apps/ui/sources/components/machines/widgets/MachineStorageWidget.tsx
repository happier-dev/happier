import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  CompositionStrip,
  happierPageTextMetrics,
  type CompositionSegment,
} from '@happier-dev/plugin-ui/presentation';
import type { MachineResourceReasonV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { usageSignatureAccent } from '@/components/settings/usage/usageAccent';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import {
  StorageCategoryRow,
  StorageRing,
} from '@/components/machines/storage/StorageBreakdown';
import { describeStorageCategoryFacts } from '@/components/machines/storage/storageCategoryText';
import { useStorageCollect } from '@/components/machines/storage/StorageCollectToggle';
import { StorageItemRow } from '@/components/machines/storage/StorageItemRow';
import { StoragePileDock } from '@/components/machines/storage/StoragePileDock';
import { describeStorageVerdict, storageEvidenceLabel } from '@/components/machines/storage/storageReasonPresentation';
import { StorageVolumeRow } from '@/components/machines/storage/StorageVolumes';
import {
  orderStorageCategories,
  resolveStorageVolumeParts,
  selectStorageHeadlineVolume,
  selectStorageTabView,
  storageVolumeName,
  type StorageCategory,
  type StorageSummary,
  type StorageVolume,
} from '@/components/machines/storage/storageViewModel';
import {
  describeMachineAttentionWord,
  readMachinePublishedResources,
  resolveMachineReasonAction,
} from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineResourceToneColor } from '@/components/machines/summary/machineSummaryStripModel';
import {
  formatMachineBytes,
  machineBytesParts,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import {
  MachineWidgetSectionLabel,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  readStorageWidgetFreshness,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetTarget,
} from './machineWidgetKit';

/** The ring's diameter per size (lab `rw` ST: 100 small/wide, 124 medium/full, 150 tall/large). */
const RING_SIZE: Readonly<Record<WidgetSizeV1, number>> = {
  small: 100,
  wide: 100,
  medium: 124,
  full: 124,
  tall: 150,
  large: 150,
};
const CATEGORY_ROWS: Readonly<Record<WidgetSizeV1, number>> = {
  small: 0,
  wide: 0,
  medium: 2,
  full: 3,
  tall: 5,
  large: 4,
};

type StorageWidgetView = Readonly<{
  summary: StorageSummary;
  volume: StorageVolume;
  /** This volume's verified "can go" (`volumes[].canGoBytes`); null when unreported, unmeasured or for a recipient. */
  canGoBytes: number | null;
  measuring: boolean;
  /** The volume that holds Happier's share; the summary's top suggestions are collected from Review only here. */
  headline: boolean;
  /** The disk's attention reason (nearly full / full), from the machine's published summary. */
  reason: Extract<
    MachineResourceReasonV1,
    { kind: 'disk_nearly_full' | 'disk_full' }
  > | null;
  offline: boolean;
  recipient: boolean;
  /** Protection awaits the machine's resources policy: sizes only, no cleanup action. */
  policyUnavailable: boolean;
}>;

/**
 * Storage (plan 60 EU-6, lab `rw` ST): one volume as the capacity ring — free in the centre, everything
 * else in ink, Happier's share in the accent and what can go hatched — with Happier's own breakdown and
 * the volumes beside it where there is width. Data is plan 40's storage summary (the Storage tab's) and
 * the disk's tone is plan 20's published attention. Nothing is removed here: Review collects into the
 * machine's pile and opens the Storage tab, "Free up space" opens the prepared low-disk view.
 */
export function MachineStorageWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.storage.noMachine')}
        testID={props.testID}
      />
    );
  return (
    <MachineStorageWidgetBody
      target={target}
      volumeId={
        typeof props.input.volume === 'string' ? props.input.volume : null
      }
      testID={props.testID}
    />
  );
}

function MachineStorageWidgetBody(
  props: Readonly<{
    target: MachineWidgetTarget;
    volumeId: string | null;
    testID: string;
  }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const storage = useMachineStorageSummary(props.target);
  const open = useOpenMachinePage(props.target);
  const daemonState: unknown = facts.machine?.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const tabView = selectStorageTabView({
    status: storage.status,
    enabled: storage.enabled,
    summary: storage.summary,
    offline: storage.offline,
    recipient: facts.recipient,
  });
  useMachineWidgetFreshness(readStorageWidgetFreshness(tabView), props.testID);
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (tabView.kind === 'not_reported')
    return (
      <MachineWidgetState
        kind="not_reported"
        machineName={facts.name}
        testID={props.testID}
      />
    );
  if (tabView.kind === 'offline_empty')
    return (
      <MachineWidgetState
        kind="offline"
        machineName={facts.name}
        lastSeenAt={facts.lastSeenAt}
        testID={props.testID}
      />
    );
  // A machine that is offline says so, as Vitals and Guard do, rather than "couldn't read" with a Retry that cannot work.
  if (tabView.kind === 'error' && facts.online === false)
    return (
      <MachineWidgetState
        kind="offline"
        machineName={facts.name}
        lastSeenAt={facts.lastSeenAt}
        testID={props.testID}
      />
    );
  if (tabView.kind === 'error')
    return (
      <MachineWidgetState
        kind="error"
        onRetry={storage.retry}
        testID={props.testID}
      />
    );
  // Protection and cleanup await the machine's resources policy and nothing was sized yet: the tab's notice, in the widget's frame.
  if (tabView.kind === 'policy_unavailable')
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machineStorage.states.policyUnavailable')}
        reason={t('machineStorage.states.policyUnavailableReason')}
        testID={`${props.testID}.policy`}
      />
    );
  if (tabView.kind === 'waiting')
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('projects.checkouts.waiting', { machine: facts.name })}
        testID={props.testID}
      />
    );
  if (tabView.kind === 'loading')
    return <MachineWidgetState kind="loading" rows={2} testID={props.testID} />;
  const summary = tabView.summary;
  const headline = selectStorageHeadlineVolume(summary);
  const volume = props.volumeId
    ? (summary.volumes.find(
        (entry) => entry.volume.volumeId === props.volumeId,
      ) ?? null)
    : headline;
  if (!volume) {
    // A volume the person chose that the machine no longer reports: a dash, never zero.
    return (
      <MachineWidgetState
        kind="unavailable"
        testID={`${props.testID}.volume`}
        title={
          props.volumeId
            ? t('machines.widgets.body.storage.volumeMissing')
            : t('machines.widgets.body.storage.noVolumes')
        }
        reason={
          props.volumeId
            ? t('machines.widgets.body.storage.volumeMissingReason')
            : undefined
        }
      />
    );
  }
  const reason =
    (published?.attention.reasons ?? []).find(
      (entry): entry is StorageWidgetView['reason'] & object =>
        (entry.kind === 'disk_nearly_full' || entry.kind === 'disk_full') &&
        entry.volumeId === volume.volume.volumeId,
    ) ?? null;
  // The daemon's verified-Safe figure for this volume (40c): absent is not reported (or not yet measured), 0 is
  // a measured zero. A recipient's projection omits it; there it is simply not shown.
  // While the policy is unavailable the sizes stay but nothing is claimed as able to go.
  const cleanupKnown = !tabView.recipient && !tabView.policyUnavailable;
  const volumeCanGo = cleanupKnown ? (volume.canGoBytes ?? null) : null;
  const measuring = cleanupKnown && volume.canGoBytes === undefined;
  const view: StorageWidgetView = {
    summary,
    volume,
    measuring,
    reason,
    offline: tabView.offline,
    recipient: tabView.recipient,
    policyUnavailable: tabView.policyUnavailable,
    canGoBytes: volumeCanGo,
    headline: volume.volume.volumeId === headline?.volume.volumeId,
  };
  return (
    <StorageWidgetComposition
      view={view}
      size={size}
      target={props.target}
      machineName={facts.name}
      open={open}
      testID={props.testID}
    />
  );
}

function StorageWidgetComposition(
  props: Readonly<{
    view: StorageWidgetView;
    size: WidgetSizeV1;
    target: MachineWidgetTarget;
    machineName: string;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const { view, size } = props;
  const ring = (
    <StorageCapacityRing
      view={view}
      size={RING_SIZE[size]}
      testID={`${props.testID}.ring`}
    />
  );
  const legend = (
    <StorageCapacityLegend
      view={view}
      free={size === 'tall' || size === 'large'}
      // Beside the ring the legend is its key, one line each with the figure right-aligned (lab `rw` ST);
      // under the ring (Tall) the entries run on.
      layout={size === 'tall' ? 'flow' : 'key'}
      testID={`${props.testID}.legend`}
    />
  );
  const canAct = !view.offline && !view.recipient && !view.policyUnavailable;
  const actions = (
    <StorageWidgetActions
      view={view}
      target={props.target}
      machineName={props.machineName}
      open={props.open}
      canAct={canAct}
      testID={props.testID}
    />
  );
  const volumes = view.summary.volumes.slice(0, 2);
  const volumeRows =
    volumes.length > 0 ? (
      <View style={styles.section}>
        {size === 'wide' ? null : (
          <MachineWidgetSectionLabel
            label={t('machines.widgets.body.storage.volumesOn', {
              machine: props.machineName,
            })}
          />
        )}
        {volumes.map((entry, index) => (
          <StorageVolumeRow
            key={entry.volume.volumeId}
            volume={entry}
            compact
            showDivider={index < volumes.length - 1}
          />
        ))}
      </View>
    ) : null;
  const categories = (
    <StorageWidgetCategories
      view={view}
      target={props.target}
      count={CATEGORY_ROWS[size]}
      open={props.open}
      label={
        size === 'large'
          ? t('machines.widgets.body.storage.byKind')
          : t('machines.widgets.body.storage.happierUses')
      }
      testID={props.testID}
    />
  );
  const offlineLine = view.offline ? (
    <Text style={styles.caption}>
      {t('machines.widgets.body.storage.lastKnown')}
    </Text>
  ) : null;
  const toned = view.reason ? (
    <StorageReasonLine
      view={view}
      machineName={props.machineName}
      testID={props.testID}
    />
  ) : null;

  if (size === 'small') {
    return (
      <View testID={props.testID} style={styles.row}>
        {ring}
        <View style={styles.grow}>
          {toned ? (
            <>
              {toned}
              {actions}
            </>
          ) : (
            <>
              {legend}
              {offlineLine}
            </>
          )}
        </View>
      </View>
    );
  }
  if (size === 'wide') {
    return (
      <View testID={props.testID} style={styles.row}>
        {ring}
        <View style={styles.legendColumn}>
          {toned ?? legend}
          {toned ? actions : offlineLine}
        </View>
        {volumeRows ? (
          <View style={styles.besideRule}>{volumeRows}</View>
        ) : null}
      </View>
    );
  }
  const head = (
    <View style={styles.row}>
      {ring}
      <View style={styles.grow}>
        {toned ?? legend}
        {offlineLine}
      </View>
    </View>
  );
  if (size === 'medium')
    return (
      <View testID={props.testID} style={styles.column}>
        {head}
        {categories}
        {actions}
      </View>
    );
  if (size === 'full') {
    return (
      <View testID={props.testID} style={styles.fill}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {head}
              {volumeRows}
              <View style={styles.end}>{actions}</View>
            </>
          }
          rest={
            <>
              <MachineWidgetSectionLabel
                label={t('machines.widgets.body.storage.happierUses')}
                meta={formatMachineBytes(
                  readHappierBytes(view.summary),
                  'storage',
                )}
              />
              <StorageRing summary={view.summary} />
              <StorageWidgetCategories
                view={view}
                target={props.target}
                count={CATEGORY_ROWS.full}
                open={props.open}
                label={null}
                testID={props.testID}
              />
            </>
          }
        />
      </View>
    );
  }
  if (size === 'tall') {
    return (
      <View testID={props.testID} style={styles.column}>
        <View style={styles.centered}>{ring}</View>
        {toned ?? legend}
        {offlineLine}
        {volumeRows}
        {categories}
        <View style={styles.end}>{actions}</View>
      </View>
    );
  }
  // Large: the ring with its key and the volumes, Happier's donut and its kinds, then what is easy to get back and the pile.
  return (
    <View testID={props.testID} style={styles.column}>
      <View style={styles.row}>
        {ring}
        <View style={styles.legendColumn}>
          {toned ?? legend}
          {offlineLine}
        </View>
        {volumeRows ? <View style={styles.grow}>{volumeRows}</View> : null}
      </View>
      <MachineWidgetTwoColumns
        lead={
          <>
            <MachineWidgetSectionLabel
              label={t('machines.widgets.body.storage.happierUses')}
              meta={formatMachineBytes(
                readHappierBytes(view.summary),
                'storage',
              )}
            />
            <StorageRing summary={view.summary} />
          </>
        }
        rest={categories}
      />
      <StorageWidgetEasy
        view={view}
        target={props.target}
        canAct={canAct}
        testID={props.testID}
      />
      {canAct ? (
        <StoragePileDock
          serverId={props.target.serverId}
          machineId={props.target.machineId}
          machineName={props.machineName}
          summary={view.summary}
          compact
          placement="card"
        />
      ) : (
        <View style={styles.end}>{actions}</View>
      )}
    </View>
  );
}

function readHappierBytes(summary: StorageSummary): number {
  return summary.volumes.reduce((sum, volume) => sum + volume.happierBytes, 0);
}

/** The disk as one ring: everything else · Happier · what can go (hatched); the unfilled track is free (R9). */
function StorageCapacityRing(
  props: Readonly<{ view: StorageWidgetView; size: number; testID: string }>,
) {
  const { theme } = useUnistyles();
  const accent = usageSignatureAccent(theme);
  const { volume, canGoBytes, reason } = props.view;
  const parts = resolveStorageVolumeParts(volume);
  const total = Math.max(1, volume.totalBytes);
  const happier = parts.happier + parts.pile;
  const canGo = Math.min(happier, canGoBytes ?? 0);
  const tone = reason
    ? reason.level === 'needs_you' || reason.kind === 'disk_full'
      ? 'crit'
      : 'warn'
    : 'calm';
  const toneColor = resolveMachineResourceToneColor(tone, theme.colors);
  const segments =
    tone === 'calm'
      ? [
          {
            fraction: parts.everythingElse / total,
            color: theme.colors.text.tertiary,
          },
          { fraction: (happier - canGo) / total, color: accent },
          ...(canGo > 0
            ? [
                {
                  fraction: canGo / total,
                  color: accent,
                  pattern: 'hatched' as const,
                },
              ]
            : []),
        ]
      : undefined;
  const free = machineBytesParts(parts.free, 'storage');
  const label = t('machines.widgets.body.storage.ringLabel', {
    volume: storageVolumeName(volume),
    free: formatMachineBytes(parts.free, 'storage'),
    total: formatMachineBytes(volume.totalBytes, 'storage'),
  });
  const stroke = Math.round(props.size / 11);
  return (
    <CapacityRing
      testID={props.testID}
      size={props.size}
      strokeWidth={stroke}
      trackColor={theme.colors.border.default}
      {...(segments
        ? { segments }
        : { ratio: 1 - parts.free / total, color: toneColor })}
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.ringValue,
          props.size >= 150 ? styles.ringValueLarge : null,
          tone !== 'calm' ? { color: toneColor } : null,
        ]}
      >
        {free.value}
      </Text>
      <Text style={styles.ringUnit}>
        {t('machines.widgets.body.storage.unitFree', { unit: free.unit })}
      </Text>
    </CapacityRing>
  );
}

/** The ring's key: the three parts with their amounts (and Free where there is room), or "Measuring what can go…". */
function StorageCapacityLegend(
  props: Readonly<{ view: StorageWidgetView; free: boolean; layout: 'flow' | 'key'; testID: string }>,
) {
  const language = usePreferredLanguage();
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const { volume, canGoBytes, measuring } = props.view;
  const parts = resolveStorageVolumeParts(volume);
  const segments = React.useMemo(
    (): CompositionSegment[] => [
      {
        id: 'else',
        label: t('machineStorage.volumes.everythingElse'),
        value: parts.everythingElse,
        color: theme.colors.text.tertiary,
      },
      {
        id: 'happier',
        label: t('machineStorage.volumes.happier'),
        value: parts.happier + parts.pile,
        color: usageSignatureAccent(theme),
      },
      ...(canGoBytes !== null
        ? [
            {
              id: 'canGo',
              label: t('machines.widgets.body.storage.canGo'),
              value: canGoBytes,
              color: usageSignatureAccent(theme),
              pattern: 'hatched' as const,
            },
          ]
        : []),
      ...(props.free
        ? [
            {
              id: 'free',
              label: t('machineStorage.volumes.free'),
              value: parts.free,
              color: theme.colors.border.default,
            },
          ]
        : []),
    ],
    [
      language,
      canGoBytes,
      parts.everythingElse,
      parts.free,
      parts.happier,
      parts.pile,
      theme,
      props.free,
      theme.colors.border.default,
      theme.colors.text.tertiary,
    ],
  );
  const format = React.useCallback(
    (value: number) => formatMachineBytes(value, 'storage'),
    [],
  );
  return (
    <View testID={props.testID} style={styles.legend}>
      <CompositionStrip
        theme={pluginTheme}
        label={storageVolumeName(volume)}
        total={volume.totalBytes}
        segments={segments}
        variant="legend"
        unknownLabel=""
        appearance={{ legend: 'compact', figure: 'value', layout: props.layout }}
        valueFormatter={format}
      />
      {measuring ? (
        <Text testID={`${props.testID}.measuring`} style={styles.caption}>
          {t('machines.widgets.body.storage.measuring')}
        </Text>
      ) : null}
    </View>
  );
}

/** A disk that needs you says so in tone, with the consequence (lab ST "Needs you" / "Critical"). */
function StorageReasonLine(
  props: Readonly<{
    view: StorageWidgetView;
    machineName: string;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const reason = props.view.reason!;
  const tone =
    reason.level === 'needs_you' || reason.kind === 'disk_full'
      ? 'crit'
      : 'warn';
  const color = resolveMachineResourceToneColor(tone, theme.colors);
  const volume = props.view.volume;
  const usedPct =
    volume.totalBytes > 0
      ? Math.round((1 - volume.freeBytes / volume.totalBytes) * 100)
      : null;
  const detail =
    reason.kind === 'disk_full'
      ? t('machines.widgets.body.storage.fullDetail', {
          machine: props.machineName,
        })
      : usedPct === null
        ? null
        : t('machines.widgets.body.storage.nearlyFullDetail', {
            percent: usedPct,
            total: formatMachineBytes(volume.totalBytes, 'storage'),
            happier: formatMachineBytes(volume.happierBytes, 'storage'),
          });
  return (
    <View testID={`${props.testID}.reason`} style={styles.reason}>
      <Text style={[styles.reasonWord, { color }]} numberOfLines={2}>
        {describeMachineAttentionWord(reason)}
      </Text>
      {detail ? (
        <Text style={styles.caption} numberOfLines={3}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The widget's one way in. A full disk opens the prepared low-disk view (the tap is the intent, plan 40
 * STO-23); otherwise Review collects the verified Safe suggestions into the machine's pile and opens
 * the Storage tab. Nothing is removed from here; a recipient or an offline machine gets no button.
 */
function StorageWidgetActions(
  props: Readonly<{
    view: StorageWidgetView;
    target: MachineWidgetTarget;
    machineName: string;
    canAct: boolean;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const { view } = props;
  if (view.recipient)
    return (
      <Text testID={`${props.testID}.recipient`} style={styles.caption}>
        {t('machines.widgets.body.common.recipient')}
      </Text>
    );
  if (!props.canAct) return null;
  if (view.reason) {
    const action = resolveMachineReasonAction(view.reason);
    if (!action) return null;
    return (
      <View style={styles.actions}>
        <RoundButton
          testID={`${props.testID}.freeUp`}
          size="small"
          display="secondary"
          title={action.label}
          onPress={() => {
            beginMachinePageTabIntent(props.target, action.tab);
            props.open(action.tab);
          }}
        />
      </View>
    );
  }
  if (view.canGoBytes === null || view.canGoBytes <= 0) return null;
  return (
    <StorageReviewAction
      view={view}
      target={props.target}
      open={props.open}
      testID={props.testID}
    />
  );
}

/** Mounted only where Review is offered: it is the pile's reader and writer for the collect. */
function StorageReviewAction(
  props: Readonly<{
    view: StorageWidgetView;
    target: MachineWidgetTarget;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const collect = useStorageCollect({
    serverId: props.target.serverId,
    machineId: props.target.machineId,
  });
  const safe = React.useMemo(
    () =>
      (props.view.summary.suggestionsSafeTop ?? props.view.summary.suggestionsTop).filter(
        (item) => item.verdict === 'safe' && item.collectable,
      ),
    [props.view.summary.suggestionsSafeTop, props.view.summary.suggestionsTop],
  );
  const review = React.useCallback(() => {
    // Add only: a second press must never take back what is already collected.
    // The top suggestions carry no volume: collect them only for the volume that holds Happier's share; another
    // volume's Review opens Storage there to pick from its own items.
    if (props.view.headline && safe.length > 0 && collect.groupOf(safe) !== 'checked')
      collect.collectAll(safe);
    props.open({ id: 'storage', volumeId: props.view.volume.volume.volumeId });
  }, [collect, props, safe]);
  return (
    <View style={styles.actions}>
      <RoundButton
        testID={`${props.testID}.review`}
        size="small"
        display="secondary"
        title={t('machines.widgets.body.storage.review', {
          amount: formatMachineBytes(props.view.canGoBytes ?? 0, 'storage'),
        })}
        onPress={review}
      />
      <Text style={styles.caption} numberOfLines={1}>
        {t('machines.widgets.body.storage.trashFirst')}
      </Text>
    </View>
  );
}

/** Happier's kinds, largest first, as the Storage tab's own rows; each opens its kind's page. */
function StorageWidgetCategories(
  props: Readonly<{
    view: StorageWidgetView;
    target: MachineWidgetTarget;
    count: number;
    label: string | null;
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const { summary } = props.view;
  const categories = React.useMemo(
    () => orderStorageCategories(summary).slice(0, props.count),
    [props.count, summary],
  );
  const largest = categories.reduce(
    (max, category) => Math.max(max, category.size.allocatedBytes),
    0,
  );
  const { open } = props;
  const openCategory = React.useCallback(
    (categoryId: StorageCategory['categoryId']) =>
      open(
        categoryId === 'worktrees'
          ? { id: 'storage', page: 'worktrees' }
          : { id: 'storage', page: 'category', categoryId },
      ),
    [open],
  );
  if (props.count === 0 || categories.length === 0) return null;
  return (
    <View testID={`${props.testID}.categories`} style={styles.section}>
      {props.label ? (
        <MachineWidgetSectionLabel
          label={props.label}
          meta={formatMachineBytes(readHappierBytes(summary), 'storage')}
        />
      ) : null}
      {categories.map((category, index) => (
        <StorageCategoryRow
          key={category.categoryId}
          serverId={props.target.serverId}
          machineId={props.target.machineId}
          category={category}
          summary={summary}
          largest={largest}
          facts={describeStorageCategoryFacts(category, null)}
          compact
          cleanupHidden={props.view.policyUnavailable}
          showDivider={index < categories.length - 1}
          onOpen={openCategory}
        />
      ))}
    </View>
  );
}

/** Large: the machine's verified suggestions with their verdicts, each collectable into the pile. */
function StorageWidgetEasy(
  props: Readonly<{
    view: StorageWidgetView;
    target: MachineWidgetTarget;
    canAct: boolean;
    testID: string;
  }>,
) {
  const items = props.view.summary.suggestionsTop;
  if (items.length === 0) return null;
  return (
    <StorageWidgetEasyRows
      items={items}
      target={props.target}
      canAct={props.canAct}
      testID={props.testID}
    />
  );
}

function StorageWidgetEasyRows(
  props: Readonly<{
    items: readonly StorageItemV1[];
    target: MachineWidgetTarget;
    canAct: boolean;
    testID: string;
  }>,
) {
  const collect = useStorageCollect({
    serverId: props.target.serverId,
    machineId: props.target.machineId,
    readOnly: !props.canAct,
  });
  // The card's own width decides the row's composition, as a page's body width does for its rows (a phone's card
  // holds the bar and the verdict beneath the name instead of in columns it has no room for).
  const layout = useMachineTabCompactLayout();
  const total = props.items.reduce(
    (sum, item) => sum + item.size.freesBytes,
    0,
  );
  const largest = props.items.reduce(
    (max, item) => Math.max(max, item.size.allocatedBytes),
    0,
  );
  return (
    <View testID={`${props.testID}.easy`} style={styles.section} onLayout={layout.onLayout}>
      <MachineWidgetSectionLabel
        label={t('machineStorage.suggestions.easy')}
        meta={t('machines.widgets.body.storage.easyMeta', {
          amount: formatMachineBytes(total, 'storage'),
          count: props.items.length,
        })}
      />
      {props.items.map((item, index) => (
        <StorageItemRow
          key={item.itemId}
          testID={`${props.testID}.easy.${item.itemId}`}
          title={item.title}
          evidence={item.evidence.map(storageEvidenceLabel).join(' · ')}
          bytes={item.size.allocatedBytes}
          atLeast={item.size.atLeast}
          largest={largest}
          freesBytes={item.size.freesBytes}
          chip={describeStorageVerdict(item)}
          compact={layout.compact}
          collect={
            props.canAct ? collect.rowProps(item, props.items) : undefined
          }
          showDivider={index < props.items.length - 1}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flexGrow: 1, minWidth: 0 },
  column: { flexGrow: 1, minWidth: 0, gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s20, minWidth: 0 },
  grow: { flex: 1, minWidth: 0, gap: theme.space.s8 },
  centered: { alignItems: 'center', paddingVertical: theme.space.s4 },
  legendColumn: { width: 200, flexShrink: 1, minWidth: 0, gap: theme.space.s8 },
  besideRule: {
    flex: 1,
    minWidth: 0,
    paddingLeft: theme.space.s20,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: theme.colors.border.subtle,
  },
  legend: { gap: theme.space.s6, minWidth: 0 },
  section: { gap: theme.space.s4, minWidth: 0 },
  end: { marginTop: 'auto' },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
    marginTop: theme.space.s4,
  },
  reason: { gap: 3, minWidth: 0 },
  reasonWord: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
  },
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  ringValue: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('pageTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  ringValueLarge: {
    ...happierPageTextMetrics('heroTitle'),
  },
  ringUnit: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
