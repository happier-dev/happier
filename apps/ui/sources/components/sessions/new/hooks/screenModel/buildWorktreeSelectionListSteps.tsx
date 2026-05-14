import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type {
    SelectionListDynamicSectionResolveResult,
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import type { ScmBranchListEntry, ScmWorktree } from '@happier-dev/protocol';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { t } from '@/text';

import { buildExistingWorktreeOptions } from './worktreeExistingOptions';
import { pathsAreSameWorktree } from './worktreePathComparison';

const WORKTREE_ROW_ICON_SIZE = 16;

/**
 * Worktree picker SelectionList step builder.
 *
 * Builds the `SelectionListStep` tree consumed by the worktree popover. The
 * root step exposes:
 *   - QUICK_ACTIONS: "Use current directory" + "Create new worktree from…" (drill-down).
 *   - EXISTING_WORKTREES: one row per repo worktree (excluding the main / current-dir entry).
 *
 * Drill-down step (`worktree-create`):
 *   - LOCAL_BRANCHES + REMOTE_BRANCHES, populated via `repoScmBranchService` as a
 *     dynamic section. Each row's `onSelect` routes through either
 *     `onReuseExistingWorktreeForBranch` (when an existing worktree references
 *     that branch) or `onSelectBranchForNewWorktree`.
 *
 * Branch rows expose `<StatusPill variant="info" />` when a worktree already
 * exists for the branch (the "reuse" signal). Existing worktree rows expose
 * `<RelativeTimeText />` + `<StatusPill />` accessories when SCM provided
 * `lastActivityAt`/`changeCount`.
 */

export type WorktreeBranchSourceKind = 'local' | 'remote';

export type WorktreeSelectionListBuilderParams = Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    /** Current selected path in the new-session screen; used to elide self-rows + reuse path matching. */
    currentDirPath: string;
    /** Machine bound to the new-session screen; null disables branch loading. */
    machineId: string | null;
    /** Path on the machine used to scope branch queries (usually the repo root). */
    machinePath: string | null;
    /**
     * Optional machine home directory (e.g. `/Users/leeroy`, `C:\\Users\\leeroy`). When provided,
     * tilde-prefixed `currentDirPath`/worktree paths are expanded before canonical comparison so
     * `~/foo` and `/Users/leeroy/foo` match for self-row suppression and reuse routing.
     */
    machineHomeDir?: string | null;
    /** Effective theme color supplied by the React owner; this pure builder must not import a static base theme. */
    rowIconColor: string;
    /** Caller-supplied "now" for relative-time pills (kept pure / testable). */
    nowMs: number;
    onSelectCurrentDir: () => void;
    onSelectExistingWorktree: (worktreePath: string) => void;
    onSelectBranchForNewWorktree: (selection: Readonly<{
        branchName: string;
        sourceKind: WorktreeBranchSourceKind;
    }>) => void;
    onReuseExistingWorktreeForBranch: (info: Readonly<{
        worktreePath: string;
        branch: string;
    }>) => void;
}>;

/**
 * Strip a known remote prefix from a branch name (e.g. `origin/feature` → `feature`,
 * `upstream/feature/login` → `feature/login`). Returns the original name when no
 * remote name from {@link remoteNames} matches as the leading path segment(s).
 *
 * This allows the reuse-detection logic to canonically compare a remote-tracking
 * branch row (`origin/feature`) against a local worktree branch (`feature`),
 * which would otherwise differ even though they refer to the same conceptual
 * branch (per `git worktree list --porcelain`, local worktree branches are
 * normalized by stripping `refs/heads/` only — see `worktreeListParser.ts`).
 *
 * Important: only known remote names from the snapshot's `remotes` array (and
 * the conventional `origin` fallback) are stripped. Branches like `feature/login`
 * (a local branch with a slash) are returned unchanged when their leading
 * segment doesn't match any known remote.
 */
