import * as React from 'react';

import { Icon } from '@/components/ui/icons/Icon';
import type {
    SelectionListDynamicSectionResolveResult,
    SelectionListOption,
    SelectionListSectionDescriptor,
    SelectionListStep,
} from '@/components/ui/selectionList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { repoScmBranchService } from '@/scm/repository/repoScmBranchService';
import { buildWorktreeRelativePath, type ScmBranchListEntry, type ScmWorktree } from '@happier-dev/protocol';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { resolveWorktreeNameForCommit } from '@/utils/worktree/resolveWorktreeNameForCommit';
import { t } from '@/text';
import { pathsAreSameWorktree } from '@/components/sessions/new/modules/worktreePathComparison';

import { buildExistingWorktreeOptions } from './worktreeExistingOptions';

const WORKTREE_ROW_ICON_SIZE = 16;

/**
 * Option id for the synthetic "New worktree: <name>" row surfaced at the top of
 * the worktree-root step while a git-worktree creation is pending (chosen but
 * not yet materialized). The owning chip points the popover's `selectedOptionId`
 * here so the pending choice is highlighted + scrolled into view on reopen.
 */
export const PENDING_GIT_WORKTREE_OPTION_ID = 'pending_git_worktree';

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
 *     dynamic section. A branch with an existing reusable worktree selects
 *     immediately (`onSelect` → `onReuseExistingWorktreeForBranch`); a branch with
 *     no existing worktree navigates (`openStep`) into the value-mode "name your
 *     worktree" step, which commits the new worktree via `onCreateWorktreeWithName`.
 *
 * Name step (`worktree-name`):
 *   - `inputMode: 'value'`. Typing a name + Enter/return commits the git-sanitized
 *     value; an empty/invalid value falls back to the generated suggestion; the
 *     "use suggested name" row commits the suggestion directly.
 *
 * Branch rows expose `<StatusPill variant="info" />` when a worktree already
 * exists for the branch (the "reuse" signal). Existing worktree rows expose
 * `<RelativeTimeText />` + `<StatusPill />` accessories when SCM provided
 * `lastActivityAt`/`changeCount`.
 */

export type WorktreeBranchSourceKind = 'local' | 'remote';

/**
 * A fully-resolved request to create a new worktree: the base ref to branch
 * from, where that ref came from (local/remote), and the user-chosen (or
 * suggested, already git-sanitized) name for the new branch + worktree.
 */
export type WorktreeCreateSelection = Readonly<{
    baseRef: string;
    sourceKind: WorktreeBranchSourceKind;
    name: string;
}>;

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
    /** Optional machine platform for platform-specific path alias canonicalization. */
    machinePlatform?: string | null;
    /** Effective theme color supplied by the React owner; this pure builder must not import a static base theme. */
    rowIconColor: string;
    /** Caller-supplied "now" for relative-time pills (kept pure / testable). */
    nowMs: number;
    /**
     * Stable suggested name (generated once per session by the owning chip).
     * Pre-populates the "name your worktree" step and is the fallback when the
     * user commits an empty or git-invalid name.
     */
    worktreeNameSuggestion: string;
    onSelectCurrentDir: () => void;
    onSelectExistingWorktree: (worktreePath: string) => void;
    /**
     * Create a new worktree on a NEW branch named `selection.name`, based on
     * `selection.baseRef`. Invoked from the "name your worktree" value step
     * (pushed after a base branch is chosen), so the name is already resolved.
     */
    onCreateWorktreeWithName: (selection: WorktreeCreateSelection) => void;
    onReuseExistingWorktreeForBranch: (info: Readonly<{
        worktreePath: string;
        branch: string;
    }>) => void;
    /**
     * Resolved name of a pending git-worktree creation (chosen but not yet
     * materialized). When set, a selected "New worktree: <name>" row is surfaced
     * at the top of the root step so the pending choice is visible on reopen.
     * `null`/omitted when no creation is pending.
     */
    pendingWorktreeName?: string | null;
    /**
     * Base ref the pending worktree will branch from (e.g. `main`, `origin/dev`).
     * Surfaced in the pending row subtitle ("From <baseRef> · <predicted path>")
     * so the user can see both the source branch and where the worktree lands.
     * `null`/omitted falls back to showing the predicted path alone.
     */
    pendingWorktreeBaseRef?: string | null;
    /** Re-affirm the pending "New worktree" row (it is already the selection). */
    onSelectPendingWorktree?: () => void;
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
 * Build the "name your worktree" step pushed after a base branch is chosen for
 * a NEW worktree. Carries its own commit closure (over `baseRef`/`sourceKind`)
 * through the otherwise-stateless step tree:
 *  - a synthesized **"Create worktree: <typed>"** row reflects the live input
 *    and is the default-focused row while typing (Enter / return / tap all
 *    create the custom-named worktree and close the popover),
 *  - "Use suggested name: <name>" commits the generated suggestion,
 *  - a non-interactive hint row signals that a custom name can be typed,
 *  - an empty / git-invalid input falls back to the suggestion on commit.
 */
