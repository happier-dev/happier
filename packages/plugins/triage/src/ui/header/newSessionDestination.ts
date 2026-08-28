import {
    TriageStartEntrySessionSettledDraftV1Schema,
    type TriageStartEntrySessionInputV1,
} from '../../actions/entrySessionProtocol.js';
import {
    TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1,
    type TriageWorkspaceMaterializationV1,
    type TriageWorkspaceModeV1,
} from '../../sessions/entrySessionWorkspace.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginUiSessionPlacementCandidateV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    TriageActionCheckoutResolutionV1,
    TriageActionExecutionPlacementV1,
    TriageActionPlacementV1,
} from '../../sessions/actionLaunch.js';
import {
    projectTriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceInputV1,
} from '@happier-dev/triage-protocol/v1';

/**
 * The one projection from the host's settled new-Session draft to the
 * destination the start Action carries.
 *
 * The default path names no Agent. Triage cannot: an
 * `agentTarget.identity` is the host's own backend-target vocabulary, and a
 * plugin that reconstructed it would be guessing at a catalog it does not own.
 * So the reader is taken to the host's New Session surface — the same place
 * they pick an Agent for every other Session — and this module turns what they
 * settled there into the exact `destination` the wire already declares.
 *
 * It decides nothing else. It mints no key, opens nothing, dispatches nothing
 * and reads no state; the workspace-mode gate, the creation, the link and the
 * open all stay in `sessions/entrySessionOrchestrator.ts`. The one refusal it
 * does own is the pull-request mode, and only because refusing it here is the
 * difference between telling the reader up front and spending their Agent and
 * directory choice on a start the gate rejects afterwards.
 */

/**
 * The Triage-side preference that may pre-select the host's own fields.
 *
 * A preference is a SEED, never a bypass. The surface opens either way, because
 * a Session also needs an execution target and a working directory and a
 * mounted plugin surface can produce neither: `PluginUiHostApiSurfaceContextV1`
 * carries no `machineId` or `serverId` at all, so the host's own settlement is
 * the ONLY plugin-visible producer of `executionTarget`. A pinned Agent
 * therefore shortens the choice rather than removing it.
 */
export type TriageNewSessionPreferenceV1 = Readonly<{
    /**
     * The Agent Triage settings pin for this action, in the host's own
     * vocabulary: the agent local id, which is
     * the configured action's Launch Profile, resolved against the host inventory's
     * resolved `agentTarget.identity.localId`. It is deliberately not the
     * stored `agentTargetKey`: turning one into the other is the host
     * inventory's job, and parsing that key here would be exactly the
     * backend-target grammar this plugin must not own.
     */
    agentId?: string;
    /** The working directory Triage settings pin for an action, if any. */
    directory?: string;
}>;

export type TriageNewSessionPlacementSeedV1 = Readonly<{
    profileId?: string;
    checkoutIntent: TriageActionCheckoutResolutionV1;
    placement: TriageActionPlacementV1;
}>;