function stripKnownRemotePrefix(
    branchName: string,
    remoteNames: ReadonlyArray<string>,
): string {
    if (!branchName || remoteNames.length === 0) return branchName;
    for (const remoteName of remoteNames) {
        if (!remoteName) continue;
        const prefix = `${remoteName}/`;
        if (branchName.startsWith(prefix) && branchName.length > prefix.length) {
            return branchName.slice(prefix.length);
        }
    }
    return branchName;
}

function resolveRemoteNamesFromSnapshot(snapshot: ScmWorkingSnapshot | null): ReadonlyArray<string> {
    const fromSnapshot = snapshot?.repo.remotes ?? [];
    const names = new Set<string>();
    for (const remote of fromSnapshot) {
        if (remote && typeof remote.name === 'string' && remote.name.length > 0) {
            names.add(remote.name);
        }
    }
    if (names.size === 0) {
        // RV-10/F5: fall back to the conventional `origin` name when the snapshot has no
        // remotes listed (offline boot, partial fetch, fresh clone). Without this default,
        // `stripKnownRemotePrefix` cannot canonicalize remote-tracking branch rows like
        // `origin/feature` to a local branch `feature`, so the row would route to "create"
        // instead of reusing the existing local worktree. `origin` is the universal default
        // primary-remote name git assigns, so this fallback matches user expectation.
        return ['origin'];
    }
    return [...names];
}

function findWorktreeForBranch(
    snapshot: ScmWorkingSnapshot | null,
    branchName: string,
    remoteNames: ReadonlyArray<string>,
): ScmWorktree | null {
    const worktrees = snapshot?.repo.worktrees ?? [];
    if (worktrees.length === 0) return null;
    // First pass: exact match (covers local branches and remote rows where the
    // local worktree happens to be on the qualified ref).
    for (const worktree of worktrees) {
        if (worktree.branch === branchName) return worktree;
    }
    // Second pass: canonical match — strip a known remote prefix from the row
    // name and look for a local worktree on that branch. This is the F5 fix.
    const canonical = stripKnownRemotePrefix(branchName, remoteNames);
    if (canonical === branchName) return null;
    for (const worktree of worktrees) {
        if (worktree.branch === canonical) return worktree;
    }
    return null;
}

/**
 * Build a single branch row option. Exposed so unit tests can validate the
 * reuse-vs-create routing without invoking the live dynamic resolver.
 */
export function buildWorktreeBranchOption(params: Readonly<{
    branch: ScmBranchListEntry;
    snapshot: ScmWorkingSnapshot | null;
    currentDirPath: string;
    machineHomeDir?: string | null;
    /**
     * Optional list of remote names (e.g. `['origin', 'upstream']`). When provided,
     * a remote-tracking branch row like `origin/feature` will be matched against a
     * local worktree on `feature` for reuse routing. Defaults to the names found
     * in the snapshot's `repo.remotes`.
     */
    remoteNames?: ReadonlyArray<string>;
    rowIconColor: string;
    onSelectBranchForNewWorktree: WorktreeSelectionListBuilderParams['onSelectBranchForNewWorktree'];
    onReuseExistingWorktreeForBranch: WorktreeSelectionListBuilderParams['onReuseExistingWorktreeForBranch'];
}>): SelectionListOption {
    const sourceKind: WorktreeBranchSourceKind = params.branch.type === 'remote' ? 'remote' : 'local';
    const remoteNames = params.remoteNames ?? resolveRemoteNamesFromSnapshot(params.snapshot);
    const existingWorktree = findWorktreeForBranch(params.snapshot, params.branch.name, remoteNames);
    // Canonical comparison so trailing slashes / separators / tilde-expansion don't trick us into
    // routing through "reuse" when the existing worktree IS the canonical current dir.
    const willReuse = existingWorktree !== null
        && !pathsAreSameWorktree(existingWorktree.path, params.currentDirPath, params.machineHomeDir);

    const subtitle = willReuse
        ? t('newSession.worktree.branchRow.reuseSubtitle', { path: existingWorktree!.path })
        : params.branch.upstream
            ? t('files.branchMenu.branch.upstream', { upstream: params.branch.upstream })
            : params.branch.type === 'remote'
                ? t('files.branchMenu.category.remote')
                : undefined;

    return {
        id: `branch:${params.branch.type}:${params.branch.name}`,
        label: params.branch.name,
        subtitle,
        icon: React.createElement(Ionicons, {
            name: 'git-branch-outline',
            size: WORKTREE_ROW_ICON_SIZE,
            color: params.rowIconColor,
        }),
        rightAccessory: willReuse
            ? React.createElement(StatusPill, {
                variant: 'info',
                label: t('newSession.worktree.branchRow.reuseLabel'),
                hideDot: true,
                testID: `worktree-branch-reuse:${params.branch.name}`,
            })
            : undefined,
        onSelect: () => {
            if (willReuse && existingWorktree !== null) {
                params.onReuseExistingWorktreeForBranch({
                    worktreePath: existingWorktree.path,
                    branch: existingWorktree.branch ?? params.branch.name,
                });
                return;
            }
            params.onSelectBranchForNewWorktree({
                branchName: params.branch.name,
                sourceKind,
            });
        },
    };
}

