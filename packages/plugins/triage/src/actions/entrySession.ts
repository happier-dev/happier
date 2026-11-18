import { readCurrentPrepareReviewWorkspace, readCurrentVerifyReviewWorkspaceOperation, verifyTriagePullRequestReviewWorkspace } from './entryReviewWorkspace.js';
import { readTriageAccountDataSourceOptionsV1 } from './accountDataSources.js';
import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import { PluginError, type JsonValue, type PluginInvocationContext, } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type ActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    type TriageVerifyReviewWorkspaceResultV1,
} from '@happier-dev/triage-protocol/v1';
import { projectNativeJsonValueForTransport, pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import { readReviewStartActionResultV1, reviewReviewerIdsForStartV1, ReviewStartInputSchema } from '@happier-dev/plugin-sdk/reviews';
import { SessionIdSchema, SessionStatusActionResultV1Schema, SessionMessageSendResultV1ProtocolSchema } from '@happier-dev/plugin-sdk/sessions';

import { projectTriageNewSessionFailureV1 } from '../ui/header/newSessionSeedCommand.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { configuredSourceInstanceIsOwnedBy, findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { CORPUS_SOURCE_INSTANCE_LIFECYCLE } from '../corpus/collections/ids.js';
import { sameTriageEntryReference } from '../corpus/identity/components.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
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
    TriageVerifyExistingReviewWorkspaceInputV1,
    TriageVerifyExistingReviewWorkspaceResultV1,
} from './entrySessionProtocol.js';

/** Verifies an existing accepted checkout through the selected source's one native verifier. */
export function createTriageVerifyExistingReviewWorkspaceActionHandler(): TriageDataActionHandler<
    TriageVerifyExistingReviewWorkspaceInputV1, TriageVerifyExistingReviewWorkspaceResultV1
