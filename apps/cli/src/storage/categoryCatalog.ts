import { z } from 'zod/mini';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalAbsolutePathsEqual, resolveCanonicalAbsolutePath } from '@/utils/path/expandHomeDirPath';
import { getHappierTempRoot } from '@happier-dev/cli-common/tempDirs';
import { StorageItemV1Schema, type StorageItemV1, type StorageReasonV1 } from '@happier-dev/protocol/storage/storageV1';
import { contains, exists, isPermissionError, storagePermissionReadIssue, unavailableDirectory } from './categories/filesystem';
import { worktrees, readStorageWorktreeItems } from './categories/worktrees';
import { caches, managedAcpCacheCleanupLimitation } from './categories/caches';
import { modelPacks } from './categories/modelPacks';
import { sessionFolders } from './categories/sessionFolders';
import { logs } from './categories/logs';
import { agentHomes } from './categories/agentHomes';
import { temporary } from './categories/temporary';
import { recordings } from './categories/recordings';
import { ownData, trash } from './categories/retainedData';
import { StorageCategoryAdapterError } from './categories/types';
import type { StorageCategoryAdapter, StorageCategoryCatalogDeps, StorageCategoryItem, StorageCleanupItem, StorageCategoryContext, StorageCategoryDefinition, StorageCategoryDiscoverySnapshot, StorageProjectFacts, StorageCategoryVerdict, StoragePathUse } from './categories/types';
import { bindFilesystemItem, filesystemAdapterForEntry } from './categories/filesystemAdapters';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { HappierStorageCategoryIdV1 } from '@happier-dev/protocol/storage/storageV1';
import { physicalStoragePathWithoutFollowingLeaf, realStoragePathWithAbsentSuffix, storagePathContains } from './storagePath';
import { createStorageCategoryDiscovery, UNAVAILABLE_PATH_USE } from './categoryDiscovery';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
export type { StorageCategoryAdapter, StorageCategoryCatalogDeps, StorageCategoryItem, StorageProjectFacts, StorageCategoryDiscoverySnapshot } from './categories/types';

const categories: readonly StorageCategoryDefinition[] = [worktrees, caches, modelPacks, sessionFolders, logs,
    agentHomes, temporary, recordings, trash, ownData];
export const STORAGE_CATEGORY_IDS = categories.map(category => category.id);

/** Private custody/fingerprint facts never become Machine RPC presentation fields. */
export function publicStorageItem(item: StorageItemV1): StorageItemV1 {
    return z.object(StorageItemV1Schema.shape).parse(item);
}

/** Read intrinsic facts before the catalog folds owned descendants into a container. */
export function intrinsicStorageItem<T extends StorageCleanupItem>(item: T): T {
    return item.ownVerdict ? { ...item, ...item.ownVerdict, loses: item.ownVerdict.loses } : item;
}

/** Containers inherit their owned descendants' facts through the same catalog decision. */
export function foldStorageDescendantVerdicts(item: StorageCategoryVerdict & Pick<StorageCleanupItem, 'categoryId' | 'retirementKind'>,
    children: readonly StorageCleanupItem[]): StorageCategoryVerdict {
    const nestedCheckout = item.categoryId === 'worktrees' && item.retirementKind !== 'main' && item.retirementKind !== 'common';
    const protectedItems = children.filter(child => child.verdict === 'keep' || child.verdict === 'check' || child.verdict === 'forbidden'
        || nestedCheckout && child.categoryId === 'worktrees' && child.verdict === 'caution');
    if (!protectedItems.length || item.verdict === 'forbidden') return item;
    const forbidden = protectedItems.some(child => child.verdict === 'forbidden');
    const unavailable = protectedItems.some(child => child.verdict === 'check');
    const verdict = forbidden ? 'forbidden' : unavailable && item.verdict !== 'keep' ? 'check' : 'keep';
    return { ...item, verdict, collectable: item.collectable && !forbidden && verdict !== 'check',
        reason: item.verdict === verdict ? item.reason : { code: forbidden ? 'contains_forbidden' : verdict === 'check' ? 'facts_unavailable' : 'contains',
            detail: { count: protectedItems.length } },
        loses: [...(item.loses ?? []), ...protectedItems.flatMap(child => child.loses ?? [{ ...child.reason,
            detail: { ...child.reason.detail, path: child.path } }])] };
}