function buildBranchesResolver(params: WorktreeSelectionListBuilderParams, opts: Readonly<{ includeRemotes: boolean }>) {
    const remoteNames = resolveRemoteNamesFromSnapshot(params.snapshot);
    return async (_seed: string, _abortSignal: AbortSignal): Promise<SelectionListDynamicSectionResolveResult> => {
        if (params.machineId === null || params.machinePath === null) {
            return { options: [] };
        }
        const branches = await repoScmBranchService.fetchBranchesForMachinePath({
            machineId: params.machineId,
            path: params.machinePath,
            includeRemotes: opts.includeRemotes,
        });
        return {
            options: branches
                .filter((branch) => (opts.includeRemotes ? branch.type === 'remote' : branch.type !== 'remote'))
                .map((branch) => buildWorktreeBranchOption({
                    branch,
                    snapshot: params.snapshot,
                    currentDirPath: params.currentDirPath,
                    machineHomeDir: params.machineHomeDir,
                    remoteNames,
                    rowIconColor: params.rowIconColor,
                    onSelectBranchForNewWorktree: params.onSelectBranchForNewWorktree,
                    onReuseExistingWorktreeForBranch: params.onReuseExistingWorktreeForBranch,
                })),
        };
    };
}

function buildCreateWorktreeStep(params: WorktreeSelectionListBuilderParams): SelectionListStep {
    const localResolver = buildBranchesResolver(params, { includeRemotes: false });
    const remoteResolver = buildBranchesResolver(params, { includeRemotes: true });
    // FR3-6: scope the dynamic-section cache (cross-mount cache key in
    // `useSelectionListDynamicSections.ts` falls back to `${id}::${id}::${seed}`
    // when `resolverKey` is absent — which is the SAME across every repo + machine
    // pair). Without an explicit key, switching machine or repo would surface
    // stale branch rows from the previous binding. Canonicalize `machinePath`
    // so trailing-slash / separator variants collapse to a single key.
    const canonicalMachinePath = params.machinePath !== null
        ? (normalizeFileSystemPath(params.machinePath) ?? params.machinePath)
        : null;
    const branchResolverKey = params.machineId === null
        ? 'no-machine'
        : `${params.machineId}::${canonicalMachinePath ?? ''}`;

    // FR4-8: the branch resolvers ignore the input seed (they always fetch the
    // full local/remote branch list for the bound machine+repo), so we explicitly
    // collapse every input variant to the empty seed. Without `seedFromInput`,
    // `useSelectionListDynamicSections.ts` derives the seed from raw input and bakes
    // it into the cache key, causing the resolver to refire on every keystroke even
    // though filtering is client-side (handled by the render-plan input filter).
    const stableEmptySeed = (): string => '';

    const sections: ReadonlyArray<SelectionListSectionDescriptor> = [
        {
            kind: 'dynamic',
            id: 'worktree:branches:local',
            title: t('newSession.worktree.sections.localBranches'),
            // Local branch lists can grow large, so opt into automatic virtualization and
            // let the orchestrator switch to FlashList past the threshold.
            virtualization: 'auto',
            // The create-worktree drilldown is dynamic-only, so keep loading skeletons
            // visible on an uncached first load instead of collapsing the list body.
            showSkeletonsOnFirstLoad: true,
            resolverKey: branchResolverKey,
            seedFromInput: stableEmptySeed,
            resolve: localResolver,
        },
        {
            kind: 'dynamic',
            id: 'worktree:branches:remote',
            title: t('newSession.worktree.sections.remoteBranches'),
            // RV-10/F4: same rationale as the local section — remote-tracking refs commonly
            // outnumber local branches and benefit even more from windowed rendering.
            virtualization: 'auto',
            // The create-worktree drilldown is dynamic-only, so keep loading skeletons
            // visible on an uncached first load instead of collapsing the list body.
            showSkeletonsOnFirstLoad: true,
            resolverKey: branchResolverKey,
            seedFromInput: stableEmptySeed,
            resolve: remoteResolver,
        },
    ];

    return {
        id: 'worktree-create',
        title: t('newSession.worktree.createTitle'),
        backLabel: t('newSession.worktree.backToRoot'),
        inputPlaceholder: t('newSession.worktree.searchBranchPlaceholder'),
        sections,
        footerHints: [
            { id: 'navigate', label: '↑↓', description: t('newSession.worktree.hints.navigate') },
            { id: 'enter', label: '↵', description: t('newSession.worktree.hints.select') },
            { id: 'esc', label: 'Esc', description: t('newSession.worktree.hints.back') },
        ],
    };
}