export function buildWorktreeNameStep(params: Readonly<{
    baseRef: string;
    sourceKind: WorktreeBranchSourceKind;
    worktreeNameSuggestion: string;
    rowIconColor: string;
    onCreateWorktreeWithName: WorktreeSelectionListBuilderParams['onCreateWorktreeWithName'];
}>): SelectionListStep {
    const { baseRef, sourceKind, worktreeNameSuggestion, rowIconColor, onCreateWorktreeWithName } = params;
    const create = (name: string) => onCreateWorktreeWithName({ baseRef, sourceKind, name });

    return {
        id: 'worktree-name',
        title: t('newSession.worktree.nameStep.title'),
        backLabel: t('newSession.worktree.nameStep.backLabel'),
        inputPlaceholder: t('newSession.worktree.nameStep.placeholder'),
        inputMode: 'value',
        // The input is the candidate NAME, not a search query, so don't narrow
        // the rows by it — the "Use suggested name" row must stay visible while
        // the user types a custom value (the selection just moves to the live
        // "Create …" row, see `resolveDefaultFocusedOptionId`).
        disableInputFilter: true,
        // Default focus follows the input: the suggested-name row while empty
        // (so Enter accepts the suggestion and the highlight matches what gets
        // created), then the live "Create …" row once the user types.
        resolveDefaultFocusedOptionId: (input) =>
            (input.trim().length > 0 ? 'worktree-name-create' : 'worktree-name-suggested'),
        onCommitInputValue: (raw) => create(resolveWorktreeNameForCommit(raw, worktreeNameSuggestion)),
        // The custom-name row is ALWAYS present (the first synthesized input row).
        // While the field is empty it is a PROMPT, not a commit: activating it
        // (tap / Enter) sets `requiresInputValue`, so SelectionList focuses +
        // shakes the input instead of silently creating the suggestion (the prior
        // behavior, which was confusing — the row says "type a name" yet created
        // "<suggestion>"). Accepting the suggestion is the separate suggested-name
        // row. Once the user types, the row transforms into a live
        // "Create worktree: <sanitized>" row whose activation commits that name.
        buildInputRow: (input) => {
            const hasInput = input.trim().length > 0;
            if (!hasInput) {
                return {
                    id: 'worktree-name-create',
                    label: t('newSession.worktree.nameStep.customHint'),
                    icon: <Icon name="pencil-simple" size={WORKTREE_ROW_ICON_SIZE} color={rowIconColor} />,
                    requiresInputValue: true,
                };
            }
            const name = resolveWorktreeNameForCommit(input, worktreeNameSuggestion);
            return {
                id: 'worktree-name-create',
                label: t('newSession.worktree.nameStep.createNamed', { name }),
                icon: <Icon name="plus-circle" size={WORKTREE_ROW_ICON_SIZE} color={rowIconColor} />,
                onSelect: () => create(name),
            };
        },
        sections: [
            {
                kind: 'static',
                id: 'worktree:name:suggested',
                title: t('newSession.worktree.nameStep.suggestedSectionTitle'),
                options: [
                    {
                        id: 'worktree-name-suggested',
                        label: t('newSession.worktree.nameStep.useSuggested', { name: worktreeNameSuggestion }),
                        icon: <Icon name="sparkle" size={WORKTREE_ROW_ICON_SIZE} color={rowIconColor} />,
                        onSelect: () => create(worktreeNameSuggestion),
                    },
                ],
            },
        ],
        footerHints: [
            { id: 'enter', label: '↵', description: t('newSession.worktree.nameStep.hints.create') },
            { id: 'esc', label: 'Esc', description: t('newSession.worktree.nameStep.hints.back') },
        ],
    };
}

/**
 * Build the "branch already has a worktree" choice step. Git allows only one
 * worktree per branch, so a branch with an existing worktree offers either:
 *  - **Use existing worktree** — switch to it (the previous immediate-reuse
 *    behavior), or
 *  - **Create new worktree from this branch** — branch off that ref into a NEW
 *    named worktree (→ the name step with `baseRef` = the branch).
 */
