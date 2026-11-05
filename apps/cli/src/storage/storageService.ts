import { HappierStorageSummaryV1Schema, MachineStorageCategoryListResultV1Schema,
    type HappierStorageSummaryV1, type HappierStorageCategoryIdV1, type MachineStorageCategoryListResultV1,
    type StorageSizeV1, type StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { canonicalAbsolutePathsEqual, isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';
import { createStorageCategoryCatalog, publicStorageItem, type StorageCategoryCatalogDeps, type StorageCategoryItem, type StorageCategoryDiscoverySnapshot } from './categoryCatalog';
import { measureNativeDisk, type NativeDiskMeasurement } from './measure/nativeDiskMeasure';
import type { ActivityLog } from '@/daemon/guard/activityLog';
import type { MachineStoragePolicyV1 } from '@happier-dev/protocol/storage/storageV1';
import type { MachineGuardActivityEntryV1 } from '@happier-dev/protocol/machines/guard/activityV1';
import { createStorageOperations } from './storageOperations';
import type { StorageProtectionFacts } from './protection/protectedPaths';
import { readStorageScanHints, resolveStorageScanShortcuts, storageCandidateRepositoryFacts, type CompletedStorageSuggestionScan } from './suggestions/recognizers';
import { readStorageIgnoredPaths } from './worktrees/readStorageIgnoredPaths';
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
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { MachineStorageDockerPruneInputV1 } from '@happier-dev/protocol/storage/storageV1';
import type { createStorageDockerPruneForHost } from './dockerPrune';

export type StorageEnvironmentProtectionFacts = Pick<StorageProtectionFacts,
    'platform' | 'systemPaths' | 'personalFolders' | 'knownFolders' | 'env' | 'browserProfileRoots' | 'cloudSyncedFolders'>;

/** Admission is stamped by the RPC owner, never reconstructed from Action input. */
export type StorageOperationActor = Readonly<{
    accountId: string;
    kind: 'person' | 'agent';
    custodianAccountId: string;
    /** Absent for admitted Machine Manage; Use is limited to these requester-owned Sessions. */
    sessionIds?: ReadonlySet<string>;
    /** Target/lifetime checks and current Session custody, without Machine admission verification. */
    assertCurrent(): Promise<void>;
    assertCurrentAuthority(): Promise<void>;
}>;

export type StorageServiceDeps = Readonly<{
    dockerPrune?: ReturnType<typeof createStorageDockerPruneForHost>;
    catalog: StorageCategoryCatalogDeps;
    readVolumes: () => readonly Readonly<{ id: string; label: string; mount: string; totalBytes: number; availableBytes: number;
        reservedBytes?: number; apfsContainerId?: string; availableIncludingPurgeableBytes?: number }>[];
    readVolumesReported?: () => boolean;
    subscribeChanges?: (listener: () => void) => () => void;
    subscribeVolumeChanges?: (listener: () => void) => () => void;
    nowMs?: () => number;
    machineId?: string;
    serverId?: string;
    custodianAccountId?: string;
    homeDir?: string;
    activityLog?: ActivityLog;
    readPolicy?: () => MachineStoragePolicyV1;
    resourcesPolicy?: Pick<MachineResourcesPolicyRuntime, 'read' | 'set' | 'subscribe'>;
    canRunStorageOwnerOperation?: () => boolean | Promise<boolean>;
    readLowPower?: () => boolean;
    readIndexedStorageItem?: (ref: StorageItemRefV1) => Promise<TrustedDiskNode | null>;
    maintenance?: Omit<StorageMaintenanceDeps, 'readPolicy' | 'getTrashStore' | 'runScheduledScan'>;
    attributionFor?: (accountId: string) => MachineGuardActivityEntryV1['attribution'];
    /** Existing OS/browser owners supply facts; this service performs no environment discovery. */
    readStorageProtectionFacts?: () => StorageEnvironmentProtectionFacts | Promise<StorageEnvironmentProtectionFacts>;
    /** EU7's completed whole-disk index is the only outside-Happier candidate producer. */
    readCompletedStorageScan?: (inUse?: StoragePathUse) => Promise<CompletedStorageSuggestionScan | null>;
    /** Omitted in the daemon, where the canonical applied-runtime lease supplies SCM. */
    scmRegistry?: ScmBackendRegistry;
}>;

export function createStorageService(deps: StorageServiceDeps) {
    let currentTrashRoots: readonly string[] = [];
    const catalog = createStorageCategoryCatalog({ ...deps.catalog, scmRegistry: deps.scmRegistry ?? deps.catalog.scmRegistry,
        trashRoots: () => currentTrashRoots.length ? currentTrashRoots
        : deps.catalog.trashRoots?.() ?? [] });
    const now = deps.nowMs ?? Date.now;
    const listeners = new Set<() => void>();
    const controllers = new Set<AbortController>();
    let disposed = false;
    let dirty = true;
    let revision = 0;
    let cached: HappierStorageSummaryV1 | null = null;
    // Discovery and sizing are two phases of the same event-invalidated storage
    // snapshot. Disk pages need its catalog facts, not a new sizing operation.
    let catalogSnapshot: Promise<StorageCategoryDiscoverySnapshot> | undefined;
    let scanOwner: Promise<Readonly<{ runner: StorageScanRunner; index: StorageScanIndex }>> | undefined;
    let scanLifecycleKey: string | undefined;
    let scanLifecycle: Promise<void> = Promise.resolve();
    let scheduledPolicyKey: string | undefined;
    const scheduledSubscriptions: (() => void)[] = [];
    const readWholeDiskEnabled = (): boolean | undefined => {
        // The daemon's presentation defaults cannot authorize deleting retained
        // scans before its canonical resources policy has loaded (or while locked).
        if (deps.resourcesPolicy) {
            const snapshot = deps.resourcesPolicy.read();
            return snapshot.status === 'ready' ? snapshot.policy.storage.wholeDiskEnabled : undefined;
        }
        return deps.readPolicy?.().wholeDiskEnabled;
    };
    const currentScheduledPolicyKey = () => {
        const policy = deps.readPolicy?.();
        return readWholeDiskEnabled() === true && policy?.scheduledScan
            ? JSON.stringify(policy.scheduledScan) : undefined;
    };
    let items: readonly SizedStorageCategoryItem[] = [];
    type Operation = { controller: AbortController; readers: number; done: Promise<HappierStorageSummaryV1> };
    let pending: Operation | null = null;
    const abortError = () => Object.assign(new Error('Storage request cancelled'), { name: 'AbortError' });
    const notify = () => { for (const listener of listeners) listener(); };
    const invalidate = () => { if (disposed) return; dirty = true; catalogSnapshot = undefined; revision += 1; notify(); };
    function readCatalogSnapshot(inUse?: StoragePathUse): Promise<StorageCategoryDiscoverySnapshot> {
        if (catalogSnapshot) return catalogSnapshot;
        const snapshot = catalog.discoverSnapshot([], inUse);
        catalogSnapshot = snapshot;
        void snapshot.catch(() => { if (catalogSnapshot === snapshot) catalogSnapshot = undefined; });
        return snapshot;
    }
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
    const unsubscribeWorktrees = scmWorktreeMutationActivity.subscribe(invalidate);
    const unsubscribeVolumes = deps.subscribeVolumeChanges?.(() => {
        reconcileScans();
        if (disposed || !cached) return;
        const previous = new Map(cached.volumes.map(volume => [volume.volume.volumeId, volume]));
        const volumes = deps.readVolumes().map(volume => ({
            volume: { volumeId: volume.id, label: volume.label, mountPath: volume.mount },
            totalBytes: volume.totalBytes, freeBytes: volume.availableBytes,
            ...(volume.availableIncludingPurgeableBytes === undefined ? {} : { availableIncludingPurgeableBytes: volume.availableIncludingPurgeableBytes }),
            happierBytes: previous.get(volume.id)?.happierBytes ?? 0,
            pileBytes: previous.get(volume.id)?.pileBytes ?? 0,
            trashBytes: previous.get(volume.id)?.trashBytes ?? 0,
            ...(previous.get(volume.id)?.pileFreesBytes === undefined ? {} : { pileFreesBytes: previous.get(volume.id)!.pileFreesBytes }),
            ...(previous.get(volume.id)?.trashFreesBytes === undefined ? {} : { trashFreesBytes: previous.get(volume.id)!.trashFreesBytes }),
            ...(previous.get(volume.id)?.canGoBytes === undefined ? {} : { canGoBytes: previous.get(volume.id)!.canGoBytes }),
        }));
        if (JSON.stringify(volumes) === JSON.stringify(cached.volumes)) return;
        // Capacity is sampled by plan 20. Reusing that edge must not periodically resize trees.
        cached = { ...cached, revision: ++revision, volumes };
        notify();
    });
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
                            suggestUnusedAfterDays: deps.readPolicy?.().suggestUnusedAfterDays ?? 30,
                            readIgnoredPaths: repositoryRoot => readStorageIgnoredPaths({ repositoryRoot,
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
                        deps.maintenance.subscribePower(resume), deps.maintenance.subscribePolicy(policyChanged));
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
        await timeWebLatencyPhase('storage.summary.prepare', () => operations.prepareRead());
        // Catalog, protection and recognition describe this same sizing operation.
        // Discard its process observation on settlement; later actor/effect reads
        // acquire current protection independently, including after slow sizing.
        const inUse = await timeWebLatencyPhase('storage.facts.in-use', () => deps.catalog.readInUsePaths?.()
            ?? { reliable: false, paths: [] });
        const discovery = await timeWebLatencyPhase('storage.summary.catalog', () => readCatalogSnapshot(inUse));
        const candidates = discovery.items;
        const incompleteCategories = new Set(discovery.incompleteCategoryIds);
        assertActive(signal);
        const projected = await timeWebLatencyPhase('storage.summary.projection', () => operations.projectCatalogItems(candidates.map(item => ({ ...item, size: emptySize() })), inUse));
        const volumeFacts = deps.readVolumes();
        const volumeFor = (path: string) => volumeFacts.filter(volume => canonicalAbsolutePathsEqual(path, volume.mount)
            || isCanonicalAbsolutePathInsideRoot(volume.mount, path, { platform: process.platform }))
            .sort((left, right) => right.mount.length - left.mount.length)[0];
        // The recognizer/protection owners decide eligible sets before native sizing.
        // Missing native facts remove that root from the union rather than granting eligibility.
        const provisionalSuggestions = await timeWebLatencyPhase('storage.summary.provisional-suggestions', () => operations.summarySuggestions(projected, inUse));
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
        const trashEntries = await timeWebLatencyPhase('storage.summary.trash', () => operations.trashEntries());
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
            return { categoryId, size, canGoBytes: eligibleMeasurement?.totalExclusiveBytes ?? 0,
                count: members.length, detailFacts: { canGoCount: eligible.length,
                    keepCount: members.filter(item => item.verdict === 'keep').length,
                    factsReported: !incompleteCategories.has(categoryId) } };
        });
        assertActive(signal);
        const byVolume = new Map<string, number>();
        for (const item of nextItems) {
            const volume = volumeFor(item.path);
            if (volume) byVolume.set(volume.id, (byVolume.get(volume.id) ?? 0) + item.size.allocatedBytes);
        }
        const trash = categories.find(category => category.categoryId === 'trash');
        if (trash) trash.count = trashEntries.length;
        const suggestionsTop = await timeWebLatencyPhase('storage.summary.suggestions', () => operations.summarySuggestions(nextItems, inUse));
        const environment = await timeWebLatencyPhase('storage.summary.environment', () => deps.readStorageProtectionFacts?.());
        const result = HappierStorageSummaryV1Schema.parse({
            revision: dirty ? measuredRevision : Math.max(measuredRevision, revision), sizedAt: now(),
            scanShortcuts: resolveStorageScanShortcuts({ protection: { ...environment, homeDir: deps.homeDir ?? homedir() } }),
            volumes: volumeFacts.map(volume => ({ volume: { volumeId: volume.id, label: volume.label, mountPath: volume.mount },
                totalBytes: volume.totalBytes, freeBytes: volume.availableBytes, happierBytes: byVolume.get(volume.id) ?? 0,
                ...(volume.availableIncludingPurgeableBytes === undefined ? {} : { availableIncludingPurgeableBytes: volume.availableIncludingPurgeableBytes }),
                canGoBytes: unionById.get(`volume:${volume.id}`)?.totalExclusiveBytes ?? 0,
                pileBytes: 0, pileFreesBytes: 0,
                trashFreesBytes: nextItems.filter(item => item.categoryId === 'trash' && volumeFor(item.path)?.id === volume.id)
                    .reduce((sum, item) => sum + item.size.freesBytes, 0),
                trashBytes: nextItems.filter(item => item.categoryId === 'trash' && volumeFor(item.path)?.id === volume.id)
                    .reduce((sum, item) => sum + item.size.allocatedBytes, 0) })),
            categories, suggestionsTop,
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] },
            trash: { count: trash?.count ?? 0, allocatedBytes: trash?.size.allocatedBytes ?? 0 },
            wholeDisk: { enabled: readWholeDiskEnabled() === true,
                scans: scanOwner ? (await timeWebLatencyPhase('storage.summary.scan-state', () => scanOwner!)).index.states() : [] },
        });
        // Cancellation or owner retirement cannot replace the last-known-good snapshot.
        assertActive(signal);
        items = nextItems;
        cached = result;
        notify();
        return result;
    }

    function begin(): Operation {
        if (pending && !pending.controller.signal.aborted) return pending;
        const controller = new AbortController();
        controllers.add(controller);
        dirty = false;
        const measuredRevision = ++revision;
        const operation: Operation = { controller, readers: 0,
            done: measure(controller.signal, measuredRevision).catch(error => {
                if (pending === operation) dirty = true;
                throw error;
            }).finally(() => {
                controllers.delete(controller);
                if (pending === operation) pending = null;
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
                if (operation.readers !== 0) { reject(abortError()); return; }
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
    async function summary(options: Readonly<{ signal?: AbortSignal; actor?: StorageOperationActor }> = {}): Promise<HappierStorageSummaryV1> {
        assertActive(options.signal);
        const measured = cached && !dirty && !pending ? cached : await timeWebLatencyPhase('storage.summary.measurement', () => join(begin(), options.signal));
        const current = { ...measured, revision, wholeDisk: {
            enabled: readWholeDiskEnabled() === true,
            scans: scanOwner ? [...(await timeWebLatencyPhase('storage.summary.scans', scans)).index.states()] : [],
        } };
        return options.actor ? timeWebLatencyPhase('storage.summary.actor-projection', () => operations.summaryForActor(current, options.actor!, items)) : current;
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
    const operations = createStorageOperations({ deps: { ...deps, readCompletedStorageScan,
        readIndexedStorageItem: deps.readIndexedStorageItem ?? (async ref => (await scans()).index.readNode(ref.itemId) ?? null) }, catalog, revision: () => revision, invalidate,
        setTrashRoots: paths => { currentTrashRoots = paths; },
        readCatalogItems: async () => (await readCatalogSnapshot()).items,
        readSizedItems: async signal => { await summary({ signal }); return items; },
    });
    const protectedFolders = createStorageProtectedFolders({ resourcesPolicy: deps.resourcesPolicy,
        readProtectionFacts: operations.readProtectionFacts });
    const maintenance = deps.maintenance ? createStorageMaintenance({ ...deps.maintenance,
        readPolicy: () => deps.readPolicy?.() ?? MachineStoragePolicyV1Schema.parse({}),
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
        protectedAdd: protectedFolders.add,
        protectedRemove: protectedFolders.remove,
        async initialize() { await scans(); await maintenance?.start(); },
        async scanStart(request: MachineStorageScanStartInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            await assertScanActor(options.actor, options.signal);
            if (readWholeDiskEnabled() !== true) throw Object.assign(new Error('Whole-disk scan disabled'), { code: 'storage_whole_disk_disabled' });
            const owner = await scans();
            await assertScanActor(options.actor, options.signal);
            return owner.runner.start(request, { beforeEffect: () => assertScanAuthority(options.actor, options.signal) });
        },
        async scanGet(request: MachineStorageScanGetInputV1, options: Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>) {
            await timeWebLatencyPhase('storage.page.actor', () => assertScanActor(options.actor, options.signal));
            const owner = await timeWebLatencyPhase('storage.page.scans', scans);
            const result = await timeWebLatencyPhase('storage.page.snapshot', () => owner.runner.get(request, { beforeEffect: () => assertScanAuthority(options.actor, options.signal) }));
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
                : [...deps.readVolumes()].sort((left, right) => right.mount.length - left.mount.length)
                    .find(volume => storagePathContains(volume.mount, target.folderPath))?.id);
            const insights = result.insights ? { ...result.insights,
                largestDistinct: project(result.insights.largestDistinct),
                trashBytes: (await timeWebLatencyPhase('storage.page.trash', () => operations.trashEntries())).filter(entry => entry.volumeId === insightVolume)
                    .reduce((total, entry) => total + entry.size.allocatedBytes, 0),
                changes: {
                    grew: project(result.insights.changes.grew),
                    shrank: project(result.insights.changes.shrank),
                    appeared: project(result.insights.changes.appeared),
                    disappeared: project(result.insights.changes.disappeared),
                },
            } : undefined;
            await timeWebLatencyPhase('storage.page.disclosure', () => assertScanActor(options.actor, options.signal));
            return { ...result, nodes, ...(result.root ? { root: projected.get(result.root.nodeId) ?? result.root } : {}), ...(insights ? { insights } : {}) };
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
            const owner = await scans();
            await assertScanAuthority(options.actor, options.signal);
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
                const trashEntries = await operations.trashEntries(options.actor);
                assertActive(options.signal);
                if (!options.actor) await options.assertCurrent?.();
                assertActive(options.signal);
                return MachineStorageCategoryListResultV1Schema.parse({ categoryId, revision, sizedAt: now(),
                    trashEntries, items: trashEntries.map(entry => ({ itemId: entry.entryId, kind: 'category-item', categoryId: 'trash',
                        path: entry.originalPath, title: entry.title, size: entry.size, lastChangedAt: entry.movedAt,
                        evidence: ['trash_entry'], verdict: 'safe', reason: { code: 'old' }, collectable: false })) });
            }
            const current = await summary({ signal: options.signal });
            // Refresh the caller's readonly Session scope after measurement, before
            // projection strips the private binding used to enforce that scope.
            await options.assertCurrent?.();
            const visible = items.filter(item => item.categoryId === categoryId && (options.sessionIds === undefined
                || item.sessionId !== undefined && options.sessionIds.has(item.sessionId)));
            const groups = new Map<StorageCategoryGroupV1['id'], StorageCategoryGroupV1>();
            for (const item of visible) {
                if (!item.categoryGroup) continue;
                const group = groups.get(item.categoryGroup.id) ?? { ...item.categoryGroup, itemIds: [] };
                group.itemIds.push(item.itemId); groups.set(group.id, group);
            }
            const order: StorageCategoryGroupV1['id'][] = ['stopped', 'old', 'recent'];
            return MachineStorageCategoryListResultV1Schema.parse({ categoryId, revision: current.revision, sizedAt: current.sizedAt,
                items: visible.map(publicStorageItem),
                ...(groups.size ? { groups: [...groups.values()].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id)) } : {}) });
        },
        async refresh(options: Readonly<{ categoryId?: HappierStorageCategoryIdV1; signal?: AbortSignal; actor?: StorageOperationActor }> = {}) {
            assertActive(options.signal);
            await options.actor?.assertCurrentAuthority();
            assertActive(options.signal);
            // Rebuild the native union: a changed category can share inodes with any other category.
            catalogSnapshot = undefined;
            const current = await join(begin(), options.signal);
            return options.actor ? operations.summaryForActor(current, options.actor, items) : current;
        },
        revision: () => revision,
        async dockerPrune(request: MachineStorageDockerPruneInputV1, options: Readonly<{
            actor: StorageOperationActor; context: ActionExecutorContext;
        }>) {
            assertActive(options.context.signal);
            await options.actor.assertCurrentAuthority();
            assertActive(options.context.signal);
            if (!deps.dockerPrune) return { kind: 'unsupported' as const, reason: 'native_runtime_unavailable' as const, removed: [], kept: [] };
            const result = await deps.dockerPrune(request, options);
            if (result.removed.length) invalidate();
            return result;
        },
        subscribe(listener: () => void) { assertActive(); listeners.add(listener); return () => { listeners.delete(listener); }; },
        invalidate,
        dispose() { if (disposed) return; disposed = true; operations.dispose(); unsubscribe?.(); unsubscribeWorktrees(); unsubscribeVolumes?.();
            maintenance?.stop();
            for (const release of scheduledSubscriptions) release();
            if (scanOwner) void scanOwner.then(owner => owner.runner.dispose(), () => {});
            for (const controller of controllers) controller.abort(); listeners.clear(); },
    };
}

export type StorageService = ReturnType<typeof createStorageService>;