export type TriageNewSessionDraftActionContextV1 = Readonly<{
    profileId?: string;
    checkoutIntent: TriageActionCheckoutResolutionV1;
    candidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>;

/**
 * Projects the placement owner's candidate unchanged into the public New
 * Session seed grammar.
 *
 * Both the single-entry and bulk authoring paths reach this one conversion so
 * neither invents a second candidate shape or drops the project identity that
 * keeps a machine/path pair attributable to its registry row.
 */
export function projectTriageSessionPlacementCandidateV1(
    candidate: Extract<TriageActionPlacementV1, { kind: 'launch' }>['candidate'],
): PluginUiSessionPlacementCandidateV1 {
    return Object.freeze({
        projectKey: candidate.projectKey,
        serverId: candidate.serverId,
        machineId: candidate.machineId,
        rootPath: candidate.rootPath,
        ...(candidate.label === undefined ? {} : { label: candidate.label }),
        reachable: candidate.reachable,
        worktrees: [...candidate.worktrees],
    });
}

/**
 * The seed the host's composer admits, or `null` when Triage has nothing to
 * say and the host should use its own defaults.
 *
 * The host parses this strictly (`apps/ui/sources/components/sessions/new/
 * serverStartDraftComposer.ts#readSeed`), so an unknown or blank member is
 * dropped here rather than sent and refused.
 */
export function triageNewSessionDraftSeedV1(
    preference: TriageNewSessionPreferenceV1,
    /**
     * Where the launch placement resolved this press to run, when it resolved
     * anywhere (`sessions/actionLaunch.ts`).
     *
     * Its two halves travel TOGETHER. A directory is not a place: seeded alone,
     * it is composed against whichever machine the surface happens to be mounted
     * on, which pairs a checkout on one machine with an execution target on
     * another and starts an agent at a path that does not exist there. The host
     * seed therefore admits the machine too, within its own stamped server
     * (`apps/ui/sources/components/sessions/new/serverStartDraftComposer.ts`).
     *
     * Server and machine are sent together. Machine ids are not globally unique,
     * so dropping the server would let the host combine a path from one server
     * with an equal machine id mounted from another.
     */
    placement?: TriageActionExecutionPlacementV1 | TriageNewSessionPlacementSeedV1,
    actionContext?: TriageNewSessionDraftActionContextV1,
): Readonly<Record<string, JsonValue>> | null {
    const agentId = preference.agentId?.trim();
    // A directory the reader pinned in Triage settings names no machine, so it
    // wins as a stated choice and the host stamps its own scope.
    const pinnedDirectory = preference.directory?.trim();
    const resolved = placement === undefined
        ? undefined
        : 'checkoutIntent' in placement
            ? placement.placement.kind === 'pinned'
                ? {
                    executionTarget: placement.placement.target,
                    directory: placement.placement.directory,
                }
                : placement.placement.kind === 'launch'
                    ? {
                        executionTarget: {
                            serverId: placement.placement.candidate.serverId,
                            machineId: placement.placement.candidate.machineId,
                        },
                        directory: placement.placement.candidate.rootPath,
                    }
                    : undefined
            : placement;
    const directory = pinnedDirectory || resolved?.directory?.trim();
    const executionTarget = pinnedDirectory ? undefined : resolved?.executionTarget;
    const actionSeed = actionContext
        ?? (placement !== undefined && 'checkoutIntent' in placement ? placement : undefined);
    const candidates = actionContext?.candidates ?? (actionSeed === undefined || !('placement' in actionSeed)
        ? undefined
        : actionSeed.placement.kind === 'launch'
            ? [projectTriageSessionPlacementCandidateV1(actionSeed.placement.candidate)]
            : actionSeed.placement.kind === 'prefill'
                ? actionSeed.placement.candidates.map(projectTriageSessionPlacementCandidateV1)
                : undefined);
    const seed = {
        ...(agentId ? { agentId } : {}),
        ...(actionSeed?.profileId === undefined ? {} : { profileId: actionSeed.profileId }),
        ...(actionSeed === undefined ? {} : { checkoutIntent: actionSeed.checkoutIntent }),
        ...(directory ? { directory } : {}),
        ...(executionTarget === undefined ? {} : { executionTarget }),
        ...(candidates === undefined ? {} : { candidates }),
    };
    return Object.keys(seed).length === 0 ? null : Object.freeze(seed);
}

export type TriageNewSessionDestinationRefusalV1 =
    /**
     * The action declares `pull_request`. The reachable wire cannot request the
     * prepared review workspace that mode names
     * (`actions/entrySessionProtocol.ts`), so nothing is opened for it.
     */
    | 'preparedWorkspaceUnsupported'
    /** The host settled something this start cannot be built from. */
    | 'draftUnusable';

export type TriageNewSessionDestinationV1 =
    | Readonly<{
        status: 'settled';
        destination: TriageStartEntrySessionInputV1['destination'];
    }>
    | Readonly<{ status: 'refused'; reason: TriageNewSessionDestinationRefusalV1 }>;

type TriageReviewWorkspaceRequestV1 = Extract<
    Extract<TriageStartEntrySessionInputV1['destination'], Readonly<{ kind: 'new' }>>['materialization'],
    Readonly<{ kind: 'reviewWorkspace' }>
>['request'];

/** Facts the mounted detail already holds before the host settles an Agent/directory. */
export type TriageReviewWorkspacePreparationV1 = Omit<
    TriageReviewWorkspaceRequestV1,
    'workflowSubject' | 'workspace'
>;

/**
 * The materialization this wire will carry for a mode, or `null` when it cannot
 * carry one at all.
 *
 * The pairing itself is NOT restated here: it is read from the single table the
 * gate validates against
 * (`sessions/entrySessionWorkspace.ts#TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1`).
 * What this function adds is the one fact the table cannot know — that the
 * reachable Action wire admits only the two directory materializations, because
 * preparing the third needs a source-declared operation no shipped source binds
 * (`actions/entrySessionProtocol.ts`).
 *
 * It is exported because the press consults it BEFORE opening the host's New
 * Session surface — spending a reader's Agent and directory choice on a start
 * that is refused afterwards is worse than telling them first — and the
 * projection below consults the same function once the host has settled. One
 * reader for both, so the up-front refusal and the built request cannot drift.
 */
export function triageNewSessionWireMaterializationV1(
    workspaceMode: TriageWorkspaceModeV1,
): TriageWorkspaceMaterializationV1['kind'] {
    return TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1[workspaceMode];
}

export function projectTriageNewSessionDestinationV1(input: Readonly<{
    /** The pressed action's declared mode. It IS the request; nothing re-decides it. */
    workspaceMode: TriageWorkspaceModeV1;
    /** Minted once per logical start and re-sent unchanged on a retry. */
    creationKey: string;
    /** Exactly what the host settled, unread and unreshaped until here. */
    settlement: unknown;
    /**
     * The pressed action's configured Launch Profile, carried through to the
     * canonical creator that owns what a profile means. It is a reference, and
     * the only authored member a Triage start forwards; every default it
     * implies — agent, model, permission, persistence, environment, coding
     * prompt — is resolved there, never here.
     */
    profileId?: string;
    /** Exact selected-PR facts, supplied only for the pull-request mode. */
    reviewWorkspace?: TriageReviewWorkspacePreparationV1;
    /** Saved project identities already admitted by the canonical placement owner. */
    placementCandidates?: readonly PluginUiSessionPlacementCandidateV1[];
}>): TriageNewSessionDestinationV1 {
    const kind = triageNewSessionWireMaterializationV1(input.workspaceMode);

    const draft = TriageStartEntrySessionSettledDraftV1Schema.safeParse(input.settlement);
    if (!draft.success) return { status: 'refused', reason: 'draftUnusable' };

    if (kind === 'reviewWorkspace' && input.reviewWorkspace === undefined) {
        return { status: 'refused', reason: 'preparedWorkspaceUnsupported' };
    }

    const materialization = kind === 'reviewWorkspace'
        ? {
            kind,
            request: {
                ...input.reviewWorkspace!,
                workflowSubject: 'pullRequest' as const,
                workspace: selectedWorkspaceScope(draft.data, input.placementCandidates ?? []),
            },
        }
        : { kind, directory: draft.data.directory };

    const { directory: _directory, ...settledSpawn } = draft.data;
    const spawn = {
        ...settledSpawn,
        ...(settledSpawn.profileId === undefined && input.profileId !== undefined
            ? { profileId: input.profileId }
            : {}),
    };

    return {
        status: 'settled',
        destination: {
            kind: 'new',
            creationKey: input.creationKey,
            spawn,
            // The action's declared mode IS the materialization request, read
            // from the one table the gate validates it against. A second copy
            // of the pairings here is the unbound duplicate F1 named.
            materialization,
        },
    };
}

/**
 * A prepared PR workspace may use only the saved project identity the placement
 * owner already surfaced. A settled directory that matches no candidate (or
 * more than one) is deliberately `null`: no URL, recents index, or string path
 * fallback is allowed to invent a project/machine/root selection.
 */
function selectedWorkspaceScope(
    placement: Readonly<{
        executionTarget: Readonly<{ serverId: string; machineId: string }>;
        directory: string;
    }>,
    candidates: readonly PluginUiSessionPlacementCandidateV1[],
): TriageReviewWorkspaceRequestV1['workspace'] {
    const matches = candidates.filter((candidate) => candidate.serverId === placement.executionTarget.serverId
        && candidate.machineId === placement.executionTarget.machineId
        && candidate.rootPath === placement.directory);
    if (matches.length !== 1) return null;
    const candidate = matches[0]!;
    return {
        serverId: candidate.serverId,
        machineId: candidate.machineId,
        rootPath: candidate.rootPath,
    };
}

/**
 * The one projection used when a compose action prepares before New Session
 * opens. It reuses the same candidate-correspondence owner as direct Session
 * starts, so a path or machine hint can never become a saved-workspace choice
 * merely because the destination is authoring rather than immediate launch.
 */
export function projectTriagePreparedWorkspaceSelectionInputV1(input: Readonly<{
    preparation: TriageReviewWorkspacePreparationV1;
    placement: TriageActionExecutionPlacementV1 | null;
    candidates: readonly PluginUiSessionPlacementCandidateV1[];
}>): TriagePrepareReviewWorkspaceInputV1 {
    const workspace = input.placement?.directory === undefined
        ? null
        : selectedWorkspaceScope({
            executionTarget: input.placement.executionTarget,
            directory: input.placement.directory,
        }, input.candidates);
    return projectTriagePrepareReviewWorkspaceInputV1({
        ...input.preparation,
        workspace,
    });
}
