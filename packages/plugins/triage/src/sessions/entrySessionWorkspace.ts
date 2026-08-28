import type {
    AdmittedTargetedOperationExecutionHandle,
    AdmittedTargetedOperationExecutionOptions,
} from '@happier-dev/plugin-sdk/actions';
import {
    projectTriagePrepareReviewWorkspaceInputV1,
    type TriageConfiguredSourceInstanceV1,
    type TriageEntryLocatorV1,
    type TriageEntryRefV1,
    type TriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceResultV1,
    type TriageReviewWorkspaceCurrentnessV1,
    type TriageReviewWorkspaceObservedRevisionV1,
    type TriageSelectedWorkspaceScopeV1,
    type TriageSourceWorkflowSubjectV1,
} from '@happier-dev/triage-protocol/v1';

import { sameTriageSourceIdentity } from '../corpus/identity/components.js';

/**
 * What a Triage Session start knows about the working directory it is about to
 * create a Session in.
 *
 * Destination and workspace are independent decisions (`core/SESSIONS.md` §2).
 * Ask never touches SCM, a non-pull-request Fix uses the project the user
 * explicitly chose, and only a pull-request Fix reaches a source-prepared
 * worktree. Nothing here derives a directory from a provider URL, stack frame,
 * repository label, source locator or cached detail.
 */

/** The one admitted success arm of the source-owned preparation operation. */
export type TriagePreparedReviewWorkspaceOutcomeV1 = Extract<
    TriagePrepareReviewWorkspaceResultV1,
    Readonly<{ kind: 'prepared' }>
>;

/**
 * The bounded projection Triage keeps once preparation has succeeded.
 *
 * `directory` is the prepared path handed to the already selected generic
 * Session target, `branch`/`created` are the user-visible worktree result,
 * `pullRequest` is the source-owned opaque canonical reference the generic
 * SCM/Reviews producer validates later, and `currentness` is the source's own
 * resolved-head fact. No clone URL, fetch ref, remote, push target or provider
 * repository identity is retained, because the source operation never returns
 * one.
 *
 * This is live orchestration and result-display state only. It is never copied
 * into the corpus, a Session record, a Message, or retained source detail.
 */
export type TriagePreparedReviewWorkspaceFactsV1 = Readonly<{
    kind: 'preparedReviewWorkspace';
    directory: string;
    branch: string;
    created: boolean;
    pullRequest: TriagePreparedReviewWorkspaceOutcomeV1['pullRequest'];
    currentness: TriagePreparedReviewWorkspaceOutcomeV1['currentness'];
    reviewEligibility: TriageReviewStartEligibilityV1;
}>;

/**
 * The one projection from a source-owned prepared result into the Session
 * facts carried through link/open retries. Keeping it here ensures initial
 * preparation and a retry use the same local-head eligibility decision.
 */
export function preparedReviewWorkspaceFactsFor(
    result: TriagePreparedReviewWorkspaceOutcomeV1,
    observed: TriageReviewWorkspaceObservedRevisionV1,
): TriagePreparedReviewWorkspaceFactsV1 {
    return {
        kind: 'preparedReviewWorkspace',
        directory: result.repositoryPath,
        branch: result.branch,
        created: result.created,
        pullRequest: result.pullRequest,
        currentness: result.currentness,
        reviewEligibility: reviewEligibilityFor(result.currentness, observed),
    };
}

type TriagePreservedStaleCurrentnessV1 = Extract<
    TriageReviewWorkspaceCurrentnessV1,
    Readonly<{ kind: 'preservedStale' }>
>;

/**
 * Whether the prepared worktree may still start a review, decided once from the
 * source's own resolved local HEAD.
 *
 * A prepared workspace is a Session outcome; review start is a stricter one. A
 * worktree the source deliberately preserved at a stale head, or one whose
 * reported head is not the head this start observed, still opens a Session and
 * still shows the user a real directory — it just says, truthfully, that it
 * cannot describe the commits they were looking at. `baseSha`/`headSha` are the
 * exact observed pair this start carried, never a locally re-derived guess.
 */
export type TriageReviewStartEligibilityV1 =
    | Readonly<{ status: 'eligible'; baseSha: string; headSha: string }>
    | Readonly<{
        status: 'ineligible';
        reason: 'localHeadStale';
        resolvedHeadSha: string;
        observedHeadSha: string;
        staleReason: TriagePreservedStaleCurrentnessV1['reason'];
    }>
    | Readonly<{
        status: 'ineligible';
        reason: 'observedHeadMismatch';
        resolvedHeadSha: string;
        observedHeadSha: string;
    }>;

/**
 * What a Triage action declares it needs on disk (`PLAN.md` §0a A3).
 *
 * It replaces the retired `ask | fix` intent union at the one gate that used it
 * to choose a materialization. An intent was a label that a gate then had to
 * re-read together with the entry's workflow subject to work out what the
 * caller meant; a mode says it. The three approved pairings are unchanged —
 * they are simply declared by the action instead of derived from its name.
 */
