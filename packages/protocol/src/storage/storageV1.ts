import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

// Shared Map/Rings drawing geometry also sets native scan folding resolution.
export const STORAGE_TREEMAP_MIN_NODE_PX = { width: 56, height: 20 } as const;
export const STORAGE_TREEMAP_LARGEST_VIEW_PX = { width: 760, height: 300 } as const;
export const STORAGE_RINGS_MIN_ARC_DEGREES = 2;
export const STORAGE_CHART_MAX_DRAWABLE_NODES = Math.max(
  Math.floor((STORAGE_TREEMAP_LARGEST_VIEW_PX.width * STORAGE_TREEMAP_LARGEST_VIEW_PX.height)
    / (STORAGE_TREEMAP_MIN_NODE_PX.width * STORAGE_TREEMAP_MIN_NODE_PX.height)),
  360 / STORAGE_RINGS_MIN_ARC_DEGREES,
);

// Storage V1 is a new Machine RPC epoch, independent of the package version.
// Closed: requests, volume refs, item/category identities and removal facts,
// dropped-item refs, scan envelopes/targets/binary identity, pagination and watch.
// Additive-open/drop: summary/volume totals, sizes, reasons, pile/Trash summaries,
// whole-disk presentation, and nested scan progress/unreadable/permission facts.
// Scalar detail records are presentation-only. No object round-trips unknowns;
// known fields never coerce and accepted extras acquire no authority meaning.
const bytes = () => z.number().check(z.int(), z.nonnegative());
const time = () => z.number().check(z.int(), z.nonnegative());
const revision = () => z.number().check(z.int(), z.nonnegative());
const target = () => ({ serverId: z.optional(z.string().check(z.minLength(1))), machineId: z.string().check(z.minLength(1)) });
const detailFacts = () => z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const dockerPruneImage = () => z.readonly(z.strictObject({
  nativeId: z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u)),
  configDigest: z.string().check(z.regex(/^sha256:[a-f0-9]{64}$/u)),
  platform: z.string().check(z.minLength(1)),
}));
/** Closed native selectors are expectations, never custody or protection facts. */
export const MachineStorageDockerPruneInputV1Schema = lazyZodSchema(() => z.readonly(z.union([
  z.strictObject({ ...target(), expectedEngineId: z.string().check(z.minLength(1)),
    selection: z.readonly(z.strictObject({ kind: z.literal('explicit'), images: z.readonly(z.array(dockerPruneImage())),
      buildCacheIds: z.readonly(z.array(z.string().check(z.minLength(1)))) })) }),
  z.strictObject({ ...target(), expectedEngineId: z.optional(z.string().check(z.minLength(1))),
    selection: z.readonly(z.strictObject({ kind: z.literal('unusedBuildCacheAndUnreferencedImages') })) }),
])));
export type MachineStorageDockerPruneInputV1 = z.infer<typeof MachineStorageDockerPruneInputV1Schema>;
export const MachineStorageDockerPruneResultV1Schema = lazyZodSchema(() => {
  const result = { removed: z.readonly(z.array(z.string())), kept: z.readonly(z.array(z.string())) };
  return z.readonly(z.union([
    z.strictObject({ ...result, kind: z.literal('completed'), buildCache: z.literal('unsupported') }),
    z.strictObject({ ...result, kind: z.literal('changed') }),
    z.strictObject({ ...result, kind: z.literal('failed') }),
    z.strictObject({ ...result, kind: z.literal('outcome_unknown') }),
    z.strictObject({ ...result, kind: z.literal('unavailable'),
      reason: z.enum(['image_custody_unavailable', 'native_inventory_unavailable']), deploymentIds: z.readonly(z.array(z.string())) }),
    z.strictObject({ ...result, kind: z.literal('unsupported'), reason: z.enum(['build_cache_custody_unavailable', 'image_custody_unavailable', 'native_runtime_unavailable']) }),
    z.strictObject({ ...result, kind: z.literal('effect_in_progress'), actionOperationId: z.string().check(z.minLength(1)) }),
  ]));
});
export type MachineStorageDockerPruneResultV1 = z.infer<typeof MachineStorageDockerPruneResultV1Schema>;