export function buildWorktreeSelectionListSteps(params: WorktreeSelectionListBuilderParams): SelectionListStep {
    const createStep = buildCreateWorktreeStep(params);

    const quickActions: SelectionListOption[] = [
        {
            id: 'current_path',
            label: t('newSession.checkout.noWorktree'),
            subtitle: params.currentDirPath || undefined,
            icon: React.createElement(Ionicons, {
                name: 'folder-outline',
                size: WORKTREE_ROW_ICON_SIZE,
                color: params.rowIconColor,
            }),
            onSelect: params.onSelectCurrentDir,
        },
        {
            id: 'create_git_worktree',
            label: t('newSession.checkout.newWorktree'),
            subtitle: t('newSession.checkout.newWorktreeSubtitle'),
            icon: React.createElement(Ionicons, {
                name: 'add-circle-outline',
                size: WORKTREE_ROW_ICON_SIZE,
                color: params.rowIconColor,
            }),
            openStep: createStep,
        },
    ];

    const existingOptions = buildExistingWorktreeOptions(params);

    const sections: SelectionListSectionDescriptor[] = [
        {
            kind: 'static',
            id: 'worktree:quick-actions',
            title: t('newSession.checkout.actionsSectionTitle'),
            options: quickActions,
        },
    ];

    if (existingOptions.length > 0) {
        sections.push({
            kind: 'static',
            id: 'worktree:existing',
            title: t('newSession.checkout.existingWorktreesSectionTitle'),
            options: existingOptions,
        });
    }

    return {
        id: 'worktree-root',
        title: t('newSession.checkout.selectTitle'),
        inputPlaceholder: t('newSession.worktree.searchPlaceholder'),
        sections,
        footerHints: [
            { id: 'navigate', label: '↑↓', description: t('newSession.worktree.hints.navigate') },
            { id: 'enter', label: '↵', description: t('newSession.worktree.hints.select') },
        ],
    };
}
