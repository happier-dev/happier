import { PluginError } from '@happier-dev/plugin-sdk';
import { TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 } from '@happier-dev/triage-protocol/v1';
import { resolveLaunchProfilePlacementDirectoryIntentV1, type LaunchProfilePlacementPreferenceV1, type LaunchProfileCheckoutPreferenceV1, type SessionDirectoryIntentV1 } from '@happier-dev/plugin-sdk/protocol';
import {
    resolveTriageLaunchPlacementV1,
    resolveTriageLaunchCandidatesV1,
    type TriageForgeIdentityV1,
    type TriageLaunchPlacementV1,
    type TriageProjectCandidateV1,
} from './launchPlacement.js';
import type { TriageWorkspaceModeV1 } from './entrySessionWorkspace.js';

/**
 * The ONE precedence rule two owners of placement produce (`PLAN.md` §0a A8).
 *
 * A Triage action declares what it needs on disk; a Launch Profile states where
 * its author prefers Sessions to run. Both are legitimate, and without a stated
 * order the same press resolves differently depending on which one a reader
 * happens to look at. The order is:
 *
 * ```
 * action workspaceMode requirement
 *   -> profile placement/checkout preference
 *     -> currently reachable repository candidates
 *       -> exactly one reachable match launches directly
 *         -> otherwise New Session prefill
 * ```
 *
 * **A profile preference never weakens an action's workspace requirement.** A
 * pull-request repair that requires the source-prepared review workspace cannot
 * be downgraded to a reused checkout because a profile says `reuse_workspace`,
 * and a reference-only action does not acquire a worktree because a profile
 * says `create_worktree`. The action states what the work needs; the profile
 * states a preference among the ways that requirement can be met, and a
 * requirement with exactly one way to be met leaves the preference nothing to
 * choose. That is the whole rule, and it lives here rather than at each caller.
 *
 * This module builds nothing and reads nothing. It composes the placement join
 * (`launchPlacement.ts`) with the profile's two preferences and returns one
 * decision; the join stays the sole owner of which project matches a repository.
 */

/**
 * The profile's own placement preference, in the canonical vocabulary
 * `LaunchProfileV2` publishes (`packages/protocol/src/profiles/v2/schema.ts`).
 * It is a PREFERENCE, never a stored resolution.
 */
export type TriageProfilePlacementPreferenceV1 = LaunchProfilePlacementPreferenceV1;
export type TriageProfileCheckoutPreferenceV1 = LaunchProfileCheckoutPreferenceV1;

/**
 * What the pressed action's Launch Profile contributes to the placement
 * decision. Every member is optional because a profile need not state one, and
 * an absent preference is "no preference", never "prefer nothing".
 */
export type TriageActionProfilePreferencesV1 = Readonly<{
    placement?: TriageProfilePlacementPreferenceV1;
    checkout?: TriageProfileCheckoutPreferenceV1;
}>;

/**
 * How the checkout question is answered for one press.
 *
 * `preparedReviewWorkspace` and `none` are REQUIREMENTS the action's mode
 * states, not preferences: the profile is not consulted for them, because there
 * is exactly one way to satisfy each. Only `repository` leaves a real choice,
 * and that is the one case the profile decides.
 */
export type TriageActionCheckoutResolutionV1 =
    /** `reference_only`: nothing is materialized, so there is no checkout to choose. */
    | 'none'
    /** `pull_request`: the source-prepared review workspace, and only that. */
    | 'preparedReviewWorkspace'
    | 'reuseWorkspace'
    | 'createWorktree'
    /** `repository` with a profile that asks: the reader picks at the surface. */
    | 'ask';

export function resolveTriageActionCheckoutV1(
    workspaceMode: TriageWorkspaceModeV1,
    profile?: TriageActionProfilePreferencesV1,
): TriageActionCheckoutResolutionV1 {
    // The action's requirement is read FIRST and terminates the decision. A
    // profile that says `reuse_workspace` is stating a preference among ways to
    // obtain a checkout; a pull-request repair has exactly one, and a
    // reference-only action has none at all.
    if (workspaceMode === 'reference_only') return 'none';
    if (workspaceMode === 'pull_request') return 'preparedReviewWorkspace';
    switch (profile?.checkout) {
        case 'create_worktree': return 'createWorktree';
        case 'ask': return 'ask';
        // An absent preference reuses the selected project's own checkout,
        // which is exactly what `repository` has always materialized.
        default: return 'reuseWorkspace';
    }
}

export type TriageActionPlacementV1 =
    /** One place to run, stated by the profile rather than inferred. */
    | Readonly<{
        kind: 'pinned';
        target: Readonly<{ serverId: string; machineId: string }>;
        directory?: string;
        directoryIntent?: SessionDirectoryIntentV1;
        candidates: Extract<TriageLaunchPlacementV1, { kind: 'prefill' }>['candidates'];
    }>
    /** The join resolved exactly one reachable checkout. */
    | Readonly<{ kind: 'launch'; candidate: Extract<TriageLaunchPlacementV1, { kind: 'launch' }>['candidate'] }>
    | Readonly<{
        kind: 'prefill';
        /**
         * `profileAsk` is deliberately its own reason: nothing failed, the
         * profile's author asked to be asked, and telling a reader "no checkout
         * matched" when their own profile requested the screen would be false.
         */
        reason: 'profileAsk' | Extract<TriageLaunchPlacementV1, { kind: 'prefill' }>['reason'];
        candidates: Extract<TriageLaunchPlacementV1, { kind: 'prefill' }>['candidates'];
    }>;

