import * as React from 'react';
import { Animated, Easing, Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProcessOwnerRefV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';
import type {
  StorageItemV1,
  StorageReasonV1,
} from '@happier-dev/protocol/storage/storageV1';

import { useMotionPreferences } from '@/components/instrument/motion/useMotionPreferences';
import { useMachineTabCompactLayout } from '@/components/machines/page/useMachineTabCompactLayout';
import { PileBar } from '@/components/machines/storage/PileBar';
import { StorageRestoreRecovery, useTrackedRestoreRefusals } from '@/components/machines/storage/StorageRestoreRecovery';
import { StorageVerdictPill } from '@/components/machines/storage/StorageItemRow';
import { StorageVolumeRow } from '@/components/machines/storage/StorageVolumes';
import {
  describeStorageLosses,
  describeStorageVerdict,
  storageReasonLabel,
  type StorageVerdictChip,
} from '@/components/machines/storage/storageReasonPresentation';
import type { StoragePileBar } from '@/components/machines/storage/storagePileModel';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { describeEndedOwner, describeProcessTitle } from '@/components/machines/processes/processOwnerIdentity';

import type {
  ResourceProposalVerdict,
  ResourceProposalModel,
} from './readResourceProposalApproval';
import {
  describeResourceProposalRows,
  resolveResourceProposalOutcomes,
  resourceProposalChangedCount,
  resourceProposalSelectAllState,
  resourceProposalTrashBytes,
  type ResourceProposalOutcome,
  type ResourceProposalRow,
} from './resourceProposalPresentation';
import { resolveResourceProposalLabels } from './resourceProposalLabels';
import { ResourceProposalProcessesContext } from './ResourceProposalProcessesContext';
import type { ResourceProposalController } from './useResourceProposalCheck';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

function lastSegment(path: string): string {
  const parts = path.replace(/[\\/]+$/u, '').split(/[\\/]/u);
  return parts[parts.length - 1] || path;
}

function ownerKindTitle(owner: ProcessOwnerRefV1 | null | undefined): string | null {
  switch (owner?.kind) {
    case 'session':
    case 'terminal':
    case 'service':
    case 'run':
    case 'browser_sidecar':
    case 'workspace_sync':
      return t(`resourceProposal.owner.${owner.kind}`);
    default:
      return null;
  }
}

/**
 * A process row in words: the checked process by name, what it belongs to (or, for Left behind, what ended)
 * and its command. The identity-pinned ref is never shown; without the checked row (an older daemon, or a
 * gone/refused target) the title falls back to the owner kind.
 */
function describeProcessItem(
  row: ResourceProposalRow,
  actionId: ResourceProposalModel['actionId'],
): Readonly<{ title: string; details: readonly string[] }> {
  const process = row.facts?.process;
  const checked = process?.row;
  const owner = process?.owner ?? row.item.owner;
  const named = checked
    ? 'appGroup' in checked ? checked.name : describeProcessTitle(checked)
    : null;
  const leftBehind = actionId === 'machines.processes.leftBehind.cleanUp' || process?.level === 'left_behind';
  const caption = leftBehind && owner ? describeEndedOwner(owner) : named ? ownerKindTitle(owner) : null;
  const command = checked && 'command' in checked ? checked.command?.trim() : null;
  return {
    title: row.facts?.keptByGuard?.label ?? named ?? ownerKindTitle(owner) ?? t('resourceProposal.owner.other'),
    details: [caption, command].filter((line): line is string => Boolean(line)),
  };
}

function verdictChip(
  kind: 'storage' | 'processes',
  verdict: ResourceProposalVerdict,
  reason: StorageReasonV1 | null,
  actionId: ResourceProposalModel['actionId'],
): StorageVerdictChip {
  if (kind === 'processes') {
    if (verdict === 'keep') return {
      variant: 'neutral', chrome: 'pill', icon: 'lock', label: t('machineStorage.verdicts.keep'),
    };
    return verdict === 'safe'
      ? {
          variant: 'success',
          chrome: 'plain',
          icon: 'check-circle',
          label: t(actionId === 'machines.processes.stop' ? 'resourceProposal.processSafe' : 'machineStorage.verdicts.safe'),
        }
      : {
          variant: 'attention',
          chrome: 'plain',
          icon: 'warning-circle',
          label: t('resourceProposal.processCheck'),
        };
  }
  if (reason) return describeStorageVerdict({ verdict, reason });
  // No reason reported: the verdict word alone, in the verdict table's tone and mark.
  const chip = describeStorageVerdict({ verdict, reason: { code: 'facts_unavailable' } });
  return { ...chip, label: t(VERDICT_WORD[verdict]) };
}

const VERDICT_WORD = {
  safe: 'machineStorage.verdicts.safe',
  caution: 'machineStorage.verdicts.caution',
  keep: 'machineStorage.verdicts.keep',
  forbidden: 'machineStorage.verdicts.forbidden',
  check: 'machineStorage.verdicts.check',
} as const;

/** One request item: its tick, title, path and reason, the verdict, and what it gives back. */
const ProposalRow = React.memo(function ProposalRow(
  props: Readonly<{
    kind: 'storage' | 'processes';
    actionId: ResourceProposalModel['actionId'];
    row: ResourceProposalRow;
    index: number;
    outcome: ResourceProposalOutcome | null;
    interactive: boolean;
    arrive: boolean;
    compact: boolean;
    showDivider: boolean;
    onToggle?: (key: string) => void;
    onConfirmKeep?: (key: string) => void;
    /** Settled: invoke the Action again for this skipped item (a new UI invocation, re-checked). */
    onRetry?: ((key: string) => unknown) | null;
    /** Stopped: the process owner's Start again. */
    onStartAgain?: ((key: string) => unknown) | null;
    startedAgain?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const motion = useMotionPreferences();
  const { row } = props;
  const [revealLoss, setRevealLoss] = React.useState(false);
  // Arrival (lab AM): rows fill top to bottom once, opacity + 4 px, 160 ms each, 40 ms apart.
  const arrival = React.useRef(
    new Animated.Value(props.arrive && !motion.reduceMotion ? 0 : 1),
  ).current;
  React.useEffect(() => {
    if (!props.arrive || motion.reduceMotion) return;
    const animation = Animated.timing(arrival, {
      toValue: 1,
      duration: 160,
      delay: props.index * 40,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
    // Once per mount: the arrival is not replayed when facts or ticks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const processItem = props.kind === 'processes' ? describeProcessItem(row, props.actionId) : null;
  const title = processItem?.title ?? lastSegment(row.item.path);
  const path = processItem
    ? processItem.details.join('\n')
    : formatPathRelativeToHome(row.item.path);
  const gone = row.facts?.status === 'gone';
  const bytes = row.facts?.bytes ?? null;
  const size = gone
    ? t('resourceProposal.gone')
    : bytes === null
      ? '—'
      : formatMachineBytes(
          bytes,
          props.kind === 'storage' ? 'storage' : 'memory',
        );
  const onDisk = row.facts?.onDiskBytes
    ? t('resourceProposal.onDisk', {
        amount: formatMachineBytes(row.facts.onDiskBytes, 'storage'),
      })
    : null;
  const chip = verdictChip(props.kind, row.verdict, row.reason, props.actionId);
  const reasonText = row.facts?.keptByGuard
    ? t(`machineGuard.reasons.${row.facts.keptByGuard.reason}`)
    : row.reason ? storageReasonLabel(row.reason) : null;
  const skipped = props.outcome?.status === 'skipped';
  const skippedReason =
    skipped && props.outcome?.reasonCode
      ? t('resourceProposal.skipped', {
          reason:
            props.kind === 'storage'
              ? storageReasonLabel({
                  code: props.outcome.reasonCode as StorageReasonV1['code'],
                })
              : props.outcome.reasonCode,
        })
      : null;
  const press = () => {
    if (!props.interactive || !row.selectable) return;
    if (row.needsConfirm) {
      setRevealLoss((value) => !value);
      return;
    }
    props.onToggle?.(row.item.key);
  };
  let lead: React.ReactNode = <View style={styles.leadSpace} />;
  if (props.outcome) {
    lead =
      props.outcome.status === 'done' ? (
        <Icon
          name="check"
          size={16}
          color={theme.colors.state.success.textForeground}
        />
      ) : (
        <Icon name="minus" size={16} color={theme.colors.text.tertiary} />
      );
  } else if (row.selectable && props.interactive) {
    lead = (
      <SelectionCheckGlyph state={row.selected ? 'checked' : 'unchecked'} />
    );
  } else if (!row.selectable) {
    lead = <Icon name="lock" size={14} color={theme.colors.text.tertiary} />;
  }
  const rowAction = skipped && props.onRetry ? (
    <HappierPressable testID={`resource-proposal-retry-${row.item.key}`} accessibilityRole="button" 
      onPress={() => { void props.onRetry?.(row.item.key); }}>
      <Text style={styles.link}>{t('resourceProposal.tryAgain')}</Text>
    </HappierPressable>
  ) : props.outcome?.status === 'done' && props.onStartAgain ? (
    props.startedAgain ? <Text style={styles.onDisk}>{t('resourceProposal.startedAgain')}</Text> : (
      <HappierPressable testID={`resource-proposal-start-again-${row.item.key}`} accessibilityRole="button" 
        onPress={() => { void props.onStartAgain?.(row.item.key); }}>
        <Text style={styles.link}>{t('resourceProposal.startAgain')}</Text>
      </HappierPressable>
    )
  ) : null;
  const subtitle = [path, skippedReason ?? reasonText]
    .filter(Boolean)
    .join('\n');
  const label = t('resourceProposal.itemLabel', {
    title,
    size,
    verdict: chip.label,
  });
  return (
    <Animated.View
      style={{
        opacity: arrival,
        transform: [
          {
            translateY: arrival.interpolate({
              inputRange: [0, 1],
              outputRange: [4, 0],
            }),
          },
        ],
      }}
    >
      <Item
        testID={`resource-proposal-item-${row.item.key}`}
        title={title}
        titleAccessory={
          row.facts?.changed && row.facts.status === 'present' ? (
            <Text style={styles.changed}>{t('resourceProposal.changed')}</Text>
          ) : undefined
        }
        subtitle={subtitle}
        subtitleLines={props.compact || processItem ? 3 : 2}
        mode={props.interactive && row.selectable ? 'interactive' : 'info'}
        onPress={props.interactive && row.selectable ? press : undefined}
        accessibilityRole={
          props.interactive && row.selectable ? 'checkbox' : undefined
        }
        accessibilityChecked={
          props.interactive && row.selectable ? row.selected : undefined
        }
        accessibilityLabel={label}
        showDivider={props.showDivider}
        leftElement={<View style={styles.lead}>{lead}</View>}
        style={!row.selected && props.interactive ? styles.unticked : undefined}
        rightElement={
          <View
            style={[styles.figures, props.compact && styles.figuresCompact]}
          >
            {props.compact ? null : (
              <StorageVerdictPill
                chip={skipped ? { ...chip, variant: 'attention' } : chip}
              />
            )}
            <View style={styles.sizeColumn}>
              <Text
                style={[
                  styles.size,
                  row.facts?.changed &&
                    row.facts.status === 'present' &&
                    styles.sizeChanged,
                ]}
                numberOfLines={1}
              >
                {size}
              </Text>
              {onDisk ? (
                <Text style={styles.onDisk} numberOfLines={1}>
                  {onDisk}
                </Text>
              ) : null}
            </View>
          </View>
        }
        bottomElementOutsidePressable={Boolean(rowAction)}
        // Try again / Start again belong to the row's words: they start under its title, not under its glyph.
        bottomElementInset="text"
        bottomElement={
          props.compact || (revealLoss && row.needsConfirm) || rowAction ? (
            <View style={styles.bottom}>
              {props.compact ? <StorageVerdictPill chip={chip} /> : null}
              {rowAction}
              {revealLoss && row.needsConfirm ? (
                <View style={styles.loss}>
                  <Text style={styles.lossText}>
                    {row.facts?.keptByGuard ? t(props.actionId === 'machines.processes.kill'
                      ? 'resourceProposal.processKillLoss' : 'resourceProposal.processStopLoss', { title }) : describeStorageLosses(
                      row.facts?.loses.length
                        ? row.facts.loses
                        : row.reason
                          ? [row.reason]
                          : [],
                    )}
                  </Text>
                  <RoundButton
                    testID={`resource-proposal-include-${row.item.key}`}
                    size="small"
                    display="secondary"
                    title={t('resourceProposal.includeAnyway')}
                    onPress={() => props.onConfirmKeep?.(row.item.key)}
                  />
                </View>
              ) : null}
            </View>
          ) : undefined
        }
      />
    </Animated.View>
  );
});

/** Items the agent left out (Keep, Forbidden): listed so the person knows they exist, never tickable. */
const NotIncludedRow = React.memo(function NotIncludedRow(
  props: Readonly<{
    item: StorageItemV1;
    compact: boolean;
    showDivider: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const chip = describeStorageVerdict(props.item);
  return (
    <Item
      testID={`resource-proposal-left-out-${props.item.itemId}`}
      title={props.item.title || lastSegment(props.item.path)}
      subtitle={[
        formatPathRelativeToHome(props.item.path),
        storageReasonLabel(props.item.reason),
      ].join('\n')}
      subtitleLines={2}
      mode="info"
      showDivider={props.showDivider}
      leftElement={
        <View style={styles.lead}>
          <Icon name="lock" size={14} color={theme.colors.text.tertiary} />
        </View>
      }
      style={styles.unticked}
      rightElement={
        <View style={styles.figures}>
          {props.compact ? null : <StorageVerdictPill chip={chip} />}
          <View style={styles.sizeColumn}>
            <Text style={styles.size} numberOfLines={1}>
              {formatMachineBytes(props.item.size.allocatedBytes, 'storage')}
            </Text>
          </View>
        </View>
      }
    />
  );
});

/** The volume the items live on, with the selection as its hatched ghost "after the Trash empties". */
const ProposalVolume = React.memo(function ProposalVolume(
  props: Readonly<{
    machineId: string;
    serverId: string | null;
    paths: readonly string[];
    selectedBytes: number;
    compact: boolean;
    permanent: boolean;
  }>,
) {
  const storage = useMachineStorageSummary({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const volume = React.useMemo(() => {
    const volumes = storage.summary?.volumes ?? [];
    let best: (typeof volumes)[number] | null = null;
    for (const candidate of volumes) {
      const mount = candidate.volume.mountPath;
      if (
        props.paths.some(
          (path) =>
            path === mount ||
            path.startsWith(
              mount.endsWith('/') || mount.endsWith('\\') ? mount : `${mount}/`,
            ) ||
            path.startsWith(`${mount}\\`),
        )
      ) {
        if (!best || mount.length > best.volume.mountPath.length)
          best = candidate;
      }
    }
    return best;
  }, [props.paths, storage.summary]);
  if (!volume) return null;
  return (
    <StorageVolumeRow
      volume={{ ...volume, pileBytes: props.selectedBytes }}
      compact={props.compact}
      after={props.permanent ? 'cleanup' : 'trashEmpties'}
    />
  );
});

function pileBarFor(
  controller: ResourceProposalController,
): StoragePileBar | null {
  const { display } = controller;
  switch (display.kind) {
    case 'ask':
      return controller.selectedCount > 0
        ? {
            kind: 'ready',
            count: controller.selectedCount,
            freesBytes: controller.selectedBytes,
          }
        : null;
    case 'executing':
      return {
        kind: 'checking',
        count: display.count,
        freesBytes: display.bytes,
      };
    case 'trashed': {
      if (display.receipt) {
        if (display.receipt.kind !== 'ready' || display.receipt.remaining.length === 0) return null;
        return { kind: 'held', batchId: display.result.batchId, count: display.receipt.remaining.length,
          inTrashBytes: resourceProposalTrashBytes(display.result, display.receipt),
          notActed: display.result.outcomes.filter(outcome => outcome.status !== 'moved' && outcome.status !== 'deleted').length,
          emptiesAt: null, trash: display.receipt };
      }
      const acted = display.result.outcomes.filter(
        (outcome) => outcome.status === 'moved' || outcome.status === 'deleted',
      ).length;
      return {
        kind: 'held',
        batchId: display.result.batchId,
        count: acted,
        inTrashBytes: display.result.inTrashBytes,
        notActed: display.result.outcomes.length - acted,
        emptiesAt: null,
      };
    }
    case 'emptied':
      return {
        kind: 'freed',
        count: display.count,
        freedBytes: display.freedBytes,
      };
    default:
      return null;
  }
}

function pileNote(controller: ResourceProposalController): string | null {
  const { display, model } = controller;
  if (display.kind === 'ask') {
    if (model.kind === 'processes') return t(model.actionId === 'machines.processes.kill'
      ? 'machineProcesses.kill.treeBody' : 'resourceProposal.note.processes');
    return model.storageMode === 'delete'
      ? t('machineStorage.review.whereDeleteNote')
      : model.emptyAfter
      ? t('resourceProposal.note.emptyAfter')
      : t('resourceProposal.note.trash');
  }
  if (display.kind === 'trashed') {
    const skipped = display.result.outcomes.filter(
      (outcome) => outcome.status !== 'moved' && outcome.status !== 'deleted',
    ).length;
    return skipped > 0
      ? t('machineStorage.pile.skippedNote', { count: skipped })
      : t('machineStorage.pile.heldNote');
  }
  // PileBar's freed title already says what came back; the note says it is final.
  if (display.kind === 'emptied') return null;
  return null;
}

/** The admitted operands, shared with immediate reviews that have no retained selection controller. */
export function ResourceProposalOperandFacts(props: Readonly<{ model: ResourceProposalModel; testID: string }>) {
  const layout = useMachineTabCompactLayout();
  const rows = React.useMemo(() => describeResourceProposalRows(props.model, null, new Set<string>(), new Set<string>()), [props.model]);
  return <View testID={props.testID} style={styles.body} onLayout={layout.onLayout}>
    <ResourceProposalItemRows model={props.model} rows={rows} compact={layout.compact} showNotIncluded />
  </View>;
}

function ResourceProposalItemRows(props: Readonly<{
  model: ResourceProposalModel;
  rows: readonly ResourceProposalRow[];
  compact: boolean;
  showNotIncluded: boolean;
  outcomes?: ReadonlyMap<string, ResourceProposalOutcome> | null;
  retried?: ReadonlyMap<string, ResourceProposalOutcome>;
  controls?: Pick<React.ComponentProps<typeof ProposalRow>,
    'interactive' | 'arrive' | 'onToggle' | 'onConfirmKeep' | 'onRetry' | 'onStartAgain'> & Readonly<{ startedAgain: ReadonlySet<string> }>;
}>) {
  const { theme } = useUnistyles();
  const { model, rows, compact, controls } = props;
  return <>
    <View accessibilityRole="list">
      {rows.map((row, index) => <ProposalRow key={row.item.key} kind={model.kind} actionId={model.actionId}
        row={row} index={index} outcome={props.retried?.get(row.item.key) ?? props.outcomes?.get(row.item.key) ?? null}
        interactive={controls?.interactive ?? false} arrive={controls?.arrive ?? false} compact={compact}
        showDivider={index < rows.length - 1 || props.showNotIncluded && model.notIncluded.length > 0}
        onToggle={controls?.onToggle} onConfirmKeep={controls?.onConfirmKeep} onRetry={controls?.onRetry}
        onStartAgain={controls?.onStartAgain} startedAgain={controls?.startedAgain.has(row.item.key)} />)}
    </View>
    {props.showNotIncluded && model.notIncluded.length > 0 ? <View>
      <View style={styles.leftOutHead}>
        <Icon name="lock" size={13} color={theme.colors.text.secondary} />
        <Text style={styles.leftOutTitle}>{t('resourceProposal.notIncluded')}</Text>
      </View>
      {model.notIncluded.map((item, index) => <NotIncludedRow key={item.itemId} item={item} compact={compact}
        showDivider={index < model.notIncluded.length - 1} />)}
    </View> : null}
  </>;
}

/**
 * The proposal card's body (plan 60 AGW-6/7/8, lab `ra` A2/A3/A4/A7): the decision itself — items with
 * reason, verdict and the size each actually gives back, the selection, the volume's ghost and the
 * docked pile. The surrounding approval card and its footer stay the existing approval owners.
 */
export const ResourceProposalBody = React.memo(function ResourceProposalBody(
  props: Readonly<{
    controller: ResourceProposalController;
    /** The approval was just requested: rows arrive once. */
    arrive: boolean;
    /** The second R37 choice (keep Undo) for an in-session disk-full proposal. */
    onApproveKeepingUndo?: () => void;
    decisionsAvailable: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { controller } = props;
  const layout = useMachineTabCompactLayout();
  const compact = layout.compact;
  const { model, display, rows } = controller;
  // Kept here, above the early returns: the receipt changes shape when everything is back, and a refused item's success must outlive that.
  const refusals = useTrackedRestoreRefusals(controller.restoreOutcomes, {
    entries: [controller, ...controller.retryReceipts].flatMap((holder) => holder.restoreEntries),
  });
  const interactive = display.kind === 'ask' && props.decisionsAvailable;
  if (display.kind === 'declined') {
    return (
      <View testID="resource-proposal-declined" style={styles.quiet}>
        <Icon
          name="minus-circle"
          size={16}
          color={theme.colors.text.tertiary}
        />
        <Text style={styles.quietText} numberOfLines={2}>
          <Text style={styles.quietStrong}>
            {t('resourceProposal.declinedTitle')}
          </Text>
          {` · ${t('resourceProposal.declinedFacts', { count: model.items.length })}`}
        </Text>
        {controller.reopen ? (
          <HappierPressable
            testID="resource-proposal-reopen"
            accessibilityRole="button"
            onPress={controller.reopen}
          >
            <Text style={styles.link}>{t('resourceProposal.reopen')}</Text>
          </HappierPressable>
        ) : null}
      </View>
    );
  }
  const outcomes = resolveResourceProposalOutcomes(
    display,
    controller.approvedKeys,
  );
  // Once Undo has put the original batch back, only what it left unresolved (skipped operands) stays a row.
  const visibleRows = outcomes
    ? rows.filter((row) => display.kind === 'restored'
      ? outcomes.get(row.item.key)?.status === 'skipped'
      : outcomes.has(row.item.key))
    : rows;
  const selectAll = resourceProposalSelectAllState(rows);
  const openCount = rows.filter(
    (row) => row.selectable && !row.needsConfirm,
  ).length;
  const changedCount = resourceProposalChangedCount(controller.check);
  const pile = pileBarFor(controller);
  const goal =
    model.goalBytes && display.kind === 'ask'
      ? t('resourceProposal.goal', {
          found: formatMachineBytes(controller.selectedBytes, 'storage'),
          goal: formatMachineBytes(model.goalBytes, 'storage'),
        })
      : null;
  return (
    <View testID={props.testID ?? 'resource-proposal-body'} style={styles.body} onLayout={layout.onLayout}>
      {display.kind === 'restored' ? (
        <View testID="resource-proposal-restored" style={styles.quiet}>
          <Icon
            name="arrow-arc-left"
            size={16}
            color={theme.colors.text.tertiary}
          />
          <Text style={styles.quietText}>{t('resourceProposal.restored')}</Text>
        </View>
      ) : null}
      {display.kind === 'ask' && display.stale ? (
        <View
          testID="resource-proposal-stale"
          style={styles.stale}
          accessibilityLiveRegion="polite"
        >
          <Icon
            name="clock"
            size={16}
            color={theme.colors.state.attention.textForeground}
          />
          <View style={styles.staleCopy}>
            <Text style={styles.staleTitle}>
              {t('resourceProposal.staleTitle', { count: changedCount })}
            </Text>
            <Text style={styles.staleBody}>
              {t('resourceProposal.staleBody')}
            </Text>
          </View>
          <RoundButton
            testID="resource-proposal-check-again"
            size="small"
            display="default"
            title={t('resourceProposal.checkAgain')}
            onPress={controller.checkAgain}
          />
        </View>
      ) : null}
      {display.kind === 'ask' && controller.check.kind === 'unavailable' ? (
        <View testID="resource-proposal-check-unavailable">
          <Text style={styles.hint}>{t('resourceProposal.checkUnavailable')}</Text>
          <RoundButton testID="resource-proposal-check-again" size="small" display="secondary"
            title={t('resourceProposal.checkAgain')} onPress={controller.checkAgain} />
        </View>
      ) : null}
      {interactive && openCount > 0 ? (
        <View style={styles.allRow}>
          <HappierPressable
            testID="resource-proposal-select-all"
            accessibilityRole="checkbox"
            checked={selectAll === 'mixed' ? 'mixed' : selectAll === 'checked'}
            accessibilityLabel={t('resourceProposal.selectAll')}
            onPress={controller.toggleAll}
            style={styles.allBox}
          >
            <SelectionCheckGlyph state={selectAll} />
            <Text style={styles.allText}>
              {t('resourceProposal.selected', {
                count: controller.selectedCount,
                total: openCount,
              })}
            </Text>
          </HappierPressable>
          <View style={styles.grow} />
          {model.kind === 'storage' && !model.emptyAfter ? (
            <HappierPressable
              testID="resource-proposal-select-safe"
              accessibilityRole="button"
              onPress={controller.selectAllSafe}
            >
              <Text style={styles.link}>
                {t('resourceProposal.selectAllSafe')}
              </Text>
            </HappierPressable>
          ) : null}
          {compact ? null : (
            <Text style={styles.columnHead}>
              {t(
                model.kind === 'storage'
                  ? 'resourceProposal.givesBack'
                  : 'resourceProposal.frees',
              )}
            </Text>
          )}
        </View>
      ) : null}
      {goal ? (
        <Text testID="resource-proposal-goal" style={styles.hint}>
          {goal}
        </Text>
      ) : null}
      <ResourceProposalItemRows model={model} rows={visibleRows} compact={compact}
        showNotIncluded={display.kind === 'ask'} outcomes={outcomes} retried={controller.retried}
        controls={{ interactive, arrive: props.arrive, onToggle: controller.toggle, onConfirmKeep: controller.confirmKeep,
          onRetry: controller.retryItem, onStartAgain: controller.startAgain, startedAgain: controller.startedAgain }} />
      {model.kind === 'processes' && display.kind === 'ask' ? (
        <ResourceProposalProcessesContext machineId={model.machineId} serverId={model.serverId}
          proposedRefs={new Set(model.items.map((item) => item.key))} selectedBytes={controller.selectedBytes} />
      ) : null}
      {model.kind === 'storage' && display.kind === 'ask' ? (
        <ProposalVolume
          machineId={model.machineId}
          serverId={model.serverId}
          paths={model.items.map((item) => item.path)}
          selectedBytes={controller.selectedBytes}
          compact={compact}
          permanent={model.storageMode === 'delete'}
        />
      ) : null}
      {display.kind === 'stopped' ? (
        <StoppedSummary controller={controller} />
      ) : null}
      {display.kind === 'trashed' && display.receipt ? (
        <View accessibilityLiveRegion="polite">
          {display.receipt.kind === 'checking' ? (
            <Text testID="resource-proposal-receipt-checking" style={styles.hint}>{t('resourceProposal.receiptChecking')}</Text>
          ) : display.receipt.kind === 'unavailable' ? (
            <Text testID="resource-proposal-receipt-unavailable" style={styles.hint}>{t('resourceProposal.receiptUnavailable')}</Text>
          ) : <>
            {display.receipt.deletedCount > 0 || display.receipt.freedBytes > 0 ? (
              <Text style={styles.hint}>{display.receipt.deletedCount > 0
                ? t('resourceProposal.receiptFreed', { count: display.receipt.deletedCount,
                  amount: formatMachineBytes(display.receipt.freedBytes, 'storage') })
                : t('machineStorage.pile.freed', { amount: formatMachineBytes(display.receipt.freedBytes, 'storage') })}</Text>
            ) : null}
            {display.receipt.restoredCount > 0 ? (
              <Text style={styles.hint}>{t('resourceProposal.receiptRestored', { count: display.receipt.restoredCount })}</Text>
            ) : null}
            {display.receipt.unknownCount > 0 ? (
              <Text testID="resource-proposal-receipt-unavailable" style={styles.hint}>{t('resourceProposal.receiptUnknown', { count: display.receipt.unknownCount })}</Text>
            ) : null}
          </>}
        </View>
      ) : null}
      {display.kind === 'failed' ? (
        <Text testID="resource-proposal-failed" style={styles.hint}>
          {display.error ?? t('resourceProposal.failed')}
        </Text>
      ) : null}
      {interactive && props.onApproveKeepingUndo && model.emptyAfter ? (
        <View style={styles.keepUndo}>
          <RoundButton
            testID="resource-proposal-keep-undo"
            size="small"
            display="secondary"
            disabled={controller.approveWithheld}
            title={t('resourceProposal.approve.keepUndo')}
            onPress={props.onApproveKeepingUndo}
          />
          <Text style={styles.hint}>
            {t('resourceProposal.approve.keepUndoHint')}
          </Text>
        </View>
      ) : null}
      {controller.reopened ? (
        <View style={styles.keepUndo}>
          <RoundButton
            testID="resource-proposal-run"
            size="small"
            display="default"
            disabled={!controller.runFromUi}
            title={resolveResourceProposalLabels(controller).approve}
            action={async () => { await controller.runFromUi?.(); }}
          />
        </View>
      ) : null}
      {pile ? (
        <PileBar
          testID="resource-proposal-pile"
          bar={pile}
          quantityKind={model.kind === 'processes' ? 'memory' : 'storage'}
          note={pileNote(controller)}
          compact={compact}
          placement="card"
          onUndo={
            display.kind === 'trashed' && controller.undo
              ? controller.undo
              : undefined
          }
          onEmptyNow={
            display.kind === 'trashed' && controller.emptyNow
              ? controller.emptyNow
              : undefined
          }
        />
      ) : null}
      <ProposalRestoreRecovery controller={controller} refusals={refusals} compact={compact} />
      {controller.retryReceipts.map((receipt) => receipt.restored ? (
        <View key={receipt.batchId} testID={`resource-proposal-retry-receipt-${receipt.batchId}`} style={styles.quiet}>
          <Text style={styles.quietText}>{t('resourceProposal.restored')}</Text>
        </View>
      ) : (
        <PileBar
          key={receipt.batchId}
          testID={`resource-proposal-retry-receipt-${receipt.batchId}`}
          bar={receipt.bar}
          note={receipt.bar.kind === 'held' ? t('machineStorage.pile.heldNote') : null}
          compact={compact}
          placement="card"
          onUndo={receipt.undo ?? undefined}
          onEmptyNow={receipt.emptyNow ?? undefined}
        />
      ))}
    </View>
  );
});

/**
 * A refused Put back on this card, named with its reason and the one recovery. The card's own receipt and
 * each retry's receipt keep their entries; the owner's outcomes are joined to them by entry id, never by order.
 */
function ProposalRestoreRecovery(
  props: Readonly<{ controller: ResourceProposalController; refusals: ReturnType<typeof useTrackedRestoreRefusals>; compact: boolean }>,
) {
  const { controller, refusals } = props;
  const holders = [controller, ...controller.retryReceipts];
  const latest = React.useRef(holders);
  latest.current = holders;
  const putBackBeside = React.useCallback(
    (entryId: string) => latest.current.find((holder) => holder.restoreEntries.some((entry) => entry.entryId === entryId))?.putBackBeside?.(entryId),
    [],
  );
  if (refusals.ids.length === 0) return null;
  return (
    <PileBar
      testID="resource-proposal-restore"
      bar={{ kind: 'hidden' }}
      note={null}
      compact={props.compact}
      placement="card"
      recovery={
        <StorageRestoreRecovery
          ids={refusals.ids}
          entries={refusals.entries}
          outcomes={controller.restoreOutcomes}
          homeDir={undefined}
          compact={props.compact}
          onPutBackBeside={putBackBeside}
          onDone={refusals.dismiss}
        />
      }
    />
  );
}

/** Stopping frees memory at once (R25): the receipt says so with the real amount. */
function StoppedSummary(
  props: Readonly<{ controller: ResourceProposalController }>,
) {
  const { theme } = useUnistyles();
  const { display } = props.controller;
  if (display.kind !== 'stopped') return null;
  const ended = display.result.outcomes.filter(
    (outcome) =>
      outcome.outcome === 'ended' || outcome.outcome === 'gone_before',
  );
  const freed = ended.reduce(
    (sum, outcome) => sum + (outcome.freedBytes ?? 0),
    0,
  );
  return (
    <View
      testID="resource-proposal-stopped"
      style={styles.quiet}
      accessibilityLiveRegion="polite"
    >
      <Icon
        name="check-circle"
        size={16}
        color={theme.colors.state.success.textForeground}
      />
      <Text style={styles.quietText}>
        <Text style={styles.quietStrong}>
          {t('resourceProposal.stopped', { count: ended.length })}
        </Text>
        {freed > 0
          ? ` · ${t('resourceProposal.stoppedFreed', { amount: formatMachineBytes(freed, 'memory') })}`
          : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: 0,
  },
  stale: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
    backgroundColor: theme.colors.state.attention.background,
  },
  staleCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  staleTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
  },
  staleBody: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  hint: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
  },
  allRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.default,
  },
  allBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minHeight: 32,
  },
  allText: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  grow: {
    flex: 1,
  },
  link: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
  },
  columnHead: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    width: 84,
    textAlign: 'right',
  },
  lead: {
    width: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadSpace: {
    width: 18,
  },
  unticked: {
    opacity: 0.86,
  },
  changed: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.state.attention.textForeground,
  },
  figures: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s16,
  },
  figuresCompact: {
    gap: 0,
  },
  sizeColumn: {
    width: 84,
    alignItems: 'flex-end',
  },
  size: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  sizeChanged: {
    color: theme.colors.state.attention.textForeground,
  },
  onDisk: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  bottom: {
    gap: theme.space.s8,
    paddingTop: theme.space.s6,
  },
  loss: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s10,
  },
  lossText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.state.attention.textForeground,
    flexShrink: 1,
  },
  leftOutHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    paddingHorizontal: theme.space.s16,
    paddingTop: 14,
    paddingBottom: theme.space.s4,
  },
  leftOutTitle: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
  },
  keepUndo: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s4,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s8,
  },
  quiet: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
  },
  quietText: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  quietStrong: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
}));

/** The header's mode chip: this Action's own approval setting for the caller that asked (R41). */
export function ResourceProposalModeChip(props: Readonly<{ mode: 'ask_first' | 'allowed' }>) {
  const { theme } = useUnistyles();
  const label = props.mode === 'ask_first' ? t('settingsActions.modes.askFirst') : t('settingsActions.modes.allowed');
  return (
    <View testID={`resource-proposal-mode-${props.mode}`}>
      <StatusPill variant="neutral" chrome="plain" label={label} labelVariant="phrase" labelNumberOfLines={1}
        leading={<Icon name={props.mode === 'ask_first' ? 'shield' : 'check'} size={12} color={theme.colors.text.secondary} />} />
    </View>
  );
}
