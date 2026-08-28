import {
    selectCurrentTargetedContribution,
    type JsonValue,
    type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    projectTriagePrepareReviewWorkspaceInputV1,
    type TriagePrepareReviewWorkspaceInputV1,
    type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { produceScmPullRequestReviewScope } from '@happier-dev/plugin-sdk/reviews';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import { unlinkEntryFromSession } from '../sessions/entrySessionLinks.js';
import type { TriageSessionActionInvokerV1 } from '../sessions/entrySessionOpen.js';
import {
    materializationWorkspaceFacts,
    preparedReviewWorkspaceFactsFor,
    type TriageReviewWorkspacePreparationDepsV1,
} from '../sessions/entrySessionWorkspace.js';
import {
    resumeEntrySessionStart,
    startEntrySession,
    type TriageEntrySessionDestinationV1,
    type TriageEntrySessionPendingPhaseV1,
    type TriageEntrySessionStartResultV1,
} from '../sessions/entrySessionOrchestrator.js';
import type {
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1,
    TriageStartPullRequestReviewInputV1,
    TriageStartPullRequestReviewResultV1,
    TriageUnlinkEntryFromSessionActionInputV1,
    TriageUnlinkEntryFromSessionActionResultV1,
} from './entrySessionProtocol.js';

/**
 * The registered Session-start and unlink transport.
 *
 * This is not a second orchestrator. `startEntrySession` still owns the
 * workspace-mode gate, the materialization decision, the one creation key it
 * is handed, the create-versus-rejoin consumption, the idempotent link and the
 * canonical open; `unlinkEntryFromSession` still owns the removal. This module
 * carries a mounted surface's settled choice to them and projects their own
 * verdict back — which is what the header press had no way to reach.
 *
 * It writes no Session state, derives no Session id, mints no creation key,
 * seeds no draft and sends no Message. Every phase-local outcome is returned as
 * the owner produced it, so the surface can retry exactly the phase that failed.
 */

export type TriageEntrySessionActionDepsV1 = Readonly<{
    /** The `session-links` Collection. It is the only Collection these Actions touch. */
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>;
    /** The host invoker for the two generic Session Actions this start consumes. */
    execute: TriageSessionActionInvokerV1;
    /** The exact current selected source operation for a pull-request start. */
    prepareReviewWorkspace?: TriageReviewWorkspacePreparationDepsV1;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

/**
 * Carries the caller's settled destination into the orchestrator's own
 * vocabulary.
 *
 * The materialization arms travel unchanged; nothing here invents a directory,
 * upgrades a reference-only Ask into a project, or constructs a pull-request
 * preparation route outside the selected admitted source operation.
 */
function destinationFrom(
    destination: TriageStartEntrySessionInputV1['destination'],
): TriageEntrySessionDestinationV1 {
    if (destination.kind === 'existing') {
        return { kind: 'existing', sessionId: destination.sessionId };
    }
    return {
        kind: 'new',
        creationKey: destination.creationKey,
        spawn: {
            executionTarget: destination.spawn.executionTarget,
            agentTarget: destination.spawn.agentTarget,
            // The pressed action's configured Launch Profile is carried to the
            // canonical creator that owns what it means. The remaining optional
            // members are not Triage-authored defaults: they are the host's
            // already-settled Session choices, forwarded in the spawn wire's
            // own vocabulary without reinterpretation.
            ...(destination.spawn.profileId === undefined
                ? {}
                : { profileId: destination.spawn.profileId }),
            ...(destination.spawn.modelSelection === undefined
                ? {}
                : { modelSelection: destination.spawn.modelSelection }),
            ...(destination.spawn.permissionMode === undefined
                ? {}
                : { permissionMode: destination.spawn.permissionMode }),
            ...(destination.spawn.transcriptStorage === undefined
                ? {}
                : { transcriptStorage: destination.spawn.transcriptStorage }),
            ...(destination.spawn.terminal === undefined
                ? {}
                : { terminal: destination.spawn.terminal }),
        } as Extract<TriageEntrySessionDestinationV1, Readonly<{ kind: 'new' }>>['spawn'],
        materialization: destination.materialization,
    };
}

/**
 * Projects the orchestrator's verdict onto the wire.
 *
 * Ordinary workspace facts stay at the start owner. A selected-PR open carries
 * only its bounded continuation, and only when the source prepared a worktree
 * whose local HEAD is eligible for the separately owned formal review start.
 */
function projectStartResult(
    result: TriageEntrySessionStartResultV1,
    input: TriageStartEntrySessionInputV1,
): TriageStartEntrySessionResultV1 {
    switch (result.type) {
        case 'opened': {
            const review = reviewContinuationFor(input, result);
            const preparedReviewWorkspace = result.delivery === 'outcomeUnknown'
                ? preparedReviewWorkspaceForWire(result.workspace)
                : undefined;
            return {
                v: 1,
                type: result.type,
                sessionId: result.sessionId,
                disposition: result.disposition,
                // The admission owner's verdict on the structured delivery,
                // carried out as it answered. The surface cannot ask again: the
                // send happened inside this start, before the open.
                delivery: result.delivery,
                ...(review === undefined ? {} : { review }),
                ...(preparedReviewWorkspace === undefined ? {} : { preparedReviewWorkspace }),
            };
        }
        case 'openPending': {
            const preparedReviewWorkspace = preparedReviewWorkspaceForWire(result.workspace);
            return {
                v: 1,
                type: result.type,
                sessionId: result.sessionId,
                disposition: result.disposition,
                delivery: result.delivery,
                ...(preparedReviewWorkspace === undefined ? {} : { preparedReviewWorkspace }),
            };
        }
        case 'linked': {
            const review = reviewContinuationFor(input, result);
            const preparedReviewWorkspace = result.delivery === 'outcomeUnknown'
                ? preparedReviewWorkspaceForWire(result.workspace)
                : undefined;
            return {
                v: 1,
                type: 'linked',
                sessionId: result.sessionId,
                disposition: result.disposition,
                delivery: result.delivery,
                finalOpen: result.finalOpen,
                ...(review === undefined ? {} : { review }),
                ...(preparedReviewWorkspace === undefined ? {} : { preparedReviewWorkspace }),
            };
        }
        case 'linkPending': {
            // Nothing was delivered, because nothing is delivered into a Session
            // this entry is not linked to yet.
            const preparedReviewWorkspace = preparedReviewWorkspaceForWire(result.workspace);
            return {
                v: 1,
                type: result.type,
                sessionId: result.sessionId,
                disposition: result.disposition,
                ...(result.delivery === undefined ? {} : { delivery: result.delivery }),
                ...(preparedReviewWorkspace === undefined ? {} : { preparedReviewWorkspace }),
            };
        }
        case 'creationPending': {
            const preparedReviewWorkspace = preparedReviewWorkspaceForWire(result.workspace);
            return {
                v: 1,
                type: 'creationPending',
                outcome: result.outcome,
                ...(preparedReviewWorkspace === undefined ? {} : { preparedReviewWorkspace }),
            };
        }
        case 'creationFailed':
            return { v: 1, type: 'creationFailed' };
        case 'workspacePreparationFailed':
            return {
                v: 1,
                type: 'workspacePreparationFailed',
                reason: result.reason,
                retryable: result.retryable,
            };
        case 'rejected':
            return { v: 1, type: 'rejected', reason: result.reason };
    }
}

/** Carries source-returned facts across a link/open retry without rerunning SCM. */
function preparedReviewWorkspaceForWire(
    workspace: Extract<
        TriageEntrySessionStartResultV1,
        Readonly<{ type: 'opened' | 'linked' | 'creationPending' | 'linkPending' | 'openPending' }>
    >['workspace'],
) {
    if (workspace.kind !== 'preparedReviewWorkspace') return undefined;
    return {
        repositoryPath: workspace.directory,
        branch: workspace.branch,
        created: workspace.created,
        pullRequest: workspace.pullRequest,
        currentness: workspace.currentness,
    };
}

/**
 * Projects the one live continuation from a source-prepared selected PR. This
 * is deliberately narrower than the prepared workspace facts: review scope is
 * recreated only after the source rereads the PR immediately before
 * `review.start`, and its generic producer remains the sole parser of the
 * opaque pull-request reference.
 */
function reviewContinuationFor(
    input: TriageStartEntrySessionInputV1,
    result: Extract<
        TriageEntrySessionStartResultV1,
        Readonly<{ type: 'opened' | 'linked' }>
    >,
): NonNullable<Extract<
    TriageStartEntrySessionResultV1,
    Readonly<{ type: 'opened' | 'linked' }>
>['review']> | undefined {
    if (input.destination.kind !== 'new'
        || input.destination.materialization.kind !== 'reviewWorkspace'
        || result.workspace.kind !== 'preparedReviewWorkspace'
        || result.workspace.reviewEligibility.status !== 'eligible') {
        return undefined;
    }
    const request = input.destination.materialization.request;
    if (request.workspace === null) return undefined;
    return {
        instance: request.instance,
        entryRef: request.entryRef,
        lastKnownLocator: request.lastKnownLocator,
        observed: request.observed,
        workspace: request.workspace,
        repositoryPath: result.workspace.directory,
        pullRequest: result.workspace.pullRequest,
    };
}

/**
 * The workspace facts a resumed phase re-reports, read from the one owner.
 *
 * A resume repeats a phase of a start that already happened, so the facts it
 * echoes are the ones that start settled on. Reference/project facts derive
 * from the original materialization. A prepared selected-PR result is carried
 * back only by the pending result itself, so retrying link/open cannot re-run
 * a source-owned local materialization.
 */
function resumedWorkspaceFacts(
    destination: TriageStartEntrySessionInputV1['destination'],
    resume: NonNullable<TriageStartEntrySessionInputV1['resume']>,
): TriageEntrySessionPendingPhaseV1['workspace'] | undefined {
    if (destination.kind === 'existing') {
        return { kind: 'referenceOnly' };
    }
    if (destination.materialization.kind !== 'reviewWorkspace') {
        return materializationWorkspaceFacts(destination.materialization);
    }
    const prepared = resume.preparedReviewWorkspace;
    if (prepared === undefined) return undefined;
    return preparedReviewWorkspaceFactsFor({
        kind: 'prepared',
        repositoryPath: prepared.repositoryPath,
        branch: prepared.branch,
        created: prepared.created,
        pullRequest: prepared.pullRequest,
        currentness: prepared.currentness,
    }, destination.materialization.request.observed);
}

type TriageReviewWorkspaceRequestV1 = Extract<
    Extract<TriageStartEntrySessionInputV1['destination'], Readonly<{ kind: 'new' }>>['materialization'],
    Readonly<{ kind: 'reviewWorkspace' }>
>['request'];

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The host separates the selected Connected Account from the submitted raw
 * source input. Reconstruct it only to compare against the semantic request
 * this start will materialize; the host performs the real reconstruction when
 * the admitted operation consumes the carrier.
 */
function selectedPrepareInputMatchesRequest(
    selection: NonNullable<TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection']>,
    request: TriageReviewWorkspaceRequestV1,
): boolean {
    if (!isJsonRecord(selection.input)) return false;
    const instance = selection.input.instance;
    if (!isJsonRecord(instance)) return false;
    const binding = instance.binding;
    if (!isJsonRecord(binding) || Object.hasOwn(binding, 'account')) return false;

    const reconstructed: JsonValue = {
        ...selection.input,
        instance: {
            ...instance,
            binding: {
                ...binding,
                account: selection.credentialRef,
            },
        },
    };
    const expected: JsonValue = projectTriagePrepareReviewWorkspaceInputV1(request);
    return pluginJsonValuesEqual(reconstructed, expected);
}

/**
 * Reads the one current source contribution that owns a selected PR's
 * preparation. The outer Action never reconstructs a provider route, action
 * id, or operation handle: it reaches only the host-created handle published
 * by the current target-owned contribution snapshot.
 */
async function readCurrentPrepareReviewWorkspace(
    input: TriageStartEntrySessionInputV1,
    context: PluginInvocationContext,
): Promise<TriageReviewWorkspacePreparationDepsV1 | undefined> {
    if (input.destination.kind !== 'new'
        || input.destination.materialization.kind !== 'reviewWorkspace') {
        return undefined;
    }
    const selected = input.prepareReviewWorkspaceSelection;
    const request = input.destination.materialization.request;
    if (selected === undefined || !selectedPrepareInputMatchesRequest(selected, request)) {
        return undefined;
    }

    const current = await selectCurrentTargetedContribution({
        service: context.services.targetedContributions,
        point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        selection: selected.selection,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (current.kind !== 'selected') return undefined;
    const contribution = current.contribution;
    if (contribution.contributor.pluginId !== request.entryRef.source.pluginId
        || contribution.contributor.contributionId !== request.entryRef.source.localId) {
        return undefined;
    }
    const operation = contribution.operations.prepareReviewWorkspace;
    if (operation === undefined) return undefined;

    // `selected.input` crossed the Host API as JSON and was just proven to be
    // this exact source request after its account is restored. The host owns
    // that restoration during execution; this narrow boundary cast keeps the
    // raw selected representation intact so carrier equality can still hold.
    const selectedInput = selected.input as TriagePrepareReviewWorkspaceInputV1;
    return {
        operation,
        execute: async (selectedOperation, _expectedInput, options) => await context.services.actions
            .executeAdmittedTargetedOperation(selectedOperation, selectedInput, {
                expectedSelectedConnectedAccountRef: selected.credentialRef,
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
            }),
        ...(context.signal ? { signal: context.signal } : {}),
    };
}

/** Reads the selected source's exact final workspace verifier. */
async function readCurrentVerifyReviewWorkspaceOperation(
    source: TriageStartPullRequestReviewInputV1['review']['entryRef']['source'],
    context: PluginInvocationContext,
) {
    const observation = context.services.targetedContributions.observeForSelf(
        TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        { onInvalidated: () => {} },
    );
    try {
        const snapshot = await observation.readCurrent(
            context.signal === undefined ? undefined : { signal: context.signal },
        );
        return indexTriageAdmittedSourcesV1(snapshot.contributions).get(
            renderSourceQualifiedId(source),
        )?.operations.verifyReviewWorkspace;
    } finally {
        observation.dispose();
    }
}

/**
 * The terminal selected-PR review transition: one carrier-backed reread,
 * generic scope production, then the incumbent generic review fan-out. The
 * engine list and human choice deliberately happened on the mounted surface
 * before this function, so the reread remains immediately adjacent to start.
 */
export function createTriageStartPullRequestReviewActionHandler(): ActionHandler<
    TriageStartPullRequestReviewInputV1,
    TriageStartPullRequestReviewResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        if (new Set(input.engineIds).size !== input.engineIds.length) {
            return { v: 1, status: 'refused', reason: 'reviewRejected' };
        }
        const operation = await readCurrentVerifyReviewWorkspaceOperation(
            input.review.entryRef.source,
            context,
        );
        if (operation === undefined) return { v: 1, status: 'refused', reason: 'sourceUnavailable' };

        const verified: TriageVerifyReviewWorkspaceResultV1 = await context.services.actions
            .executeAdmittedTargetedOperation(
            operation,
            {
                v: 1,
                instance: input.review.instance,
                entryRef: input.review.entryRef,
                lastKnownLocator: input.review.lastKnownLocator,
                observed: input.review.observed,
                workspace: input.review.workspace,
                prepared: {
                    repositoryPath: input.review.repositoryPath,
                    pullRequest: input.review.pullRequest,
                },
            },
            {
                expectedSelectedConnectedAccountRef: input.review.instance.binding.account,
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            },
        );
        if (verified.kind === 'workspaceMismatch') {
            return { v: 1, status: 'refused', reason: 'workspaceMismatch' };
        }
        if (verified.kind === 'unavailable') {
            return { v: 1, status: 'refused', reason: 'sourceUnavailable' };
        }
        if (verified.kind !== 'verified') {
            return { v: 1, status: 'refused', reason: 'revisionMismatch' };
        }

        const scope = produceScmPullRequestReviewScope({
            authoritative: {
                account: input.review.instance.binding.account,
                pullRequest: verified.pullRequest,
                observed: input.review.observed,
            },
            expected: {
                account: input.review.instance.binding.account,
                baseSha: input.review.observed.baseSha,
                headSha: input.review.observed.headSha,
            },
        });
        if (scope.status === 'refused') {
            return { v: 1, status: 'refused', reason: 'scopeRefused' };
        }

        await context.services.actions.execute('review.start', {
            sessionId: input.sessionId,
            engineIds: [...input.engineIds],
            instructions: input.instructions,
            changeType: 'committed',
            base: { kind: 'commit', baseCommit: input.review.observed.baseSha },
            scmPullRequestReviewScope: scope.scope,
        }, context.signal === undefined ? undefined : { signal: context.signal });
        return { v: 1, status: 'started' };
    };
}

export async function startTriageEntrySession(
    input: TriageStartEntrySessionInputV1,
    deps: TriageEntrySessionActionDepsV1,
): Promise<TriageStartEntrySessionResultV1> {
    const orchestratorDeps = {
        collections: deps.collections,
        execute: deps.execute,
        nowMs: deps.nowMs(),
        ...(deps.prepareReviewWorkspace === undefined
            ? {}
            : { prepareReviewWorkspace: deps.prepareReviewWorkspace }),
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
    const delivery = input.delivery === undefined
        ? undefined
        : {
            ...(input.delivery.text === undefined ? {} : { text: input.delivery.text }),
            attachments: input.delivery.attachments,
            idempotencyKey: input.delivery.idempotencyKey,
        };

    // A resume is not a second start path. It reaches the incumbent phase-retry
    // owner with the caller's retained identity. Link/open resumes never spawn;
    // a creation-pending resume re-enters the canonical creator under the same
    // creation key so it can rejoin, rather than creating a second logical
    // Session. Nothing rematerializes and no new creation key is minted. A selected-PR retry
    // carries the source result that its own previous pending response returned;
    // a raw caller that lacks it fails closed rather than invoking SCM again.
    if (input.resume) {
        const workspace = resumedWorkspaceFacts(input.destination, input.resume);
        if (workspace === undefined) {
            return {
                v: 1,
                type: 'workspacePreparationFailed',
                reason: 'refused',
                retryable: false,
            };
        }
        const pending = input.resume.phase === 'creationPending'
            ? (() => {
                const destination = destinationFrom(input.destination);
                if (destination.kind !== 'new') return undefined;
                const directory = workspace.kind === 'referenceOnly'
                    ? destination.materialization.kind === 'reviewWorkspace'
                        ? undefined
                        : destination.materialization.directory
                    : workspace.directory;
                return directory === undefined ? undefined : {
                    type: 'creationPending' as const,
                    creationKey: destination.creationKey,
                    spawn: destination.spawn,
                    directory,
                    workspace,
                };
            })()
            : {
                type: input.resume.phase,
                sessionId: input.resume.sessionId,
                disposition: input.resume.disposition,
                workspace,
                ...(input.resume.delivery === undefined
                    ? {}
                    : { settledDelivery: input.resume.delivery }),
            };
        if (pending === undefined) {
            return { v: 1, type: 'workspacePreparationFailed', reason: 'refused', retryable: false };
        }
        return projectStartResult(await resumeEntrySessionStart(orchestratorDeps, {
            entryRef: input.entryRef,
            display: input.display,
            pending,
            ...(delivery === undefined ? {} : { delivery }),
            ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
        }), input);
    }

    const result = await startEntrySession(orchestratorDeps, {
        // Passed through exactly as the caller's projection produced it, for the
        // same reason the link Action does: the link's address is derived from
        // this reference, so a reference this module rebuilt could address a
        // second row for one relationship.
        entryRef: input.entryRef,
        display: input.display,
        workspaceMode: input.workspaceMode,
        destination: destinationFrom(input.destination),
        ...(delivery === undefined ? {} : { delivery }),
        ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
    });
    return projectStartResult(result, input);
}

export async function unlinkTriageEntryFromSession(
    input: TriageUnlinkEntryFromSessionActionInputV1,
    deps: Pick<TriageEntrySessionActionDepsV1, 'collections' | 'signal'>,
): Promise<TriageUnlinkEntryFromSessionActionResultV1> {
    const result = await unlinkEntryFromSession({
        collections: deps.collections,
        entryRef: input.entryRef,
        sessionId: input.sessionId,
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    // The writer's own verdict, minus the storage tag: a row id is plaintext
    // server metadata and nothing a surface renders needs one.
    return { v: 1, status: result.status };
}

export function createTriageStartEntrySessionActionHandler(): ActionHandler<
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        const prepareReviewWorkspace = await readCurrentPrepareReviewWorkspace(input, context);
        return await startTriageEntrySession(input, {
            collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            execute: async (actionId, actionInput, options) => await context.services.actions.execute(
                actionId,
                actionInput,
                options ?? {},
            ),
            nowMs: () => Date.now(),
            ...(prepareReviewWorkspace === undefined ? {} : { prepareReviewWorkspace }),
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}

export function createTriageUnlinkEntryFromSessionActionHandler(): ActionHandler<
    TriageUnlinkEntryFromSessionActionInputV1,
    TriageUnlinkEntryFromSessionActionResultV1
> {
    return async (input, context: PluginInvocationContext) => await unlinkTriageEntryFromSession(
        input,
        {
            collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            ...(context.signal ? { signal: context.signal } : {}),
        },
    );
}
