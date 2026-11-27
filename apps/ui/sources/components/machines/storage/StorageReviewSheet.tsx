import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveMachineDiskAttentionKindV1, type MachineVitalsAttentionInputV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsAttentionV1';
import type {
  PileReviewV1,
  StorageItemRefV1,
} from '@happier-dev/protocol/storage/storageV1';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { executeSessionLifecycleAction } from '@/components/sessions/actions/sessionActionExecution';
import type { SessionActionOperationResult } from '@/components/sessions/actions/sessionActionTypes';
import { isAcceptedPendingSessionStop } from '@/components/sessions/sessionStopArchiveFlow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { resolveMachineAvailabilityReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type {
  MachineStorageApplyItem,
  MachineStorageFailure,
  MachineStorageResult,
} from '@/sync/domains/machines/storage/machineRpc';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useDeviceType } from '@/utils/platform/responsive';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { copyStoragePath } from './copyStoragePath';
import { formatStorageDay } from './storageCategoryText';
import {
  describeStorageLosses,
  describeStorageVerdict,
  storageReasonLabel,
} from './storageReasonPresentation';
import { StorageVerdictPill } from './StorageItemRow';
import {
  buildStorageReview,
  selectStorageReviewApply,
  selectStorageReviewTicks,
  type StorageReview,
  type StorageReviewMode,
  type StorageReviewRow,
} from './storageReviewModel';
import { StorageVolumeRow } from './StorageVolumes';
import {
  describeStorageFailure,
  selectStorageHeadlineVolume,
  storageVolumeName,
  type StorageSummary,
} from './storageViewModel';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

export type StorageReviewSheetInput = Readonly<{
  /** The Home the machine is reached through; a holding session stops through the same Home. */
  serverId: string;
  machineName: string;
  homeDir: string | undefined;
  summary: StorageSummary;
  refs: readonly Readonly<StorageItemRefV1>[];
  trashEmptyAfterDays: number | null;
  nearlyFullThreshold: MachineVitalsAttentionInputV1['nearlyFull'];
  check: (refs: StorageItemRefV1[]) => Promise<MachineStorageResult<PileReviewV1>>;
  apply: (
    mode: StorageReviewMode,
    items: readonly MachineStorageApplyItem[],
  ) => Promise<MachineStorageResult<unknown>>;
  /** The pile bar shows "Checking N items again" while the machine re-reads them. */
  onChecking: (
    checking: Readonly<{ count: number; freesBytes: number }> | null,
  ) => void;
  /** The dock presents this same selected plan while Review is open. */
  onPreviewFreesBytes: (freesBytes: number | null) => void;
}>;

type ReviewProps = CustomModalInjectedProps & StorageReviewSheetInput;

/**
 * "Stop the session and remove" (R42.1): each session holding an in-use item stops through the session
 * stop Action, under that Action's own approval setting, before anything moves. A stop the session has
 * accepted and is finishing, or a session that is already gone, lets the removal go ahead.
 */
async function stopStorageHolders(
  serverId: string,
  sessionIds: readonly string[],
): Promise<'stopped' | 'approval' | SessionActionOperationResult> {
  for (const sessionId of sessionIds) {
    const result = await executeSessionLifecycleAction('session.stop', sessionId, { serverId, stopIntent: 'lifecycle_control' });
    if (result.success || isAcceptedPendingSessionStop(result) || result.code === 'session_stop_not_found') continue;
    return ActionApprovalRequestCreatedResultSchema.safeParse(result.details).success ? 'approval' : result;
  }
  return 'stopped';
}

/**
 * The review sheet (plan 40 STO-12, R24, lab `rs` R / Rp): the disk's result first, every item checked
 * again on the machine, what goes with what each frees (a Keep item says what is lost), what stays and
 * why, then the one choice of where it goes — Happier's Trash always chosen, Delete now beside it with a
 * button that says it can't be undone. Unticking narrows the Action's operands; its policy owns confirmation.
 */
function StorageReviewSheet(props: ReviewProps) {
  // The body keeps the card's edge inset (the header's and footer's), and its sections add no second page inset.
  return (
    <ListPresentationProvider value="page" pageInsets="contained">
      <StorageReviewBody {...props} />
    </ListPresentationProvider>
  );
}

