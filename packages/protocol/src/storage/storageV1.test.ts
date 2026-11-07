import { describe, expect, it } from 'vitest';
import {
  HappierStorageSummaryV1Schema, MachineStorageCategoryListInputV1Schema, MachineStorageCategoryListResultV1Schema, MachineStorageSizeRefreshInputV1Schema,
  MachineStorageSummaryGetInputV1Schema, MachineStorageWatchInputV1Schema, MachineStorageWatchResultV1Schema,
  StorageItemV1Schema, type HappierStorageSummaryV1, type StorageItemV1,
  PileItemRefV1Schema, PileItemRefStoredV1Schema, TrashEntryV1Schema, TrashEntryStoredV1Schema,
  MachineStorageTrashMoveInputV1Schema, MachineStorageDeleteNowInputV1Schema, PileApplyResultV1Schema,
} from './storageV1.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { resolveMachineRpcRoutePolicy } from '../machines/peer/mediation/rpc/routePolicyV1.js';
import * as storage from './storageV1.js';

const size = { allocatedBytes: 4096, freesBytes: 2048, sharedBytes: 2048, sharedExtentsUnmeasured: true, atLeast: false };
const item: StorageItemV1 = {
  itemId: 'log', kind: 'category-item', categoryId: 'logs', title: 'Old logs', evidence: ['log_file_modified_time'], path: '/data/logs',
  size, verdict: 'safe', reason: { code: 'old', detail: { days: 30 } }, collectable: true,
};
const summary: HappierStorageSummaryV1 = {
  revision: 1, sizedAt: 1000,
  volumes: [{ volume: { volumeId: 'disk', mountPath: '/data', label: 'Data' }, totalBytes: 10000, freeBytes: 5000, happierBytes: 4096, pileBytes: 0, trashBytes: 0 }],
  categories: [{ categoryId: 'logs', size, canGoBytes: 2048, count: 1, detailFacts: {} }], suggestionsTop: [item],
  pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] },
};