export const HappierStorageCategoryIdV1Schema = lazyZodSchema(() => z.enum([
  'worktrees', 'caches', 'modelPacks', 'sessionFolders', 'logs', 'agentHomes', 'temporary', 'recordings', 'trash', 'ownData',
]));
export type HappierStorageCategoryIdV1 = z.infer<typeof HappierStorageCategoryIdV1Schema>;

export const StorageVolumeRefV1Schema = lazyZodSchema(() => z.strictObject({
  volumeId: z.string().check(z.minLength(1)), mountPath: z.string().check(z.minLength(1)), label: z.string(),
}));
export type StorageVolumeRefV1 = z.infer<typeof StorageVolumeRefV1Schema>;
export const StorageSizeV1Schema = lazyZodSchema(() => z.object({
  allocatedBytes: bytes(), freesBytes: bytes(), freesUpToBytes: z.optional(bytes()), sharedBytes: bytes(),
  sharedExtentsUnmeasured: z.boolean(), atLeast: z.boolean(),
}));
export type StorageSizeV1 = z.infer<typeof StorageSizeV1Schema>;
export const StorageReasonV1Schema = lazyZodSchema(() => z.object({
  code: z.enum([
    'main_checkout', 'in_use', 'changed_files', 'unpushed_commits', 'unsaved_edits', 'open_pr', 'recent', 'always_kept',
    'merged_clean', 'branch_gone', 'clean_pushed', 'rebuilds', 'reinstalls', 'downloads_again', 'stopped', 'old',
    'attachments_go', 'feature_waits', 'not_rebuildable', 'personal_folder', 'agent_home', 'credentials',
    'user_protected', 'contains', 'root', 'system', 'home_folder', 'happier_install', 'happier_data',
    'contains_forbidden', 'facts_unavailable',
    'changed_since_review', 'missing', 'trash_unavailable', 'destination_occupied', 'parent_missing',
    'unauthorized', 'operation_failed', 'unsupported', 'has_submodules',
  ]),
  // Presentation-only structured facts, never provider-native or executable content.
  detail: z.optional(detailFacts()),
}));
export type StorageReasonV1 = z.infer<typeof StorageReasonV1Schema>;

/** Presentation evidence only; these codes never establish cleanup authority. */
export const StorageEvidenceCodeV1Schema = lazyZodSchema(() => z.enum([
  'directory_permission_unavailable', 'managed_acp_install', 'runner_snapshot_root', 'managed_cache_root',
  'connected_service_home', 'execution_run_isolation_owner', 'execution_run_isolation_facts_unavailable',
  'happier_temporary_directory', 'temporary_lifecycle_owner', 'temporary_lifecycle_facts_unavailable',
  'voice_model_pack_install_record', 'model_pack_facts_unavailable', 'browser_recording_owner', 'recording_expired',
  'happier_trash_root', 'happier_data_remainder', 'managed_session_directory_record',
  'managed_session_directory_record_unavailable', 'session_workspace_upload', 'worktree_parent',
  'registration_unavailable', 'scm_orphan_back_reference', 'scm_registered_worktree',
  'nested_worktree_kept', 'nested_worktrees_children_first', 'log_file_modified_time', 'trusted_disk_index',
  'scm_ignored', 'browser_profile_cache', 'unused_after_policy', 'repository_not_in_use',
  'verified_cache_location', 'empty_folder_relisted', 'trash_entry', 'unknown',
]));
export type StorageEvidenceCodeV1 = z.infer<typeof StorageEvidenceCodeV1Schema>;
export const StorageEvidenceV1Schema = lazyZodSchema(() => z.union([
  StorageEvidenceCodeV1Schema,
  z.templateLiteral(['recognizer:', z.string().check(z.minLength(1))]),
  z.templateLiteral(['manifest:', z.string().check(z.minLength(1))]),
]));
export type StorageEvidenceV1 = z.infer<typeof StorageEvidenceV1Schema>;
// Future presentation codes remain readable, but acquire no display or authority meaning.
const storageEvidenceRead = () => z.pipe(z.string(), z.catch(StorageEvidenceV1Schema, 'unknown'));
export const StorageItemV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: z.string().check(z.minLength(1)), kind: z.enum(['category-item', 'worktree', 'suggestion', 'disk-node']),
  categoryId: z.optional(HappierStorageCategoryIdV1Schema), title: z.string(), evidence: z.array(storageEvidenceRead()),
  path: z.string().check(z.minLength(1)), size: StorageSizeV1Schema, lastChangedAt: z.optional(time()), lastUsedAt: z.optional(time()),
  verdict: z.enum(['safe', 'caution', 'keep', 'forbidden', 'check']), reason: StorageReasonV1Schema,
  collectable: z.boolean(), loses: z.optional(z.array(StorageReasonV1Schema)),
}));
export type StorageItemV1 = z.infer<typeof StorageItemV1Schema>;
export const PileSummaryV1Schema = lazyZodSchema(() => z.object({
  count: z.number().check(z.int(), z.nonnegative()), freesBytes: bytes(),
  droppedSinceLastView: z.array(z.strictObject({ itemId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), reason: StorageReasonV1Schema })),
}));
export type PileSummaryV1 = z.infer<typeof PileSummaryV1Schema>;
export const TrashSummaryV1Schema = lazyZodSchema(() => z.object({
  count: z.number().check(z.int(), z.nonnegative()), allocatedBytes: bytes(), emptiesNextAt: z.optional(time()),
}));
export type TrashSummaryV1 = z.infer<typeof TrashSummaryV1Schema>;

