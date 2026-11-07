import type { DaemonPublicVoiceModelPackEntry, DaemonPublicVoiceModelPackRuntime } from '@/daemon/voiceInference/publicModelPacks/runtime';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { BrowserRecordingDaemonService } from '@/daemon/browser/recording/service';
import type { createManagedSessionDirectories, ManagedSessionDirectoryEntry } from '@/session/creation/managedSessionDirectories';
import type { HappierStorageCategoryIdV1, StorageItemV1, StorageReasonV1, StorageCategoryGroupV1, MachineStoragePolicyV1, StorageReadIssueV1 } from '@happier-dev/protocol/storage/storageV1';
import type { ScmWorktreeEnrichmentEntry } from '@happier-dev/protocol/scm';
import type { SessionDraftPresence } from '@/session/drafts/readSessionDraftPresence';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { createStorageWorktreeOperations } from '../worktrees/storageWorktreeOperations';
import type { SkillCachePaths } from '@/prompts/skills/store/skillStore';
import type { createProjectWorkspaceRetirement } from '@/workspaces/projectWorkspaceRetirement';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { StoragePathComparator } from '../storagePath';

export type StorageCleanupItem = Omit<StorageItemV1, 'size'> & Readonly<{
    /** A disk-index item has no invented Happier category. */
    categoryId?: HappierStorageCategoryIdV1;
    /** Exact indexed aliases retain the canonical catalog owner's identity. */
    canonicalItemId?: string;
    /** Private owner binding for recipient filtering; never projected into the public item. */
    sessionId?: string;
    /** Accepted current Project anchors, scoped by the catalog's admitted Home and machine. */
    projectIds?: readonly string[];
    /** Canonical SCM common-directory authority; never an outward storage field. */
    repositoryRoot?: string;
    fingerprint?: string;
    ownFingerprint?: string;
    /** Intrinsic facts before descendant presentation is folded into a container. */
    ownVerdict?: Readonly<Pick<StorageItemV1, 'verdict' | 'reason' | 'collectable' | 'loses'>>;
    fingerprintRequired?: boolean;
    nestedWorktreePaths?: readonly string[];
    /** A main checkout/common directory is moved whole, retaining its contained SCM bytes. */
    retirementKind?: 'main' | 'common' | 'orphan';
    referenceOwnerData?: JsonValue;
}>;
export type StorageCategoryItem = StorageCleanupItem & Readonly<{ categoryId: HappierStorageCategoryIdV1;
    /** Category lifecycle presentation, stripped from the public item DTO. */
    categoryGroup?: Omit<StorageCategoryGroupV1, 'itemIds'>;
}>;
export type SizedStorageCategoryItem = StorageCategoryItem & Pick<StorageItemV1, 'size'>;
export type StorageTrackedSession = Readonly<{ sessionId: string; cwd: string; running: boolean; stoppedAt?: number; archived?: boolean }>;
export type StoragePathUse = Readonly<{ reliable: boolean; paths: readonly string[];
    /** Same-principal cwd holders protect that folder and its ancestors, not its descendants. */
    cwdPaths?: readonly string[];
    sessions?: readonly Readonly<{ path: string; sessionId: string; tree?: boolean }>[];
}>;
export type StorageTemporaryFact = Readonly<{ path: string; state: 'closed' | 'delivered' | 'ended' | 'in_use' | 'unknown' }>;
export type StorageIsolationFact = Readonly<{ path: string; state: 'finished' | 'running' | 'unknown_owner' | 'unknown' }>;
export type StorageRecording = Readonly<{ recordingId: string; path: string; title?: string; expiresAtMs?: number; active: boolean }>;
export type StorageProject = Readonly<{ repositoryRoot: string; projectId?: string; title?: string }>;
export type StorageProjectFacts = Readonly<{ status: 'ready'; projects: readonly StorageProject[] }>
    | Readonly<{ status: 'unavailable'; projects?: readonly StorageProject[] }>;
export type StorageCategoryDiscoverySnapshot = Readonly<{
    items: readonly StorageCategoryItem[];
    incompleteCategoryIds: readonly HappierStorageCategoryIdV1[];
    incomplete?: readonly StorageReadIssueV1[];
}>;
export type StorageWorktree = Readonly<{ path: string; repositoryRoot: string; title?: string;
    isMain?: boolean; facts?: ScmWorktreeEnrichmentEntry; pullRequestState?: 'open' | 'closed' | 'merged' | null;
    retentionSupported?: boolean; fingerprint?: string; retentionKind?: 'main' | 'common' | 'orphan' }>;
