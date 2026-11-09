import * as React from 'react';
import type { PileApplyResultV1, TrashRestoreResultV1 } from '@happier-dev/protocol/storage/storageV1';
import { machineStorageStore } from '@/sync/domains/machines/storage/machineStorageStore';
import type { MachineStorageKey } from '@/sync/domains/machines/storage/machineRpc';
import type { ResourceProposalTrashReceipt } from './resourceProposalPresentation';
import { settleStorageTrashReceipt, type StorageTrashReceiptEffect } from '@/sync/domains/machines/storage/trashReceipt';

export type ResourceProposalRestoreOutcomes = Readonly<Record<string, TrashRestoreResultV1['outcomes'][number]>>;

/** Receipt recovery uses only the original entries and the storage owner's typed results. */
export function useResourceProposalTrashActions(
  scope: MachineStorageKey | null,
  receipts: ReadonlyMap<string, ResourceProposalTrashReceipt>,
  setReceipts: React.Dispatch<React.SetStateAction<ReadonlyMap<string, ResourceProposalTrashReceipt>>>,
) {
  const [restoreOutcomes, setRestoreOutcomes] = React.useState<ResourceProposalRestoreOutcomes>({});
  const forResult = (result: PileApplyResultV1) => {
    const receipt = receipts.get(result.batchId);
    const entries = receipt?.kind === 'ready' ? receipt.remaining : [];
    const update = (effect: StorageTrashReceiptEffect) => {
      setReceipts(current => {
        const prior = current.get(result.batchId);
        if (prior?.kind !== 'ready') return current;
        const next = settleStorageTrashReceipt(prior, effect);
        return next === prior ? current : new Map(current).set(result.batchId, { ...next, kind: 'ready' });
      });
    };
    const restore = async (entryIds: string[], beside = false) => {
      if (!scope) return false;
      const outcome = await machineStorageStore.restoreTrash({ ...scope, entryIds, ...(beside ? { beside: true } : {}) });
      if (!outcome.ok) return false;
      const requested = new Set(entryIds);
      const outcomes = outcome.value.outcomes.filter(value => requested.has(value.entryId));
      setRestoreOutcomes(current => ({ ...current, ...Object.fromEntries(outcomes.map(value => [value.entryId, value])) }));
      const restored = new Set(outcomes.filter(value => value.status === 'restored').map(value => value.entryId));
      update({ kind: 'restore', result: { outcomes } });
      return restored.size === entryIds.length;
    };
    const restoreIds = entries.filter(entry => entry.restorable).map(entry => entry.entryId);
    return {
      restoreEntries: entries,
      emptyOutcomes: receipt?.kind === 'ready' ? receipt.emptyOutcomes : undefined,
      restoreOutcomes: Object.fromEntries(entries.flatMap(entry => restoreOutcomes[entry.entryId]
        ? [[entry.entryId, restoreOutcomes[entry.entryId]]] : [])),
      undo: restoreIds.length ? () => restore(restoreIds) : null,
      putBackBeside: restoreIds.length ? (entryId: string) => {
        const outcome = restoreOutcomes[entryId];
        return restoreIds.includes(entryId) && outcome?.status === 'refused' && outcome.reason?.code === 'destination_occupied'
          ? restore([entryId], true) : Promise.resolve(false);
      } : null,
      emptyNow: entries.length ? async () => {
        if (!scope) return false;
        const entryIds = entries.map(entry => entry.entryId);
        const outcome = await machineStorageStore.emptyTrash({ ...scope, entryIds });
        if (!outcome.ok) return false;
        const deleted = new Set(outcome.value.outcomes.filter(value => value.status === 'deleted' && entryIds.includes(value.entryId)).map(value => value.entryId));
        update({ kind: 'empty', result: outcome.value });
        return deleted.size === entryIds.length;
      } : null,
    };
  };
  return { restoreOutcomes, forResult };
}