export const TRIAGE_WORKSPACE_MODES_V1 = [
    'reference_only',
    'repository',
    'pull_request',
] as const;
/**
 * The closed vocabulary and the type are one declaration.
 *
 * The configured action record validates a stored mode against this exact
 * array. Spelling the three members again beside a parser would be a second
 * vocabulary that no compiler binds to the pairing table below, and a mode
 * admitted by one and unknown to the other is a start that is offered and then
 * refused.
 */
export type TriageWorkspaceModeV1 = (typeof TRIAGE_WORKSPACE_MODES_V1)[number];

/**
 * The ONE mode-to-materialization pairing.
 *
 * Both ends of one start read this table: the surface BUILDS the materialization
 * it sends from it, and `entrySessionOrchestrator.ts#rejectionFor` VALIDATES the
 * materialization it received against it. Before the mode existed those two ends
 * each restated the pairings in their own vocabulary with nothing binding the
 * copies, which is exactly the unbound duplicate the Ask/Fix verifier filed as
 * F1: a change to one was invisible to the other until a start was refused in
 * front of a reader.
 */
export const TRIAGE_WORKSPACE_MODE_MATERIALIZATION_V1 = Object.freeze({
    reference_only: 'referenceOnly',
    repository: 'selectedProject',
    pull_request: 'reviewWorkspace',
}) satisfies Readonly<Record<TriageWorkspaceModeV1, TriageWorkspaceMaterializationV1['kind']>>;

export type TriageEntrySessionWorkspaceFactsV1 =
    | Readonly<{ kind: 'referenceOnly' }>
    | Readonly<{ kind: 'selectedProject'; directory: string }>
    | TriagePreparedReviewWorkspaceFactsV1;

/**
 * The materialization the user's choice already settled on, supplied to the
 * start orchestrator.
 *
 * The `reviewWorkspace` arm carries only the request: no directory exists yet,
 * because the exact saved workspace the user selected is the source's input and
 * the prepared path is the source's answer. Triage cannot supply a path here
 * even by accident.
 */
export type TriageWorkspaceMaterializationV1 =
    | Readonly<{ kind: 'referenceOnly'; directory: string }>
    | Readonly<{ kind: 'selectedProject'; directory: string }>
    | Readonly<{
        kind: 'reviewWorkspace';
        request: TriageReviewWorkspacePreparationRequestV1;
    }>;

/**
 * The materialization once every source-owned decision has been made. A start
 * creates a Session only from this shape, so a directory can only ever be one
 * the user selected or one the source prepared.
 */
export type TriageResolvedMaterializationV1 =
    | Readonly<{ kind: 'referenceOnly'; directory: string }>
    | Readonly<{ kind: 'selectedProject'; directory: string }>
    | Readonly<{
        kind: 'preparedReviewWorkspace';
        facts: TriagePreparedReviewWorkspaceFactsV1;
    }>;

/** The single directory authority for one start: the generic spawn never carries a second one. */
export function materializationDirectory(
    materialization: TriageResolvedMaterializationV1,
): string {
    return materialization.kind === 'preparedReviewWorkspace'
        ? materialization.facts.directory
        : materialization.directory;
}

/**
 * Projects the result facts a start reports and retries with. An Ask keeps no
 * directory at all: it selected one to create the Session in, but the entry
 * relationship it establishes is reference-only.
 */
export function materializationWorkspaceFacts(
    materialization: TriageResolvedMaterializationV1,
): TriageEntrySessionWorkspaceFactsV1 {
    if (materialization.kind === 'referenceOnly') return { kind: 'referenceOnly' };
    if (materialization.kind === 'selectedProject') {
        return { kind: 'selectedProject', directory: materialization.directory };
    }
    return materialization.facts;
}

/**
 * The exact facts one pull-request preparation is invoked with.
 *
 * `workspace` is the incumbent saved-workspace selector's projection of the one
 * choice the user made, or `null` when they made none. Triage neither
 * enumerates candidate clones nor keeps this scope beyond the invocation.
 */
export type TriageReviewWorkspacePreparationRequestV1 = Readonly<{
    instance: TriageConfiguredSourceInstanceV1;
    entryRef: TriageEntryRefV1;
    workflowSubject: TriageSourceWorkflowSubjectV1;
    lastKnownLocator: TriageEntryLocatorV1;
    observed: TriageReviewWorkspaceObservedRevisionV1;
    workspace: TriageSelectedWorkspaceScopeV1 | null;
}>;

/** The selected contribution's original host-created preparation handle. */
export type TriagePrepareReviewWorkspaceOperationV1 = AdmittedTargetedOperationExecutionHandle<
    TriagePrepareReviewWorkspaceInputV1,
    TriagePrepareReviewWorkspaceResultV1,
    'prepareReviewWorkspace'
>;

/** The host-owned execution of that handle. The handle is passed through untouched. */
export type TriagePrepareReviewWorkspaceExecutorV1 = (
    operation: TriagePrepareReviewWorkspaceOperationV1,
    input: TriagePrepareReviewWorkspaceInputV1,
    options: AdmittedTargetedOperationExecutionOptions,
) => Promise<TriagePrepareReviewWorkspaceResultV1>;