function StorageReviewBody(props: ReviewProps) {
  usePreferredLanguage();
  const { theme } = useUnistyles();
  // A phone sheet (the modal's own phone decision) ends with Cancel and the apply filling the line (lab `rs` Rp);
  // the total is the ghost's line above.
  const phone = useDeviceType() === 'phone';
  const { check, onChecking, refs, onClose } = props;
  const [review, setReview] = React.useState<StorageReview | null>(null);
  const [failure, setFailure] = React.useState<MachineStorageFailure | null>(null);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    new Set(),
  );
  const [mode, setMode] = React.useState<StorageReviewMode>('trash');
  const [applying, setApplying] = React.useState(false);
  const [applyFailed, setApplyFailed] = React.useState<MachineStorageFailure | SessionActionOperationResult | 'approval' | null>(null);
  // The sheet hugs its content, then keeps the tallest height it reached while open (a re-check never shrinks it).
  const [heldHeight, setHeldHeight] = React.useState(0);
  const holdHeight = React.useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setHeldHeight((held) => (height > held ? height : held));
  }, []);
  const load = React.useCallback(() => {
    setFailure(null);
    onChecking({
      count: refs.length,
      freesBytes: props.summary.pile.freesBytes,
    });
    void check([...refs]).then((result) => {
      onChecking(null);
      if (!result.ok) {
        setFailure(result);
        return;
      }
      const model = buildStorageReview(result.value, props.summary.volumes);
      setReview(model);
      setSelected(selectStorageReviewTicks(model));
    });
  }, [
    check,
    onChecking,
    props.summary.pile.freesBytes,
    props.summary.volumes,
    refs,
  ]);
  React.useEffect(() => {
    load();
    return () => onChecking(null);
  }, [load, onChecking]);

  const plan = review ? selectStorageReviewApply(review, selected, mode) : null;
  const { onPreviewFreesBytes } = props;
  const previewFreesBytes = plan?.freesBytes ?? null;
  React.useEffect(() => { onPreviewFreesBytes(previewFreesBytes); }, [onPreviewFreesBytes, previewFreesBytes]);
  React.useEffect(() => () => onPreviewFreesBytes(null), [onPreviewFreesBytes]);
  const reviewedVolumes = new Set(review?.going.filter(row => selected.has(row.itemId)).map(row => row.volumeId));
  const lowSpaceVolume = props.summary.volumes.find(volume => reviewedVolumes.has(volume.volume.volumeId)
    && resolveMachineDiskAttentionKindV1({ totalBytes: volume.totalBytes, availableBytes: volume.freeBytes }, props.nearlyFullThreshold) !== null) ?? null;
  const headline = lowSpaceVolume ?? selectStorageHeadlineVolume(props.summary);
  const ghostVolume =
    headline && plan ? { ...headline, pileBytes: plan.allocatedBytes, pileFreesBytes: plan.freesBytes } : headline;
  const toggle = (itemId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  const run = async () => {
    if (!review || !plan || plan.count === 0) return;
    setApplying(true);
    setApplyFailed(null);
    if (plan.holders.length > 0) {
      const stopped = await stopStorageHolders(props.serverId, plan.holders);
      if (stopped !== 'stopped') {
        setApplying(false);
        setApplyFailed(stopped);
        return;
      }
      // Stopping changes the reviewed holder facts. Show the fresh review for
      // confirmation: its opaque token may also cover changes beyond that stop.
      const refreshed = await check([...refs]);
      setApplying(false);
      if (!refreshed.ok) {
        setApplyFailed(refreshed);
        return;
      }
      const nextReview = buildStorageReview(refreshed.value, props.summary.volumes);
      setReview(nextReview);
      setSelected((current) => selectStorageReviewTicks(nextReview, { review, selected: current }));
      return;
    }
    const result = await props.apply(mode, plan.items);
    setApplying(false);
    if (result.ok) onClose();
    else if (result.reason !== 'declined') setApplyFailed(result);
  };
  const amount = (bytes: number) => formatMachineBytes(bytes, 'storage');
  const days = props.trashEmptyAfterDays;
  const nearlyFull = lowSpaceVolume !== null;
  const allRebuild =
    !!review && review.going.every((row) => row.verdict === 'safe');

  // The total and the apply stay pinned in the card's footer while the list scrolls (lab `rs` R).
  const footer = review ? (
    <View style={styles.footer}>
      {phone ? null : (
        <Text style={[styles.sum, styles.grow]}>
          {`${t('machineStorage.review.frees')} `}
          <Text style={styles.sumStrong}>{amount(plan?.freesBytes ?? 0)}</Text>
        </Text>
      )}
      <RoundButton
        testID="machine-storage-review-cancel"
        size="normal"
        display="inverted"
        title={t('common.cancel')}
        onPress={onClose}
      />
      <RoundButton
        testID="machine-storage-review-confirm"
        size="normal"
        style={phone ? styles.grow : undefined}
        display={mode === 'delete' ? 'destructive' : 'default'}
        titleNumberOfLines="complete"
        loading={applying}
        disabled={!plan || plan.count === 0 || applying}
        title={
          applying
            ? t('machineStorage.review.applying', { count: plan?.count ?? 0 })
            : plan && plan.holders.length > 0
              ? t('machineStorage.review.stopAndRemove', { count: plan.holders.length })
              : mode === 'trash'
              ? t('machineStorage.review.moveToTrash', {
                  count: plan?.count ?? 0,
                })
              : t('machineStorage.review.deleteForGood', {
                  count: plan?.count ?? 0,
                })
        }
        onPress={() => {
          void run();
        }}
      />
    </View>
  ) : null;
  const { setChrome } = props;
  // One count story: once the check keeps some where they are, the title counts what goes out of what was
  // checked, as the Going and Staying sections and the action do.
  const title = review && review.staying.length > 0
    ? t('machineStorage.review.titleGoing', { going: review.going.length, checked: review.going.length + review.staying.length })
    : undefined;
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer, ...(title ? { title } : {}) });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);

  if (!review) {
    return (
      <View testID="machine-storage-review" style={[styles.body, { minHeight: heldHeight }]} onLayout={holdHeight}>
        <Text style={styles.paragraph}>
          {t('machineStorage.review.subtitle', { machine: props.machineName })}
        </Text>
        {failure ? (
          <SurfaceStateCard
            kind="error"
            size="line"
            title={t('machineStorage.review.checkFailed')}
            {...describeStorageFailure(failure, { closedCopyOnly: true })}
            action={{ label: t('machineStorage.tryAgain'), onPress: load }}
          />
        ) : (
          <View
            style={styles.checking}
            accessibilityRole="progressbar"
            accessibilityLabel={t('machineStorage.pile.checking', {
              count: refs.length,
            })}
          >
            <ActivitySpinner size="small" color={theme.colors.text.secondary} />
            <Text style={styles.note}>
              {t('machineStorage.pile.checkingNote')}
            </Text>
          </View>
        )}
      </View>
    );
  }
  return (
    <View testID="machine-storage-review" style={[styles.body, { minHeight: heldHeight }]} onLayout={holdHeight}>
      <Text style={styles.paragraph}>
        {t('machineStorage.review.subtitle', { machine: props.machineName })}
      </Text>
      {ghostVolume ? (
        <ItemGroup header="none">
          <StorageVolumeRow
            volume={ghostVolume}
            compact
            after={mode === 'trash' ? 'trashEmpties' : 'cleanup'}
          />
        </ItemGroup>
      ) : null}
      <ItemGroup
        title={t('machineStorage.review.going', { count: review.going.length })}
        titleAccessory={
          <Text style={styles.accessory}>
            {t('machineStorage.review.goingAccessory')}
          </Text>
        }
      >
        {review.going.map((row, index) => (
          <ReviewRow
            key={row.itemId}
            row={row}
            homeDir={props.homeDir}
            selected={selected.has(row.itemId)}
            mode={mode}
            onToggle={() => toggle(row.itemId)}
            showDivider={index < review.going.length - 1}
          />
        ))}
      </ItemGroup>
      {review.countedOnceBytes > 0 || review.absorbedCount > 0 ? (
        <Text style={styles.note}>
          {t('machineStorage.review.countedOnce', {
            count: review.absorbedCount,
            amount: amount(review.countedOnceBytes),
          })}
        </Text>
      ) : null}
      {review.staying.length > 0 ? (
        <ItemGroup
          title={t('machineStorage.review.staying', {
            count: review.staying.length,
          })}
          titleAccessory={
            <Text style={styles.accessory}>
              {t('machineStorage.review.stayingAccessory')}
            </Text>
          }
        >
          {review.staying.map((entry, index) => (
            <Item
              key={entry.itemId}
              testID={`machine-storage-review-staying-${entry.itemId}`}
              mode="info"
              showChevron={false}
              title={<Text style={styles.struck}>{entry.title}</Text>}
              subtitle={formatPathRelativeToHome(entry.path, props.homeDir)}
              subtitleLines={1}
              rightElement={
                <View style={styles.rowEnd}>
                  <StorageVerdictPill
                    chip={{
                      variant: 'neutral',
                      chrome: 'pill',
                      icon: 'lock',
                      label: storageReasonLabel(entry.reason),
                    }}
                  />
                  <StoragePathMenu title={entry.title} path={entry.path} testID={`machine-storage-review-staying-${entry.itemId}-more`} />
                </View>
              }
              showDivider={index < review.staying.length - 1}
            />
          ))}
        </ItemGroup>
      ) : null}
      {plan && plan.withoutTrash.length > 0 ? (
        <Text style={styles.warning}>
          {t('machineStorage.review.withoutTrash', {
            count: plan.withoutTrash.length,
          })}
        </Text>
      ) : null}
      <ItemGroup header="none">
        <Item
          testID="machine-storage-review-where"
          mode="info"
          showChevron={false}
          accessoryLayout="adaptive"
          title={
            mode === 'trash'
              ? nearlyFull && headline
                ? t('machineStorage.review.whereTrashOn', {
                    volume: storageVolumeName(headline),
                  })
                : t('machineStorage.review.whereTrash')
              : t('machineStorage.review.whereDelete')
          }
          subtitle={
            mode === 'delete'
              ? t('machineStorage.review.whereDeleteNote')
              : nearlyFull && headline
                ? t(
                    allRebuild
                      ? 'machineStorage.review.whereTrashFullRebuild'
                      : 'machineStorage.review.whereTrashFull',
                    {
                      volume: storageVolumeName(headline),
                      date: props.summary.trash.emptiesNextAt
                        ? formatStorageDay(props.summary.trash.emptiesNextAt)
                        : t('machineStorage.review.whenItEmpties'),
                    },
                  )
                : days === null
                  ? t('machineStorage.review.whereTrashNever')
                  : t('machineStorage.review.whereTrashNote', {
                      days: days ?? 7,
                    })
          }
          rightElement={
            <SegmentedTabBar<StorageReviewMode>
              role="radiogroup"
              segmentSizing="content"
              accessibilityLabel={t('machineStorage.review.whereLabel')}
              testIDPrefix="machine-storage-review-mode"
              tabs={[
                { id: 'trash', label: t('machineStorage.review.trash') },
                { id: 'delete', label: t('machineStorage.review.deleteNow') },
              ]}
              activeTabId={mode}
              onSelectTab={setMode}
            />
          }
        />
      </ItemGroup>
      {applyFailed && typeof applyFailed !== 'string' && 'success' in applyFailed ? (
        <SurfaceStateCard
          kind="error"
          size="line"
          title={resolveMachineAvailabilityReasonCopy(applyFailed.code)
            ?? resolveActionExecutionErrorMessage(applyFailed,
              t('machineStorage.review.stopFailed', { count: plan?.holders.length ?? 1 }), { closedCodesOnly: true })}
          diagnosticCode={applyFailed.code}
        />
      ) : applyFailed && typeof applyFailed !== 'string' && applyFailed.reason !== 'approval_requested' ? (
        <SurfaceStateCard
          kind="error"
          size="line"
          title={t('machineStorage.review.applyFailed')}
          {...describeStorageFailure(applyFailed, { closedCopyOnly: true })}
        />
      ) : applyFailed ? (
        <Text style={styles.warning}>
          {t('machineStorage.review.approvalRequested')}
        </Text>
      ) : null}
      {/* Without card chrome (an embedding host), the footer ends the body. */}
      {setChrome ? null : footer}
    </View>
  );
}

