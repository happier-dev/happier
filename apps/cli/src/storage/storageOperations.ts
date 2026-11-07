import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import {
    STORAGE_SUMMARY_SUGGESTION_LIMIT,
    type MachineStoragePolicyV1,
    type MachineStoragePileSetInputV1, type MachineStoragePileResultV1, type MachineStorageTrashMoveInputV1,
    type MachineStorageDeleteNowInputV1, type MachineStorageTrashEmptyInputV1, type MachineStorageTrashRestoreInputV1,
    type MachineStorageWorktreesListInputV1, type MachineStorageSuggestionsListInputV1,
    type MachineStorageSuggestionsDeclineInputV1, type PileItemRefV1, type StorageItemV1, type HappierStorageSummaryV1,
    type DiskNodeV1, type StorageItemRefV1, type PileReviewV1, type TrashEntryV1, type StorageReadIssueV1,
} from '@happier-dev/protocol/storage/storageV1';
import { storagePathsEqual as canonicalAbsolutePathsEqual, storagePathContains,
    physicalStoragePathWithoutFollowingLeaf as physicalPathWithoutFollowingLeaf, createStoragePathIndex } from './storagePath';
import type { StorageOperationActor, StorageServiceDeps } from './storageService';
import type { createStorageCategoryCatalog, StorageCategoryItem } from './categoryCatalog';
import { foldStorageDescendantVerdicts, publicStorageItem } from './categoryCatalog';
import { createPileStore } from './pileStore';
import { PileFactError, reviewPile, type PileReviewDeps } from './reviewPile';
import { applyPile } from './applyPile';
import { measureNativeDisk } from './measure/nativeDiskMeasure';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createTrashStore, resolveTrashOsUserId, type TrashStore, type TrashSelection } from './trash/trashStore';
import { readStoragePathIdentity } from './trash/removeStoragePath';
import { classifyPath, classifyPaths, type StoragePathClassification, type StorageProtectionFacts } from './protection/protectedPaths';
import { createStorageSuggestions, recognizeStorageCandidate, storageCandidateRepositoryFacts } from './suggestions/recognizers';
import { readRepositoryIgnoredPaths } from '@/scm/readRepositoryIgnoredPaths';
import type { SizedStorageCategoryItem, StorageCategoryVerdict, StorageCleanupItem, StoragePathUse } from './categories/types';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { resolveCliHomeStoragePaths } from '@/configuration/homeStoragePaths';

type ActorOptions = Readonly<{ actor: StorageOperationActor; signal?: AbortSignal }>;
type Catalog = ReturnType<typeof createStorageCategoryCatalog>;
type SizedItem = SizedStorageCategoryItem;

function summarySuggestionPreview(suggestions: readonly StorageItemV1[]) {
    const safe = suggestions.filter(item => item.verdict === 'safe');
    return {
        suggestionsTop: suggestions.slice(0, STORAGE_SUMMARY_SUGGESTION_LIMIT),
        suggestionsSafeTop: safe.slice(0, STORAGE_SUMMARY_SUGGESTION_LIMIT),
        suggestionsSafeTotalCount: safe.length,
        suggestionsSafeFreesBytes: safe.reduce((sum, item) => sum + item.size.freesBytes, 0),
        suggestionsTotalCount: suggestions.length,
    };
}

function classifiedItemVerdict(item: StorageCleanupItem, classification: StoragePathClassification): StorageCategoryVerdict {
    const verdict = item.verdict === 'forbidden' || classification.tier === 'forbidden' ? 'forbidden'
        : item.verdict === 'keep' || classification.tier === 'keep' ? 'keep'
        : item.verdict === 'check' ? 'check' : classification.tier === 'caution' ? 'caution' : item.verdict;
    return { verdict, reason: classification.tier === verdict ? classification.reason! : item.reason,
        collectable: item.collectable && verdict !== 'forbidden',
        ...(classification.loses === undefined && item.loses === undefined ? {}
            // Protection refines category losses with paths/Session holders. Drop the
            // category's generic or identical copy, preserving every distinct detail.
            : { loses: [...(item.loses ?? []).filter(loss => !classification.loses?.some(protectedLoss =>
                protectedLoss.code === loss.code && (loss.detail === undefined
                    || sameStrictJsonValue(loss.detail, protectedLoss.detail)))), ...(classification.loses ?? [])] }) };
}