/** A required source checkout cannot be replaced by a private no-folder directory. */
export function readTriageActionDirectoryRefusalV1(
    workspaceMode: TriageWorkspaceModeV1,
    directoryIntent: SessionDirectoryIntentV1 | undefined,
): typeof TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 | undefined {
    return directoryIntent?.kind === 'managed' && workspaceMode !== 'reference_only'
        ? TRIAGE_SAVE_ACTION_DEFAULTS_WORKSPACE_MODE_REASON_V1 : undefined;
}

export function resolveTriageActionPlacementV1(input: Readonly<{
    /** The pressed action's declared mode. Read first, and never overridden. */
    workspaceMode: TriageWorkspaceModeV1;
    profile?: TriageActionProfilePreferencesV1;
    /** The entry's own repository, when its source declared one. */
    forge?: TriageForgeIdentityV1;
    projects: readonly TriageProjectCandidateV1[];
    /**
     * Whether `projects` is the whole registry, as its reader reported
     * (`sessions/projectCandidates.ts`). It is forwarded rather than
     * re-derived: the join owns what a partial registry may and may not
     * conclude, and a second opinion here would be a second exactness rule.
     */
    registryComplete?: boolean;
}>): TriageActionPlacementV1 {
    const preference = input.profile?.placement;

    // A pinned machine is a stated choice; its directory intent must still
    // satisfy the action's workspace requirement. For pull requests, pinning
    // chooses the machine that prepares the source workspace.
    if (preference !== undefined && preference !== 'automatic' && preference !== 'ask') {
        const directoryIntent = resolveLaunchProfilePlacementDirectoryIntentV1(preference);
        const refusal = readTriageActionDirectoryRefusalV1(input.workspaceMode, directoryIntent);
        if (refusal) throw new PluginError({ code: 'invalid_parameters',
            diagnostics: [{ code: refusal, severity: 'error' }] });
        return {
            kind: 'pinned',
            target: preference.fixed,
            candidates: resolveTriageLaunchCandidatesV1(input),
            ...(directoryIntent?.kind === 'path' ? { directory: directoryIntent.path }
                : directoryIntent === undefined ? {} : { directoryIntent }),
        };
    }

    if (preference === 'ask') return { kind: 'prefill', reason: 'profileAsk', candidates: resolveTriageLaunchCandidatesV1(input) };

    const placement = resolveTriageLaunchPlacementV1({
        ...(input.forge === undefined ? {} : { forge: input.forge }),
        projects: input.projects,
        ...(input.registryComplete === undefined ? {} : { registryComplete: input.registryComplete }),
    });
    return placement.kind === 'launch'
        ? { kind: 'launch', candidate: placement.candidate }
        : { kind: 'prefill', reason: placement.reason, candidates: placement.candidates };
}

/**
 * Where a settled placement says the Session runs — the WHOLE target, or
 * nothing at all.
 *
 * The predecessor projected a bare directory string, and that is the shape of
 * the defect it caused: a Session needs a machine and a path, and a path
 * carried without the machine it lives on gets paired with whatever machine the
 * next owner happens to hold. A checkout resolved on one machine combined with
 * an execution target on another is not a degraded start, it is a wrong one,
 * and nothing downstream can notice.
 *
 * A pinned placement wins because it is stated; a resolved single reachable
 * candidate is the join's exact answer; and every prefill arm — ambiguous,
 * unreachable, unmatched, or a registry that admitted it was partial — carries
 * nothing, because a place chosen between two clones would put an agent to work
 * where the reader never picked.
 *
 * A managed directory intent explicitly chooses no folder. When both directory
 * fields are absent, the pinned machine leaves that choice to the reader.
 */
export type TriageActionExecutionPlacementV1 = Readonly<{
    executionTarget: Readonly<{ serverId: string; machineId: string }>;
    directory?: string;
    directoryIntent?: SessionDirectoryIntentV1;
}>;

export function readTriageActionExecutionPlacementV1(
    placement: TriageActionPlacementV1,
): TriageActionExecutionPlacementV1 | null {
    if (placement.kind === 'pinned') {
        return Object.freeze({
            executionTarget: placement.target,
            ...(placement.directory === undefined ? {} : { directory: placement.directory }),
            ...(placement.directoryIntent === undefined ? {} : { directoryIntent: placement.directoryIntent }),
        });
    }
    if (placement.kind === 'launch') {
        return Object.freeze({
            executionTarget: Object.freeze({
                serverId: placement.candidate.serverId,
                machineId: placement.candidate.machineId,
            }),
            directory: placement.candidate.rootPath,
        });
    }
    return null;
}

/** A complete launch answers the action's checkout requirement as well as its directory choice. */
export function readTriageActionLaunchDirectoryV1(
    placement: TriageActionExecutionPlacementV1 | null,
    checkout: TriageActionCheckoutResolutionV1,
): SessionDirectoryIntentV1 | undefined {
    if (placement === null) return undefined;
    const directory: SessionDirectoryIntentV1 | undefined = placement.directory === undefined
        ? placement.directoryIntent : { kind: 'path', path: placement.directory };
    if (directory === undefined) return undefined;
    if (checkout === 'none') return directory;
    if ((checkout === 'reuseWorkspace' || checkout === 'preparedReviewWorkspace') && directory.kind === 'path') return directory;
    return undefined;
}
