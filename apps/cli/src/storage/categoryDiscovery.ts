import { tmpdir } from 'node:os';
import { MachineStoragePolicyV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import { readStorageWorktrees } from '@/daemon/resources/readStorageWorktrees';
import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { createStoragePathComparator, realStoragePathWithAbsentSuffix, storagePathContains } from './storagePath';
import { ownData } from './categories/retainedData';
import { temporary } from './categories/temporary';
import { isPermissionError } from './categories/filesystem';
import type { StorageCategoryCatalogDeps, StorageCategoryContext, StorageCategoryDefinition, StoragePathUse, StorageProjectFacts } from './categories/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_POLICY = MachineStoragePolicyV1Schema.parse({});
const UNAVAILABLE_PROJECT_FACTS: StorageProjectFacts = { status: 'unavailable' };
export const UNAVAILABLE_PATH_USE: StoragePathUse = { reliable: false, paths: [] };

/** Catalog-owned fact acquisition, selected before filesystem inventory walks. */
export function createStorageCategoryDiscovery(deps: StorageCategoryCatalogDeps, categories: readonly StorageCategoryDefinition[]) {
    async function selectedCategories(facts: StorageCategoryContext) {
        const scope = facts.discoveryPaths;
        if (!scope) return categories;
        if (!scope.length) return [ownData];
        return (await Promise.all(categories.map(async category => {
            if (category === ownData) return category;
            const roots = [...category.roots(facts), ...(category === temporary ? [deps.tempRoot ?? tmpdir()] : [])];
            let physical: string[];
            try { physical = await Promise.all(roots.map(realStoragePathWithAbsentSuffix)); }
            catch (error) { if (isPermissionError(error)) return category; throw error; }
            return physical.some(root => scope.some(path => storagePathContains(path, root) || storagePathContains(root, path))) ? category : undefined;
        }))).filter(category => category !== undefined);
    }
    const context = async (paths: readonly string[] = [], suppliedInUse?: StoragePathUse, discoveryPaths?: readonly string[]): Promise<StorageCategoryContext> => {
        const now = deps.now?.() ?? Date.now();
        const readInventory = (needed: ReadonlySet<StorageCategoryDefinition['id']>) => Promise.all([
            timeWebLatencyPhase('storage.catalog.allocations', () => needed.has('sessionFolders') ? deps.managedSessionDirectories?.listRecords() ?? [] : []),
            timeWebLatencyPhase('storage.catalog.model-packs', () => needed.has('modelPacks') ? (deps.readModelPackRuntime?.() ?? deps.modelPackRuntime)?.list() ?? deps.readModelPacks?.() ?? [] : []),
            timeWebLatencyPhase('storage.catalog.temporary', () => needed.has('temporary') ? deps.readTemporaryFacts?.() ?? [] : []),
            timeWebLatencyPhase('storage.catalog.isolation', () => needed.has('agentHomes') ? deps.readIsolationFacts?.() ?? [] : []),
            timeWebLatencyPhase('storage.catalog.worktrees', () => discoveryPaths ? [] : deps.readWorktrees?.() ?? []),
        ] as const);
        // Full inventory keeps its original parallel acquisition. Only a page
        // needs to select producers before starting their filesystem work.
        const inventory = discoveryPaths ? undefined : readInventory(new Set(categories.map(category => category.id)));
        // Scoped reads select the category producers before any filesystem inventory
        // or owner metadata walk. Recording locations come from their resident owner.
        const [projectFacts, inUse, recordings, fullInventory] = await Promise.all([
            timeWebLatencyPhase('storage.catalog.projects', () => deps.readProjects?.() ?? UNAVAILABLE_PROJECT_FACTS),
            timeWebLatencyPhase('storage.catalog.in-use', () => suppliedInUse ?? deps.readInUsePaths?.() ?? UNAVAILABLE_PATH_USE),
            timeWebLatencyPhase('storage.catalog.recordings', () => deps.readRecordings?.() ?? []),
            inventory,
        ]);
        const policy = deps.readPolicy?.() ?? DEFAULT_STORAGE_POLICY;
        const base: StorageCategoryContext = { deps, now, pathComparator: createStoragePathComparator(), discoveryPaths,
            unusedBefore: now - policy.suggestUnusedAfterDays * DAY_MS, logRetentionDays: policy.logRetentionDays,
            sessions: deps.readTrackedSessions?.() ?? [], projects: projectFacts.projects ?? [], projectsAvailable: projectFacts.status === 'ready',
            inUse: { ...inUse, paths: [...new Set(inUse.paths)], cwdPaths: [...new Set(inUse.cwdPaths)] },
            allocations: [], modelPacks: [], recordings, temporaryFacts: [], isolationFacts: [], worktrees: [], discoveryIssues: [] };
        const relevant = async (root: string) => {
            if (!discoveryPaths) return true;
            let physical: string;
            try { physical = await realStoragePathWithAbsentSuffix(root); }
            catch (error) { if (isPermissionError(error)) return true; throw error; }
            return discoveryPaths.some(path => storagePathContains(path, physical) || storagePathContains(physical, path));
        };
        const needed = new Set((await selectedCategories(base)).map(category => category.id));
        const [allocations, modelPacks, temporaryFacts, isolationFacts, worktrees] = fullInventory ?? await readInventory(needed);
        const candidates = discoveryPaths ? [...discoveryPaths, ...(await Promise.all(base.projects.map(async project =>
            await relevant(project.repositoryRoot) ? project.repositoryRoot : undefined))).filter(path => path !== undefined)] : paths;
        const missingPaths = candidates.filter(path => !worktrees.some(worktree => canonicalAbsolutePathsEqual(worktree.path, path)));
        const scannedWorktrees = missingPaths.length ? await timeWebLatencyPhase('storage.catalog.scanned-worktrees', () => readStorageWorktrees({ cwds: [], candidatePaths: missingPaths,
            knownRoots: worktrees.map(worktree => worktree.path),
            happyHomeDir: deps.happyHomeDir, registry: deps.scmRegistry, trashRoots: deps.trashRoots?.() })) : [];
        return { ...base, allocations, modelPacks, temporaryFacts, isolationFacts,
            worktrees: [...new Map([...worktrees, ...scannedWorktrees].map(worktree => [worktree.path, worktree])).values()], discoveryIssues: [] };
    };
    return { context, selectedCategories };
}