/** The lazy service composes the catalog, pile and Trash owners; Actions do not own cleanup policy. */
export function createStorageOperations(input: Readonly<{
    deps: StorageServiceDeps; catalog: Catalog; readSizedItems(signal?: AbortSignal): Promise<readonly SizedItem[]>;
    readIncomplete(): readonly StorageReadIssueV1[];
    /** The service's policy owner; throws `policy_unavailable` rather than defaulting. */
    readPolicy(): MachineStoragePolicyV1;
    setTrashRoots(paths: readonly string[]): void;
    revision(): number; invalidate(): void;
}>) {
    const { deps, catalog } = input;
    const pile = createPileStore({ activeServerDir: deps.catalog.activeServerDir, now: deps.nowMs, onChanged: input.invalidate });
    // Last published detail facts, qualified by the caller's actual projection scope.
    const detailPublications = new Map<string, { facts: unknown; revision: number }>();
    let detailContentRevision = 0;
    function detailRevision(actor: StorageOperationActor, fact: 'pile' | 'items', facts: unknown) {
        const scope = JSON.stringify([actor.accountId, actor.kind, actor.sessionIds ? [...actor.sessionIds].sort() : null, fact]);
        const previous = detailPublications.get(scope);
        if (previous && isDeepStrictEqual(previous.facts, facts)) return previous.revision;
        const revision = ++detailContentRevision;
        detailPublications.set(scope, { facts, revision });
        return revision;
    }
    const policy = input.readPolicy;
    let trash: Promise<TrashStore> | undefined;
    let unsubscribeTrash: (() => void) | undefined;
    let disposed = false;
    const lifecycle = new AbortController();
    const assertActive = () => { if (disposed) throw Object.assign(new Error('Storage owner retired'), { name: 'AbortError' }); };
    const contains = storagePathContains;
    const permitted = (item: Readonly<{ sessionId?: string }>, actor: StorageOperationActor) => actor.sessionIds === undefined
        || item.sessionId !== undefined && actor.sessionIds.has(item.sessionId);
    const worktreeItems = (items: readonly SizedItem[], actor: StorageOperationActor) => items
        .filter(item => item.categoryId === 'worktrees' && permitted(item, actor));
    function retirementChildren(item: Pick<StorageCleanupItem, 'path' | 'retirementKind'>, discovered: readonly StorageCategoryItem[]) {
        const children = discovered.filter(child => !canonicalAbsolutePathsEqual(item.path, child.path) && contains(item.path, child.path));
        if (item.retirementKind === 'main' || item.retirementKind === 'common') return children;
        return children.filter(child => !children.some(parent => parent !== child && parent.retirementKind === 'main'
            && contains(parent.path, child.path)));
    }
    async function assertActor(actor: StorageOperationActor) { assertActive(); await actor.assertCurrent(); assertActive(); }
    async function assertEffectActor(actor: StorageOperationActor, item?: StorageCleanupItem) {
        assertActive(); await actor.assertCurrentAuthority(); assertActive();
        if (item && !permitted(item, actor)) throw Object.assign(new Error('Storage item is not owned by this Account'), { code: 'unauthorized' });
    }
    async function protectionSnapshot(paths: readonly string[] = [], current?: readonly StorageCategoryItem[], inUse?: StoragePathUse,
        pagePaths?: readonly string[]) {
        policy();
        const unavailableUse: StoragePathUse = { reliable: false, paths: [] };
        const [projects, use, environment] = await Promise.all([
            timeWebLatencyPhase('storage.protection.projects', () => deps.catalog.readProjects?.()),
            timeWebLatencyPhase('storage.protection.in-use', () => inUse ?? deps.catalog.readInUsePaths?.() ?? unavailableUse),
            timeWebLatencyPhase('storage.protection.environment', () => deps.readStorageProtectionFacts?.()),
        ]);
        // Catalog verdicts and path protection describe the same observation,
        // including Review's freshly discovered and indexed SCM roots.
        const discovered = await timeWebLatencyPhase('storage.protection.catalog', () => pagePaths
            ? catalog.discoverPage(pagePaths, use) : catalog.discover(paths, current, use));
        const trashRoots = trash ? (await timeWebLatencyPhase('storage.protection.trash', async () => (await trash!).roots())).map(root => root.path) : [];
        const facts: StorageProtectionFacts = { ...environment, homeDir: deps.homeDir ?? homedir(),
            dataHomes: [deps.catalog.happyHomeDir, deps.catalog.activeServerDir],
            deploymentPaths: { serversDir: resolveCliHomeStoragePaths(deps.catalog.happyHomeDir).serversDir,
                activeServerDir: deps.catalog.activeServerDir },
            installPaths: deps.catalog.installDir ? [deps.catalog.installDir] : [],
            volumeRoots: deps.readVolumes().map(volume => volume.mount), trashRoots,
            mainCheckouts: projects?.projects?.map(project => project.repositoryRoot) ?? [],
            inUsePaths: [...new Set(use?.paths ?? [])], inUseCwds: [...new Set(use?.cwdPaths)],
            inUseSessions: use?.sessions ?? [], userProtectedFolders: policy().protectedFolders.map(folder => folder.path),
            agentHomes: discovered.filter(item => item.categoryId === 'agentHomes' && item.verdict === 'keep').map(item => item.path),
            cloudSyncedFolders: [...(environment?.cloudSyncedFolders ?? []), process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial]
                .filter((path): path is string => !!path),
        };
        return { facts, discovered, use };
    }
    async function protectionFacts(): Promise<StorageProtectionFacts> { return (await protectionSnapshot()).facts; }
    async function classifyItem(item: StorageCleanupItem, path = item.path, facts?: StorageProtectionFacts): Promise<StorageCategoryVerdict> {
        const classification = await classifyPath(path, { ...(facts ?? await protectionFacts()),
            ...(item.categoryId === undefined ? {} : { managedItemPath: item.path }) });
        return classifiedItemVerdict(item, classification);
    }
    function getTrash(): Promise<TrashStore> {
        assertActive();
        if (!deps.activityLog || !deps.machineId) throw Object.assign(new Error('Trash owner is unavailable'), { code: 'storage_owner_unavailable' });
        if (!trash) {
            trash = (async () => {
                const store = createTrashStore({ happyHomeDir: deps.catalog.happyHomeDir, osUserId: await resolveTrashOsUserId(),
                    target: { machineId: deps.machineId!, ...(deps.serverId === undefined ? {} : { serverId: deps.serverId }) }, readVolumes: deps.readVolumes, activityLog: deps.activityLog!,
                    attributionFor: deps.attributionFor ?? (() => ({ kind: 'unknown' })),
                    readEmptyAfterDays: () => policy().trashEmptyAfterDays,
                    classifyRestorePath: async path => {
                        const classification = await classifyPath(path, { ...await protectionFacts(), managedItemPath: path });
                        return classification.tier === 'forbidden' ? classification.reason! : null;
                    },
                    resolveOwnerAdapter: catalog.adapterForEntry, nowMs: deps.nowMs,
                });
                unsubscribeTrash = store.subscribe(input.invalidate);
                input.setTrashRoots((await store.roots()).map(root => root.path));
                // Crash reconciliation belongs to policy-aware maintenance. Merely
                // opening Trash (including an explicit Empty now) performs no effects.
                return store;
            })();
            void trash.catch(() => { trash = undefined; unsubscribeTrash?.(); unsubscribeTrash = undefined; });
        }
        return trash;
    }
    async function resolveRef(ref: StorageItemRefV1, actor: StorageOperationActor, snapshot?: Awaited<ReturnType<typeof protectionSnapshot>>) {
        await assertActor(actor);
        let discovered = snapshot?.discovered ?? await catalog.discover();
        await assertActor(actor);
        if (actor.sessionIds !== undefined && !discovered.some(item => item.itemId === ref.itemId && permitted(item, actor))) {
            throw Object.assign(new Error('Storage item is not owned by this Account'), { code: 'unauthorized' });
        }
        const physical = await physicalPathWithoutFollowingLeaf(ref.path);
        for (const item of discovered) {
            if (item.itemId === ref.itemId && canonicalAbsolutePathsEqual(await physicalPathWithoutFollowingLeaf(item.path), physical)) {
                if (!permitted(item, actor)) throw Object.assign(new Error('Storage item is not owned by this Account'), { code: 'unauthorized' });
                return { item, fingerprint: item.fingerprint, fingerprintRequired: item.fingerprintRequired,
                    ownFingerprint: item.ownFingerprint,
                    retirementChildren: retirementChildren(item, discovered) };
            }
        }
        // Global disk refs have no Session scope proof, even when their spelling overlaps a Session.
        if (actor.sessionIds !== undefined) throw Object.assign(new Error('Disk item is custodian-only'), { code: 'unauthorized' });
        const indexed = await deps.readIndexedStorageItem?.(ref);
        await assertActor(actor);
        if (!indexed || !indexed.complete || indexed.node.nodeId !== ref.itemId
            || !canonicalAbsolutePathsEqual(await physicalPathWithoutFollowingLeaf(indexed.path), physical)) return null;
        discovered = await catalog.discover([physical], discovered, snapshot?.use);
        if (snapshot) snapshot.discovered = discovered;
        await assertActor(actor);
        const exact = discovered.find(item => canonicalAbsolutePathsEqual(item.path, physical));
        if (exact) return { item: { ...exact, itemId: ref.itemId, canonicalItemId: exact.itemId },
            fingerprint: exact.fingerprint, fingerprintRequired: exact.fingerprintRequired, ownFingerprint: exact.ownFingerprint,
            retirementChildren: retirementChildren(exact, discovered) };
        const children = retirementChildren({ path: physical }, discovered);
        const enclosing = discovered.filter(item => contains(item.path, physical)).sort((left, right) => right.path.length - left.path.length);
        const limitation = catalog.descendantCleanupLimitation(physical, discovered);
        if (limitation) throw new PileFactError('facts_unavailable', limitation);
        const worktree = enclosing.find(item => item.categoryId === 'worktrees' && item.retirementKind !== 'main');
        if (worktree && !worktree.collectable) throw new PileFactError('facts_unavailable');
        const protection = snapshot?.facts ?? await protectionFacts();
        const recognized = await recognizeStorageCandidate({ path: physical, size: indexed.node.size,
            ...(worktree ? { repositoryRoot: worktree.path, repositoryInUse: worktree.reason.code === 'in_use' } : {}) },
            { protection, now: deps.nowMs?.() ?? Date.now(), suggestUnusedAfterDays: policy().suggestUnusedAfterDays,
                readIgnoredPaths: repositoryRoot => readRepositoryIgnoredPaths({ repositoryRoot, happyHomeDir: deps.catalog.happyHomeDir, registry: deps.scmRegistry }) });
        const item: StorageCleanupItem = { itemId: ref.itemId, path: physical,
            title: indexed.node.name, kind: 'disk-node',
            verdict: recognized?.verdict ?? 'caution', reason: recognized?.reason ?? { code: 'not_rebuildable' },
            evidence: ['trusted_disk_index', ...(recognized?.evidence ?? [])], collectable: true,
            ...(worktree && worktree.verdict !== 'safe' ? { verdict: worktree.verdict, reason: worktree.reason, loses: worktree.loses } : {}) };
        return { item: { ...item, ownVerdict: item, ...foldStorageDescendantVerdicts(item, children) }, retirementChildren: children };
    }
    async function reviewDeps(actor: StorageOperationActor, readSnapshot?: Awaited<ReturnType<typeof protectionSnapshot>>): Promise<PileReviewDeps> {
        const store = await getTrash();
        let needsInventory = true;
        return { resolve: ref => resolveRef(ref, actor, readSnapshot), measure: request => measureNativeDisk(request, { signal: lifecycle.signal }),
            cleanupLimitation: (path, items) => catalog.cleanupLimitation(path, items),
            freshFacts: async ref => {
                await assertActor(actor);
                // Apply acquires one initial inventory. Later checks still inspect
                // this target and its descendants afresh, not unrelated categories.
                const snapshot = readSnapshot ?? await protectionSnapshot([], undefined, undefined,
                    needsInventory ? undefined : [ref.path]);
                needsInventory = false;
                await assertActor(actor);
                return { resolve: (ref: PileItemRefV1) => resolveRef(ref, actor, snapshot),
                    classify: async (path: string, item: StorageCleanupItem) => classifyItem(item, path, snapshot.facts),
                    cleanupLimitation: (path: string, items: readonly StorageCleanupItem[]) => catalog.cleanupLimitation(path, items) };
            },
            trashAvailability: store.availability,
            classify: async (path, item) => {
                const projected = await classifyItem(item, path);
                return { verdict: projected.verdict, reason: projected.reason,
                    ...(projected.loses === undefined ? {} : { loses: projected.loses }) };
            },
        };
    }
    async function pileProjection(actor: StorageOperationActor, readSnapshot?: Awaited<ReturnType<typeof protectionSnapshot>>, includeVolumeFrees = false) {
        const state = await pile.get(actor.accountId, () => assertEffectActor(actor));
        // Custody observed when this projection began; a ref dropped as unauthorized is only
        // "another Account's" while that custody still holds.
        const startingSessionIds = actor.sessionIds && new Set(actor.sessionIds);
        let droppedUnauthorized = false;
        const snapshot = readSnapshot ?? (state.items.length
            ? await protectionSnapshot(actor.sessionIds === undefined ? state.items.map(ref => ref.path) : []) : undefined);
        const visible: PileItemRefV1[] = [];
        const bindings: StorageCleanupItem[] = [];
        for (const ref of state.items) {
            try {
                const resolved = await resolveRef(ref, actor, snapshot);
                if (resolved && permitted(resolved.item, actor)) { visible.push({ ...ref, title: resolved.item.title }); bindings.push(resolved.item); }
            }
            catch (error) {
                if (!(error !== null && typeof error === 'object' && 'code' in error && error.code === 'unauthorized')) throw error;
                droppedUnauthorized = true;
            }
        }
        const volumeFrees = new Map<string, number>();
        const dependencies = visible.length ? await reviewDeps(actor, snapshot) : undefined;
        const review = dependencies ? await reviewPile(visible, { ...dependencies, measure: async request => {
            if (!includeVolumeFrees) return dependencies.measure(request);
            // Reuse review's physical walk for each volume's selected union. Per-item
            // exclusivity omits links shared by two selected roots on the same disk.
            const volumes = [...deps.readVolumes()].sort((left, right) => right.mount.length - left.mount.length);
            const paths = new Map<string, string[]>();
            for (const path of request.paths) {
                const volume = volumes.find(volume => contains(volume.mount, path));
                if (!volume) continue;
                const members = paths.get(volume.id) ?? []; members.push(path); paths.set(volume.id, members);
            }
            const measured = await dependencies.measure({ ...request, unions: [...(request.unions ?? []),
                ...[...paths].map(([id, paths]) => ({ id: `pile:${id}`, paths }))] });
            for (const id of paths.keys()) {
                const union = measured.unions?.find(union => union.id === `pile:${id}`);
                if (union) volumeFrees.set(id, union.totalExclusiveBytes);
            }
            return measured;
        } }) : null;
        await assertActor(actor);
        // Native review can await OS/SCM facts while current Session custody changes.
        // Never disclose the earlier projection after its private scope proof expired.
        if (droppedUnauthorized && startingSessionIds
            && [...startingSessionIds].some(sessionId => !actor.sessionIds?.has(sessionId))
            || bindings.some(item => !permitted(item, actor))) {
            throw Object.assign(new Error('Storage item is not owned by this Account'), { code: 'unauthorized' });
        }
        const result: MachineStoragePileResultV1 = { revision: input.revision(), items: visible,
            summary: { count: visible.length, freesBytes: review?.totalFreesBytes ?? 0,
                // Missing refs have no current Session scope proof; their paths stay custodian-only.
                droppedSinceLastView: actor.sessionIds === undefined ? state.droppedSinceLastView : [] } };
        return { result, review, volumeFrees,
            contentRevision: detailRevision(actor, 'pile', { items: result.items, summary: result.summary }) };
    }
    async function pileResult(actor: StorageOperationActor, snapshot?: Awaited<ReturnType<typeof protectionSnapshot>>) {
        return (await pileProjection(actor, snapshot)).result;
    }
    function suggestionOwner(actor?: StorageOperationActor, suppliedItems?: readonly SizedItem[],
        snapshot?: Awaited<ReturnType<typeof protectionSnapshot>>) {
        const readCompletedScan = deps.readCompletedStorageScan;
        return createStorageSuggestions({
            readCatalogItems: async () => (suppliedItems ?? await input.readSizedItems())
                .filter(item => !actor || permitted(item, actor)).map(publicStorageItem),
            readProtectionFacts: async () => (snapshot ?? await protectionSnapshot([], suppliedItems)).facts,
            now: deps.nowMs, suggestUnusedAfterDays: () => policy().suggestUnusedAfterDays,
            readCompletedScan: readCompletedScan && (!actor || actor.sessionIds === undefined)
                ? () => readCompletedScan(snapshot?.use) : undefined,
            readIgnoredPaths: repositoryRoot => readRepositoryIgnoredPaths({ repositoryRoot, happyHomeDir: deps.catalog.happyHomeDir, registry: deps.scmRegistry }),
            volumeForPath: path => deps.readVolumes().filter(volume => contains(volume.mount, path)).sort((a, b) => b.mount.length - a.mount.length)[0]?.id,
            readDeclined: actor ? async items => {
                const candidates = [];
                for (const item of items) candidates.push({ ref: {
                    itemId: item.itemId, path: await physicalPathWithoutFollowingLeaf(item.path), identity: await readStoragePathIdentity(item.path),
                    collectedAt: deps.nowMs?.() ?? Date.now(), collectedBy: { accountId: actor.accountId, kind: actor.kind },
                }, size: item.size, lastChangedAt: item.lastChangedAt });
                return pile.readDeclined(actor.accountId, candidates, () => assertEffectActor(actor));
            } : undefined,
        });
    }
    async function suggestions(actor?: StorageOperationActor, request: Pick<MachineStorageSuggestionsListInputV1, 'group' | 'quickestForVolume'> = {},
        suppliedItems?: readonly SizedItem[]) {
        return suggestionOwner(actor, suppliedItems).list({ callerKind: actor?.kind ?? 'person', ...request });
    }
    async function entrySessionId(entry: TrashEntryV1, ownerData?: JsonValue): Promise<string | undefined> {
        if (entry.categoryId !== 'sessionFolders' || ownerData === undefined) return undefined;
        return (await catalog.adapterForEntry(entry.categoryId, ownerData)).sessionId;
    }
    function permittedEntry(entry: TrashEntryV1, sessionId: string | undefined, actor: StorageOperationActor): boolean {
        return actor.sessionIds === undefined || entry.categoryId === 'sessionFolders' && entry.movedBy.accountId === actor.accountId
            && sessionId !== undefined && actor.sessionIds.has(sessionId);
    }
    function entryAuthority(actor: StorageOperationActor) {
        return async (entry: TrashEntryV1, ownerData?: JsonValue) => {
            await assertActor(actor);
            if (actor.sessionIds === undefined) { await assertEffectActor(actor); return; }
            if (entry.categoryId !== 'sessionFolders' || ownerData === undefined || entry.movedBy.accountId !== actor.accountId) {
                throw Object.assign(new Error('Storage entry is not owned by this Account'), { code: 'unauthorized' });
            }
            const sessionId = await entrySessionId(entry, ownerData);
            await assertEffectActor(actor);
            if (!permittedEntry(entry, sessionId, actor)) {
                throw Object.assign(new Error('Session folder is not owned by this Account'), { code: 'unauthorized' });
            }
        };
    }
    return {
        /** Only the returned index page is projected; the scan never acquires per-file TS identities. */
        async projectDiskNodes(nodes: readonly DiskNodeV1[]): Promise<DiskNodeV1[]> {
            if (!nodes.length) return [];
            const paths = await timeWebLatencyPhase('storage.projection.path-resolutions', () => Promise.all(nodes.map(node => {
                const virtual = node.kind === 'small-items' || node.kind === 'hidden-space' || node.kind === 'reserved';
                const source = virtual ? node.parentId : node.nodeId;
                // A synthetic ID is presentation only; only its producer-bound parent supplies path facts.
                return source ? physicalPathWithoutFollowingLeaf(source) : undefined;
            })));
            const { facts, discovered } = await timeWebLatencyPhase('storage.projection.protection-snapshot', () =>
                protectionSnapshot([], undefined, undefined, paths.filter((path): path is string => path !== undefined)));
            const catalogPaths = createStoragePathIndex(discovered, item => item.path);
            const dataRoots = createStoragePathIndex(catalog.dataRoots(), path => path);
            const livePaths = createStoragePathIndex(facts.inUsePaths ?? [], path => path);
            const liveCwds = createStoragePathIndex(facts.inUseCwds ?? [], path => path);
            const page: { node: DiskNodeV1; path: string; owner: StorageCategoryItem | undefined;
                enclosing: StorageCategoryItem[]; children: StorageCategoryItem[] }[] = [];
            for (const [index, node] of nodes.entries()) {
                const path = paths[index];
                if (path === undefined) continue;
                const owner = catalogPaths.exact(path);
                page.push({ node, path, owner,
                    enclosing: catalogPaths.ancestors(path).filter(item => item.categoryId === 'worktrees' && item.retirementKind !== 'main'),
                    children: catalogPaths.descendants(path) });
            }
            const descendants = [...new Set(page.flatMap(item => item.children))];
            // Permission-limited discovery rows already carry Check and cannot
            // grant cleanup authority. Their unresolved parents cannot be
            // physically probed again; retain that Check contribution verbatim.
            const classifiableDescendants = descendants.filter(item => !item.evidence.includes('directory_permission_unavailable'));
            // One page shares one fresh physical rule set, including catalog
            // descendants contained by more than one returned folder.
            const classifications = await timeWebLatencyPhase('storage.projection.classification', () => classifyPaths([
                ...page.map(item => ({ path: item.path, managedItemPath: item.owner?.path })),
                ...classifiableDescendants.map(item => ({ path: item.path, managedItemPath: item.categoryId === undefined ? undefined : item.path })),
            ], facts));
            const byDescendant = new Map(descendants.map(item => [item, item]));
            for (const [index, item] of classifiableDescendants.entries()) {
                byDescendant.set(item, { ...item, ...classifiedItemVerdict(item, classifications[page.length + index]) });
            }
            const projectedNodes = new Map<DiskNodeV1, DiskNodeV1>();
            for (const [index, item] of page.entries()) {
                const { node, path, owner, enclosing } = item;
                const classification = classifications[index];
                const losses = [...(owner?.loses ?? []), ...enclosing.flatMap(item => item.loses ?? []), ...(classification.loses ?? [])];
                const children = item.children.map(child => byDescendant.get(child)!);
                const projected = foldStorageDescendantVerdicts({ verdict: classification.tier ?? owner?.verdict
                    ?? (enclosing.some(item => item.verdict === 'keep') ? 'keep' : 'caution'),
                    reason: classification.reason ?? owner?.reason ?? { code: 'not_rebuildable' }, collectable: true, loses: losses }, children);
                const forbidden = node.flags.protection === 'forbidden' || projected.verdict === 'forbidden';
                const keep = projected.verdict === 'keep';
                projectedNodes.set(node, { ...node,
                    ...(classification.reason || owner || children.length ? { reason: projected.reason } : {}),
                    ...(projected.loses?.length ? { loses: projected.loses } : {}), flags: { ...node.flags,
                    happier: dataRoots.hasAncestor(path) || catalogPaths.overlaps(path),
                    protection: forbidden ? 'forbidden' : keep ? 'keep' : 'none',
                    inUse: livePaths.overlaps(path) || liveCwds.hasDescendant(path),
                } });
            }
            return nodes.map(node => projectedNodes.get(node) ?? node);
        },
        async projectCatalogItems<T extends StorageCategoryItem>(items: readonly T[], inUse?: StoragePathUse): Promise<readonly (Omit<T, keyof StorageCategoryVerdict> & StorageCategoryVerdict)[]> {
            const { facts } = await timeWebLatencyPhase('storage.projection.protection-snapshot', () => protectionSnapshot([], items, inUse));
            const classifications = await timeWebLatencyPhase('storage.projection.classification', () => classifyPaths(items.map(item => ({ path: item.path,
                ...(item.categoryId === undefined ? {} : { managedItemPath: item.path }) })), facts));
            return items.map((item, index) => ({ ...item, ...classifiedItemVerdict(item, classifications[index]) }));
        },
        async pileGet({ actor }: ActorOptions) { policy(); await assertActor(actor); return pileResult(actor); },
        async pileSet(request: MachineStoragePileSetInputV1, { actor }: ActorOptions) {
            policy();
            await assertActor(actor);
            // Indexed paths are custodian-only; recipient refs need catalog scope
            // proof before any caller-supplied path can trigger SCM inspection.
            const snapshot = request.add?.length
                ? await protectionSnapshot(actor.sessionIds === undefined ? request.add.map(ref => ref.path) : []) : undefined;
            const additions: StorageCleanupItem[] = [];
            for (const ref of request.add ?? []) {
                const resolved = await resolveRef(ref, actor, snapshot);
                if (!resolved || !(await classifyItem(resolved.item, resolved.item.path, snapshot?.facts)).collectable) {
                    throw Object.assign(new Error('Storage item cannot be collected'), { code: 'storage_item_not_collectable' });
                }
                additions.push(resolved.item);
            }
            await pile.set(actor.accountId, request, { accountId: actor.accountId, kind: actor.kind }, async ref => (await resolveRef(ref, actor, snapshot))?.fingerprint,
                async () => {
                    await assertEffectActor(actor);
                    if (additions.some(item => !permitted(item, actor))) throw Object.assign(new Error('Storage item is not owned by this Account'), { code: 'unauthorized' });
                });
            await assertActor(actor); return pileResult(actor, snapshot);
        },
        async itemsCheck(refs: readonly StorageItemRefV1[], { actor }: ActorOptions) {
            policy();
            await assertActor(actor);
            const snapshot = refs.length ? await protectionSnapshot(actor.sessionIds === undefined ? refs.map(ref => ref.path) : []) : undefined;
            const fresh: PileItemRefV1[] = [];
            const unavailable: PileReviewV1['staying'] = [];
            for (const ref of refs) {
                let title: string | undefined;
                try {
                    const resolved = await resolveRef(ref, actor, snapshot);
                    if (!resolved) throw new PileFactError('facts_unavailable');
                    title = resolved.item.title;
                    const path = await physicalPathWithoutFollowingLeaf(resolved.item.path);
                    fresh.push({ itemId: ref.itemId, path, title: resolved.item.title, identity: await readStoragePathIdentity(path),
                        collectedAt: deps.nowMs?.() ?? Date.now(), collectedBy: { accountId: actor.accountId, kind: actor.kind } });
                } catch (error) {
                    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    if (code === 'unauthorized' || code === 'policy_unavailable') throw error;
                    unavailable.push({ item: { itemId: ref.itemId, path: ref.path, ...(title === undefined ? {} : { title }) }, reason: error instanceof PileFactError && error.reason ? error.reason : { code:
                        code === 'ENOENT' ? 'missing'
                            : error instanceof PileFactError && error.code !== 'storage_forbidden' ? error.code : 'facts_unavailable' } });
                }
            }
            const result = await reviewPile(fresh, await reviewDeps(actor, snapshot));
            result.staying.push(...unavailable);
            await assertActor(actor); return result;
        },
        async trashMove(request: MachineStorageTrashMoveInputV1, { actor }: ActorOptions) {
            policy();
            await assertActor(actor);
            const result = await applyPile({ items: request.items, mode: 'trash', actor: { accountId: actor.accountId, kind: actor.kind },
                custodianAccountId: actor.custodianAccountId, emptyAfter: request.emptyAfter,
                assertCurrent: () => assertActor(actor), assertCurrentAuthority: async item => { await assertEffectActor(actor, item); policy(); } },
                { ...await reviewDeps(actor), trashStore: await getTrash(), resolveAdapter: catalog.resolveAdapter,
                    removeActed: (accountId, ids) => pile.removeActed(accountId, ids, () => assertEffectActor(actor)) });
            input.invalidate(); return result;
        },
        async deleteNow(request: MachineStorageDeleteNowInputV1, { actor }: ActorOptions) {
            policy();
            await assertActor(actor);
            const result = await applyPile({ items: request.items, mode: 'delete', actor: { accountId: actor.accountId, kind: actor.kind },
                custodianAccountId: actor.custodianAccountId,
                assertCurrent: () => assertActor(actor), assertCurrentAuthority: async item => { await assertEffectActor(actor, item); policy(); } },
                { ...await reviewDeps(actor), trashStore: await getTrash(), resolveAdapter: catalog.resolveAdapter,
                    removeActed: (accountId, ids) => pile.removeActed(accountId, ids, () => assertEffectActor(actor)) });
            input.invalidate(); return result;
        },
        async trashEmpty(request: MachineStorageTrashEmptyInputV1, { actor }: ActorOptions) {
            await assertActor(actor); const store = await getTrash();
            const result = await store.empty({ entryIds: request.entryIds, batchId: request.batchId, volumeId: request.volume },
                { actorAccountId: actor.accountId, custodianAccountId: actor.custodianAccountId, assertCurrentAuthority: () => assertActor(actor),
                    assertEntryAuthority: entryAuthority(actor) });
            return result;
        },
        async trashRestore(request: MachineStorageTrashRestoreInputV1, { actor }: ActorOptions) {
            await assertActor(actor); const store = await getTrash();
            const verifyEntry = entryAuthority(actor);
            const result = await store.restore({ entryIds: request.entryIds, batchId: request.batchId },
                { actorAccountId: actor.accountId, custodianAccountId: actor.custodianAccountId, beside: request.beside,
                    assertCurrentAuthority: () => assertActor(actor), assertEntryAuthority: async (entry, ownerData) => {
                        await verifyEntry(entry, ownerData); policy();
                    } });
            return result;
        },
        async worktreesList(request: MachineStorageWorktreesListInputV1, { actor, signal }: ActorOptions) {
            await assertActor(actor);
            const current = worktreeItems(await input.readSizedItems(signal), actor).filter(item => (!request.projectId || item.projectIds?.includes(request.projectId))
                && (!request.filter || item.verdict === request.filter));
            const incomplete = input.readIncomplete().filter(issue => issue.categoryId === 'worktrees');
            await assertActor(actor); return { revision: input.revision(), items: current.map(publicStorageItem),
                ...(incomplete.length ? { incomplete } : {}) };
        },
        async suggestionsList(request: MachineStorageSuggestionsListInputV1, { actor }: ActorOptions) {
            policy();
            await assertActor(actor); const result = await suggestions(actor, request); await assertActor(actor);
            const incomplete = input.readIncomplete();
            return { revision: input.revision(), ...result, ...(incomplete.length ? { incomplete: [...incomplete] } : {}) };
        },
        async suggestionsDecline(request: MachineStorageSuggestionsDeclineInputV1, { actor }: ActorOptions) {
            policy();
            await assertActor(actor);
            const review = await reviewDeps(actor);
            const changedAt = new Map<string, number | undefined>();
            const reviewed = await reviewPile(request.items.map(item => item.ref), { ...review, measure: async request => {
                const measured = await review.measure(request);
                for (const path of measured.perPath) changedAt.set(path.path, path.lastChangedAtMs);
                return measured;
            } });
            await pile.decline(actor.accountId, reviewed.items.filter(item => request.items.some(chosen => chosen.ref.itemId === item.ref.itemId
                && chosen.expect === item.expect)).map(item => ({ ref: item.ref, size: item.size,
                lastChangedAt: changedAt.get(item.ref.path) })), () => assertEffectActor(actor));
            await assertActor(actor);
            return { revision: input.revision(), declinedCount: (await suggestions({ ...actor, kind: 'agent' })).declinedCount };
        },
        async prepareRead() {
            if (!deps.activityLog || !deps.machineId) return [];
            const volumes = await (await getTrash()).volumeAvailability();
            input.setTrashRoots(volumes.flatMap(volume => volume.path ? [volume.path] : []));
            return volumes;
        },
        async trashEntries(actor?: StorageOperationActor, onPermissionDenied?: () => void, selection: TrashSelection = {}) {
            if (actor) await assertActor(actor);
            if (!deps.activityLog || !deps.machineId) return [];
            const sessionBindings = new Map<string, string | undefined>();
            const entries = await (await getTrash()).list(selection, actor?.sessionIds === undefined ? undefined : async (entry, ownerData) => {
                if (entry.categoryId !== 'sessionFolders' || entry.movedBy.accountId !== actor.accountId) return false;
                sessionBindings.set(entry.entryId, await entrySessionId(entry, ownerData));
                return true;
            }, onPermissionDenied);
            if (!actor) return entries;
            // Refresh once after local owner bindings resolve, then project the
            // current scope without an Account RPC for every retained entry.
            await assertActor(actor);
            return entries.filter(entry => permittedEntry(entry, sessionBindings.get(entry.entryId), actor));
        },
        // Internal verified inventory: sizing needs the entire Safe union, and
        // actor projections must filter before taking their presentation window.
        async readSuggestionInventory(candidates: readonly SizedItem[], inUse?: StoragePathUse) {
            const snapshot = await protectionSnapshot([], candidates, inUse);
            return (await suggestionOwner(undefined, candidates, snapshot).list({ callerKind: 'person' })).items;
        },
        async summaryForActor(current: HappierStorageSummaryV1, actor: StorageOperationActor,
            candidates: readonly SizedItem[], suggestions: readonly StorageItemV1[]): Promise<HappierStorageSummaryV1> {
            policy();
            await assertActor(actor);
            const snapshot = suggestions.length ? await protectionSnapshot([], candidates) : undefined;
            const projection = await timeWebLatencyPhase('storage.summary.pile-projection', () => pileProjection(actor, snapshot, true));
            const volumes = deps.readVolumes();
            const byVolume = new Map<string, number>();
            for (const item of projection.review?.items ?? []) {
                const volume = volumes.filter(volume => contains(volume.mount, item.ref.path)).sort((a, b) => b.mount.length - a.mount.length)[0];
                if (volume) byVolume.set(volume.id, (byVolume.get(volume.id) ?? 0) + item.size.allocatedBytes);
            }
            const visible = (item: StorageItemV1) => actor.sessionIds === undefined
                || candidates.some(candidate => candidate.itemId === item.itemId && permitted(candidate, actor));
            // Recognition and sizes belong to the service's event-invalidated
            // snapshot. Every explicit actor read observes fresh protection,
            // visibility and declines; Vitals capacity edges never call this path.
            const eligibleSuggestions = snapshot ? (await timeWebLatencyPhase('storage.summary.actor-suggestions', () => suggestionOwner(actor, candidates, snapshot)
                .projectSnapshot(suggestions.filter(item => {
                    if (!visible(item)) return false;
                    if (!item.evidence.includes('repository_not_in_use')) return true;
                    return storageCandidateRepositoryFacts(item.path, snapshot.facts.mainCheckouts ?? [], snapshot.use).repositoryInUse === false;
                }), { callerKind: actor.kind }))).items : [];
            await assertActor(actor);
            policy();
            // Keep the cursor paired with the supplied measurement. Protection
            // or pile I/O may span a newer measurement publication; its revision
            // must remain visible to the next watch rather than being consumed here.
            return { ...current, pile: projection.result.summary, pileRevision: projection.contentRevision,
                itemsRevision: detailRevision(actor, 'items', {
                    worktrees: worktreeItems(candidates, actor).map(item => ({ item: publicStorageItem(item), projectIds: item.projectIds })),
                    suggestions: eligibleSuggestions,
                }),
                ...summarySuggestionPreview(eligibleSuggestions),
                volumes: current.volumes.map(volume => {
                    const { canGoBytes, ...sharedVolume } = volume;
                    return { ...sharedVolume, ...(actor.sessionIds === undefined && canGoBytes !== undefined ? { canGoBytes } : {}),
                        pileBytes: byVolume.get(volume.volume.volumeId) ?? 0,
                        pileFreesBytes: projection.volumeFrees.get(volume.volume.volumeId) ?? 0 };
                }) };
        },
        dispose() { disposed = true; lifecycle.abort(); unsubscribeTrash?.(); detailPublications.clear(); },
        projectSummarySuggestions: summarySuggestionPreview,
        readProtectionFacts: protectionFacts,
        maintenanceTrash: getTrash,
    };
}
