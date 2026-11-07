import * as React from 'react';

import { useMachineTabFacts } from '@/components/machines/page/useMachineTabFacts';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { useMachineStorageCategory } from '@/sync/domains/machines/storage/useMachineStorageCategory';
import { useMachineStorageCleanup } from '@/sync/domains/machines/storage/useMachineStorageCleanup';
import { useMachineStoragePile } from '@/sync/domains/machines/storage/useMachineStoragePile';
import { t } from '@/text';

import { PileBar } from './PileBar';
import { formatStorageDay } from './storageCategoryText';
import { describeStoragePileBar } from './storagePileModel';
import { StorageRestoreRecovery, useRememberedRestoreEntries, useTrackedRestoreRefusals, type RestoreRecoveryOutcomes } from './StorageRestoreRecovery';
import { showStorageReviewSheet } from './StorageReviewSheet';
import type { StorageSummary } from './storageViewModel';

/**
 * The pile, docked on every Storage view of one machine (plan 40 STO-11/12, ruling 4): a thin container
 * binding `PileBar` to the machine's pile, the review sheet and the last result. The pile travels with
 * the person across Worktrees, Suggestions and Whole disk; the result stays until Done, Undo or Empty now.
 */
export const StoragePileDock = React.memo(function StoragePileDock(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    summary: StorageSummary;
    compact: boolean;
    /** The view's own words for a holding pile ("The pile stays with you while you look around."). */
    readyNote?: string;
    readOnly?: boolean;
    /** `card`: the last row of a widget or card instead of floating over the page. */
    placement?: 'page' | 'card';
    /** On the Trash page the page itself says what is in the Trash: the dock keeps only the pile. */
    omitTrashReceipt?: boolean;
  }>,
) {
  const target = { machineId: props.machineId, serverId: props.serverId };
  const pile = useMachineStoragePile(target);
  const cleanup = useMachineStorageCleanup(target);
  const { homeDir } = useMachineTabFacts(props.serverId, props.machineId);
  const resourcesPolicy = useMachineResourcesPolicy(target).policy;
  const policy = resourcesPolicy?.storage ?? null;
  const nearlyFullThreshold = resourcesPolicy?.alerts.disk.threshold ?? null;
  const [checking, setChecking] = React.useState<Readonly<{
    count: number;
    freesBytes: number;
  }> | null>(null);
  const [previewFreesBytes, setPreviewFreesBytes] = React.useState<number | null>(null);
  const emptiesAt = props.summary.trash.emptiesNextAt ?? null;
  const receipt =
    cleanup.receipt?.kind === 'applied'
      ? props.omitTrashReceipt && cleanup.receipt.result.mode === 'trash'
        ? null
        : { ...cleanup.receipt, emptiesAt }
      : cleanup.receipt;
  // The last Trash move on this machine owns the entries a refused Put back can be about; the receipt itself
  // goes once everything is back, so its batch is kept to let a success stay on screen.
  const batch = cleanup.receipt?.kind === 'applied' && cleanup.receipt.result.mode === 'trash' ? cleanup.receipt.result : null;
  const [lastBatch, setLastBatch] = React.useState<Readonly<{ id: string; entryIds: readonly string[] }> | null>(null);
  if (batch && lastBatch?.id !== batch.batchId) setLastBatch({ id: batch.batchId, entryIds: batch.trashEntryIds ?? [] });
  const refusals = useTrackedRestoreRefusals(cleanup.restoreOutcomes, { scope: lastBatch?.entryIds ?? [], resetKey: lastBatch?.id ?? null });
  const bar = describeStoragePileBar({
    pile: {
      ...props.summary.pile,
      ...(previewFreesBytes === null ? {} : { freesBytes: previewFreesBytes }),
    },
    receipt,
    checking,
    measuring: pile.pending && previewFreesBytes === null,
  });
  const { items, set } = pile;
  const review = React.useCallback(() => {
    if (items.length === 0) return;
    showStorageReviewSheet({
      serverId: props.serverId,
      machineName: props.machineName,
      homeDir,
      summary: props.summary,
      refs: items,
      trashEmptyAfterDays: policy ? policy.trashEmptyAfterDays : 7,
      nearlyFullThreshold,
      check: (refs) => cleanup.check(refs),
      apply: (mode, chosen) => cleanup.apply(mode, chosen),
      onChecking: setChecking,
      onPreviewFreesBytes: setPreviewFreesBytes,
    });
  }, [cleanup, homeDir, items, policy, nearlyFullThreshold, props.machineName, props.serverId, props.summary]);
  const date = emptiesAt ? formatStorageDay(emptiesAt) : null;
  const dropped = props.summary.pile.droppedSinceLastView.length;
  const note =
    bar.kind === 'held'
      ? bar.notActed > 0
        ? date
          ? t('machineStorage.pile.skippedNoteOn', {
              count: bar.notActed,
              date,
            })
          : t('machineStorage.pile.skippedNote', { count: bar.notActed })
        : date
          ? t('machineStorage.pile.heldNoteOn', { date })
          : t('machineStorage.pile.heldNote')
      : bar.kind === 'freed'
        ? null
        : bar.kind === 'checking'
          ? t('machineStorage.pile.checkingNote')
          : dropped > 0
            ? t('machineStorage.pile.dropped', { count: dropped })
            : (props.readyNote ?? t('machineStorage.pile.readyNote'));
  if (props.readOnly) return null;
  return (
    <PileBar
      bar={bar}
      note={note}
      compact={props.compact}
      placement={props.placement}
      onClear={() => {
        void set({ clear: true });
      }}
      onReview={review}
      recovery={refusals.ids.length > 0 && !props.omitTrashReceipt ? (
        <DockRestoreRecovery
          serverId={props.serverId}
          machineId={props.machineId}
          ids={refusals.ids}
          outcomes={cleanup.restoreOutcomes}
          homeDir={homeDir}
          compact={props.compact}
          onPutBackBeside={cleanup.putBackBeside}
          onDone={refusals.dismiss}
        />
      ) : undefined}
      onUndo={() => cleanup.undo()}
      onEmptyNow={async () => {
        if (bar.kind === 'held') await cleanup.emptyNow();
      }}
      onDone={bar.kind === 'dropped' ? () => {
        void set({ acknowledgeDropped: props.summary.pile.droppedSinceLastView.map((entry) => entry.itemId) });
      } : cleanup.dismiss}
    />
  );
});

/** Names a refused Put back from the Trash the machine lists now; mounted only while there is something to say. */
function DockRestoreRecovery(
  props: Readonly<{
    serverId: string;
    machineId: string;
    ids: readonly string[];
    outcomes: RestoreRecoveryOutcomes;
    homeDir: string | undefined;
    compact: boolean;
    onPutBackBeside: (entryId: string) => unknown;
    onDone: () => void;
  }>,
) {
  const trash = useMachineStorageCategory({ serverId: props.serverId, machineId: props.machineId, categoryId: 'trash' });
  const entries = useRememberedRestoreEntries(trash.page?.trashEntries ?? []);
  return (
    <StorageRestoreRecovery
      ids={props.ids}
      entries={entries}
      outcomes={props.outcomes}
      homeDir={props.homeDir}
      compact={props.compact}
      onPutBackBeside={props.onPutBackBeside}
      onDone={props.onDone}
    />
  );
}
