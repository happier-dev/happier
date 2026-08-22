import type {
    AdmittedTargetedOperationExecutionHandle,
    AdmittedTargetedOperationExecutionOptions,
} from '@happier-dev/plugin-sdk/actions';
import type {
    TriageConfiguredSourceInstanceV1,
    TriageEntryRefV1,
    TriagePrepareReviewWorkspaceInputV1,
    TriagePrepareReviewWorkspaceResultV1,
    TriageReviewWorkspaceCurrentnessV1,
    TriageReviewWorkspaceObservedRevisionV1,
    TriageSelectedWorkspaceScopeV1,
    TriageSourceWorkflowSubjectV1,
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
 * Session target, `branch`/`created` are the user-visible worktree result, and
 * `currentness` is the source's own resolved-head fact — the exact input the
 * separate SCM/Reviews scope producer needs later (`CONTRACT.md` §5.4). No
 * clone URL, fetch ref, remote, push target or provider repository identity is
 * retained, because the source operation never returns one.
 *
 * This is live orchestration and result-display state only. It is never copied
 * into the corpus, a Session record, a Message, or retained source detail.
 */
export type TriagePreparedReviewWorkspaceFactsV1 = Readonly<{
    kind: 'preparedReviewWorkspace';
    directory: string;
    branch: string;
    created: boolean;
    currentness: TriagePreparedReviewWorkspaceOutcomeV1['currentness'];
    reviewEligibility: TriageReviewStartEligibilityV1;
}>;

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
        {
            v: 1,
            instance: request.instance,
            entryRef: request.entryRef,
            observed: request.observed,
            workspace: request.workspace,
        },
        {
            expectedSelectedConnectedAccountRef: request.instance.binding.account,
            ...(deps.signal ? { signal: deps.signal } : {}),
        },
    );
    if (result.kind !== 'prepared') return failureFor(result);
    return {
        status: 'prepared',
        facts: {
            kind: 'preparedReviewWorkspace',
            directory: result.repositoryPath,
            branch: result.branch,
            created: result.created,
            currentness: result.currentness,
            reviewEligibility: reviewEligibilityFor(result.currentness, request.observed),
        },
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