// Target and scan-id envelope are closed identities; progress/permission facts are read projections.
export const DiskScanStateV1Schema = lazyZodSchema(() => z.strictObject({
  scanId: z.string().check(z.minLength(1)),
  target: z.union([z.strictObject({ volumeId: z.string().check(z.minLength(1)) }), z.strictObject({ folderPath: z.string().check(z.minLength(1)) })]),
  status: z.enum(['running', 'complete', 'cancelled', 'interrupted', 'failed']),
  progress: z.object({ sizedBytes: bytes(), usedBytes: bytes(), items: z.number().check(z.int(), z.nonnegative()), currentPath: z.optional(z.string()), stuckSinceMs: z.optional(time()) }),
  startedAt: time(), finishedAt: z.optional(time()), previousScanAt: z.optional(time()),
  // Read-only observation of local Time Machine snapshots on the scanned APFS volume.
  // Missing means unobserved; it never contributes bytes or authorizes cleanup.
  apfsLocalSnapshotCount: z.optional(z.number().check(z.int(), z.nonnegative())),
  unreadable: z.object({
    counts: z.object({ permission: z.number().check(z.int(), z.nonnegative()), os_private: z.number().check(z.int(), z.nonnegative()), timeout: z.number().check(z.int(), z.nonnegative()), io: z.number().check(z.int(), z.nonnegative()) }),
    examples: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  fullDiskAccess: z.object({
    state: z.enum(['granted', 'not_granted', 'unknown', 'not_applicable']),
    binary: z.strictObject({ name: z.string(), path: z.string() }), waitingForConsent: z.optional(z.boolean()),
  }),
}));
export type DiskScanStateV1 = z.infer<typeof DiskScanStateV1Schema>;

export const DiskNodeV1Schema = lazyZodSchema(() => z.strictObject({
  nodeId: z.string().check(z.minLength(1)), parentId: z.optional(z.string().check(z.minLength(1))), name: z.string(), nameBytes: z.optional(z.string()),
  kind: z.enum(['folder', 'file', 'package', 'small-items', 'hidden-space', 'reserved', 'mount', 'cloud-only']),
  size: StorageSizeV1Schema, logicalBytes: bytes(), items: bytes(), changedAt: time(), deltaSincePrevious: z.optional(z.number().check(z.int())),
  flags: z.strictObject({ happier: z.boolean(), protection: z.enum(['forbidden', 'keep', 'none']), atLeast: z.boolean(), inUse: z.boolean() }), childCount: bytes(),
  reason: z.optional(StorageReasonV1Schema), loses: z.optional(z.array(StorageReasonV1Schema)),
}));
export type DiskNodeV1 = z.infer<typeof DiskNodeV1Schema>;
export const DiskScanViewV1Schema = lazyZodSchema(() => z.strictObject({
  tab: z.enum(['folders', 'large', 'old', 'insights', 'find']), nodeId: z.optional(z.string().check(z.minLength(1))), depth: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  sort: z.optional(z.strictObject({ by: z.enum(['name', 'size', 'items', 'changed', 'since']), direction: z.enum(['asc', 'desc']) })),
  cursor: z.optional(z.string().check(z.minLength(1))), pageSize: z.optional(z.number().check(z.int(), z.positive())), minBytes: z.optional(bytes()),
  olderThanDays: z.optional(z.number().check(z.int(), z.minimum(1))), olderThanMonths: z.optional(z.union([z.literal(3), z.literal(6), z.literal(12)])),
  query: z.optional(z.strictObject({ name: z.optional(z.string()), kind: z.optional(z.enum(['folder', 'file', 'package'])), minBytes: z.optional(bytes()),
    maxBytes: z.optional(bytes()), modifiedWithinDays: z.optional(z.number().check(z.int(), z.minimum(1))) }).check(z.refine(value => value.minBytes === undefined || value.maxBytes === undefined
      || value.minBytes <= value.maxBytes, { message: 'invalid_size_range' }))),
}).check(z.refine(value => value.olderThanDays === undefined || value.olderThanMonths === undefined, { message: 'exclusive_old_age_filter' })));
export type DiskScanViewV1 = z.infer<typeof DiskScanViewV1Schema>;
export const MachineStorageScanStartInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), target: DiskScanStateV1Schema.shape.target, resume: z.optional(z.boolean()),
}));
export type MachineStorageScanStartInputV1 = z.infer<typeof MachineStorageScanStartInputV1Schema>;
export const MachineStorageScanGetInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.optional(z.string().check(z.minLength(1))), view: z.optional(DiskScanViewV1Schema) }));
export type MachineStorageScanGetInputV1 = z.infer<typeof MachineStorageScanGetInputV1Schema>;
export const MachineStorageScanCancelInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.string().check(z.minLength(1)) }));
export type MachineStorageScanCancelInputV1 = z.infer<typeof MachineStorageScanCancelInputV1Schema>;
export const MachineStorageScanSkipInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), scanId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) }));
export type MachineStorageScanSkipInputV1 = z.infer<typeof MachineStorageScanSkipInputV1Schema>;
export const MachineStorageScanGetResultV1Schema = lazyZodSchema(() => z.strictObject({
  state: z.nullable(DiskScanStateV1Schema), nodes: z.array(DiskNodeV1Schema), nextCursor: z.optional(z.string().check(z.minLength(1))),
  // The selected level's facts are independent of child paging and chart depth.
  root: z.optional(DiskNodeV1Schema),
  coverage: z.array(z.strictObject({ path: z.string().check(z.minLength(1)), scannedAt: time(), complete: z.boolean() })),
  indexedAt: z.optional(time()), previousScanAt: z.optional(time()), findCoverageMinBytes: z.optional(bytes()),
  insights: z.optional(z.strictObject({ largestDistinct: z.array(DiskNodeV1Schema),
    changes: z.strictObject({ grew: z.array(DiskNodeV1Schema), shrank: z.array(DiskNodeV1Schema), appeared: z.array(DiskNodeV1Schema), disappeared: z.array(DiskNodeV1Schema) }),
    growthBytes: bytes(), reclaimedBytes: bytes(), notComparableFolders: bytes(),
    ageGroupBytes: z.strictObject({ unknown: bytes(), months3: bytes(), months6: bytes(), months12: bytes() }), trashBytes: bytes(),
  })),
}));
export type MachineStorageScanGetResultV1 = z.infer<typeof MachineStorageScanGetResultV1Schema>;
export const MachineStorageProtectedAddInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), path: z.string().check(z.minLength(1)) }));
export type MachineStorageProtectedAddInputV1 = z.infer<typeof MachineStorageProtectedAddInputV1Schema>;
export const MachineStorageProtectedRemoveInputV1Schema = MachineStorageProtectedAddInputV1Schema;
export type MachineStorageProtectedRemoveInputV1 = z.infer<typeof MachineStorageProtectedRemoveInputV1Schema>;

