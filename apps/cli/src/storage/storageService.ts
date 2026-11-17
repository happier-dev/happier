import { type HappierStorageSummaryV1, type HappierStorageCategoryIdV1, type MachineStorageCategoryListResultV1,
    type StorageSizeV1, type StorageItemV1, type StorageReadIssueV1 } from '@happier-dev/protocol/storage/storageV1';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { createStorageCategoryCatalog, publicStorageItem, type StorageCategoryCatalogDeps, type StorageCategoryItem } from './categoryCatalog';
import { measureNativeDisk, type NativeDiskMeasurement } from './measure/nativeDiskMeasure';
import type { ActivityLog } from '@/daemon/guard/activityLog';
import type { MachineStoragePolicyV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { createStorageOperations } from './storageOperations';
import type { StorageProtectionFacts } from './protection/protectedPaths';
import { readStorageScanHints, resolveStorageScanShortcuts, storageCandidateRepositoryFacts, type CompletedStorageSuggestionScan } from './suggestions/recognizers';
import { readRepositoryIgnoredPaths } from '@/scm/readRepositoryIgnoredPaths';
import { homedir } from 'node:os';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { MachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import { createStorageProtectedFolders } from './protection/storageProtectedFolders';
import type { StorageScanRunner } from './scan/scanRunner';
import type { StorageScanIndex, TrustedDiskNode } from './scan/scanIndex';
import type { MachineStorageScanStartInputV1, MachineStorageScanGetInputV1,
    MachineStorageScanCancelInputV1, MachineStorageScanSkipInputV1, StorageItemRefV1, StorageCategoryGroupV1 } from '@happier-dev/protocol/storage/storageV1';
import { resolveProcessCustodySupportExecutable } from '@/subprocess/supervision/processCustody';
import { createStorageMaintenance, type StorageMaintenanceDeps } from './maintenance/storageMaintenance';
import { storagePathContains } from './storagePath';
import type { SizedStorageCategoryItem, StoragePathUse } from './categories/types';
import { logger } from '@/ui/logger';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { scmWorktreeMutationActivity } from '@/scm/worktreeMutationActivity';
import { isDeepStrictEqual } from 'node:util';
import { storagePolicyUnavailableError } from './storagePolicy';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { MachineStorageDockerPruneInputV1 } from '@happier-dev/protocol/storage/storageV1';
import type { createStorageDockerPruneForHost } from './dockerPrune';
import type { createStorageDockerForHost } from './dockerStorage';
import { storagePermissionReadIssue } from './categories/filesystem';
import { readStoragePathCapacity, storageVolumeForPath, type StorageFilesystemCapacityReader } from './pathCapacity';

export type StorageEnvironmentProtectionFacts = Pick<StorageProtectionFacts,
    'platform' | 'systemPaths' | 'personalFolders' | 'knownFolders' | 'env' | 'browserProfileRoots' | 'cloudSyncedFolders'>;

/** Admission is stamped by the RPC owner, never reconstructed from Action input. */
export type StorageOperationActor = Readonly<{
    accountId: string;
    kind: 'person' | 'agent';
    custodianAccountId: string;
    /** The native removal invocation retains its requester, cancellation and review owner. */
    removalContext?: import('./worktrees/storageWorktreeOperations').StorageWorktreeRemovalContext;
    /** Absent for admitted Machine Manage; Use is limited to these requester-owned Sessions. */
    sessionIds?: ReadonlySet<string>;
    /** Target/lifetime checks and current Session custody, without Machine admission verification. */
    assertCurrent(): Promise<void>;
    assertCurrentAuthority(): Promise<void>;
}>;

export type StorageServiceDeps = Readonly<{
    dockerPrune?: ReturnType<typeof createStorageDockerPruneForHost>;
    readDockerStorage?: ReturnType<typeof createStorageDockerForHost>['readDockerStorage'];
    /** The Storage owner supplies the catalog's policy reader; callers cannot inject a second one. */
    catalog: Omit<StorageCategoryCatalogDeps, 'readPolicy'>;
    readVolumes: () => readonly Readonly<{ id: string; label: string; mount: string; totalBytes: number; availableBytes: number;
        reservedBytes?: number; apfsContainerId?: string; availableIncludingPurgeableBytes?: number }>[];
    readVolumesReported?: () => boolean;
    readFilesystemCapacity?: StorageFilesystemCapacityReader;
    subscribeChanges?: (listener: () => void) => () => void;
    nowMs?: () => number;
    machineId?: string;
    serverId?: string;
    custodianAccountId?: string;
    homeDir?: string;
    activityLog?: ActivityLog;
    /** The only Storage policy source. Not ready (loading, locked, offline) is unknown, never a default. */
    resourcesPolicy: Pick<MachineResourcesPolicyRuntime, 'read' | 'set' | 'subscribeKey'>;
    canRunStorageOwnerOperation?: () => boolean | Promise<boolean>;
    readLowPower?: () => boolean;
    readIndexedStorageItem?: (ref: StorageItemRefV1) => Promise<TrustedDiskNode | null>;
    maintenance?: Omit<StorageMaintenanceDeps, 'readPolicy' | 'subscribePolicy' | 'getTrashStore' | 'runScheduledScan'>;
    attributionFor?: (accountId: string) => MachineGuardActivityEntryV1['attribution'];
    /** Existing OS/browser owners supply facts; this service performs no environment discovery. */
    readStorageProtectionFacts?: () => StorageEnvironmentProtectionFacts | Promise<StorageEnvironmentProtectionFacts>;
    /** EU7's completed whole-disk index is the only outside-Happier candidate producer. */
    readCompletedStorageScan?: (inUse?: StoragePathUse) => Promise<CompletedStorageSuggestionScan | null>;
    /** Omitted in the daemon, where the canonical applied-runtime lease supplies SCM. */
    scmRegistry?: ScmBackendRegistry;
}>;

export function createStorageService(deps: StorageServiceDeps) {
    let docker: HappierStorageSummaryV1['docker'];
    let currentTrashRoots: readonly string[] | undefined;
    // One policy availability owner for every Storage reader. Maintenance skips
    // effects on unknown; protection, projections and effects refuse instead of
    // classifying against presentation defaults (empty protected folders).
    const readPolicy = (): MachineStoragePolicyV1 | undefined => {
        const snapshot = deps.resourcesPolicy.read();
        return snapshot.status === 'ready' ? snapshot.policy.storage : undefined;
    };
    const subscribePolicy = (listener: () => void) => deps.resourcesPolicy.subscribeKey('storage', listener);
    const requirePolicy = (): MachineStoragePolicyV1 => {
        const policy = readPolicy();
        if (!policy) throw storagePolicyUnavailableError();
        return policy;
    };
    const catalog = createStorageCategoryCatalog({ ...deps.catalog, readPolicy: requirePolicy, scmRegistry: deps.scmRegistry ?? deps.catalog.scmRegistry,
        trashRoots: () => currentTrashRoots ?? deps.catalog.trashRoots?.() ?? [] });
    const now = deps.nowMs ?? Date.now;
    const listeners = new Set<() => void>();
    const controllers = new Set<AbortController>();
    let disposed = false;
    let dirty = true;
    let revision = 0;
    let cached: HappierStorageSummaryV1 | null = null;
    let scanOwner: Promise<Readonly<{ runner: StorageScanRunner; index: StorageScanIndex }>> | undefined;
    let scanLifecycleKey: string | undefined;
    let scanLifecycle: Promise<void> = Promise.resolve();
    let scheduledPolicyKey: string | undefined;
    const scheduledSubscriptions: (() => void)[] = [];
    // Unknown policy cannot authorize deleting retained scans (STO6).
    const readWholeDiskEnabled = (): boolean | undefined => readPolicy()?.wholeDiskEnabled;
    const currentScheduledPolicyKey = () => {
        const policy = readPolicy();
        return readWholeDiskEnabled() === true && policy?.scheduledScan
            ? JSON.stringify(policy.scheduledScan) : undefined;
    };
    let items: readonly SizedStorageCategoryItem[] = [];
    let sizedTrashEntries: Awaited<ReturnType<typeof operations.trashEntries>> = [];
    // Same event-invalidated observation as sizes; only its presentation window
    // crosses summary RPC/watch. Keep all rows for fresh actor filtering/backfill.
    let suggestions: readonly StorageItemV1[] = [];
    type Operation = { controller: AbortController; readers: number; background: boolean; done: Promise<HappierStorageSummaryV1> };
    let pending: Operation | null = null;
    let measurementError: string | undefined;
    const abortError = () => Object.assign(new Error('Storage request cancelled'), { name: 'AbortError' });
    const notify = () => { for (const listener of listeners) listener(); };
    const invalidate = () => { if (disposed) return; dirty = true; revision += 1; notify(); };
    const reconcileScans = () => {
        if (!scanOwner || disposed) return;
        const key = JSON.stringify([readWholeDiskEnabled(), deps.readVolumesReported?.() ?? true,
            deps.readVolumes().map(volume => [volume.id, volume.mount]).sort()]);
        if (scanLifecycleKey === key) return;
        scanLifecycleKey = key;
        const owner = scanOwner;
        scanLifecycle = scanLifecycle.catch(() => {}).then(async () => {
            const current = await owner;
            assertActive();
            await current.runner.initialize();
        });
        void scanLifecycle.catch(error => {
            scanLifecycleKey = undefined;
            deps.maintenance?.onError(error);
        });
    };
    const unsubscribe = deps.subscribeChanges?.(() => { invalidate(); reconcileScans(); });
    // Policy edges change availability, protection and retention verdicts.
    const unsubscribePolicy = subscribePolicy(() => { invalidate(); reconcileScans(); });
    const unsubscribeWorktrees = scmWorktreeMutationActivity.subscribe(invalidate);
    const assertActive = (signal?: AbortSignal) => { if (disposed || signal?.aborted) throw abortError(); };
    async function scans() {
        assertActive();
        if (!scanOwner) {
            scanOwner = (async () => {
                const [{ createStorageScanRunner }, { createStorageScanIndex }] = await Promise.all([
                    import('./scan/scanRunner'), import('./scan/scanIndex'),
                ]);
                assertActive();
                const index = createStorageScanIndex({ activeServerDir: deps.catalog.activeServerDir, nowMs: deps.nowMs });
                const runner = createStorageScanRunner({ index,
                    readVolumes: () => deps.readVolumes().map(volume => ({ id: volume.id, mountPath: volume.mount,
                        usedBytes: Math.max(0, volume.totalBytes - volume.availableBytes),
                        reservedBytes: volume.reservedBytes, apfsContainerId: volume.apfsContainerId })),
                    readEnabled: readWholeDiskEnabled,
                    readVolumesReported: deps.readVolumesReported,
                    readLowPower: deps.readLowPower,
                    readScanHints: async root => {
                        const [environment, projects, worktrees] = await Promise.all([deps.readStorageProtectionFacts?.(),
                            deps.catalog.readProjects?.(), deps.catalog.readWorktrees?.()]);
                        return readStorageScanHints({ root, repositoryRoots: [...new Set([
                            ...(projects?.projects?.map(project => project.repositoryRoot) ?? []),
                            ...(worktrees?.map(worktree => worktree.path) ?? []),
                        ])], facts: { protection: { ...environment, homeDir: deps.homeDir ?? homedir() }, now: now(),
                            suggestUnusedAfterDays: requirePolicy().suggestUnusedAfterDays,
                            readIgnoredPaths: repositoryRoot => readRepositoryIgnoredPaths({ repositoryRoot,
                                happyHomeDir: deps.catalog.happyHomeDir, registry: deps.scmRegistry }) } });
                    },
                    fullDiskAccess: () => ({ state: process.platform === 'darwin' ? 'unknown' : 'not_applicable',
                        binary: { name: 'processcustody', path: resolveProcessCustodySupportExecutable() ?? '' } }),
                    onChange: () => { if (!disposed) { revision += 1; notify(); } },
                    onCompleted: invalidate,
                    beforeScheduledEffect: async () => {
                        const blocked = () => Object.assign(new Error('Scheduled scan awaiting current policy, idle or power'),
                            { code: 'scheduled_scan_blocked' });
                        if (disposed || scheduledPolicyKey === undefined || scheduledPolicyKey !== currentScheduledPolicyKey()) throw blocked();
                        const idle = await (deps.canRunStorageOwnerOperation?.() ?? deps.maintenance?.isIdle() ?? false);
                        if (disposed || !idle || !deps.maintenance?.isOnPower()
                            || scheduledPolicyKey === undefined || scheduledPolicyKey !== currentScheduledPolicyKey()) throw blocked();
                    },
                    onScheduledError: error => deps.maintenance?.onError(error),
                });
                if (disposed) { await runner.dispose(); throw abortError(); }
                if (deps.maintenance) {
                    const resume = () => { if (!disposed) runner.resumeScheduled(); };
                    const policyChanged = () => {
                        if (disposed) return;
                        if (scheduledPolicyKey !== currentScheduledPolicyKey()) {
                            scheduledPolicyKey = undefined;
                            runner.clearScheduled();
                        }
                    };
                    scheduledSubscriptions.push(deps.maintenance.subscribeIdle(resume),
                        deps.maintenance.subscribePower(resume), subscribePolicy(policyChanged));
                }
                return { index, runner };
            })();
            void scanOwner.catch(() => { scanOwner = undefined; });
        }
        const owner = await timeWebLatencyPhase('storage.scans.owner', () => scanOwner!);
        reconcileScans();
        await timeWebLatencyPhase('storage.scans.lifecycle', () => scanLifecycle);
        assertActive();
        return owner;
    }
    async function assertScanActor(actor: StorageOperationActor, signal?: AbortSignal) {
        assertActive(signal); await actor.assertCurrent(); assertActive(signal);
        if (actor.sessionIds !== undefined) {
            throw Object.assign(new Error('Storage scan access denied'), { code: 'unauthorized' });
        }
    }
    async function assertScanAuthority(actor: StorageOperationActor, signal?: AbortSignal) {
        await assertScanActor(actor, signal);
        await actor.assertCurrentAuthority();
        assertActive(signal);
    }
    const emptySize = (): StorageSizeV1 => ({ allocatedBytes: 0, freesBytes: 0, sharedBytes: 0,
        sharedExtentsUnmeasured: false, atLeast: false });
    const sizeOf = (measured: NativeDiskMeasurement['perPath'][number]): StorageSizeV1 => ({
        allocatedBytes: measured.allocatedBytes, freesBytes: measured.exclusiveBytes, sharedBytes: measured.sharedBytes,
        sharedExtentsUnmeasured: measured.sharedExtentsUnmeasured, atLeast: measured.atLeast,
        ...(measured.freesUpToBytes !== undefined ? { freesUpToBytes: measured.freesUpToBytes } : {}),
    });
    const sumSizes = (members: readonly Pick<StorageItemV1, 'size'>[]): StorageSizeV1 => members.reduce((sum, item) => ({
        allocatedBytes: sum.allocatedBytes + item.size.allocatedBytes,
        freesBytes: sum.freesBytes + item.size.freesBytes,
        sharedBytes: sum.sharedBytes + item.size.sharedBytes,
        atLeast: sum.atLeast || item.size.atLeast,
        sharedExtentsUnmeasured: sum.sharedExtentsUnmeasured || item.size.sharedExtentsUnmeasured,
        ...(sum.freesUpToBytes !== undefined || item.size.freesUpToBytes !== undefined
            ? { freesUpToBytes: (sum.freesUpToBytes ?? sum.freesBytes) + (item.size.freesUpToBytes ?? item.size.freesBytes) } : {}),
    }), emptySize());
    const canGo = (item: StorageItemV1) => item.collectable && (item.verdict === 'safe' || item.verdict === 'caution');

    async function measure(signal: AbortSignal, measuredRevision: number): Promise<HappierStorageSummaryV1> {
        const cleanupVolumes = new Map((await timeWebLatencyPhase('storage.summary.prepare', () => operations.prepareRead()))
            .map(volume => [volume.volumeId, volume.cleanup]));
        // Catalog, protection and recognition describe this same sizing operation.
        // Later actor/effect reads acquire current protection independently,
        // including after slow sizing. Vitals publishes capacity independently.
        const inUse = await timeWebLatencyPhase('storage.facts.in-use', () => deps.catalog.readInUsePaths?.()
            ?? { reliable: false, paths: [] });
        const discovery = await timeWebLatencyPhase('storage.summary.catalog', () => catalog.discoverSnapshot([], inUse));
        // Denied ancestry remains in the catalog's protection facts. It is not
        // a readable sizing candidate and must not be probed again here.
        const candidates = discovery.items.filter(item => item.evidence.length !== 1 || item.evidence[0] !== 'directory_permission_unavailable');
        const incompleteCategories = new Set(discovery.incompleteCategoryIds);
        const incomplete = [...(discovery.incomplete ?? [])];
        assertActive(signal);
        const projected = await timeWebLatencyPhase('storage.summary.projection', () => operations.projectCatalogItems(candidates.map(item => ({ ...item, size: emptySize() })), inUse));
        const volumeFacts = deps.readVolumes();
        const volumeFor = (path: string) => storageVolumeForPath(volumeFacts, path);
        // The recognizer/protection owners decide eligible sets before native sizing.
        // Missing native facts remove that root from the union rather than granting eligibility.
        const provisionalSuggestions = await timeWebLatencyPhase('storage.summary.provisional-suggestions', () => operations.readSuggestionInventory(projected, inUse));
        const unions = [
            ...catalog.categoryIds.map(categoryId => ({ id: `category:${categoryId}`,
                paths: projected.filter(item => item.categoryId === categoryId && canGo(item)).map(item => item.path), excludeIncomplete: true })),
            ...volumeFacts.map(volume => ({ id: `volume:${volume.id}`, paths: provisionalSuggestions.filter(item =>
                item.verdict === 'safe' && volumeFor(item.path)?.id === volume.id).map(item => item.path), excludeIncomplete: true })),
        ];
        const paths = [...new Set(projected.map(item => item.path))];
        const measured = paths.length || unions.some(union => union.paths.length) ? await timeWebLatencyPhase('storage.summary.measure-native', () => measureNativeDisk({ paths, unions }, { signal }))
            : { v: 1 as const, perPath: [], totalAllocatedBytes: 0, totalExclusiveBytes: 0 };
        assertActive(signal);
        const byPath = new Map(measured.perPath.map(path => [path.path, path]));
        const unionById = new Map(('unions' in measured ? measured.unions : undefined)?.map(union => [union.id, union]));
        const trashEntries = await timeWebLatencyPhase('storage.summary.trash', () => operations.trashEntries(undefined, () => {
            incompleteCategories.add('trash');
            if (!incomplete.some(issue => issue.categoryId === 'trash')) incomplete.push(storagePermissionReadIssue('trash'));
        }));
        const nextItems = projected.map(item => {
            const value = byPath.get(item.path);
            const measuredSize = value ? sizeOf(value) : { ...emptySize(), atLeast: true };
            // Trash manifests own retained payload sizes; root directories and
            // receipt files do not become bytes returned by emptying the Trash.
            const retainedTrashSize = item.categoryId === 'trash'
                ? sumSizes(trashEntries.filter(entry => entry.volumeId === volumeFor(item.path)?.id)) : undefined;
            const size = retainedTrashSize ? { ...retainedTrashSize, atLeast: retainedTrashSize.atLeast || measuredSize.atLeast } : measuredSize;
            // Missing/partial measurement is never positive evidence that an item can go.
            return { ...item, size, ...(item.lastChangedAt === undefined && value?.lastChangedAtMs !== undefined
                ? { lastChangedAt: value.lastChangedAtMs } : {}), ...(size.atLeast && item.verdict !== 'forbidden'
                ? { verdict: 'check' as const, reason: { code: 'facts_unavailable' as const }, collectable: false } : {}) };
        });
        const categories = catalog.categoryIds.map(categoryId => {
            const members = nextItems.filter(item => item.categoryId === categoryId);
            const eligible = members.filter(canGo);
            // Hard links across two collectable items are reclaimable only as their union.
            const eligibleMeasurement = unionById.get(`category:${categoryId}`);
            const size = sumSizes(members);
            if (incompleteCategories.has(categoryId)) size.atLeast = true;
            if (eligibleMeasurement?.atLeast) size.atLeast = true;
            const facts = { categoryId, size, canGoBytes: eligibleMeasurement?.totalExclusiveBytes ?? 0,
                count: categoryId === 'trash' ? trashEntries.length : members.length, detailFacts: { canGoCount: eligible.length,
                    keepCount: members.filter(item => item.verdict === 'keep').length,
                    factsReported: !incompleteCategories.has(categoryId) } };
            const previous = cached?.categories.find(category => category.categoryId === categoryId);
            const detailItems = (rows: readonly SizedStorageCategoryItem[]) => rows.map(item => ({
                item: publicStorageItem(item), group: item.categoryGroup,
            }));
            // Compare only when the catalog is measured, never on scan progress arrivals.
            const unchanged = previous && isDeepStrictEqual({ ...previous, revision: undefined }, { ...facts, revision: undefined })
                && isDeepStrictEqual(detailItems(items.filter(item => item.categoryId === categoryId)), detailItems(members))
                && (categoryId !== 'trash' || isDeepStrictEqual(sizedTrashEntries, trashEntries));
            return { ...facts, revision: unchanged ? previous.revision : measuredRevision };
        });
        assertActive(signal);
        const byVolume = new Map<string, number>();
        for (const item of nextItems) {
            const volume = volumeFor(item.path);
            if (volume) byVolume.set(volume.id, (byVolume.get(volume.id) ?? 0) + item.size.allocatedBytes);
        }
        const trash = categories.find(category => category.categoryId === 'trash');
        const nextSuggestions = await timeWebLatencyPhase('storage.summary.suggestions', () => operations.readSuggestionInventory(nextItems, inUse));
        const [environment, projects] = await Promise.all([
            timeWebLatencyPhase('storage.summary.environment', () => deps.readStorageProtectionFacts?.()), deps.catalog.readProjects?.(),
        ]);
        const scanShortcuts = await resolveStorageScanShortcuts({ protection: { ...environment, homeDir: deps.homeDir ?? homedir() } }, [
            ...(projects?.projects ?? []).map(project => project.repositoryRoot),
            ...(deps.catalog.readTrackedSessions?.() ?? []).map(session => session.cwd),
        ]);
        const result: HappierStorageSummaryV1 = {
            revision: dirty ? measuredRevision : Math.max(measuredRevision, revision), sizedAt: now(),
            ...(incomplete.length ? { incomplete } : {}),
            scanShortcuts,
            volumes: volumeFacts.map(volume => ({ volume: { volumeId: volume.id, label: volume.label, mountPath: volume.mount },
                ...(cleanupVolumes.has(volume.id) ? { cleanup: cleanupVolumes.get(volume.id)! } : {}),
                totalBytes: volume.totalBytes, freeBytes: volume.availableBytes, happierBytes: byVolume.get(volume.id) ?? 0,
                ...(volume.availableIncludingPurgeableBytes === undefined ? {} : { availableIncludingPurgeableBytes: volume.availableIncludingPurgeableBytes }),
                canGoBytes: unionById.get(`volume:${volume.id}`)?.totalExclusiveBytes ?? 0,
                pileBytes: 0, pileFreesBytes: 0,
                trashFreesBytes: nextItems.filter(item => item.categoryId === 'trash' && volumeFor(item.path)?.id === volume.id)
                    .reduce((sum, item) => sum + item.size.freesBytes, 0),
                trashBytes: nextItems.filter(item => item.categoryId === 'trash' && volumeFor(item.path)?.id === volume.id)
                    .reduce((sum, item) => sum + item.size.allocatedBytes, 0) })),
            categories, ...operations.projectSummarySuggestions(nextSuggestions),
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] },
            trash: { count: trash?.count ?? 0, allocatedBytes: trash?.size.allocatedBytes ?? 0 },
            wholeDisk: { enabled: readWholeDiskEnabled() === true,
                scans: scanOwner ? (await timeWebLatencyPhase('storage.summary.scan-state', () => scanOwner!)).index.states() : [] },
        };
        // Cancellation or owner retirement cannot replace the last-known-good snapshot.
        assertActive(signal);
        items = nextItems;
        sizedTrashEntries = trashEntries;
        suggestions = nextSuggestions;
        cached = result;
        return result;
    }

    function begin(): Operation {
        if (pending && !pending.controller.signal.aborted) return pending;
        const controller = new AbortController();
        controllers.add(controller);
        dirty = false;
        measurementError = undefined;
        const measuredRevision = ++revision;
        const operation: Operation = { controller, readers: 0, background: false,
            done: measure(controller.signal, measuredRevision).catch(error => {
                if (pending === operation) {
                    if (controller.signal.aborted) dirty = true;
                    // Summary is also shared with Use recipients; native errors
                    // can contain private owner paths and stay out of this fact.
                    else measurementError = 'Storage measurement failed';
                }
                throw error;
            }).finally(() => {
                controllers.delete(controller);
                if (pending === operation) {
                    pending = null;
                    if (!disposed) { revision += 1; notify(); }
                }
            }),
        };
        pending = operation;
        return operation;
    }
    async function join(operation: Operation, signal?: AbortSignal): Promise<HappierStorageSummaryV1> {
        assertActive(signal);
        operation.readers += 1;
        return await new Promise<HappierStorageSummaryV1>((resolve, reject) => {
            let settled = false;
            const finish = (complete: () => void) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                operation.readers -= 1;
                complete();
            };
            const onAbort = () => finish(() => {
                if (operation.readers !== 0 || operation.background) { reject(abortError()); return; }
                operation.controller.abort();
                // The last reader owns native retirement; do not report its cancellation
                // before the helper's close/settlement has reached the existing adapter.
                void operation.done.then(() => reject(abortError()), () => reject(abortError()));
            });
            signal?.addEventListener('abort', onAbort, { once: true });
            operation.done.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
            if (signal?.aborted) onAbort();
        });
    }
    async function readMeasured(signal?: AbortSignal): Promise<void> {
        if (!cached || dirty || pending || measurementError !== undefined) await join(begin(), signal);
    }
    async function summary(options: Readonly<{ signal?: AbortSignal; actor?: StorageOperationActor; context?: ActionExecutorContext }> = {}): Promise<HappierStorageSummaryV1> {
        assertActive(options.signal);
        requirePolicy();
        if (dirty || pending) {
            const operation = begin();
            operation.background = true;
            // Reads own demand, not the measurement's lifetime. The service keeps
            // it alive until settlement or disposal, even if this reader leaves.
            void operation.done.catch(() => {});
        }
        // Explicit demand may read Docker or initialize scan state. Capture the
        // measurement and its cursor together after those asynchronous reads.
        if (options.context && options.actor) {
            docker = deps.readDockerStorage ? await deps.readDockerStorage({ actor: options.actor, context: options.context })
                : { kind: 'unavailable', reason: 'native_runtime_unavailable' };
        }
        const scanStates = scanOwner ? [...(await timeWebLatencyPhase('storage.summary.scans', scans)).index.states()] : [];
        assertActive(options.signal);
        const measured: HappierStorageSummaryV1 = cached ?? {
            revision, sizedAt: 0, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] },
            trash: { count: 0, allocatedBytes: 0 },
            wholeDisk: { enabled: readWholeDiskEnabled() === true, scans: [] },
        };
        const measurement: NonNullable<HappierStorageSummaryV1['measurement']> = pending || dirty
            ? { status: 'measuring', hasMeasured: cached !== null }
            : measurementError !== undefined ? { status: 'failed', hasMeasured: cached !== null, error: measurementError }
                : { status: 'ready' };
        // One-shot Action reads join the current capacity from Vitals without
        // publishing a Storage revision or measuring any Storage tree.
        const capacity = new Map(deps.readVolumes().map(volume => [volume.id, volume]));
        const current = { ...measured, measurement, ...(docker ? { docker } : {}), revision, wholeDisk: {
            enabled: readWholeDiskEnabled() === true,
            scans: scanStates,
        }, volumes: measured.volumes.map(volume => {
            const latest = capacity.get(volume.volume.volumeId);
            if (!latest) return volume;
            const { availableIncludingPurgeableBytes: _previousPurgeable, ...facts } = volume;
            return { ...facts, totalBytes: latest.totalBytes, freeBytes: latest.availableBytes,
                ...(latest.availableIncludingPurgeableBytes === undefined ? {} : { availableIncludingPurgeableBytes: latest.availableIncludingPurgeableBytes }) };
        }) };
        requirePolicy();
        return options.actor ? timeWebLatencyPhase('storage.summary.actor-projection', () => operations.summaryForActor(current, options.actor!, items, suggestions)) : current;
    }
    const readCompletedStorageScan: NonNullable<StorageServiceDeps['readCompletedStorageScan']> = deps.readCompletedStorageScan ?? (async inUse => {
        if (readWholeDiskEnabled() !== true) return null;
        const owner = await scans();
        if (!deps.readVolumes().some(volume => owner.index.hasWholeDiskCoverage(volume.id))) return null;
        const [projects, use, protection] = await Promise.all([
            deps.catalog.readProjects?.(), inUse ?? deps.catalog.readInUsePaths?.(), deps.readStorageProtectionFacts?.(),
        ]);
        const contains = storagePathContains;
        function* candidates() {
            for (const value of owner.index.iterateWholeDiskCandidates()) {
                const { repositoryRoot, repositoryInUse } = storageCandidateRepositoryFacts(value.path,
                    projects?.projects?.map(project => project.repositoryRoot) ?? [], use);
                const browserProfileRoot = protection?.browserProfileRoots?.find(root => contains(root, value.path));
                yield { nodeId: value.node.nodeId, path: value.path, kind: value.node.kind, size: value.node.size,
                    lastChangedAt: value.node.changedAt, repositoryRoot, repositoryInUse, browserProfileRoot };
            }
        }
        return { status: 'complete' as const, scope: 'whole-disk' as const, candidates: candidates() };
    });
    const operations = createStorageOperations({ readPolicy: requirePolicy, deps: { ...deps, readCompletedStorageScan,
        readIndexedStorageItem: deps.readIndexedStorageItem ?? (async ref => (await scans()).index.readNode(ref.itemId) ?? null) }, catalog, revision: () => revision, invalidate,
        setTrashRoots: paths => { currentTrashRoots = paths; },
        readSizedItems: async signal => { await readMeasured(signal); return items; },
        readIncomplete: () => cached?.incomplete ?? [],
    });
    const protectedFolders = createStorageProtectedFolders({ resourcesPolicy: deps.resourcesPolicy,
        readProtectionFacts: operations.readProtectionFacts });
    const maintenance = deps.maintenance ? createStorageMaintenance({ ...deps.maintenance,
        readPolicy, subscribePolicy,
        getTrashStore: operations.maintenanceTrash,
        runScheduledScan: async () => {
            const key = currentScheduledPolicyKey();
            if (key === undefined) return;
            const owner = await scans();
            if (disposed || key !== currentScheduledPolicyKey()) return;
            scheduledPolicyKey = key;
            await owner.runner.scheduleVolumes(deps.readVolumes().map(volume => volume.id));
        },
    }) : undefined;
    return {
        ...operations,
        capacityForPath: (path: string) => readStoragePathCapacity(path, deps),
        protectedAdd: protectedFolders.add,
        protectedRemove: protectedFolders.remove,
        async initialize() { await scans(); await maintenance?.start(); },
        async scanStart(request: MachineStorageScanStartInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            await assertScanActor(options.actor, options.signal);
            requirePolicy();
            if (readWholeDiskEnabled() !== true) throw Object.assign(new Error('Whole-disk scan disabled'), { code: 'storage_whole_disk_disabled' });
            const owner = await scans();
            await assertScanActor(options.actor, options.signal);
            requirePolicy();
            return owner.runner.start(request, { beforeEffect: async () => { await assertScanAuthority(options.actor, options.signal); requirePolicy(); } });
        },
        async scanGet(request: MachineStorageScanGetInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            await timeWebLatencyPhase('storage.page.actor', () => assertScanActor(options.actor, options.signal));
            requirePolicy();
            const owner = await timeWebLatencyPhase('storage.page.scans', scans);
            const result = await timeWebLatencyPhase('storage.page.snapshot', () => owner.runner.get(request, { beforeEffect: async () => { await assertScanAuthority(options.actor, options.signal); requirePolicy(); } }));
            const pageNodes = [...(result.root ? [result.root] : []), ...result.nodes, ...(result.insights ? [
                ...result.insights.largestDistinct, ...result.insights.changes.grew,
                ...result.insights.changes.shrank, ...result.insights.changes.appeared,
                ...result.insights.changes.disappeared,
            ] : [])];
            const projected = new Map((await timeWebLatencyPhase('storage.page.projection', () => operations.projectDiskNodes(pageNodes))).map(node => [node.nodeId, node]));
            const project = (nodes: typeof result.nodes) => nodes.map(node => projected.get(node.nodeId) ?? node);
            const nodes = project(result.nodes);
            const target = result.state?.target;
            const insightVolume = target && ('volumeId' in target ? target.volumeId
                : storageVolumeForPath(deps.readVolumes(), target.folderPath)?.id);
            const incomplete: StorageReadIssueV1[] = [];
            const insights = result.insights ? { ...result.insights,
                largestDistinct: project(result.insights.largestDistinct),
                trashBytes: insightVolume === undefined ? 0 : (await timeWebLatencyPhase('storage.page.trash', () => operations.trashEntries(undefined, () => {
                    if (!incomplete.length) incomplete.push(storagePermissionReadIssue('trash'));
                }, { volumeId: insightVolume })))
                    .reduce((total, entry) => total + entry.size.allocatedBytes, 0),
                changes: {
                    grew: project(result.insights.changes.grew),
                    shrank: project(result.insights.changes.shrank),
                    appeared: project(result.insights.changes.appeared),
                    disappeared: project(result.insights.changes.disappeared),
                },
            } : undefined;
            await timeWebLatencyPhase('storage.page.disclosure', () => assertScanActor(options.actor, options.signal));
            requirePolicy();
            return { ...result, nodes, ...(result.root ? { root: projected.get(result.root.nodeId) ?? result.root } : {}),
                ...(insights ? { insights } : {}), ...(incomplete.length ? { incomplete } : {}) };
        },
        async scanCancel(request: MachineStorageScanCancelInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            logger.infoFile('[storage-scan] cancel-service-entry', { scanId: request.scanId, atMs: Date.now() });
            await assertScanActor(options.actor, options.signal);
            // Stopping an existing run does not depend on discovery/retention
            // for newly reported volumes. Keep current authority at the effect.
            const owner = await (scanOwner ?? scans());
            logger.infoFile('[storage-scan] cancel-owner-ready', { scanId: request.scanId, atMs: Date.now() });
            await assertScanAuthority(options.actor, options.signal);
            logger.infoFile('[storage-scan] cancel-authority-ready', { scanId: request.scanId, atMs: Date.now() });
            const result = await owner.runner.cancel(request.scanId);
            if (!result) throw Object.assign(new Error('Scan unavailable'), { code: 'storage_scan_unavailable' });
            return result;
        },
        async scanSkip(request: MachineStorageScanSkipInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            await assertScanActor(options.actor, options.signal);
            requirePolicy();
            const owner = await scans();
            await assertScanAuthority(options.actor, options.signal);
            requirePolicy();
            const result = await owner.runner.skip(request.scanId, request.path);
            if (!result) throw Object.assign(new Error('Scan unavailable'), { code: 'storage_scan_unavailable' });
            return result;
        },
        async initializeScans() { await scans(); },
        summary,
        async categoryList(categoryId: HappierStorageCategoryIdV1, options: Readonly<{
            actor?: StorageOperationActor; signal?: AbortSignal; cursor?: string; sessionIds?: ReadonlySet<string>;
            assertCurrent?: () => Promise<void>;
        }> = {}): Promise<MachineStorageCategoryListResultV1> {
            if (options.cursor) throw Object.assign(new Error('Unknown storage cursor'), { code: 'invalid_storage_cursor' });
            if (categoryId === 'trash') {
                assertActive(options.signal);
                // The Trash owner already measured each manifest when it moved
                // the payload. Reading its current entries needs no catalog scan.
                const incomplete: StorageReadIssueV1[] = [];
                const trashEntries = await operations.trashEntries(options.actor, () => {
                    if (!incomplete.length) incomplete.push(storagePermissionReadIssue('trash'));
                });
                assertActive(options.signal);
                if (!options.actor) await options.assertCurrent?.();
                assertActive(options.signal);
                return { categoryId, revision, sizedAt: now(),
                    ...(incomplete.length ? { incomplete } : {}),
                    trashEntries, items: trashEntries.map(entry => ({ itemId: entry.entryId, kind: 'category-item', categoryId: 'trash',
                        path: entry.originalPath, title: entry.title, size: entry.size, lastChangedAt: entry.movedAt,
                        evidence: ['trash_entry'], verdict: 'safe', reason: { code: 'old' }, collectable: false })) };
            }
            await readMeasured(options.signal);
            const current = await summary({ signal: options.signal });
            // The admitted caller's readonly Session scope filters the snapshot;
            // keep local lifetime checks before stripping its private bindings.
            await options.assertCurrent?.();
            requirePolicy();
            const visible = items.filter(item => item.categoryId === categoryId && (options.sessionIds === undefined
                || item.sessionId !== undefined && options.sessionIds.has(item.sessionId)));
            const groups = new Map<StorageCategoryGroupV1['id'], StorageCategoryGroupV1>();
            for (const item of visible) {
                if (!item.categoryGroup) continue;
                const group = groups.get(item.categoryGroup.id) ?? { ...item.categoryGroup, itemIds: [] };
                group.itemIds.push(item.itemId); groups.set(group.id, group);
            }
            const order: StorageCategoryGroupV1['id'][] = ['stopped', 'old', 'recent'];
            const incomplete = current.incomplete?.filter(issue => issue.categoryId === categoryId);
            return { categoryId, revision: current.revision, sizedAt: current.sizedAt,
                ...(incomplete?.length ? { incomplete } : {}),
                items: visible.map(publicStorageItem),
                ...(groups.size ? { groups: [...groups.values()].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id)) } : {}) };
        },
        async refresh(options: Readonly<{ categoryId?: HappierStorageCategoryIdV1; signal?: AbortSignal; actor?: StorageOperationActor; context?: ActionExecutorContext }> = {}) {
            assertActive(options.signal);
            requirePolicy();
            await options.actor?.assertCurrentAuthority();
            assertActive(options.signal);
            // Rebuild the native union: a changed category can share inodes with any other category.
            await join(begin(), options.signal);
            requirePolicy();
            return summary(options);
        },
        revision: () => revision,
        async dockerPrune(request: MachineStorageDockerPruneInputV1, options: Readonly<{
            actor: StorageOperationActor; context: ActionExecutorContext;
        }>) {
            assertActive(options.context.signal);
            requirePolicy();
            await options.actor.assertCurrentAuthority();
            assertActive(options.context.signal);
            if (!deps.dockerPrune) return { kind: 'unsupported' as const, reason: 'native_runtime_unavailable' as const, removed: [], kept: [] };
            const result = await deps.dockerPrune(request, options);
            if (result.removed.length) invalidate();
            return result;
        },
        subscribe(listener: () => void) { assertActive(); listeners.add(listener); return () => { listeners.delete(listener); }; },
        invalidate,
        dispose() { if (disposed) return; disposed = true; operations.dispose(); unsubscribe?.(); unsubscribePolicy(); unsubscribeWorktrees();
            maintenance?.stop();
            for (const release of scheduledSubscriptions) release();
            if (scanOwner) void scanOwner.then(owner => owner.runner.dispose(), () => {});
            for (const controller of controllers) controller.abort(); listeners.clear(); },
    };
}

export type StorageService = ReturnType<typeof createStorageService>;
