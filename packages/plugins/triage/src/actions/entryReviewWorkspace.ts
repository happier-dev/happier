import { PluginError, selectCurrentTargetedContribution, type JsonValue, type PluginInvocationContext, type TargetedContributionSelectionUnavailableReason } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { pluginJsonValuesEqual, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { produceScmPullRequestReviewScope, type ScmPullRequestReviewScopeV1 } from '@happier-dev/plugin-sdk/reviews';
import { normalizeScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity, ScmComparisonSchema, type ScmComparison, type ScmComparisonSource } from '@happier-dev/plugin-sdk/scm';
import { projectTriagePrepareReviewWorkspaceInputV1, projectTriageReviewSkipRulesV1, type TriagePrepareReviewWorkspaceInputV1, type TriageVerifyReviewWorkspaceResultV1 } from '@happier-dev/triage-protocol/v1';
import { projectTriageNewSessionFailureV1 } from '../ui/header/newSessionSeedCommand.js';
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../targetedContributions.js';
import { indexTriageAdmittedSourcesV1 } from '../corpus/configuration/accountDataSources.js';
import { observedReviewWorkspacePreparationFor, prepareEntryReviewWorkspace, preparedReviewWorkspaceFactsFor, type TriageReviewWorkspacePreparationDepsV1 } from '../sessions/entrySessionWorkspace.js';
import type { TriageStartEntrySessionInputV1, TriageStartPullRequestReviewInputV1, TriageStartPullRequestReviewResultV1, TriagePreparePullRequestReviewInputV1, TriagePreparePullRequestReviewResultV1 } from './entrySessionProtocol.js';
import { TriageReobserveEntryResultV1Schema, TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1 } from './reobserveEntryProtocol.js';
import { readPullRequestReviewRules, selectPullRequestReviewPaths } from './pullRequestReviewRules.js';
import type { PullRequestReviewResolvedRulesV1 } from '@happier-dev/triage-protocol/v1';
import type { PullRequestReviewRuleOccurrenceV1 } from './entrySessionProtocol.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { setReviewSkip } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { readReviewSessionRepository, reviewSessionHasRepository, reviewSessionRepositoryMismatch } from './reviewSessionRepository.js';
import { admitPullRequestSourceForPreparation } from './resolveResource.js';

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
): Promise<TriageReviewWorkspacePreparationDepsV1 | TargetedContributionSelectionUnavailableReason | undefined> {
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
    if (current.kind !== 'selected') return current.reason;
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
                    ...selectedInput, entryRef: expectedInput.entryRef,
                    observed: expectedInput.observed, lastKnownLocator: expectedInput.lastKnownLocator,
                }, {
                expectedSelectedConnectedAccountRef: selected.credentialRef ?? null,
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
            }),
        ...(context.signal ? { signal: context.signal } : {}),
    };
}

/** Reads the selected source's current workspace operation. */
async function readCurrentReviewWorkspaceOperation<Role extends 'prepareReviewWorkspace' | 'verifyReviewWorkspace'>(
    source: TriageStartPullRequestReviewInputV1['review']['entryRef']['source'],
    role: Role,
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
        )?.operations[role];
    } finally {
        observation.dispose();
    }
}


export function readCurrentVerifyReviewWorkspaceOperation(
    source: TriageStartPullRequestReviewInputV1['review']['entryRef']['source'],
    context: Parameters<typeof readCurrentReviewWorkspaceOperation>[2],
) {
    return readCurrentReviewWorkspaceOperation(source, 'verifyReviewWorkspace', context);
}

/** One final source verifier, strict scope producer and pinned comparison capture for every caller. */
export async function verifyTriagePullRequestReviewWorkspace(
    input: Pick<TriageStartPullRequestReviewInputV1, 'sessionId' | 'review'> & Readonly<{ comparisonSource?: ScmComparisonSource }>,
    context: PluginInvocationContext,
    captureComparison: boolean,
): Promise<
    | Readonly<{ status: 'verified'; scope: ScmPullRequestReviewScopeV1; comparisonId?: string; inventory?: ScmComparison['inventory'] }>
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

    return await captureTriagePullRequestReviewComparison({ ...input,
        review: { ...input.review, pullRequest: verified.pullRequest },
    }, context, captureComparison);
}