describe('storage V1 contract', () => {
  it('normalizes future presentation evidence without weakening item identity or admitting non-string evidence', () => {
    expect(StorageItemV1Schema.parse({ ...item, evidence: ['managed_cache_root', 'recognizer:future-tool', 'manifest:package.json', 'future_evidence'] }).evidence)
      .toEqual(['managed_cache_root', 'recognizer:future-tool', 'manifest:package.json', 'unknown']);
    expect(StorageItemV1Schema.safeParse({ ...item, evidence: [42] }).success).toBe(false);
    expect(StorageItemV1Schema.safeParse({ ...item, itemId: '', evidence: ['future_evidence'] }).success).toBe(false);
  });
  it('reads additive stored pile receipts while retaining exact Trash correlation and strict current writes', () => {
    const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }],
      inTrashBytes: 4096, freedBytes: 0, trashEntryIds: ['entry'] };
    expect(PileApplyResultV1Schema.parse(receipt)).toEqual(receipt);
    expect(storage.PileApplyResultStoredV1Schema.parse({ ...receipt, future: true,
      outcomes: [{ ...receipt.outcomes[0], future: true }] })).toEqual(receipt);
    const { trashEntryIds: _ids, ...older } = receipt;
    expect(storage.PileApplyResultStoredV1Schema.parse(older)).toEqual(older);
    expect(storage.PileApplyResultStoredV1Schema.safeParse({ ...receipt, trashEntryIds: [''] }).success).toBe(false);
    expect(PileApplyResultV1Schema.safeParse({ ...receipt, future: true }).success).toBe(false);
  });
  it('retains sampled optional reclaimable capacity without changing immediately available free space', () => {
    const volume = summary.volumes[0]!;
    for (const availableIncludingPurgeableBytes of [5000, 8000]) {
      const parsed = HappierStorageSummaryV1Schema.parse({ ...summary, volumes: [{ ...volume, availableIncludingPurgeableBytes }] });
      expect(parsed.volumes[0]).toMatchObject({ availableIncludingPurgeableBytes, freeBytes: 5000 });
    }
    expect(HappierStorageSummaryV1Schema.parse(summary).volumes[0]).not.toHaveProperty('availableIncludingPurgeableBytes');
    expect(HappierStorageSummaryV1Schema.safeParse({ ...summary, volumes: [{ ...volume, availableIncludingPurgeableBytes: -1 }] }).success).toBe(false);
  });
  it('serves the selected folder root independently of its paged children', () => {
    const root = { nodeId: '/data/archive', parentId: '/data', name: 'archive', kind: 'folder', size,
      logicalBytes: 4096, items: 4, changedAt: 1, childCount: 4,
      flags: { happier: false, protection: 'none', atLeast: false, inUse: false } };
    const page = { state: null, nodes: [], coverage: [], root };
    expect(storage.MachineStorageScanGetResultV1Schema.parse(page)).toEqual(page);
    expect(storage.MachineStorageScanGetResultV1Schema.parse({ state: null, nodes: [], coverage: [] })).not.toHaveProperty('root');
    expect(storage.MachineStorageScanGetInputV1Schema.safeParse({ machineId: 'machine', root }).success).toBe(false);
  });
  it('reads optional canonical review titles and drops additive review presentation fields while retaining strict identity', () => {
    const ref = { itemId: 'pnpm', path: '/cache/pnpm', title: 'pnpm store',
      identity: { dev: '1', ino: '2', kind: 'directory' }, collectedAt: 1,
      collectedBy: { accountId: 'owner', kind: 'person' } };
    const checked = { ref, title: 'pnpm store', expect: 'opaque', verdict: 'safe', reason: { code: 'reinstalls' }, size, absorbs: [] };
    const staying = { item: { itemId: 'kept', path: '/cache/kept', title: 'Kept cache' }, reason: { code: 'system' } };
    const review = { items: [checked], staying: [staying], countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] };
    expect(storage.PileReviewV1Schema.parse({ ...review, futureDisplay: true,
      items: [{ ...checked, futureDisplay: true }], staying: [{ ...staying, futureDisplay: true }] })).toEqual(review);
    expect(PileItemRefStoredV1Schema.parse({ ...ref, futureDisplay: true })).toEqual(ref);
    expect(storage.PileReviewV1Schema.safeParse({ ...review, items: [{ ...checked,
      ref: { ...ref, identity: { ...ref.identity, authority: 'override' } } }] }).success).toBe(false);
    expect(storage.PileReviewV1Schema.safeParse({ ...review, items: [{ ...checked, title: 1 }] }).success).toBe(false);
    const { title: _title, ...titlelessRef } = ref;
    const { title: _checkTitle, ...titlelessCheck } = checked;
    const { title: _stayingTitle, ...titlelessStaying } = staying.item;
    const old = { ...review, items: [{ ...titlelessCheck, ref: titlelessRef }], staying: [{ ...staying, item: titlelessStaying }] };
    expect(storage.PileReviewV1Schema.parse(old)).toEqual(old);
  });
  it('accepts served collect/check references without accepting caller identity or attribution', () => {
    const ref = { itemId: 'cache', path: '/cache' };
    expect(storage.MachineStoragePileSetInputV1Schema.parse({ machineId: 'machine', add: [ref] }).add).toEqual([ref]);
    expect(storage.MachineStorageItemsCheckInputV1Schema.parse({ machineId: 'machine', refs: [ref] }).refs).toEqual([ref]);
    for (const extra of [{ identity: { dev: 'unread', ino: 'unread', kind: 'other' } }, { collectedAt: 1 },
      { collectedBy: { accountId: 'forged', kind: 'person' } }]) {
      expect(storage.MachineStoragePileSetInputV1Schema.safeParse({ machineId: 'machine', add: [{ ...ref, ...extra }] }).success).toBe(false);
      expect(storage.MachineStorageItemsCheckInputV1Schema.safeParse({ machineId: 'machine', refs: [{ ...ref, ...extra }] }).success).toBe(false);
    }
  });
  it('preserves explicit Forbidden and Keep disk tiers and canonical holder loss facts', () => {
    const node = { nodeId: '/data', name: 'data', kind: 'folder', size, logicalBytes: 4096, items: 1,
      changedAt: 1, childCount: 1, flags: { happier: false, protection: 'keep', atLeast: false, inUse: true },
      reason: { code: 'in_use', detail: { sessionId: 'session' } }, loses: [{ code: 'in_use', detail: { sessionId: 'session' } }] };
    expect(storage.DiskNodeV1Schema.parse(node)).toEqual(node);
    expect(storage.DiskNodeV1Schema.parse({ ...node, flags: { ...node.flags, protection: 'forbidden' } }).flags.protection).toBe('forbidden');
    expect(storage.DiskNodeV1Schema.safeParse({ ...node, flags: { ...node.flags, protected: true } }).success).toBe(false);
  });
  it('preserves category group membership and the actual unused threshold', () => {
    const result = { revision: 1, sizedAt: 1, categoryId: 'sessionFolders', items: [item],
      groups: [{ id: 'stopped', olderThanDays: 7, itemIds: [item.itemId] }, { id: 'recent', itemIds: [] }] };
    expect(MachineStorageCategoryListResultV1Schema.parse(result)).toEqual(result);
  });
  it('reports unavailable served references without fabricating an identity', () => {
    const review = { items: [], staying: [{ item: { itemId: 'gone', path: '/gone' }, reason: { code: 'missing' } }],
      countedOnceBytes: 0, totalFreesBytes: 0, trashVolumes: [] };
    expect(storage.PileReviewV1Schema.parse(review)).toEqual(review);
  });
  it('keeps result paging independent of the shared chart folding budget without admitting caller geometry', () => {
    const pageSize = storage.STORAGE_CHART_MAX_DRAWABLE_NODES * 2;
    const start = { machineId: 'machine', target: { volumeId: 'volume' } };
    const get = { machineId: 'machine', view: { tab: 'folders', depth: 1, pageSize } };
    expect(storage.MachineStorageScanGetInputV1Schema.parse(get).view?.pageSize).toBe(pageSize);
    expect(storage.MachineStorageScanStartInputV1Schema.parse(start)).toEqual(start);
    expect(storage.MachineStorageScanStartInputV1Schema.safeParse({ ...start,
      drawableNodes: storage.STORAGE_CHART_MAX_DRAWABLE_NODES }).success).toBe(false);
    expect(storage.MachineStorageScanGetInputV1Schema.safeParse({ ...get, view: { ...get.view,
      drawableNodes: storage.STORAGE_CHART_MAX_DRAWABLE_NODES } }).success).toBe(false);
  });
  it('returns exact Trash restoration metadata in the existing category response', () => {
    const entry = { entryId: 'entry', batchId: 'batch', volumeId: 'volume', originalPath: '/cache', title: 'Cache',
      size, movedAt: 1, movedBy: { accountId: 'owner', kind: 'person' }, emptiesAt: null, restorable: true };
    const result = { revision: 1, sizedAt: 1, categoryId: 'trash', items: [], trashEntries: [entry] };
    expect(MachineStorageCategoryListResultV1Schema.parse(result)).toEqual(result);
    expect(MachineStorageCategoryListResultV1Schema.safeParse({ ...result, trashEntries: [{ ...entry, entryId: '' }] }).success).toBe(false);
    expect(MachineStorageCategoryListResultV1Schema.safeParse({ ...result, trashEntries: [{ ...entry, restoreAuthority: 'override' }] }).success).toBe(false);
    expect(MachineStorageCategoryListResultV1Schema.parse({ revision: 1, sizedAt: 1, categoryId: 'logs', items: [item] }).items).toEqual([item]);
  });
  it('accepts v1 retained pile and Trash data while dropping additions without accepting invalid known identities', () => {
    const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' },
      collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' } };
    const retained = { ...ref, future: true, identity: { ...ref.identity, future: true }, collectedBy: { ...ref.collectedBy, future: true } };
    expect(PileItemRefV1Schema.safeParse(retained).success).toBe(false);
    expect(PileItemRefStoredV1Schema.parse(retained)).toEqual(ref);
    expect(PileItemRefStoredV1Schema.safeParse({ ...retained, identity: { dev: '1', kind: 'directory' } }).success).toBe(false);
    const entry = { entryId: 'entry', batchId: 'batch', volumeId: 'volume', originalPath: '/cache', title: 'Cache',
      size, movedAt: 1, movedBy: ref.collectedBy, emptiesAt: null, restorable: true };
    expect(TrashEntryV1Schema.safeParse({ ...entry, future: true }).success).toBe(false);
    expect(TrashEntryStoredV1Schema.parse({ ...entry, future: true, movedBy: retained.collectedBy })).toEqual(entry);
    const checked = { ref, expect: 'opaque', claimedVerdict: 'keep' };
    expect(MachineStorageTrashMoveInputV1Schema.parse({ machineId: 'machine', items: [checked] }).items).toEqual([checked]);
    expect(MachineStorageTrashMoveInputV1Schema.safeParse({ machineId: 'machine', items: [{ ...checked, actorAccountId: 'other' }] }).success).toBe(false);
    expect(MachineStorageTrashMoveInputV1Schema.safeParse({ machineId: 'machine', items: [{ ...checked, reason: { code: 'in_use', authority: 'override' } }] }).success).toBe(false);
    expect(MachineStorageDeleteNowInputV1Schema.safeParse({ machineId: 'machine', items: [checked] }).success).toBe(false);
    expect(PileApplyResultV1Schema.safeParse({ batchId: 'batch', mode: 'trash', inTrashBytes: 0, freedBytes: 0,
      outcomes: [{ itemId: 'cache', status: 'held_for_approval' }] }).success).toBe(false);
  });
  it('closes item identities and removal facts while dropping safe size projection additions', () => {
    expect(StorageItemV1Schema.safeParse({ ...item, authorization: 'override' }).success).toBe(false);
    expect(HappierStorageSummaryV1Schema.safeParse({ ...summary, categories: [{ ...summary.categories[0], categoryAlias: 'ownData' }] }).success).toBe(false);
    expect(StorageItemV1Schema.parse({ ...item, size: { ...size, futureMeasurement: true } })).toEqual(item);
    expect(StorageItemV1Schema.safeParse({ ...item, verdict: 'protected' }).success).toBe(false);
    expect(StorageItemV1Schema.safeParse({ ...item, size: { ...size, allocatedBytes: '4096' } }).success).toBe(false);
    expect(StorageItemV1Schema.safeParse({ ...item, size: { ...size, allocatedBytes: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
  });

  it('drops safe summary additions recursively without weakening volume identity or known fields', () => {
    expect(HappierStorageSummaryV1Schema.parse({ ...summary, futurePresentation: true,
      volumes: [{ ...summary.volumes[0], futureCapacity: true }], pile: { ...summary.pile, futureDisplay: true },
    })).toEqual(summary);
    expect(HappierStorageSummaryV1Schema.safeParse({ ...summary,
      volumes: [{ ...summary.volumes[0], volume: { ...summary.volumes[0]!.volume, authority: 'other' } }],
    }).success).toBe(false);
    expect(HappierStorageSummaryV1Schema.safeParse({ ...summary, sizedAt: undefined }).success).toBe(false);
  });

  it('reads suggestion preview coverage while accepting older complete summaries without a total', () => {
    const preview = { ...summary, suggestionsTotalCount: 1200, suggestionsSafeTop: [item],
      suggestionsSafeTotalCount: 1100, suggestionsSafeFreesBytes: 2048 };
    expect(HappierStorageSummaryV1Schema.parse(preview)).toEqual(preview);
    const older = { ...summary, suggestionsTop: Array.from({ length: 20 }, () => item) };
    expect(HappierStorageSummaryV1Schema.parse(older)).toEqual(older);
    expect(HappierStorageSummaryV1Schema.parse({ ...summary, suggestionsTop: [], suggestionsTotalCount: 0 }).suggestionsTotalCount).toBe(0);
    for (const suggestionsTotalCount of [-1, 0.5, '1200']) {
      expect(HappierStorageSummaryV1Schema.safeParse({ ...summary, suggestionsTotalCount }).success).toBe(false);
    }
  });

  it('preserves optional per-volume verified-Safe bytes without coercing invalid measurements', () => {
    const volume = summary.volumes[0]!;
    const withCanGo = { ...summary, volumes: [{ ...volume, canGoBytes: 2048 },
      { ...volume, volume: { volumeId: 'empty', mountPath: '/empty', label: 'Empty' }, canGoBytes: 0 }] };
    expect(HappierStorageSummaryV1Schema.parse(withCanGo)).toEqual(withCanGo);
    expect(HappierStorageSummaryV1Schema.parse(summary)).toEqual(summary);
    for (const canGoBytes of [-1, 0.5, '2048']) {
      expect(HappierStorageSummaryV1Schema.safeParse({ ...summary, volumes: [{ ...volume, canGoBytes }] }).success).toBe(false);
    }
  });

  it('rejects caller authority and invalid cursors across strict requests and watch envelopes', () => {
    for (const schema of [MachineStorageSummaryGetInputV1Schema, MachineStorageSizeRefreshInputV1Schema, MachineStorageWatchInputV1Schema]) {
      expect(schema.safeParse({ machineId: 'machine', actorAccountId: 'other' }).success).toBe(false);
    }
    expect(MachineStorageCategoryListInputV1Schema.safeParse({ machineId: 'machine', categoryId: 'unknown' }).success).toBe(false);
    expect(MachineStorageCategoryListInputV1Schema.safeParse({ machineId: 'machine', categoryId: 'logs', cursor: '' }).success).toBe(false);
    expect(MachineStorageWatchInputV1Schema.safeParse({ machineId: 'machine', sinceRevision: 0.5 }).success).toBe(false);
    expect(MachineStorageWatchResultV1Schema.parse({ changed: true, summary })).toEqual({ changed: true, summary });
    expect(MachineStorageWatchResultV1Schema.safeParse({ changed: false, summary }).success).toBe(false);
  });

  it('classifies read, parked watch and explicit remeasurement routes with Action governance', () => {
    for (const method of [RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET, RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST, RPC_METHODS.DAEMON_STORAGE_WATCH]) {
      expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({ routeClass: 'direct_ephemeral', sharedMachineAccess: 'use', commandReceiptRequired: false });
    }
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET)).toMatchObject({ rpcClassification: 'action_spec_bound', actionSpecId: 'machines.storage.summary.get' });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_CATEGORY_LIST)).toMatchObject({ rpcClassification: 'action_spec_bound', actionSpecId: 'machines.storage.category.list' });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_WATCH)).toMatchObject({ rpcClassification: 'internal_only' });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_SIZE_REFRESH)).toMatchObject({ routeClass: 'server_required', sharedMachineAccess: 'manage', rpcClassification: 'action_spec_bound', actionSpecId: 'machines.storage.size.refresh' });
    for (const [method, actionSpecId] of [
      [RPC_METHODS.DAEMON_STORAGE_PILE_SET, 'machines.storage.pile.set'],
      [RPC_METHODS.DAEMON_STORAGE_TRASH_MOVE, 'machines.storage.trash.move'],
      [RPC_METHODS.DAEMON_STORAGE_DELETE_NOW, 'machines.storage.deleteNow'],
      [RPC_METHODS.DAEMON_STORAGE_TRASH_EMPTY, 'machines.storage.trash.empty'],
      [RPC_METHODS.DAEMON_STORAGE_TRASH_RESTORE, 'machines.storage.trash.restore'],
    ] as const) expect(resolveMachineRpcRoutePolicy(method)).toMatchObject({ routeClass: 'server_required', sharedMachineAccess: 'use', rpcClassification: 'action_spec_bound', actionSpecId });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_DECLINE)).toMatchObject({ routeClass: 'server_required', sharedMachineAccess: 'manage', rpcClassification: 'action_spec_bound', actionSpecId: 'machines.storage.suggestions.decline' });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_SUGGESTIONS_LIST)).toMatchObject({ routeClass: 'direct_ephemeral', sharedMachineAccess: 'manage' });
    expect(resolveMachineRpcRoutePolicy(RPC_METHODS.DAEMON_STORAGE_WORKTREES_LIST)).toMatchObject({ routeClass: 'direct_ephemeral', sharedMachineAccess: 'manage' });
  });
});