export function buildWorktreeReuseOrCreateStep(params: Readonly<{
    existingWorktreePath: string;
    existingBranch: string;
    baseRef: string;
    sourceKind: WorktreeBranchSourceKind;
    worktreeNameSuggestion: string;
    rowIconColor: string;
    onCreateWorktreeWithName: WorktreeSelectionListBuilderParams['onCreateWorktreeWithName'];
    onReuseExistingWorktreeForBranch: WorktreeSelectionListBuilderParams['onReuseExistingWorktreeForBranch'];
}>): SelectionListStep {
    return {
        id: 'worktree-reuse-or-create',
        title: t('newSession.worktree.reuseOrCreate.title'),
        backLabel: t('newSession.worktree.nameStep.backLabel'),
        sections: [
            {
                kind: 'static',
                id: 'worktree:reuse-or-create',
                options: [
                    {
                        id: 'worktree-reuse-existing',
                        label: t('newSession.worktree.reuseOrCreate.useExisting'),
                        subtitle: params.existingWorktreePath,
                        icon: <Icon name="stack-simple" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
                        onSelect: () => params.onReuseExistingWorktreeForBranch({
                            worktreePath: params.existingWorktreePath,
                            branch: params.existingBranch,
                        }),
                    },
                    {
                        id: 'worktree-create-from-branch',
                        label: t('newSession.worktree.reuseOrCreate.createNew'),
                        subtitle: t('newSession.worktree.reuseOrCreate.createNewSubtitle'),
                        icon: <Icon name="plus-circle" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
                        openStep: buildWorktreeNameStep({
                            baseRef: params.baseRef,
                            sourceKind: params.sourceKind,
                            worktreeNameSuggestion: params.worktreeNameSuggestion,
                            rowIconColor: params.rowIconColor,
                            onCreateWorktreeWithName: params.onCreateWorktreeWithName,
                        }),
                    },
                ],
            },
        ],
        footerHints: [
            { id: 'navigate', label: '↑↓', description: t('newSession.worktree.hints.navigate') },
            { id: 'enter', label: '↵', description: t('newSession.worktree.hints.select') },
            { id: 'esc', label: 'Esc', description: t('newSession.worktree.nameStep.hints.back') },
        ],
    };
}

/**
 * Build a single branch row option. Exposed so unit tests can validate the
 * reuse-vs-create routing without invoking the live dynamic resolver.
 *
 * A branch with an existing worktree NAVIGATES into the reuse-or-create choice
 * step (`openStep`) — use the existing worktree, or branch off into a new named
 * one. A branch with no existing worktree navigates straight into the name
 * step. Either way the whole flow stays inside the keyboard-navigable
 * SelectionList.
 */