export type TriageReviewWorkspacePreparationDepsV1 = Readonly<{
    /**
     * Absent when the selected source declares no preparation operation. Triage
     * then resolves the same strict `unsupported` refusal — it never looks up
     * another source, another Action, or an incumbent provider-resolving
     * worktree route.
     */
    operation?: TriagePrepareReviewWorkspaceOperationV1;
    execute: TriagePrepareReviewWorkspaceExecutorV1;
    signal?: AbortSignal;
}>;

/**
 * Why a start stopped before a workspace existed.
 *
 * `retryable` asks one question only: could this same request, repeated
 * unchanged, succeed later? An unreachable account, machine or SCM resolver
 * can clear on its own. Everything else needs a different request — a
 * different workspace selection, a source that implements preparation, or a
 * fresh observation of a pull request that moved — and saying otherwise would
 * offer the user a retry that re-sends facts already known to be stale.
 */
export type TriageWorkspacePreparationFailureV1 = Readonly<{
    reason: 'refused' | 'failed';
    retryable: boolean;
}>;

export type TriageResolvedEntrySessionWorkspaceV1 =
    | Readonly<{ status: 'prepared'; facts: TriagePreparedReviewWorkspaceFactsV1 }>
    | Readonly<{ status: 'failed'; failure: TriageWorkspacePreparationFailureV1 }>;

/**
 * The one refusal used whenever no preparation can happen at all: an absent
 * operation, a subject or source that must not reach a worktree, or a strict
 * refusal the same request cannot resolve. Repeating it changes nothing.
 */
export const TRIAGE_WORKSPACE_PREPARATION_REFUSED_V1: TriageWorkspacePreparationFailureV1 =
    Object.freeze({ reason: 'refused', retryable: false });

const REFUSED_TERMINAL: TriageResolvedEntrySessionWorkspaceV1 = {
    status: 'failed',
    failure: TRIAGE_WORKSPACE_PREPARATION_REFUSED_V1,
};

/**
 * Obtains the one prepared review workspace, or a truthful reason there is none.
 *
 * Everything that decides *where* the checkout lands belongs to the selected
 * source and the canonical SCM materializer it calls. Triage supplies the exact
 * user selection and the exact observed revision, and consumes the strict
 * result. There is no fallback: no clone, no discovered path, no second Action
 * with different authority, and no directory on any failing arm.
 */
export async function resolveEntrySessionWorkspace(
    deps: TriageReviewWorkspacePreparationDepsV1,
    request: TriageReviewWorkspacePreparationRequestV1,
): Promise<TriageResolvedEntrySessionWorkspaceV1> {
    // The target's own preconditions, checked before a `writesLocal` operation
    // can run: only a pull request reaches a worktree at all, and the entry and
    // the configured instance must be the same admitted source, so a selection
    // from one forge can never prepare a checkout through another's account.
    if (request.workflowSubject !== 'pullRequest') return REFUSED_TERMINAL;
    if (!sameTriageSourceIdentity(
        request.entryRef.source,
        request.instance.instance.source,
    )) {
        return REFUSED_TERMINAL;
    }
    const operation = deps.operation;
    if (operation === undefined) return REFUSED_TERMINAL;

    const result = await deps.execute(
        operation,
        projectTriagePrepareReviewWorkspaceInputV1(request),
        {
            expectedSelectedConnectedAccountRef: request.instance.binding.account,
            ...(deps.signal ? { signal: deps.signal } : {}),
        },
    );
    if (result.kind !== 'prepared') return failureFor(result);
    return {
        status: 'prepared',
        facts: preparedReviewWorkspaceFactsFor(result, request.observed),
    };
}

/**
 * The local-head eligibility decision, read from the source's resolved HEAD.
 *
 * Triage never inspects a worktree, reruns a revision walk, or substitutes a
 * head it likes better. It compares the head the source resolved against the
 * head this start observed, and the only pair it will ever hand to a review is
 * that observed pair.
 */
function reviewEligibilityFor(
    currentness: TriageReviewWorkspaceCurrentnessV1,
    observed: TriageReviewWorkspaceObservedRevisionV1,
): TriageReviewStartEligibilityV1 {
    if (currentness.kind === 'preservedStale') {
        return {
            status: 'ineligible',
            reason: 'localHeadStale',
            resolvedHeadSha: currentness.resolvedHeadSha,
            observedHeadSha: observed.headSha,
            staleReason: currentness.reason,
        };
    }
    if (currentness.kind === 'movedToObservedHead'
        && currentness.observedHeadSha !== observed.headSha) {
        return {
            status: 'ineligible',
            reason: 'observedHeadMismatch',
            resolvedHeadSha: currentness.observedHeadSha,
            observedHeadSha: observed.headSha,
        };
    }
    return { status: 'eligible', baseSha: observed.baseSha, headSha: observed.headSha };
}

function failureFor(
    result: Exclude<TriagePrepareReviewWorkspaceResultV1, Readonly<{ kind: 'prepared' }>>,
): TriageResolvedEntrySessionWorkspaceV1 {
    if (result.kind === 'unavailable') {
        return { status: 'failed', failure: { reason: 'failed', retryable: true } };
    }
    return REFUSED_TERMINAL;
}