export const HappierStorageSummaryV1Schema = lazyZodSchema(() => z.object({
  revision: revision(), sizedAt: time(),
  // Daemon-qualified folder entry points, consumed by the ordinary scanner.
  scanShortcuts: z.optional(z.array(z.strictObject({ kind: z.enum(['downloads', 'cache']), path: z.string().check(z.minLength(1)) }))),
  volumes: z.array(z.object({ volume: StorageVolumeRefV1Schema, totalBytes: bytes(), freeBytes: bytes(), happierBytes: bytes(), pileBytes: bytes(), trashBytes: bytes(),
    // Allocated pile/Trash bytes describe occupancy; only measured exclusive bytes
    // may forecast returned space. Absence means an older producer did not report it.
    pileFreesBytes: z.optional(bytes()), trashFreesBytes: z.optional(bytes()),
    // Sampled by the vitals capacity owner; presentation only, never free-now or cleanup budget.
    availableIncludingPurgeableBytes: z.optional(bytes()),
    // A measured verified-Safe union; absence is unreported, not measured zero.
    canGoBytes: z.optional(bytes()),
  })),
  categories: z.array(z.strictObject({ categoryId: HappierStorageCategoryIdV1Schema, size: StorageSizeV1Schema, canGoBytes: bytes(), count: z.number().check(z.int(), z.nonnegative()), detailFacts: detailFacts() })),
  suggestionsTop: z.array(StorageItemV1Schema), pile: PileSummaryV1Schema, trash: TrashSummaryV1Schema,
  wholeDisk: z.object({ enabled: z.boolean(), scans: z.array(DiskScanStateV1Schema) }),
}));
export type HappierStorageSummaryV1 = z.infer<typeof HappierStorageSummaryV1Schema>;

