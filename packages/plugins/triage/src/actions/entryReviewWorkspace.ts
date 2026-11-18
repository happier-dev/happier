import { selectCurrentTargetedContribution, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { produceScmPullRequestReviewScope, type ScmPullRequestReviewScopeV1 } from '@happier-dev/plugin-sdk/reviews';
import { ScmComparisonSchema, ScmComparisonSourceSchema } from '@happier-dev/plugin-sdk/scm';
import { projectTriagePrepareReviewWorkspaceInputV1, type TriagePrepareReviewWorkspaceInputV1, type TriageVerifyReviewWorkspaceResultV1 } from '@happier-dev/triage-protocol/v1';
import { projectTriageNewSessionFailureV1 } from '../ui/header/newSessionSeedCommand.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { indexTriageAdmittedSourcesV1 } from './listEntries.js';
import { observedReviewWorkspacePreparationFor, prepareEntryReviewWorkspace, preparedReviewWorkspaceFactsFor, type TriageReviewWorkspacePreparationDepsV1 } from '../sessions/entrySessionWorkspace.js';
import type { TriageStartEntrySessionInputV1, TriageStartPullRequestReviewInputV1, TriageStartPullRequestReviewResultV1, TriagePreparePullRequestReviewInputV1, TriagePreparePullRequestReviewResultV1 } from './entrySessionProtocol.js';
import { TriageReobserveEntryResultV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from './reobserveEntryProtocol.js';

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
 * this start will materialize; native input is compared unchanged. The host
 * performs account reconstruction when the admitted operation consumes the carrier.
 */
export function selectedPrepareInputMatchesRequest(
    selection: NonNullable<TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection']>,
    request: TriageReviewWorkspaceRequestV1,
): boolean {
    if (!isJsonRecord(selection.input)) return false;
    if (selection.credentialRef === undefined) {
        return !('account' in request.instance.binding)
            && pluginJsonValuesEqual(selection.input, projectTriagePrepareReviewWorkspaceInputV1(request));
    }
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
export async function readCurrentPrepareReviewWorkspace(
    request: TriageReviewWorkspaceRequestV1,
    selected: TriageStartEntrySessionInputV1['prepareReviewWorkspaceSelection'],
    context: PluginInvocationContext,
): Promise<TriageReviewWorkspacePreparationDepsV1 | undefined> {
    if (selected === undefined || !selectedPrepareInputMatchesRequest(selected, request)) {
        return undefined;
    }

    const current = await selectCurrentTargetedContribution({
        service: context.services.targetedContributions,
        point: TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
        selection: selected.selection,
        operationRole: 'prepareReviewWorkspace',
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
        execute: async (selectedOperation, expectedInput, options) => await context.services.actions
            .executeAdmittedTargetedOperation(selectedOperation,
                pluginJsonValuesEqual(expectedInput, projectTriagePrepareReviewWorkspaceInputV1(request)) ? selectedInput : {
                    ...selectedInput, observed: expectedInput.observed, lastKnownLocator: expectedInput.lastKnownLocator,
                }, {
                ...(selected.credentialRef === undefined ? {} : { expectedSelectedConnectedAccountRef: selected.credentialRef }),
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
            }),
        ...(context.signal ? { signal: context.signal } : {}),
    };
}

/** Reads the selected source's exact final workspace verifier. */
export async function readCurrentVerifyReviewWorkspaceOperation(
    source: TriageStartPullRequestReviewInputV1['review']['entryRef']['source'],
    context: Pick<PluginInvocationContext, 'signal'> & Readonly<{
        services: Pick<PluginInvocationContext['services'], 'targetedContributions'>;
    }>,
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


/** One final source verifier, strict scope producer and pinned comparison capture for every caller. */
export async function verifyTriagePullRequestReviewWorkspace(
    input: Pick<TriageStartPullRequestReviewInputV1, 'sessionId' | 'review' | 'comparisonSource'>,
    context: PluginInvocationContext,
    captureComparison: boolean,
): Promise<
    | Readonly<{ status: 'verified'; scope: ScmPullRequestReviewScopeV1; comparisonId?: string }>
    | (Extract<TriageStartPullRequestReviewResultV1, Readonly<{ status: 'refused' }>> & Readonly<{ sourceResult?: TriageVerifyReviewWorkspaceResultV1 }>)
> {
    if ('source' in input.review.instance.binding && input.review.instance.binding.source === 'accountData') {
        return { v: 1, status: 'refused', reason: 'scopeRefused' };
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
                ...('account' in input.review.instance.binding
                    ? { expectedSelectedConnectedAccountRef: input.review.instance.binding.account }
                    : {}),
                ...(context.signal === undefined ? {} : { signal: context.signal }),
            },
        );
        if (verified.kind !== 'verified') {
            const failure = projectTriageNewSessionFailureV1(verified.failure);
            return { v: 1, status: 'refused', sourceResult: verified,
                reason: verified.kind === 'workspaceMismatch' ? 'workspaceMismatch'
                    : verified.kind === 'unavailable' ? 'sourceUnavailable' : 'revisionMismatch',
                ...(failure === undefined ? {} : { failure }),
            };
        }

        const reviewAuthority = 'account' in input.review.instance.binding
            ? { account: input.review.instance.binding.account }
            : { nativeService: input.review.instance.binding.service };
        const scope = produceScmPullRequestReviewScope({
            authoritative: {
                ...reviewAuthority,
                pullRequest: verified.pullRequest,
                observed: input.review.observed,
            },
            expected: {
                ...reviewAuthority,
                baseSha: input.review.observed.baseSha,
                headSha: input.review.observed.headSha,
            },
        });
        if (scope.status === 'refused') {
            return { v: 1, status: 'refused', reason: 'scopeRefused' };
        }

        let comparisonId: string | undefined;
        if (captureComparison) {
            const source = ScmComparisonSourceSchema.safeParse(input.comparisonSource);
            if (!source.success || source.data.kind !== 'pullRequest') {
                return { v: 1, status: 'refused', reason: 'scopeRefused' };
            }
            if ('number' in scope.scope.pullRequest
                && source.data.locator.number !== scope.scope.pullRequest.number) {
                return { v: 1, status: 'refused', reason: 'scopeRefused' };
            }
            if (source.data.locator.baseOid !== scope.scope.observed.baseSha
                || source.data.locator.headOid !== scope.scope.observed.headSha) {
                return { v: 1, status: 'refused', reason: 'revisionMismatch' };
            }
            const captured = await context.services.actions.execute('scm.diffSummary.capture', {
                sessionId: input.sessionId,
                cwd: input.review.repositoryPath,
                source: source.data,
            }, context.signal === undefined ? undefined : { signal: context.signal });
            const capture = typeof captured === 'object' && captured !== null
                ? captured as Readonly<{ success?: unknown; comparison?: unknown }>
                : undefined;
            const comparison = ScmComparisonSchema.safeParse(capture?.comparison);
            if (capture?.success !== true || !comparison.success) {
                return { v: 1, status: 'refused', reason: 'sourceUnavailable' };
            }
            if (!pluginJsonValuesEqual(comparison.data.source, source.data)
                || !comparison.data.endpoints.before
                || comparison.data.pullRequest?.baseOid !== scope.scope.observed.baseSha
                || comparison.data.endpoints.after !== scope.scope.observed.headSha) {
                return { v: 1, status: 'refused', reason: 'revisionMismatch' };
            }
            comparisonId = comparison.data.id;
        }

    return { status: 'verified', scope: scope.scope, ...(comparisonId === undefined ? {} : { comparisonId }) };
}

/** Selected-source preparation never creates a Session or starts a reviewer. */
export function createTriagePreparePullRequestReviewActionHandler(): ActionHandler<
    TriagePreparePullRequestReviewInputV1, TriagePreparePullRequestReviewResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        // A saved workflow retains the selected source/workspace, not a saved PR revision.
        // This exact-read Action owns source qualification and observation timestamps.
        if (!selectedPrepareInputMatchesRequest(input.prepareReviewWorkspaceSelection, input.request)) {
            return { v: 1, status: 'refused', reason: 'sourceMismatch' };
        }
        const reread = TriageReobserveEntryResultV1Schema.parse(await context.services.actions.execute({
            pluginId: 'happier.triage', localId: TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
        }, { v: 1, entryRef: input.request.entryRef,
            sourceInstanceId: input.request.instance.instance.sourceInstanceId,
            lastKnownLocator: input.request.lastKnownLocator }, { signal: context.signal }));
        if (reread.kind !== 'observed') return { v: 1, status: 'unavailable', reason: 'sourceUnavailable',
            ...(reread.kind !== 'unavailable' || reread.failure === undefined ? {} : { failure: projectTriageNewSessionFailureV1(reread.failure) }) };
        const preparation = observedReviewWorkspacePreparationFor(input.request.instance, input.request.entryRef, reread.observation);
        if (preparation === undefined) return { v: 1, status: 'unavailable', reason: 'revisionUnavailable' };
        const request = { ...input.request, ...preparation };
        if (request.observed.headSha !== input.expectedHeadSha) return { v: 1, status: 'refused', reason: 'revisionMismatch' };
        const deps = await readCurrentPrepareReviewWorkspace(input.request, input.prepareReviewWorkspaceSelection, context);
        if (deps === undefined) return { v: 1, status: 'unavailable', reason: 'sourceUnavailable' };
        const preparedWorkspace = await prepareEntryReviewWorkspace(deps, request);
        if (preparedWorkspace.kind !== 'prepared') return {
            v: 1, status: preparedWorkspace.kind === 'unavailable' ? 'unavailable' : 'refused',
            reason: preparedWorkspace.kind, sourceResult: preparedWorkspace,
        };
        const facts = preparedReviewWorkspaceFactsFor(preparedWorkspace, request.observed);
        if (facts.reviewEligibility.status !== 'eligible' || request.workspace === null) {
            return { v: 1, status: 'refused', reason: 'revisionMismatch', sourceResult: preparedWorkspace };
        }
        const review = { instance: request.instance, entryRef: request.entryRef, lastKnownLocator: request.lastKnownLocator,
            observed: request.observed, workspace: request.workspace, repositoryPath: preparedWorkspace.repositoryPath,
            pullRequest: preparedWorkspace.pullRequest };
        const comparisonSource = input.comparisonSource.kind === 'pullRequest' ? { ...input.comparisonSource,
            locator: { ...input.comparisonSource.locator, baseOid: request.observed.baseSha, headOid: request.observed.headSha } } : input.comparisonSource;
        const verified = await verifyTriagePullRequestReviewWorkspace({ ...input, review, comparisonSource }, context, true);
        if (verified.status !== 'verified') return { ...verified, status: verified.reason === 'sourceUnavailable' ? 'unavailable' : 'refused' };
        if (verified.comparisonId === undefined) return { v: 1, status: 'unavailable', reason: 'sourceUnavailable' };
        return { v: 1, status: 'prepared', review, preparedWorkspace,
            scmPullRequestReviewScope: projectNativeJsonValueForTransport(verified.scope), comparisonId: verified.comparisonId, comparisonSource };
    };
}