export function buildWorktreeBranchOption(params: Readonly<{
    branch: ScmBranchListEntry;
    snapshot: ScmWorkingSnapshot | null;
    currentDirPath: string;
    machineHomeDir?: string | null;
    machinePlatform?: string | null;
    /**
     * Optional list of remote names (e.g. `['origin', 'upstream']`). When provided,
     * a remote-tracking branch row like `origin/feature` will be matched against a
     * local worktree on `feature` for reuse routing. Defaults to the names found
     * in the snapshot's `repo.remotes`.
     */
    remoteNames?: ReadonlyArray<string>;
    rowIconColor: string;
    worktreeNameSuggestion: string;
    onCreateWorktreeWithName: WorktreeSelectionListBuilderParams['onCreateWorktreeWithName'];
    onReuseExistingWorktreeForBranch: WorktreeSelectionListBuilderParams['onReuseExistingWorktreeForBranch'];
}>): SelectionListOption {
    const sourceKind: WorktreeBranchSourceKind = params.branch.type === 'remote' ? 'remote' : 'local';
    const remoteNames = params.remoteNames ?? resolveRemoteNamesFromSnapshot(params.snapshot);
    const existingWorktree = findWorktreeForBranch(params.snapshot, params.branch.name, remoteNames);
    // Canonical comparison so trailing slashes / separators / tilde-expansion don't trick us into
    // routing through "reuse" when the existing worktree IS the canonical current dir.
    const willReuse = existingWorktree !== null
        && !pathsAreSameWorktree(
            existingWorktree.path,
            params.currentDirPath,
            params.machineHomeDir,
            params.machinePlatform,
        );

    const subtitle = willReuse
        ? t('newSession.worktree.branchRow.reuseSubtitle', { path: existingWorktree!.path })
        : params.branch.upstream
            ? t('files.branchMenu.branch.upstream', { upstream: params.branch.upstream })
            : params.branch.type === 'remote'
                ? t('files.branchMenu.category.remote')
                : undefined;

    const base = {
        id: `branch:${params.branch.type}:${params.branch.name}`,
        label: params.branch.name,
        subtitle,
        icon: <Icon name="git-branch" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
    } as const;

    if (willReuse && existingWorktree !== null) {
        return {
            ...base,
            // A "Worktree" badge flags that this branch already has a worktree;
            // the row still navigates to the reuse-or-create choice step, so we
            // keep the chevron visible alongside the badge (the badge alone read
            // as a terminal "open it" action).
            rightAccessory: React.createElement(StatusPill, {
                variant: 'info',
                label: t('newSession.worktree.branchRow.reuseLabel'),
                hideDot: true,
                testID: `worktree-branch-reuse:${params.branch.name}`,
            }),
            keepChevronWithAccessory: true,
            openStep: buildWorktreeReuseOrCreateStep({
                existingWorktreePath: existingWorktree.path,
                existingBranch: existingWorktree.branch ?? params.branch.name,
                baseRef: params.branch.name,
                sourceKind,
                worktreeNameSuggestion: params.worktreeNameSuggestion,
                rowIconColor: params.rowIconColor,
                onCreateWorktreeWithName: params.onCreateWorktreeWithName,
                onReuseExistingWorktreeForBranch: params.onReuseExistingWorktreeForBranch,
            }),
        };
    }

    return {
        ...base,
        openStep: buildWorktreeNameStep({
            baseRef: params.branch.name,
            sourceKind,
            worktreeNameSuggestion: params.worktreeNameSuggestion,
            rowIconColor: params.rowIconColor,
            onCreateWorktreeWithName: params.onCreateWorktreeWithName,
        }),
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
                    machinePlatform: params.machinePlatform,
                    remoteNames,
                    rowIconColor: params.rowIconColor,
                    worktreeNameSuggestion: params.worktreeNameSuggestion,
                    onCreateWorktreeWithName: params.onCreateWorktreeWithName,
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
            // let the orchestrator switch to the virtualized backend past the threshold.
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
            icon: <Icon name="folder" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
            onSelect: params.onSelectCurrentDir,
        },
        {
            id: 'create_git_worktree',
            label: t('newSession.checkout.newWorktree'),
            subtitle: t('newSession.checkout.newWorktreeSubtitle'),
            icon: <Icon name="plus-circle" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
            openStep: createStep,
        },
    ];

    const existingOptions = buildExistingWorktreeOptions(params);

    const sections: SelectionListSectionDescriptor[] = [];

    // A pending git-worktree creation has no real worktree yet, so surface a
    // selected "New worktree: <name>" row at the very top — this is what the
    // popover highlights + scrolls to on reopen (the chip points
    // `selectedOptionId` at `PENDING_GIT_WORKTREE_OPTION_ID`). The subtitle shows
    // the source branch + the predicted on-disk location so the choice is fully
    // legible before it materializes; the path is derived from the SAME shared
    // `buildWorktreeRelativePath` convention the daemon uses for `git worktree
    // add`, so the preview can't drift from where the worktree actually lands.
    if (params.pendingWorktreeName) {
        const repoRootPath = params.snapshot?.repo.rootPath ?? params.machinePath ?? '';
        const relativeWorktreePath = buildWorktreeRelativePath(params.pendingWorktreeName);
        const predictedWorktreePath = repoRootPath
            ? `${repoRootPath.replace(/[\\/]+$/, '')}/${relativeWorktreePath}`
            : relativeWorktreePath;
        const predictedDisplayPath = formatPathRelativeToHome(
            predictedWorktreePath,
            params.machineHomeDir ?? undefined,
        );
        const pendingSubtitle = params.pendingWorktreeBaseRef
            ? t('newSession.checkout.pendingWorktreeSubtitle', {
                branch: params.pendingWorktreeBaseRef,
                path: predictedDisplayPath,
            })
            : predictedDisplayPath;
        sections.push({
            kind: 'static',
            id: 'worktree:pending',
            options: [
                {
                    id: PENDING_GIT_WORKTREE_OPTION_ID,
                    label: `${t('newSession.checkout.newWorktree')}: ${params.pendingWorktreeName}`,
                    subtitle: pendingSubtitle,
                    icon: <Icon name="plus-circle" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
                    onSelect: params.onSelectPendingWorktree ?? (() => {}),
                },
            ],
        });
    }

    sections.push({
        kind: 'static',
        id: 'worktree:quick-actions',
        title: t('newSession.checkout.actionsSectionTitle'),
        options: quickActions,
    });

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