/** A reviewed item's ⋯: Copy path (the machine's exact path), the same row action as the disk list's. */
function StoragePathMenu(props: Readonly<{ title: string; path: string; testID: string }>) {
  return (
    <ItemRowActions
      title={props.title}
      overflowOnly
      overflowTriggerTestID={props.testID}
      actions={[{
        id: 'copy-path',
        title: t('files.repositoryTree.actions.copyPath'),
        icon: 'copy',
        onPress: () => copyStoragePath(props.path),
      }]}
    />
  );
}

const ReviewRow = React.memo(function ReviewRow(
  props: Readonly<{
    row: StorageReviewRow;
    homeDir: string | undefined;
    selected: boolean;
    mode: StorageReviewMode;
    onToggle: () => void;
    showDivider: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { row } = props;
  const lost =
    row.verdict === 'keep' || row.loses.length > 0
      ? describeStorageLosses(row.loses.length ? row.loses : [row.reason])
      : null;
  const chip = describeStorageVerdict({
    verdict: row.verdict,
    reason: row.reason,
  });
  const blocked = props.mode === 'trash' && !row.trashAvailable;
  usePreferredLanguage();
  const name = row.title;
  return (
    <Item
      testID={`machine-storage-review-row-${row.itemId}`}
      accessibilityRole="checkbox"
      accessibilityChecked={props.selected}
      accessibilityLabel={t('machineStorage.review.rowLabel', {
        name,
        amount: formatMachineBytes(row.freesBytes, 'storage'),
        verdict: chip.label,
      })}
      leftElement={<SelectionCheckGlyph state={props.selected ? 'checked' : 'unchecked'} />}
      onPress={props.onToggle}
      showChevron={false}
      title={name}
      subtitle={
        blocked
          ? t('machineStorage.review.noTrashHere')
          : (lost ??
            `${storageReasonLabel(row.reason)} · ${formatPathRelativeToHome(row.path, props.homeDir)}`)
      }
      subtitleLines={lost ? 3 : 1}
      subtitleStyle={
        lost
          ? { color: theme.colors.state.attention.textForeground }
          : undefined
      }
      detail={formatMachineBytes(row.freesBytes, 'storage')}
      rightElementOutsidePressable
      rightElement={<StoragePathMenu title={name} path={row.path} testID={`machine-storage-review-row-${row.itemId}-more`} />}
      showDivider={props.showDivider}
    />
  );
});

/** Open the review over the page (a bottom sheet on a phone). */
export function showStorageReviewSheet(input: StorageReviewSheetInput): void {
  Modal.show({
    component: StorageReviewSheet,
    props: input,
    chrome: {
      kind: 'card',
      title: t('machineStorage.review.title', { count: input.refs.length }),
      testID: 'machine-storage-review-modal',
      phonePresentation: 'sheet',
      // As tall as its content up to the bound, then the body scrolls between the header and the pinned footer.
      scrollHost: 'bounded',
      bodyScroll: 'auto',
      dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'md' },
    },
    closeOnBackdrop: true,
  });
}

const styles = StyleSheet.create((theme) => ({
  rowEnd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  // Card chrome pads only its header and footer; the body aligns with the title's edge.
  body: {
    gap: theme.space.s12,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s16,
  },
  paragraph: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  accessory: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
  },
  checking: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    minHeight: 44,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  warning: {
    ...Typography.variant('meta'),
    color: theme.colors.state.attention.textForeground,
  },
  struck: {
    ...Typography.default('medium'),
    color: theme.colors.text.tertiary,
    textDecorationLine: 'line-through',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
  grow: {
    flex: 1,
    minWidth: 120,
  },
  sum: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  sumStrong: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
}));