> {
    return async (input, context) => {
        const unavailable = { kind: 'unavailable' as const };
        const options = { signal: context.signal };
        let rawStatus: unknown;
        try {
            rawStatus = await context.services.actions.execute('session.status.get',
                { sessionId: input.session.sessionId, includeAcceptedWorkspace: true }, options);
        } catch (error) {
            if (context.signal.aborted) return unavailable;
            const failure = projectTriageNewSessionFailureV1(error);
            return { ...unavailable, ...(failure === undefined ? {} : { failure }) };
        }
        const status = SessionStatusActionResultV1Schema.safeParse(rawStatus);
        if (!status.success || status.data.ok === false || status.data.session.id !== input.session.sessionId) return unavailable;
        const accepted = status.data.acceptedWorkspace;
        if (accepted === undefined || accepted.checkout.serverId !== input.session.serverId) return unavailable;
        const { sourceInstances } = bindCorpusCollections(requireTriageAccountStorage(context));
        const row = await findConfiguredSourceInstanceRow(sourceInstances, input.sourceInstanceId, await readTriageAccountDataSourceOptionsV1(context));
        if (row === null || row.value.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active
            || !configuredSourceInstanceIsOwnedBy(row.value, input.entryRef.source)) return unavailable;
        const operation = await readCurrentVerifyReviewWorkspaceOperation(input.entryRef.source, context);
        if (operation === undefined) return unavailable;
        const instance = row.value.configured;
        const verified: TriageVerifyReviewWorkspaceResultV1 = await context.services.actions.executeAdmittedTargetedOperation(operation, {
            v: 1, instance, entryRef: input.entryRef, lastKnownLocator: input.lastKnownLocator, observed: input.observed,
            workspace: { serverId: accepted.checkout.serverId, machineId: accepted.checkout.machineId, rootPath: accepted.checkout.rootPath },
            prepared: { kind: 'acceptedCheckout', repositoryPath: accepted.checkout.rootPath },
        }, { ...options, ...('account' in instance.binding ? { expectedSelectedConnectedAccountRef: instance.binding.account } : {}) });
        if (context.signal.aborted) return unavailable;
        if (verified.kind !== 'verified') {
            const failure = projectTriageNewSessionFailureV1(verified.failure);
            return { ...unavailable, ...(failure === undefined ? {} : { failure }) };
        }
        return { kind: 'verified', checkout: accepted.checkout };
    };
}

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
    /** The host invoker for the two generic Session Actions this start consumes. */
    execute: TriageSessionActionInvokerV1;
    linkSession: import('../sessions/entrySessionOrchestrator.js').TriageEntrySessionDepsV1['linkSession'];
    /** The exact current selected source operation for a pull-request start. */
    prepareReviewWorkspace?: TriageReviewWorkspacePreparationDepsV1;
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
            // The closed Action carrier already selected the allowed recipe
            // fields. Forward them whole so this adapter cannot drop a choice.
            ...destination.spawn,
        },
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
    const deliveryResult = result.deliveryResult === undefined ? {} : {
        deliveryResult: SessionMessageSendResultV1ProtocolSchema.parse(result.deliveryResult),
    };
    const sessionAddress = input.delivery?.returnResult === true && 'sessionId' in result && input.destination.kind === 'new'
        ? { sessionAddress: { serverId: input.destination.spawn.executionTarget.serverId, sessionId: result.sessionId } } : {};
    switch (result.type) {
        case 'opened': {
            const review = reviewContinuationFor(input, result);
            const preparedReviewWorkspace = result.delivery === 'outcomeUnknown'
                ? preparedReviewWorkspaceForWire(result.workspace)
                : undefined;
            return {
                v: 1,
                type: result.type,
                ...deliveryResult, ...sessionAddress,
                sessionId: result.sessionId,
                disposition: result.disposition,
                // The Message-send owner's verdict on the structured delivery,
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
                ...(result.failure === undefined ? {} : { failure: result.failure }),
                ...deliveryResult, ...sessionAddress,
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
                ...deliveryResult, ...sessionAddress,
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
                ...deliveryResult, ...sessionAddress,
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
            return { v: 1, type: 'creationFailed', failureCode: result.failureCode,
                ...(result.failureCause === undefined ? {} : { failureCause: result.failureCause }) };
        case 'workspacePreparationFailed':
            return {
                v: 1,
                type: 'workspacePreparationFailed',
                reason: result.reason,
                retryable: result.retryable,
                ...(result.failure === undefined ? {} : { failure: result.failure }),
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

function isJsonRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        if ('source' in input.review.instance.binding && input.review.instance.binding.source === 'accountData') {
            return { v: 1, status: 'refused', reason: 'scopeRefused' };
        }
        if (new Set(input.engineIds).size !== input.engineIds.length) {
            return { v: 1, status: 'refused', reason: 'reviewRejected' };
        }
        if (input.launchSelection !== undefined && !isJsonRecord(input.launchSelection)) {
            return { v: 1, status: 'refused', reason: 'reviewRejected' };
        }
        const launchSelection: Readonly<Record<string, JsonValue>> = input.launchSelection ?? {};
        // The public review owner alone admits outputs, narrator and credential
        // selections, including nested keys and normalization. Triage only relays
        // credential fields, never host-selected overrides of the PR review intent.
        const admission = ReviewStartInputSchema.safeParse({
            sessionId: input.sessionId,
            engineIds: input.engineIds,
            instructions: input.instructions,
            ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
            ...(input.narrator === undefined ? {} : { narrator: input.narrator }),
            secretReferenceOverlay: launchSelection.secretReferenceOverlay,
            teamCredentialModel: launchSelection.teamCredentialModel,
            teamCredentialSessionBindingConsent: launchSelection.teamCredentialSessionBindingConsent,
        });
        if (!admission.success) return { v: 1, status: 'refused', reason: 'reviewRejected' };
        const verified = await verifyTriagePullRequestReviewWorkspace(input, context, admission.data.outputs?.includes('walkthrough') === true);
        if (verified.status !== 'verified') {
            const { sourceResult: _sourceResult, ...refusal } = verified;
            return refusal;
        }
        const scope = { scope: verified.scope };
        const comparisonId = verified.comparisonId;

        const fanout = await context.services.actions.execute('review.start', {
            sessionId: input.sessionId,
            engineIds: [...input.engineIds],
            instructions: input.instructions,
            changeType: 'committed',
            base: { kind: 'commit', baseCommit: input.review.observed.baseSha },
            scmPullRequestReviewScope: scope.scope,
            ...(admission.data.outputs === undefined ? {} : { outputs: admission.data.outputs }),
            ...(admission.data.narrator === undefined ? {} : { narrator: admission.data.narrator }),
            ...(comparisonId === undefined ? {} : { comparisonId }),
            ...(admission.data.secretReferenceOverlay === undefined ? {} : { secretReferenceOverlay: admission.data.secretReferenceOverlay }),
            ...(admission.data.teamCredentialModel === undefined ? {} : { teamCredentialModel: admission.data.teamCredentialModel }),
            ...(admission.data.teamCredentialSessionBindingConsent === undefined ? {} : { teamCredentialSessionBindingConsent: admission.data.teamCredentialSessionBindingConsent }),
        }, context.signal === undefined ? undefined : { signal: context.signal });
        const parsed = readReviewStartActionResultV1(fanout, admission.data);
        if (parsed.kind !== 'native') {
            // The write happened and its per-engine effect is unknown. Failing
            // loudly reaches the caller's existing outcome-unknown state, which
            // offers only the idempotent Session open — never a blind second
            // review start.
            const answer = projectNativeJsonValueForTransport(fanout);
            const items = isJsonRecord(answer) && Array.isArray(answer.results) ? answer.results : [];
            throw new PluginError({
                code: 'action_outcome_unknown',
                details: answer,
                diagnostics: items.flatMap(item => typeof item === 'object' && item !== null
                    && !Array.isArray(item) && item.ok === false && typeof item.errorCode === 'string'
                    ? [{ code: item.errorCode, severity: 'error' as const }] : []),
            });
        }
        const reviewerIds = reviewReviewerIdsForStartV1(admission.data);
        const engineIdForReviewerId = (reviewerId: string): string | undefined => {
            const index = reviewerIds.indexOf(reviewerId);
            return index === -1 ? undefined : input.engineIds[index];
        };
        const started = parsed.runs
            .map(run => engineIdForReviewerId(run.key))
            .filter((engineId): engineId is string => engineId !== undefined);
        const failed = parsed.failed
            .map(run => engineIdForReviewerId(run.key))
            .filter((engineId): engineId is string => engineId !== undefined);
        if (started.length + failed.length !== input.engineIds.length) {
            const answer = projectNativeJsonValueForTransport(fanout);
            const items = isJsonRecord(answer) && Array.isArray(answer.results) ? answer.results : [];
            throw new PluginError({
                code: 'action_outcome_unknown',
                details: answer,
                diagnostics: items.flatMap(item => typeof item === 'object' && item !== null
                    && !Array.isArray(item) && item.ok === false && typeof item.errorCode === 'string'
                    ? [{ code: item.errorCode, severity: 'error' as const }] : []),
            });
        }
        if (started.length === 0) {
            return { v: 1, status: 'refused', reason: 'noEngineStarted' };
        }
        return {
            v: 1,
            status: 'started',
            startedEngineIds: started,
            failedEngineIds: failed,
        };
    };
}

export async function startTriageEntrySession(
    input: TriageStartEntrySessionInputV1,
    deps: TriageEntrySessionActionDepsV1,
): Promise<TriageStartEntrySessionResultV1> {
    const orchestratorDeps = {
        execute: deps.execute,
        linkSession: deps.linkSession,
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
            ...(input.delivery.forgeEvidence === undefined ? {} : { forgeEvidence: input.delivery.forgeEvidence }),
            ...(input.delivery.returnResult === undefined ? {} : { returnResult: input.delivery.returnResult }),
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
            ...(input.orchestrate === undefined ? {} : { orchestrate: input.orchestrate }),
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
        ...(input.orchestrate === undefined ? {} : { orchestrate: input.orchestrate }),
        ...(delivery === undefined ? {} : { delivery }),
        ...(input.finalOpen === undefined ? {} : { finalOpen: input.finalOpen }),
    });
    return projectStartResult(result, input);
}

export function createTriageStartEntrySessionActionHandler(): ActionHandler<
    TriageStartEntrySessionInputV1,
    TriageStartEntrySessionResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        const prepareReviewWorkspace = input.destination.kind === 'new' && input.destination.materialization.kind === 'reviewWorkspace'
            ? await readCurrentPrepareReviewWorkspace(input.destination.materialization.request, input.prepareReviewWorkspaceSelection, context)
            : undefined;
        const collections = bindCorpusCollections(requireTriageAccountStorage(context));
        const relations = createTriageSourceSessionRelations(context, collections);
        return await startTriageEntrySession(input, {
            linkSession: async (link) => {
                const result = await relations.write({ ...link,
                    sourceInstanceId: link.sourceInstanceId ?? (sameTriageEntryReference(link.entryRef, input.entryRef) ? input.sourceInstanceId : undefined),
                    linked: true });
                return { status: result.status === 'linked' ? 'linked' : 'failed' };
            },
            execute: async (actionId, actionInput, options) => {
                const result = await context.services.actions.execute(
                    actionId,
                    actionInput,
                    options ?? {},
                );
                if (isPluginActionApprovalRequestCreated(result)) {
                    throw new Error('triage:sessionAction:approvalDeferred');
                }
                return result;
            },
            ...(prepareReviewWorkspace === undefined ? {} : { prepareReviewWorkspace }),
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}

export function createTriageUnlinkEntryFromSessionActionHandler(): TriageDataActionHandler<
    TriageUnlinkEntryFromSessionActionInputV1,
    TriageUnlinkEntryFromSessionActionResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        const sessionId = SessionIdSchema.parse(input.sessionId);
        const result = await createTriageSourceSessionRelations(context,
            bindCorpusCollections(requireTriageAccountStorage(context))).write({ ...input,
            sessionId, linked: false });
        if (result.status === 'failed') throw result.failure;
        return { v: 1, status: result.status === 'linked' ? 'failed' : result.status };
    };
}