/** Consume source-owned preparation or final verification; SCM alone captures evidence. */
async function captureTriagePullRequestReviewComparison(
    input: Pick<TriageStartPullRequestReviewInputV1, 'sessionId' | 'review'> & Readonly<{ comparisonSource?: ScmComparisonSource }>,
    context: PluginInvocationContext,
    captureComparison: boolean,
): ReturnType<typeof verifyTriagePullRequestReviewWorkspace> {
    if ('source' in input.review.instance.binding && input.review.instance.binding.source === 'accountData') {
        return { v: 1, status: 'refused', reason: 'scopeRefused' };
    }
    const reviewAuthority = 'account' in input.review.instance.binding
        ? { account: input.review.instance.binding.account }
        : { nativeService: input.review.instance.binding.service };
    // The source result intentionally carries opaque PR metadata. Admit its
    // grammar once; its provider/head/currentness decisions already belong
    // to preparation or the final verifier, not a comparison of our own values.
    const scope = produceScmPullRequestReviewScope({
        authoritative: { ...reviewAuthority, pullRequest: input.review.pullRequest, observed: input.review.observed },
        expected: { ...reviewAuthority, baseSha: input.review.observed.baseSha, headSha: input.review.observed.headSha },
    });
    if (scope.status === 'refused') {
        return { v: 1, status: 'refused', reason: 'scopeRefused' };
    }

    if (captureComparison) {
        const source = input.comparisonSource;
        if (source?.kind !== 'pullRequest') {
            return { v: 1, status: 'refused', reason: 'scopeRefused' };
        }
        if ('number' in scope.scope.pullRequest
            && source.locator.number !== scope.scope.pullRequest.number) {
            return { v: 1, status: 'refused', reason: 'scopeRefused' };
        }
        if (source.locator.baseOid !== scope.scope.observed.baseSha
            || source.locator.headOid !== scope.scope.observed.headSha) {
            return { v: 1, status: 'refused', reason: 'revisionMismatch' };
        }
        const captured = await context.services.actions.execute('scm.diffSummary.capture', {
            sessionId: input.sessionId,
            cwd: input.review.repositoryPath,
            source,
        }, context.signal === undefined ? undefined : { signal: context.signal });
        const capture = typeof captured === 'object' && captured !== null
            ? captured as Readonly<{ success?: unknown; comparison?: unknown }>
            : undefined;
        const comparison = ScmComparisonSchema.safeParse(capture?.comparison);
        if (capture?.success !== true || !comparison.success) {
            return { v: 1, status: 'refused', reason: 'sourceUnavailable' };
        }
        if (!comparison.data.endpoints.before
            || comparison.data.pullRequest?.baseOid !== scope.scope.observed.baseSha
            || comparison.data.endpoints.after !== scope.scope.observed.headSha) {
            return { v: 1, status: 'refused', reason: 'revisionMismatch' };
        }
        return { status: 'verified', scope: scope.scope, comparisonId: comparison.data.id, inventory: comparison.data.inventory };
    }

    return { status: 'verified', scope: scope.scope };
}

type SkipReason = Extract<TriagePreparePullRequestReviewResultV1, { status: 'skipped' }>['reason'];

/**
 * The PR shows why its Review was skipped from this one record of Prepare's own result (the head it judged,
 * the occurrence facts the rule compared, the Automation whose run asked). The Run keeps the authoritative
 * step result, so a failed projection write leaves the skip readable there and never fails the step.
 */
async function recordReviewSkip(
    context: PluginInvocationContext,
    review: Readonly<{ entryRef: ApprovedPrepareInput['reviewTarget']['entryRef'];
        lastKnownLocator: { displayPath?: string }; observed: { headSha: string } }>,
    occurrence: PullRequestReviewRuleOccurrenceV1 | undefined,
    reason: SkipReason,
    rules: PullRequestReviewResolvedRulesV1,
): Promise<void> {
    const automationId = context.caller?.kind === 'automationRun' ? context.caller.automationId : undefined;
    try {
        await setReviewSkip({
            collections: bindCorpusCollections(requireTriageAccountStorage(context)),
            entryRef: review.entryRef,
            displayAtMark: { title: review.lastKnownLocator.displayPath ?? review.entryRef.entryId, scopeLabel: review.entryRef.collisionScope },
            reviewSkip: { headSha: review.observed.headSha, reason, rules: projectTriageReviewSkipRulesV1(rules),
                occurrence: {
                    ...(occurrence?.baseRef === undefined ? {} : { baseRef: occurrence.baseRef }),
                    ...(occurrence?.author?.kind === undefined ? {} : { authorKind: occurrence.author.kind }),
                },
                ...(automationId === undefined ? {} : { automationId }) },
            nowMs: Date.now(),
            ...(context.signal === undefined ? {} : { signal: context.signal }),
        });
    } catch {
        // The Run's step result remains the readable record of this skip.
    }
}

type ManualPrepareInput = Extract<TriagePreparePullRequestReviewInputV1, { kind: 'resolvedPullRequestForSession' }>;
type ApprovedPrepareInput = Extract<TriagePreparePullRequestReviewInputV1, { request: unknown }>;