/** The catalog is the single category projection and lifecycle-adapter dispatch owner. */
export function createStorageCategoryCatalog(deps: StorageCategoryCatalogDeps) {
    const dataRoots = () => [deps.happyHomeDir, deps.activeServerDir, getHappierTempRoot(deps.tempRoot)].filter((path, index, paths) =>
        !paths.slice(0, index).some(previous => canonicalAbsolutePathsEqual(previous, path)));
    const { context, selectedCategories } = createStorageCategoryDiscovery(deps, categories);
    async function projectSnapshot(facts: StorageCategoryContext): Promise<StorageCategoryDiscoverySnapshot> {
        const denied = new Set<HappierStorageCategoryIdV1>();
        const discovered = [...(await Promise.all((await selectedCategories(facts)).map(category =>
            timeWebLatencyPhase(`storage.catalog.category.${category.id}`, async () => {
                try { return await category.items(facts); }
                catch (error) {
                    if (!isPermissionError(error)) throw error;
                    denied.add(category.id);
                    for (const root of category.roots(facts)) unavailableDirectory(facts, category.id)(root);
                    return [];
                }
            })))).flat(), ...facts.discoveryIssues];
        for (const issue of discovered) {
            if (issue.evidence.includes('directory_permission_unavailable')) denied.add(issue.categoryId);
        }
        const incomplete = STORAGE_CATEGORY_IDS.filter(categoryId => denied.has(categoryId)).map(storagePermissionReadIssue);
        return { items: projectDiscoveredItems(discovered),
            incompleteCategoryIds: [...new Set<HappierStorageCategoryIdV1>([
                ...(facts.projectsAvailable ? [] : ['worktrees', 'sessionFolders'] as const), ...denied])],
            ...(incomplete.length ? { incomplete } : {}) };
    }
    function projectDiscoveredItems(discovered: readonly StorageCategoryItem[]): readonly StorageCategoryItem[] {
        // Recording files can also live in session uploads; the specialized owner wins exact duplicates.
        const byPath = new Map<string, StorageCategoryItem>();
        for (const discoveredItem of discovered) {
            // Supplementation retains projected rows. Recompose their intrinsic facts,
            // not the descendant losses/evidence already folded into the last projection.
            const item = intrinsicStorageItem(discoveredItem);
            if (!byPath.has(item.path) || item.categoryId === 'recordings') byPath.set(item.path, item);
        }
        const items = [...byPath.values()];
        // Catalog paths come from this machine's filesystem. Normalize each once,
        // then visit its ancestors instead of comparing every pair of inventory
        // rows (hundreds of retained logs otherwise block the daemon for seconds).
        const paths = new Map(items.map(item => [item, resolveCanonicalAbsolutePath(item.path)?.comparisonKey]));
        const containers = new Map<string, StorageCategoryItem[]>();
        for (const item of items) {
            const path = paths.get(item);
            if (path === undefined || item.verdict === 'forbidden') continue;
            const aliases = containers.get(path) ?? [];
            aliases.push(item);
            containers.set(path, aliases);
        }
        const descendants = new Map<StorageCategoryItem, StorageCategoryItem[]>();
        for (const child of items) {
            let path = paths.get(child);
            if (path === undefined) continue;
            while (true) {
                for (const container of containers.get(path) ?? []) {
                    if (container.path === child.path) continue;
                    const children = descendants.get(container) ?? [];
                    children.push(child);
                    descendants.set(container, children);
                }
                const parent = dirname(path);
                if (parent === path) break;
                path = parent;
            }
        }
        return items.map(item => {
            const children = descendants.get(item) ?? [];
            if (!children.length) return item;
            const nested = item.categoryId === 'worktrees' && item.retirementKind !== 'main' && item.retirementKind !== 'common'
                ? children.filter(child => child.categoryId === 'worktrees') : [];
            const verdict = foldStorageDescendantVerdicts(item, children);
            if (!nested.length && verdict === item) return item;
            return { ...item, ownVerdict: item.ownVerdict ?? item, ...verdict, ...(nested.length ? {
                nestedWorktreePaths: nested.map(child => child.path),
                fingerprint: item.ownFingerprint && nested.every(child => child.fingerprint)
                    ? `sha256:${createHash('sha256').update(JSON.stringify([item.ownFingerprint,
                        nested.map(child => [child.path, child.fingerprint, child.verdict, child.reason])
                            .sort((left, right) => String(left[0]).localeCompare(String(right[0])))])).digest('hex')}` : undefined,
                evidence: [...item.evidence, nested.some(child => child.verdict !== 'safe')
                    ? 'nested_worktree_kept' : 'nested_worktrees_children_first'],
            } : {}) };
        });
    }
    const catalog = {
        categoryIds: STORAGE_CATEGORY_IDS,
        dataRoots,
        async roots() {
            const facts = await context();
            return categories.map(category => ({ categoryId: category.id, paths: category.roots(facts) }));
        },
        async discoverSnapshot(paths: readonly string[] = [], inUse?: StoragePathUse): Promise<StorageCategoryDiscoverySnapshot> {
            return projectSnapshot(await context(paths, inUse));
        },
        async discoverPage(paths: readonly string[], inUse: StoragePathUse): Promise<readonly StorageCategoryItem[]> {
            // An ancestor of own data is already Forbidden; do not walk its entire
            // inventory just to prove that again. ownData still contributes that fact.
            const roots = (await Promise.all(dataRoots().map(async root =>
                await exists(root) ? await realStoragePathWithAbsentSuffix(root) : undefined))).filter(root => root !== undefined);
            const scope = paths.filter(path => !roots.some(root => storagePathContains(path, root)));
            const snapshot = await projectSnapshot(await context([], inUse, scope));
            return (await Promise.all(snapshot.items.map(async item => {
                // Discovery already recorded denied ancestry as Check. Probing
                // it again cannot prove more and would fail the readable page.
                const physical = item.evidence.includes('directory_permission_unavailable') ? item.path
                    : await physicalStoragePathWithoutFollowingLeaf(item.path);
                return paths.some(path => storagePathContains(path, physical) || storagePathContains(physical, path))
                    ? { ...item, path: physical } : undefined;
            }))).filter(item => item !== undefined);
        },
        async discover(paths: readonly string[] = [], current?: readonly StorageCategoryItem[], suppliedInUse?: StoragePathUse): Promise<readonly StorageCategoryItem[]> {
            if (!current) return (await catalog.discoverSnapshot(paths, suppliedInUse)).items;
            // Indexed aliases keep the same freshly inspected SCM path, even when their item ids differ.
            const missingPaths = paths.filter(path => !current.some(item => item.categoryId === 'worktrees'
                && canonicalAbsolutePathsEqual(item.path, path)));
            if (!missingPaths.length) return current;
            const scanned = await readStorageWorktrees({ cwds: [], candidatePaths: missingPaths,
                knownRoots: current.filter(item => item.categoryId === 'worktrees').map(item => item.path),
                happyHomeDir: deps.happyHomeDir, registry: deps.scmRegistry, trashRoots: deps.trashRoots?.() });
            if (!scanned.length) return current;
            // Only the encountered SCM roots need supplementation. Retained
            // category facts belong to the service snapshot and its owner events.
            const [projectFacts, inUse] = await Promise.all([deps.readProjects?.(), suppliedInUse ?? deps.readInUsePaths?.()]);
            const discoveryIssues: StorageCategoryItem[] = [];
            const supplemental = await readStorageWorktreeItems({ deps, worktrees: scanned,
                projects: (projectFacts?.projects ?? []).filter(project => scanned.some(worktree =>
                    canonicalAbsolutePathsEqual(project.repositoryRoot, worktree.repositoryRoot))),
                inUse: inUse ?? UNAVAILABLE_PATH_USE, sessions: deps.readTrackedSessions?.() ?? [], discoveryIssues });
            const refreshed = [...supplemental, ...discoveryIssues];
            return projectDiscoveredItems([...current.filter(item => !refreshed.some(value => canonicalAbsolutePathsEqual(value.path, item.path))), ...refreshed]);
        },
        descendantCleanupLimitation(path: string, discovered: readonly StorageCategoryItem[]): StorageReasonV1 | null {
            const owner = discovered.find(item => !canonicalAbsolutePathsEqual(item.path, path) && contains(item.path, path)
                && (item.retirementKind === 'common'
                    || categories.find(category => category.id === item.categoryId)?.descendantCleanup === 'whole-item-only'));
            return owner ? { code: 'unsupported', detail: { cause: 'owner_requires_whole_item', categoryId: owner.categoryId, path: owner.path } } : null;
        },
        async cleanupLimitation(path: string, items: readonly StorageCleanupItem[]): Promise<StorageReasonV1 | null> {
            const managedInstall = await managedAcpCacheCleanupLimitation(path, deps);
            if (managedInstall) return managedInstall;
            const projects = await deps.readProjects?.();
            // Project Open also records linked checkout paths as Project roots. Only
            // the exact catalog-bound Git item can distinguish one from a main root.
            const linkedCheckoutKeys = new Set(items.flatMap(item => {
                if (item.categoryId !== 'worktrees' || item.retirementKind !== undefined || !item.repositoryRoot || !item.fingerprint) return [];
                const key = resolveCanonicalAbsolutePath(item.path)?.comparisonKey;
                return key === undefined ? [] : [key];
            }));
            const projectRoots = (projects?.projects ?? []).map(project => project.repositoryRoot).filter(root => {
                const key = resolveCanonicalAbsolutePath(root)?.comparisonKey;
                return key === undefined || !linkedCheckoutKeys.has(key);
            });
            const roots = [...new Set([...projectRoots, ...items.flatMap(item => item.repositoryRoot ? [item.repositoryRoot] : [])])];
            const main = (await Promise.all(roots.map(physicalStoragePathWithoutFollowingLeaf)))
                .find(repositoryRoot => contains(path, repositoryRoot));
            // Never give an unbound container a filesystem bypass around SCM retirement.
            return main && !items.some(item => item.retirementKind === 'main' && canonicalAbsolutePathsEqual(item.path, main)
                && item.fingerprint && item.referenceOwnerData !== undefined)
                ? { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable', owner: 'scm', path: main } } : null;
        },
        async resolveAdapter(item: StorageCleanupItem): Promise<StorageCategoryAdapter> {
            if (item.categoryId === undefined) return bindFilesystemItem(item);
            const category = categories.find(category => category.id === item.categoryId);
            if (!category?.bindAdapter) throw new StorageCategoryAdapterError('owner_unavailable');
            const facts = await context([], undefined, [item.path]);
            const current = (await category.items(facts)).find(candidate => candidate.itemId === (item.canonicalItemId ?? item.itemId)
                && canonicalAbsolutePathsEqual(candidate.path, item.path));
            if (!current) throw new StorageCategoryAdapterError('owner_unavailable');
            return await category.bindAdapter(current, facts);
        },
        async adapterForEntry(categoryId: HappierStorageCategoryIdV1 | undefined, ownerData: JsonValue): Promise<StorageCategoryAdapter> {
            if (categoryId === undefined) return filesystemAdapterForEntry(ownerData);
            const category = categories.find(category => category.id === categoryId);
            if (!category?.adapterForEntry) throw new StorageCategoryAdapterError('owner_unavailable');
            return await category.adapterForEntry(ownerData, deps);
        },
    };
    return catalog;
}