export const MachineStorageSummaryGetInputV1Schema = lazyZodSchema(() => z.strictObject(target()));
export type MachineStorageSummaryGetInputV1 = z.infer<typeof MachineStorageSummaryGetInputV1Schema>;
export const MachineStorageCategoryListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), categoryId: HappierStorageCategoryIdV1Schema, cursor: z.optional(z.string().check(z.minLength(1))),
}));
export type MachineStorageCategoryListInputV1 = z.infer<typeof MachineStorageCategoryListInputV1Schema>;
export const StorageCategoryGroupV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.enum(['stopped', 'recent', 'old']), itemIds: z.array(z.string().check(z.minLength(1))), olderThanDays: z.optional(z.number().check(z.int(), z.positive())),
}));
export type StorageCategoryGroupV1 = z.infer<typeof StorageCategoryGroupV1Schema>;
export const MachineStorageCategoryListResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), sizedAt: time(), categoryId: HappierStorageCategoryIdV1Schema,
  items: z.array(StorageItemV1Schema), trashEntries: z.optional(z.array(TrashEntryV1Schema)), nextCursor: z.optional(z.string().check(z.minLength(1))),
  groups: z.optional(z.array(StorageCategoryGroupV1Schema)),
}));
export type MachineStorageCategoryListResultV1 = z.infer<typeof MachineStorageCategoryListResultV1Schema>;
export const MachineStorageSizeRefreshInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), categoryId: z.optional(HappierStorageCategoryIdV1Schema),
}));
export type MachineStorageSizeRefreshInputV1 = z.infer<typeof MachineStorageSizeRefreshInputV1Schema>;
export const MachineStorageWatchInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), sinceRevision: z.optional(revision()),
}));
export type MachineStorageWatchInputV1 = z.infer<typeof MachineStorageWatchInputV1Schema>;
export const MachineStorageWatchResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('changed', [
  z.strictObject({ changed: z.literal(true), summary: HappierStorageSummaryV1Schema }),
  z.strictObject({ changed: z.literal(false) }),
]));
export type MachineStorageWatchResultV1 = z.infer<typeof MachineStorageWatchResultV1Schema>;