async function prepareManualPullRequestReview(
    input: ManualPrepareInput,
    context: PluginInvocationContext,
): Promise<TriagePreparePullRequestReviewResultV1> {
    const options = { signal: context.signal };
    const unreadable = () => new PluginError({
        code: 'sourceUnavailable', effectAttempted: false, message: 'The pull request could not be read from its connected source.',
    });
    const preparation = observedReviewWorkspacePreparationFor(input.instance, input.entryRef, input.observation);
    const source = input.comparisonSource;
    const identity = input.observation.outcome.kind === 'present' ? input.observation.outcome.repository : undefined;
    const repository = normalizeScmHostingRepositoryIdentity(identity);
    if (!preparation || source.kind !== 'pullRequest' || !repository) throw unreadable();
    const comparisonRepository = normalizeScmHostingRepositoryIdentity({ ...repository, repository: source.locator.repository });
    if (!sameScmHostingRepositoryIdentity(repository, comparisonRepository)
        || source.locator.headOid !== preparation.observed.headSha || source.locator.baseOid !== preparation.observed.baseSha) {
        throw new PluginError({ code: 'invalid_input', effectAttempted: false,
            message: 'Use the pinned comparison and observation from the same pull request read.' });
    }

    const session = await context.services.sessions.get(input.sessionId, options);
    const summary = await session?.summary(options);
    const serverId = summary?.serverId ?? summary?.address?.serverId;
    if (!serverId || !summary?.machineId) throw reviewSessionRepositoryMismatch(repository);
    const checkout = await readReviewSessionRepository(input.sessionId, context);
    if (!checkout || !reviewSessionHasRepository(checkout, repository)) throw reviewSessionRepositoryMismatch(repository);
    const url = preparation.lastKnownLocator.webUrl;
    if (!url) throw unreadable();
    const admitted = await admitPullRequestSourceForPreparation({ instance: input.instance, entryRef: input.entryRef, url }, context);

    // The source operation verifies the approved revision before touching SCM.
    const outcome = await settlePreparedPullRequestReview({
        context, sessionId: input.sessionId,
        request: { ...preparation, instance: admitted.instance, lastKnownLocator: admitted.locator, workflowSubject: 'pullRequest',
            workspace: { serverId, machineId: summary.machineId, rootPath: checkout.rootPath } },
        deps: { operation: admitted.operation, execute: (selected, sourceInput, cancellation) =>
            context.services.actions.executeAdmittedTargetedOperation(selected, sourceInput, cancellation ?? options), ...options },
        targetSource: source,
    });
    if (outcome.status === 'refused' || outcome.status === 'unavailable') {
        const nested = outcome.sourceResult;
        const failure = nested && 'failure' in nested ? nested.failure : undefined;
        const reason = nested && 'reason' in nested ? nested.reason : outcome.reason;
        const staleHead = reason === 'observedHeadMoved' && outcome.reason === 'refused';
        const beforeWorkspace = staleHead || (reason === 'account' && outcome.reason === 'unavailable');
        const message = staleHead
            ? 'The pull request changed since you approved it. Start the Workflow again to review the new head.'
            : failure?.detail ?? (reason === 'account' ? 'Reconnect the source account in PRs & Issues, then try the pull request again.' : undefined);
        throw new PluginError({
            code: failure?.code ?? outcome.failure?.codes[0] ?? reason,
            ...(message === undefined ? {} : { message }),
            ...(beforeWorkspace ? { effectAttempted: false } : {}),
            ...(nested === undefined ? {} : { details: nested }),
            ...(failure === undefined ? {} : { failureCause: projectActionFailureCauseV1(
                new PluginError({ code: failure.code }), 'triage.prepare.review_workspace', { allowUnknownErrorCode: true },
            ) }),
        });
    }
    return outcome;
}