export type StorageCategoryCatalogDeps = Readonly<{
    happyHomeDir: string;
    activeServerDir: string;
    installDir?: string;
    bootedAt?: number;
    tempRoot?: string;
    now?: () => number;
    readProjects?: () => StorageProjectFacts | Promise<StorageProjectFacts>;
    readWorktrees?: () => readonly StorageWorktree[] | Promise<readonly StorageWorktree[]>;
    scmRegistry?: ScmBackendRegistry;
    worktreeOperations?: ReturnType<typeof createStorageWorktreeOperations>;
    checkoutReferences?: ReturnType<typeof createProjectWorkspaceRetirement>;
    readSessionDraftPresence?: (sessionId: string) => Promise<SessionDraftPresence>;
    trashRoots?: () => readonly string[];
    readTrackedSessions?: () => readonly StorageTrackedSession[];
    readAcpCatalog?: () => AcpCatalogSnapshotV1 | undefined;
    acpAccountId?: string;
    isAcpDefinitionInUse?: (definitionId: string) => boolean | Promise<boolean>;
    managedSessionDirectories?: Pick<ReturnType<typeof createManagedSessionDirectories>, 'listRecords'> & Partial<Pick<ReturnType<typeof createManagedSessionDirectories>, 'retireToTrash' | 'reinstateFromTrash' | 'discardFromTrash' | 'removeAllocation'>>;
    modelPackRuntime?: Pick<DaemonPublicVoiceModelPackRuntime, 'list' | 'resolve' | 'remove' | 'adopt'>;
    recordingRuntime?: Pick<BrowserRecordingDaemonService, 'discardStorageRecording'>;
    readModelPackRuntime?: () => Pick<DaemonPublicVoiceModelPackRuntime, 'list' | 'resolve' | 'remove' | 'adopt'> | null;
    readRecordingRuntime?: () => Pick<BrowserRecordingDaemonService, 'discardStorageRecording'> | null;
    readModelPacks?: () => Promise<readonly DaemonPublicVoiceModelPackEntry[]>;
    readRecordings?: () => Promise<readonly StorageRecording[]>;
    readLiveRunnerSnapshotPaths?: () => Readonly<{ reliable: boolean; paths: ReadonlySet<string> }>;
    readLiveSkillCachePaths?: () => SkillCachePaths | Promise<SkillCachePaths>;
    readInUsePaths?: () => StoragePathUse | Promise<StoragePathUse>;
    readPolicy?: () => Readonly<Pick<MachineStoragePolicyV1, 'suggestUnusedAfterDays' | 'logRetentionDays'>>;
    readTemporaryFacts?: () => Promise<readonly StorageTemporaryFact[]>;
    readIsolationFacts?: () => readonly StorageIsolationFact[] | Promise<readonly StorageIsolationFact[]>;
    currentLogPaths?: () => readonly string[] | Promise<readonly string[]>;
}>;
/** Private, machine-local owner data; it is never accepted as mutation authority from a caller. */
export type StorageCategoryAdapter = Readonly<{
    ownerData: JsonValue;
    /** Canonical private session binding used by recipient admission. */
    sessionId?: string;
    restorable: boolean;
    /** Git-touching maintenance waits for the daemon's existing idle boundary. */
    requiresIdle?: boolean;
    retire(input: Readonly<{ payloadPath: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
    reinstate(input: Readonly<{ payloadPath: string; restorePath: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
    discard(input: Readonly<{ payloadPath?: string; beforeEffect?: () => Promise<void> }>): Promise<void>;
}>;
export class StorageCategoryAdapterError extends Error {
    constructor(readonly code: 'owner_unavailable' | 'owner_data_invalid' | 'restore_unsupported' | 'restore_path_unsupported') {
        super(code);
        this.name = 'StorageCategoryAdapterError';
    }
}
export type StorageCategoryVerdict = Readonly<{
    verdict: StorageItemV1['verdict']; reason: StorageReasonV1; collectable: boolean; loses?: StorageReasonV1[];
    categoryGroup?: StorageCategoryItem['categoryGroup'];
}>;
export type StorageCategoryContext = Readonly<{
    /** Physical page paths; absent for full category inventory. Never effect authority. */
    discoveryPaths?: readonly string[];
    pathComparator: StoragePathComparator;
    deps: StorageCategoryCatalogDeps;
    now: number;
    unusedBefore: number;
    logRetentionDays: number | null;
    sessions: readonly StorageTrackedSession[];
    projects: readonly StorageProject[];
    projectsAvailable: boolean;
    worktrees: readonly StorageWorktree[];
    allocations: readonly ManagedSessionDirectoryEntry[];
    modelPacks: readonly DaemonPublicVoiceModelPackEntry[];
    recordings: readonly StorageRecording[];
    temporaryFacts: readonly StorageTemporaryFact[];
    isolationFacts: readonly StorageIsolationFact[];
    inUse: StoragePathUse;
    discoveryIssues: StorageCategoryItem[];
}>;
export type StorageCategoryDefinition = Readonly<{
    id: HappierStorageCategoryIdV1;
    /** These lifecycle owners retire/re-adopt a complete item, never arbitrary inner paths. */
    descendantCleanup?: 'whole-item-only';
    roots(context: StorageCategoryContext): readonly string[];
    items(context: StorageCategoryContext): Promise<readonly StorageCategoryItem[]>;
    bindAdapter?(item: StorageCategoryItem, context: StorageCategoryContext): Promise<StorageCategoryAdapter>;
    adapterForEntry?(ownerData: JsonValue, deps: StorageCategoryCatalogDeps): Promise<StorageCategoryAdapter>;
}>;