// Mutation and identity envelopes are closed at every request depth. Persisted
// readers below derive the same known fields and strip only unrecognized data.
export const StorageActorV1Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.string().check(z.minLength(1)), kind: z.enum(['person', 'agent']), proposalId: z.optional(z.string().check(z.minLength(1))),
}));
export type StorageActorV1 = z.infer<typeof StorageActorV1Schema>;
export const StorageIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  dev: z.string().check(z.minLength(1)), ino: z.optional(z.string().check(z.minLength(1))), fileId: z.optional(z.string().check(z.minLength(1))),
  kind: z.enum(['file', 'directory', 'symlink', 'other']), fingerprint: z.optional(z.string().check(z.minLength(1))),
}).check(z.refine(value => value.ino !== undefined || value.fileId !== undefined, { message: 'file_identity_required' })));
export type StorageIdentityV1 = z.infer<typeof StorageIdentityV1Schema>;
/** A reference from a served category or disk view; the daemon supplies identity and attribution. */
export const StorageItemRefV1Schema = lazyZodSchema(() => z.strictObject({ itemId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)) }));
export type StorageItemRefV1 = z.infer<typeof StorageItemRefV1Schema>;
export const PileItemRefV1Schema = lazyZodSchema(() => z.strictObject({
  itemId: z.string().check(z.minLength(1)), path: z.string().check(z.minLength(1)), title: z.optional(z.string()), identity: StorageIdentityV1Schema,
  collectedAt: time(), collectedBy: StorageActorV1Schema,
}));
export type PileItemRefV1 = z.infer<typeof PileItemRefV1Schema>;
export const PileItemRefStoredV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(PileItemRefV1Schema, {
  identity: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(StorageIdentityV1Schema), collectedBy: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(StorageActorV1Schema),
})));

export const StorageItemCheckV1Schema = lazyZodSchema(() => z.object({
  ref: PileItemRefV1Schema, title: z.optional(z.string()), expect: z.string().check(z.minLength(1)), verdict: StorageItemV1Schema.shape.verdict,
  reason: StorageReasonV1Schema, size: StorageSizeV1Schema, absorbs: z.array(z.string().check(z.minLength(1))),
  loses: z.optional(z.array(StorageReasonV1Schema)),
}));
export type StorageItemCheckV1 = z.infer<typeof StorageItemCheckV1Schema>;
export const PileReviewV1Schema = lazyZodSchema(() => z.object({
  items: z.array(StorageItemCheckV1Schema),
  staying: z.array(z.object({ item: z.extend(StorageItemRefV1Schema, { title: z.optional(z.string()) }), reason: StorageReasonV1Schema })),
  countedOnceBytes: bytes(), totalFreesBytes: bytes(),
  trashVolumes: z.array(z.strictObject({ volumeId: z.string().check(z.minLength(1)), trashAvailable: z.boolean(), reason: z.optional(StorageReasonV1Schema) })),
}));
export type PileReviewV1 = z.infer<typeof PileReviewV1Schema>;
export const PileApplyResultV1Schema = lazyZodSchema(() => z.strictObject({
  batchId: z.string().check(z.minLength(1)), mode: z.enum(['trash', 'delete']),
  outcomes: z.array(z.strictObject({ itemId: z.string().check(z.minLength(1)), status: z.enum(['moved', 'deleted', 'skipped', 'refused', 'failed']), reason: z.optional(StorageReasonV1Schema) })),
  inTrashBytes: bytes(), freedBytes: bytes(),
  /** Exact entries still in Trash at settlement; freedBytes already includes immediate emptyAfter effects. */
  trashEntryIds: z.optional(z.array(z.string().check(z.minLength(1)))),
}));
export type PileApplyResultV1 = z.infer<typeof PileApplyResultV1Schema>;
/** Retained presentation receipts drop additive fields; known correlation remains validated. */
export const PileApplyResultStoredV1Schema = createStoredReadSchema(PileApplyResultV1Schema);
export const TrashEntryV1Schema = lazyZodSchema(() => z.strictObject({
  entryId: z.string().check(z.minLength(1)), batchId: z.string().check(z.minLength(1)), volumeId: z.string().check(z.minLength(1)), originalPath: z.string().check(z.minLength(1)),
  title: z.string(), categoryId: z.optional(HappierStorageCategoryIdV1Schema), size: StorageSizeV1Schema,
  movedAt: time(), movedBy: StorageActorV1Schema, emptiesAt: z.nullable(time()), restorable: z.boolean(), reason: z.optional(StorageReasonV1Schema),
}));
export type TrashEntryV1 = z.infer<typeof TrashEntryV1Schema>;
export const TrashEntryStoredV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(z.extend(TrashEntryV1Schema, { movedBy: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: undefined }) as z.ZodMiniObject<T['shape'], z.core.$strip>)(StorageActorV1Schema) })));