/** Selected-source preparation never creates a Session or starts a reviewer. */
export function createTriagePreparePullRequestReviewActionHandler(): ActionHandler<
    TriagePreparePullRequestReviewInputV1, TriagePreparePullRequestReviewResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        if ('kind' in input) return await prepareManualPullRequestReview(input, context);
        // A saved workflow retains the selected source/workspace, not a saved PR revision.
        // This exact-read Action owns source qualification and observation timestamps.
        if (!selectedPrepareInputMatchesRequest(input.prepareReviewWorkspaceSelection, input.request)) {
            return { v: 1, status: 'refused', reason: 'sourceMismatch' };
        }
        const reread = TriageReobserveEntryResultV1Schema.parse(await context.services.actions.execute({
            pluginId: 'happier.triage', localId: TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1,
        }, { v: 1, entryRef: input.reviewTarget.entryRef,
            sourceInstanceId: input.request.instance.instance.sourceInstanceId,
            lastKnownLocator: input.reviewTarget.lastKnownLocator }, { signal: context.signal }));
        if (reread.kind !== 'observed') return { v: 1, status: 'unavailable', reason: 'sourceUnavailable',
            ...(reread.kind !== 'unavailable' || reread.failure === undefined ? {} : { failure: projectTriageNewSessionFailureV1(reread.failure) }) };
        const preparation = observedReviewWorkspacePreparationFor(input.request.instance, input.reviewTarget.entryRef, reread.observation);
        if (preparation === undefined) return { v: 1, status: 'unavailable', reason: 'revisionUnavailable' };
        const request = { ...input.request, ...preparation };
        if (request.observed.headSha !== input.expectedHeadSha) return { v: 1, status: 'refused', reason: 'revisionMismatch' };
        const deps = await readCurrentPrepareReviewWorkspace(input.request, input.prepareReviewWorkspaceSelection, context);
        if (typeof deps === 'string') return { v: 1, status: 'unavailable', reason: deps };
        if (deps === undefined) return { v: 1, status: 'unavailable', reason: 'sourceUnavailable' };
        return await settlePreparedPullRequestReview({
            context, sessionId: input.sessionId, request, deps, targetSource: input.reviewTarget.comparisonSource,
            ruleOccurrence: input.ruleOccurrence, reviewRules: input.reviewRules,
        });
    };
}

async function settlePreparedPullRequestReview({
    context, sessionId, request, deps, targetSource, ruleOccurrence, reviewRules,
}: Readonly<{
    context: PluginInvocationContext;
    sessionId: ApprovedPrepareInput['sessionId'];
    request: TriageReviewWorkspaceRequestV1;
    deps: TriageReviewWorkspacePreparationDepsV1;
    targetSource: ScmComparisonSource;
    ruleOccurrence?: ApprovedPrepareInput['ruleOccurrence'];
    reviewRules?: ApprovedPrepareInput['reviewRules'];
}>): Promise<TriagePreparePullRequestReviewResultV1> {
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
    const resolved = ruleOccurrence === undefined ? undefined : await readPullRequestReviewRules({
        repositoryPath: review.repositoryPath, baseRevision: review.observed.baseSha, occurrence: ruleOccurrence,
        project: reviewRules, context,
    });
    if (resolved?.kind === 'invalid' || resolved?.kind === 'unavailable') return {
        v: 1, status: 'unavailable', reason: resolved.kind === 'invalid' ? 'invalidReviewRules' : 'reviewRulesUnavailable',
    };
    const skip = async (reason: SkipReason, rules: PullRequestReviewResolvedRulesV1) => {
        await recordReviewSkip(context, review, ruleOccurrence, reason, rules);
        return { v: 1 as const, status: 'skipped' as const, reason, rules };
    };
    if (resolved?.kind === 'skipped') return await skip(resolved.reason, resolved.rules);
    const comparisonSource = targetSource.kind === 'pullRequest' ? { ...targetSource,
        locator: { ...targetSource.locator, baseOid: request.observed.baseSha, headOid: request.observed.headSha } } : targetSource;
    const verified = await captureTriagePullRequestReviewComparison({ sessionId, review, comparisonSource }, context, true);
    if (verified.status !== 'verified') return { ...verified, status: verified.reason === 'sourceUnavailable' ? 'unavailable' : 'refused' };
    if (verified.comparisonId === undefined) return { v: 1, status: 'unavailable', reason: 'sourceUnavailable' };
    const rules = resolved?.kind === 'ready' ? resolved.rules : undefined;
    const selectedPaths = rules?.ignorePaths?.length
        ? selectPullRequestReviewPaths(verified.inventory?.files.map(file => file.path) ?? [], rules.ignorePaths) : undefined;
    if (rules && selectedPaths?.length === 0) return verified.inventory?.state === 'complete'
        ? await skip('noReviewablePaths', rules)
        : { v: 1, status: 'unavailable', reason: 'sourceUnavailable' };
    return { v: 1, status: 'prepared', review: { ...review,
        ...(selectedPaths === undefined ? {} : { selectedPaths }),
        ...(rules?.inlineThreshold === undefined ? {} : { inlineThreshold: rules.inlineThreshold }),
    }, preparedWorkspace,
        ...(rules === undefined ? {} : { rules }),
        scmPullRequestReviewScope: projectNativeJsonValueForTransport(verified.scope), comparisonId: verified.comparisonId, comparisonSource };
}