const checkedItem = () => z.strictObject({ ref: PileItemRefV1Schema, expect: z.string().check(z.minLength(1)) });
export const MachineStoragePileGetInputV1Schema = MachineStorageSummaryGetInputV1Schema;
export type MachineStoragePileGetInputV1 = z.infer<typeof MachineStoragePileGetInputV1Schema>;
export const MachineStoragePileSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), add: z.optional(z.array(StorageItemRefV1Schema)), remove: z.optional(z.array(z.string().check(z.minLength(1)))), clear: z.optional(z.literal(true)),
}));
export type MachineStoragePileSetInputV1 = z.infer<typeof MachineStoragePileSetInputV1Schema>;
export const MachineStoragePileResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), items: z.array(PileItemRefV1Schema), summary: PileSummaryV1Schema,
}));
export type MachineStoragePileResultV1 = z.infer<typeof MachineStoragePileResultV1Schema>;
export const MachineStorageItemsCheckInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), refs: z.array(StorageItemRefV1Schema) }));
export type MachineStorageItemsCheckInputV1 = z.infer<typeof MachineStorageItemsCheckInputV1Schema>;
export const MachineStorageTrashMoveInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), items: z.array(z.extend(checkedItem(), { claimedVerdict: StorageItemV1Schema.shape.verdict, reason: z.optional((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(StorageReasonV1Schema)) })).check(z.minLength(1)),
  notIncluded: z.optional(z.array(z.extend(StorageItemV1Schema, { size: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(StorageSizeV1Schema), reason: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(StorageReasonV1Schema), loses: z.optional(z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(StorageReasonV1Schema))) }))),
  goalBytes: z.optional(bytes()), emptyAfter: z.optional(z.boolean()),
  retry: z.optional(z.strictObject({ sessionId: z.string().check(z.minLength(1)) })),
}));
export type MachineStorageTrashMoveInputV1 = z.infer<typeof MachineStorageTrashMoveInputV1Schema>;
export const MachineStorageDeleteNowInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), items: z.array(checkedItem()).check(z.minLength(1)) }));
export type MachineStorageDeleteNowInputV1 = z.infer<typeof MachineStorageDeleteNowInputV1Schema>;
export const MachineStorageTrashEmptyInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), volume: z.optional(z.string().check(z.minLength(1))), entryIds: z.optional(z.array(z.string().check(z.minLength(1))).check(z.minLength(1))), batchId: z.optional(z.string().check(z.minLength(1))),
}));
export type MachineStorageTrashEmptyInputV1 = z.infer<typeof MachineStorageTrashEmptyInputV1Schema>;
export const MachineStorageTrashRestoreInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), entryIds: z.optional(z.array(z.string().check(z.minLength(1))).check(z.minLength(1))), batchId: z.optional(z.string().check(z.minLength(1))), beside: z.optional(z.literal(true)),
}).check(z.refine(value => value.entryIds !== undefined || value.batchId !== undefined, { message: 'restore_selection_required' })));
export type MachineStorageTrashRestoreInputV1 = z.infer<typeof MachineStorageTrashRestoreInputV1Schema>;
export const TrashRestoreResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcomes: z.array(z.strictObject({ entryId: z.string().check(z.minLength(1)), status: z.enum(['restored', 'refused', 'failed']), path: z.optional(z.string().check(z.minLength(1))), reason: z.optional(StorageReasonV1Schema) })),
}));
export type TrashRestoreResultV1 = z.infer<typeof TrashRestoreResultV1Schema>;
export const TrashEmptyResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcomes: z.array(z.strictObject({ entryId: z.string().check(z.minLength(1)), status: z.enum(['deleted', 'refused', 'failed']), reason: z.optional(StorageReasonV1Schema) })), freedBytes: bytes(),
}));
export type TrashEmptyResultV1 = z.infer<typeof TrashEmptyResultV1Schema>;
export const MachineStorageWorktreesListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), projectId: z.optional(z.string().check(z.minLength(1))), filter: z.optional(StorageItemV1Schema.shape.verdict),
}));
export type MachineStorageWorktreesListInputV1 = z.infer<typeof MachineStorageWorktreesListInputV1Schema>;
export const MachineStorageSuggestionsListInputV1Schema = lazyZodSchema(() => z.strictObject({
  ...target(), group: z.optional(z.enum(['can-be-rebuilt', 'old-and-unused', 'outside-happier'])), quickestForVolume: z.optional(z.string().check(z.minLength(1))),
}));
export type MachineStorageSuggestionsListInputV1 = z.infer<typeof MachineStorageSuggestionsListInputV1Schema>;
export const MachineStorageItemsListResultV1Schema = lazyZodSchema(() => z.strictObject({
  revision: revision(), items: z.array(StorageItemV1Schema), nextCursor: z.optional(z.string().check(z.minLength(1))), declinedCount: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type MachineStorageItemsListResultV1 = z.infer<typeof MachineStorageItemsListResultV1Schema>;
export const MachineStorageSuggestionsDeclineInputV1Schema = lazyZodSchema(() => z.strictObject({ ...target(), items: z.array(checkedItem()).check(z.minLength(1)) }));
export type MachineStorageSuggestionsDeclineInputV1 = z.infer<typeof MachineStorageSuggestionsDeclineInputV1Schema>;
export const MachineStorageSuggestionsDeclineResultV1Schema = lazyZodSchema(() => z.strictObject({ revision: revision(), declinedCount: z.number().check(z.int(), z.nonnegative()) }));
export type MachineStorageSuggestionsDeclineResultV1 = z.infer<typeof MachineStorageSuggestionsDeclineResultV1Schema>;

// Persisted policy and every nested write object are closed. The resources-policy
// owner derives its tolerant stored reader; this schema never admits loose writes.
export const MachineStoragePolicyV1Schema = lazyZodSchema(() => z.strictObject({
  wholeDiskEnabled: z._default(z.boolean(), false),
  protectedFolders: z._default(z.array(z.strictObject({ path: z.string().check(z.minLength(1)), addedAt: time() })), () => []),
  logRetentionDays: z._default(z.nullable(z.number().check(z.int(), z.minimum(1))), 30),
  trashEmptyAfterDays: z._default(z.nullable(z.number().check(z.int(), z.minimum(1))), 7),
  scheduledScan: z._default(z.nullable(z.strictObject({
    // Machine-local calendar day (Sunday = 0) and the lab's 24-hour HH:mm time.
    weekday: z.number().check(z.int(), z.minimum(0), z.maximum(6)),
    time: z.string().check(z.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
    onlyOnPower: z.literal(true),
  })), null),
  suggestUnusedAfterDays: z._default(z.number().check(z.int(), z.minimum(1)), 30),
}));
export type MachineStoragePolicyV1 = z.infer<typeof MachineStoragePolicyV1Schema>;
export const MachineStoragePolicyPatchV1Schema = lazyZodSchema(() => z.strictObject({
  wholeDiskEnabled: z.optional(MachineStoragePolicyV1Schema.shape.wholeDiskEnabled._zod.def.innerType),
  protectedFolders: z.optional(MachineStoragePolicyV1Schema.shape.protectedFolders._zod.def.innerType),
  logRetentionDays: z.optional(MachineStoragePolicyV1Schema.shape.logRetentionDays._zod.def.innerType),
  trashEmptyAfterDays: z.optional(MachineStoragePolicyV1Schema.shape.trashEmptyAfterDays._zod.def.innerType),
  scheduledScan: z.optional(MachineStoragePolicyV1Schema.shape.scheduledScan._zod.def.innerType),
  suggestUnusedAfterDays: z.optional(MachineStoragePolicyV1Schema.shape.suggestUnusedAfterDays._zod.def.innerType),
}));
export type MachineStoragePolicyPatchV1 = z.infer<typeof MachineStoragePolicyPatchV1Schema>;
