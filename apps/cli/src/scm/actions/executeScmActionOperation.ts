import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ScmHistoryEntriesRequest, ScmHistoryEntriesResponse } from '@happier-dev/protocol/scm/entriesHistoryV1';
import { SCM_OPERATION_ERROR_CODES, ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm/operationError';
import { ScmDiffSummaryErrorCodeSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmDiffSummaryResultClearInputSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmDiffSummaryResultClearResponse, ScmComparisonCaptureInput, ScmActionExecute, ActionExecutorContext, ScmComparison, ScmReviewedMarkInput, ScmReviewedMarkResponse, ScmActionId, ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse, ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse, ScmPullRequestGetRequest, ScmPullRequestGetResponse, ScmPullRequestListRequest, ScmPullRequestListResponse, ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse, ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse, ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse, ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse, ScmReviewWorkspaceMaterializePreparedRequest, ScmReviewWorkspaceMaterializePreparedResponse, ScmRepositoryCloneInput, ScmRepositoryCloneOutput, ScmRepositoryInitRequest, ScmRepositoryInitResponse, ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse } from '@happier-dev/protocol';
import { admitScmRemotePolicy } from '@happier-dev/protocol/scm/remotePolicy';
import { admitScmCommitPolicy, admitScmCommitUndoLast } from '@happier-dev/protocol/scm/capabilities';
import { normalizeScmOperationOutcome, ScmOperationOutcomeSchema } from '@happier-dev/protocol/scm/operationOutcome';
import type * as scm from '@happier-dev/protocol/scm';
import { parseScmRepositoryCloneRpcRequest, projectScmLegacyRpcResponse } from './scmRpcCompatibility';

import { resolveFilesystemAccessPolicy, type FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import type { ScmBackendRegistry } from '@/scm/registry';
import { resolveCwd } from '@/scm/runtime';
import { createNonRepositoryScmSnapshotResponse, notRepositoryResponse, runScmRoute } from '@/scm/rpc/dispatch';
import { captureScmComparison, readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import type { ReadRepositoryCheckpointTranscriptPage } from '@/scm/checkpoints/readRepositoryCheckpointTranscriptPage';
import type { ReadPullRequestComparisonPage } from '@/scm/comparisons/readPullRequestComparisonPage';
import { executeScmDiffSummaryResultAction } from './executeScmDiffSummaryResultAction';
import { summarizeScmDiffSummarySevenDayCost } from './scmDiffSummarySevenDayCost';
import { executeScmCommitPlanAction } from '../commitPlans/executeScmCommitPlanAction';
import { readRepositoryCheckpointBranchEvidence, readRepositoryCheckpointPullRequestEvidence } from '../checkpoints/sessionEvidence';
import { scmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { configuration } from '@/configuration';
import { resolveScmHostingRepositoryAddress } from '@/scm/hostingProviders/resolveAddress';
import type { ResolvedScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import type { ScmHostingRepositoryResolveAddressRequestV1 } from '@happier-dev/protocol/scm/repositoryClone';
import {
    runScmHostingRepositoryDescribePublishTargetsRoute,
    runScmHostingRepositoryPublishRoute,
    runScmRepositoryCloneRoute,
    runScmRepositoryInitRoute,
    runScmRepositoryRemoveIndexLockRoute,
} from '@/scm/rpc/repositoryProvisioningDispatch';

type ScmDiffSummaryActionId = Extract<ScmActionId, 'scm.diffSummary.generate'>;
type LocalScmActionId = Exclude<ScmActionId, ScmDiffSummaryActionId>;

type RunMutation = <T>(operation: () => Promise<T>) => Promise<T>;

export type ExecuteScmDiffSummaryAction = (input: Readonly<{
    request: unknown;
}>) => Promise<unknown>;

export type ExecuteScmActionOperationParams = Readonly<{
    actionId: ScmActionId;
    input: unknown;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    signal?: AbortSignal;
    registry?: ScmBackendRegistry;
    hostingProviderRegistry?: ResolvedScmHostingProviderRegistry;
    runMutation?: RunMutation;
    executeDiffSummary?: ExecuteScmDiffSummaryAction;
    readComparisonTranscriptPage?: ReadRepositoryCheckpointTranscriptPage;
    readPullRequestComparisonPage?: ReadPullRequestComparisonPage;
    sessionId?: string;
    /** Existing authenticated Session authority, supplied only by the host ingress. */
    authorizeSession?: (sessionId: string) => Promise<boolean>;
    executeCanonicalAction?: Parameters<ScmActionExecute>[0]['executeCanonicalAction'];
    /** Exact host-stamped caller context, never parsed from SCM Action input. */
    actionContext?: ActionExecutorContext;
    executeReviewedMarks?: (comparison: ScmComparison, request: ScmReviewedMarkInput, reviewed: boolean) => Promise<ScmReviewedMarkResponse>;
    clearReviewedMarks?: (comparison: ScmComparison) => Promise<ScmReviewedMarkResponse>;
    /** Released RPC readers have a closed outer error-code vocabulary. */
    rpcCompatibility?: true;
}>;

async function admitReviewScope(params: ExecuteScmActionOperationParams,
    scope: Readonly<{ cwd: string; sessionId?: string; sourceSessionId?: string }>): Promise<boolean> {
    if (params.actionContext?.serverId && params.actionContext.serverId !== configuration.activeServerId) return false;
    if (!resolveCwd(scope.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy()).ok) return false;
    for (const sessionId of new Set([scope.sessionId, scope.sourceSessionId].filter((id): id is string => Boolean(id)))) {
        if (!params.authorizeSession || !await params.authorizeSession(sessionId).catch(() => false)) return false;
    }
    return true;
}

const reviewUnavailable = { success: false as const, errorCode: 'result_unavailable' as const, error: 'Saved result is unavailable for this caller.' };
const workEvidenceUnavailable = { success: false as const, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
    error: 'Session evidence is unavailable for this caller.' };

async function runLocalScmAction(params: ExecuteScmActionOperationParams & Readonly<{
    actionId: LocalScmActionId;
}>): Promise<unknown> {
    const routeBase = {
        workingDirectory: params.workingDirectory,
        ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.registry ? { registry: params.registry } : {}),
    } as const;
    const runMutation: RunMutation = params.runMutation ?? (async (operation) => await operation());

    // Scope comes from protected retained state. Input selectors never grant Session access.
    const capturedMarks = (params.actionId === 'scm.diffSummary.reviewed.mark' || params.actionId === 'scm.diffSummary.reviewed.unmark')
        && 'v' in (params.input as ScmReviewedMarkInput);
    if (params.actionId.startsWith('scm.diffSummary.') && params.actionId !== 'scm.diffSummary.capture'
        && params.actionId !== 'scm.diffSummary.result.list' && params.actionId !== 'scm.diffSummary.result.clear' && !capturedMarks) {
        const request = params.input as { cwd: string; resultId: string };
        const scope = await scmDiffSummaryResultStore.readStoredScope({ cwd: request.cwd, resultId: request.resultId,
            ...(params.sessionId ? { sessionId: params.sessionId } : {}) }).catch(() => null);
        if (!scope || !await admitReviewScope(params, scope)) return reviewUnavailable;
    }

    switch (params.actionId) {
        case 'scm.hostingRepository.resolveAddress':
            return resolveScmHostingRepositoryAddress({
                address: (params.input as ScmHostingRepositoryResolveAddressRequestV1).address,
                registry: params.hostingProviderRegistry, signal: params.signal,
            });
        case 'scm.diffSummary.result.list': {
            try {
                const inventory = await scmDiffSummaryResultStore.list({ admitScope: scope => admitReviewScope(params, scope) });
                const results = inventory.results;
                const untilMs = Date.now();
                const { readRetainedExecutionRunRecords } = await import('@/daemon/executionRunRegistry');
                const records = await readRetainedExecutionRunRecords().catch(() => null);
                // Permission-filter costs too: unrelated workspace usage is not this caller's data.
                const allowedRecords = [];
                for (const record of records ?? []) {
                    const cwd = record.state.launch?.cwd;
                    const sessionId = record.state.sessionId;
                    if (cwd && await admitReviewScope(params, { cwd, ...(sessionId ? { sessionId } : {}) })) allowedRecords.push(record);
                }
                return { success: true, results, count: results.length, bytes: results.reduce((sum, item) => sum + item.bytes, 0),
                    sevenDayCost: summarizeScmDiffSummarySevenDayCost(allowedRecords.map(record => record.state), untilMs) };
            } catch {
                return reviewUnavailable;
            }
        }
        case 'scm.diffSummary.result.clear': {
            const input = ScmDiffSummaryResultClearInputSchema.parse(params.input);
            const deleted: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['deleted'] = [];
            const failures: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['failures'] = [];
            for (const item of input.results) {
                if (params.signal?.aborted) {
                    failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable', error: 'Clear was cancelled before deleting this saved result.' });
                    continue;
                }
                const authorized = resolveCwd(item.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy());
                if (!authorized.ok) { failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable', error: authorized.error }); continue; }
                try {
                    const scope = await scmDiffSummaryResultStore.readStoredScope({ cwd: authorized.cwd, resultId: item.resultId,
                        ...(item.sessionId ? { sessionId: item.sessionId } : {}) });
                    if (!scope || !await admitReviewScope(params, scope)) {
                        failures.push({ ...reviewUnavailable, resultId: item.resultId }); continue;
                    }
                    const saved = await scmDiffSummaryResultStore.read({ cwd: authorized.cwd, resultId: item.resultId,
                        ...(item.sessionId ? { sessionId: item.sessionId } : {}) });
                    if (!saved.success) { failures.push({ ...saved, resultId: item.resultId }); continue; }
                    if (saved.result.output.comparison?.id !== item.comparisonId) {
                        failures.push({ resultId: item.resultId, success: false, errorCode: 'invalid_edit', error: 'The listed comparison does not identify this saved result.' }); continue;
                    }
                    const response = await executeScmDiffSummaryResultAction({ actionId: 'scm.diffSummary.result.delete',
                        input: { cwd: authorized.cwd, resultId: item.resultId, expectedRevision: item.expectedRevision }, cwd: authorized.cwd,
                        ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(params.signal ? { signal: params.signal } : {}),
                        ...(params.clearReviewedMarks ? { clearReviewedMarks: params.clearReviewedMarks } : {}) });
                    if (!response.success) failures.push({ ...response, resultId: item.resultId });
                    else if ('resultId' in response) deleted.push(response);
                } catch { failures.push({ ...reviewUnavailable, resultId: item.resultId }); }
            }
            return { success: true, deleted, failures };
        }
        case 'scm.diffSummary.commitPlan.accept':
        case 'scm.diffSummary.commitPlan.stop':
        case 'scm.diffSummary.commitPlan.includeHookChanges':
        case 'scm.diffSummary.commitPlan.cancel':
        case 'scm.diffSummary.commitPlan.recover': {
            const request = params.input as { cwd: string; resultId: string };
            const authorized = resolveCwd(request.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy());
            if (!authorized.ok) return { success: false, errorCode: 'result_unavailable', error: authorized.error };
            return executeScmCommitPlanAction({ actionId: params.actionId, input: params.input, cwd: authorized.cwd,
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                ...(params.registry ? { registry: params.registry } : {}),
                ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
                ...(params.signal ? { signal: params.signal } : {}),
            });
        }
        case 'scm.commit.resolveOutcome': {
            const request = params.input as scm.ScmCommitResolveOutcomeRequest;
            const response = await runScmRoute({ request, ...routeBase,
                onNonRepository: () => ({ ...notRepositoryResponse<scm.ScmCommitResolveOutcomeResponse>(),
                    publication: { state: 'unknown' as const, candidateOid: request.candidateOid, expectedHeadOid: request.expectedHeadOid,
                        expectedRef: request.expectedRef, indexReconciliation: 'pending' as const } }),
                runWithBackend: ({ context, selection }) => selection.backend.commitResolveOutcome
                    ? selection.backend.commitResolveOutcome({ context, request })
                    : Promise.resolve({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
                        publication: { state: 'unknown' as const, candidateOid: request.candidateOid, expectedHeadOid: request.expectedHeadOid,
                            expectedRef: request.expectedRef, indexReconciliation: 'pending' as const },
                        error: 'This backend cannot resolve commit publication.' }),
            });
            return { ...response, publication: response.publication ?? { state: 'unknown', candidateOid: request.candidateOid,
                expectedHeadOid: request.expectedHeadOid, expectedRef: request.expectedRef, indexReconciliation: 'pending' } };
        }
        case 'scm.diffSummary.reviewed.mark':
        case 'scm.diffSummary.reviewed.unmark': {
            const request = params.input as ScmReviewedMarkInput;
            const authorized = resolveCwd(request.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy());
            if (!authorized.ok) return { success: false, errorCode: 'result_unavailable', error: authorized.error };
            if ('v' in request) {
                if (params.sessionId && request.sessionId && params.sessionId !== request.sessionId) return reviewUnavailable;
                const sessionId = params.sessionId ?? request.sessionId;
                const scope = { cwd: authorized.cwd, ...(sessionId ? { sessionId } : {}) };
                if (!await admitReviewScope(params, scope)) return reviewUnavailable;
                try {
                    const captured = await readCapturedScmComparison({ ...scope, comparisonId: request.comparisonId, source: request.source });
                    const sourceSessionId = typeof captured.comparison.source.sessionId === 'string' ? captured.comparison.source.sessionId : undefined;
                    if (!await admitReviewScope(params, { ...scope, ...(sourceSessionId ? { sourceSessionId } : {}) })) return reviewUnavailable;
                    if (!params.executeReviewedMarks) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'Authenticated personal reviewed marks are unavailable' };
                    return await params.executeReviewedMarks(captured.comparison, request, params.actionId === 'scm.diffSummary.reviewed.mark');
                } catch {
                    return reviewUnavailable;
                }
            }
            const saved = await scmDiffSummaryResultStore.read({ cwd: authorized.cwd, resultId: request.resultId,
                ...(params.sessionId ? { sessionId: params.sessionId } : {}) });
            if (!saved.success) return saved;
            if (!saved.result.output.comparison || !params.executeReviewedMarks) return { success: false, errorCode: 'reviewed_marks_unavailable', error: 'Authenticated personal reviewed marks are unavailable' };
            return params.executeReviewedMarks(saved.result.output.comparison, request, params.actionId === 'scm.diffSummary.reviewed.mark');
        }
        case 'scm.diffSummary.result.read':
        case 'scm.diffSummary.result.edit':
        case 'scm.diffSummary.result.undo':
        case 'scm.diffSummary.result.delete':
        case 'scm.diffSummary.refine':
        case 'scm.diffSummary.addOutputs':
        case 'scm.diffSummary.discuss': {
            const request = params.input as { cwd: string; resultId: string };
            const authorized = resolveCwd(request.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy());
            if (!authorized.ok) return { success: false, errorCode: 'result_unavailable', error: authorized.error };
            try {
                return await executeScmDiffSummaryResultAction({ actionId: params.actionId, input: params.input, cwd: authorized.cwd,
                    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                    ...(params.executeCanonicalAction ? { executeCanonicalAction: params.executeCanonicalAction } : {}),
                    ...(params.actionContext ? { actionContext: params.actionContext } : {}),
                    ...(params.signal ? { signal: params.signal } : {}),
                    ...(params.clearReviewedMarks ? { clearReviewedMarks: params.clearReviewedMarks } : {}),
                });
            } catch (error) {
                return { success: false, errorCode: 'result_unavailable', error: error instanceof Error ? error.message : 'Saved result is unavailable' };
            }
        }
        case 'scm.diffSummary.capture': {
            const request = params.input as ScmComparisonCaptureInput;
            const authorized = resolveCwd(request.cwd, params.workingDirectory, params.accessPolicy ?? resolveFilesystemAccessPolicy());
            if (!authorized.ok) return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: authorized.error };
            const sourceSessionId = typeof request.source.sessionId === 'string' ? request.source.sessionId : undefined;
            if (!await admitReviewScope(params, { cwd: authorized.cwd,
                ...(request.sessionId ? { sessionId: request.sessionId } : {}), ...(sourceSessionId ? { sourceSessionId } : {}) })) {
                return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Comparison evidence is unavailable for this caller.' };
            }
            try {
                const captured = request.comparisonId
                    ? await readCapturedScmComparison({ ...request, comparisonId: request.comparisonId, cwd: authorized.cwd })
                    : await captureScmComparison({ ...request, cwd: authorized.cwd,
                    ...(params.registry ? { registry: params.registry } : {}),
                    ...(params.readComparisonTranscriptPage ? { readTranscriptPage: params.readComparisonTranscriptPage } : {}),
                    ...(params.readPullRequestComparisonPage ? { readPullRequestComparisonPage: params.readPullRequestComparisonPage } : {}),
                });
                return { success: true, comparison: captured.comparison, metadata: captured.metadata };
            } catch (error) {
                const code = error && typeof error === 'object' && 'code' in error
                    ? ScmDiffSummaryErrorCodeSchema.safeParse(error.code) : null;
                return { success: false, errorCode: code?.success ? code.data : 'DIFF_UNAVAILABLE',
                    error: error instanceof Error ? error.message : 'Comparison evidence is unavailable' };
            }
        }
        case 'scm.backend.describe': {
            const request = params.input as scm.ScmBackendDescribeRequest;
            return runScmRoute<scm.ScmBackendDescribeRequest, scm.ScmBackendDescribeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => ({ success: true, isRepo: false }),
                runWithBackend: async ({ context, selection }) => selection.backend.describeBackend
                    ? await selection.backend.describeBackend({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.status.snapshot': {
            const request = params.input as scm.ScmStatusSnapshotRequest;
            return runScmRoute<scm.ScmStatusSnapshotRequest, scm.ScmStatusSnapshotResponse>({
                request,
                ...routeBase,
                onNonRepository: async ({ cwd }) => createNonRepositoryScmSnapshotResponse({ workingDirectory: params.workingDirectory, cwd }),
                runWithBackend: async ({ context, selection }) => selection.backend.statusSnapshot
                    ? await selection.backend.statusSnapshot({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.worktrees.enrichment': {
            const request = params.input as scm.ScmWorktreesEnrichmentRequest;
            return runScmRoute<scm.ScmWorktreesEnrichmentRequest, scm.ScmWorktreesEnrichmentResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmWorktreesEnrichmentResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.worktreesEnrichment
                    ? await selection.backend.worktreesEnrichment({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.diff.file': {
            const request = params.input as scm.ScmDiffFileRequest;
            return runScmRoute<scm.ScmDiffFileRequest, scm.ScmDiffFileResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmDiffFileResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.diffFile
                    ? await selection.backend.diffFile({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.diff.commit': {
            const request = params.input as scm.ScmDiffCommitRequest;
            return runScmRoute<scm.ScmDiffCommitRequest, scm.ScmDiffCommitResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmDiffCommitResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.diffCommit
                    ? await selection.backend.diffCommit({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.change.include': {
            const request = params.input as scm.ScmChangeApplyRequest;
            return runMutation(async () => runScmRoute<scm.ScmChangeApplyRequest, scm.ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmChangeApplyResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.changeInclude
                    ? await selection.backend.changeInclude({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.change.exclude': {
            const request = params.input as scm.ScmChangeApplyRequest;
            return runMutation(async () => runScmRoute<scm.ScmChangeApplyRequest, scm.ScmChangeApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmChangeApplyResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.changeExclude
                    ? await selection.backend.changeExclude({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.change.discard': {
            const request = params.input as scm.ScmChangeDiscardRequest;
            return runMutation(async () => runScmRoute<scm.ScmChangeDiscardRequest, scm.ScmChangeDiscardResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmChangeDiscardResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.changeDiscard
                    ? await selection.backend.changeDiscard({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.commit.create': {
            const request = params.input as scm.ScmCommitCreateRequest;
            return runMutation(async () => runScmRoute<scm.ScmCommitCreateRequest, scm.ScmCommitCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmCommitCreateResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const admission = admitScmCommitPolicy(request, selection.backend.getCapabilities({ mode: selection.mode }));
                    if (!admission.success) return admission;
                    return selection.backend.commitCreate
                        ? await selection.backend.commitCreate({ context, request })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                },
            }));
        }
        case 'scm.commit.backout': {
            const request = params.input as scm.ScmCommitBackoutRequest;
            return runMutation(async () => runScmRoute<scm.ScmCommitBackoutRequest, scm.ScmCommitBackoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmCommitBackoutResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.commitBackout
                    ? await selection.backend.commitBackout({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.commit.undoLast': {
            const request = params.input as scm.ScmCommitUndoLastRequest;
            return runMutation(async () => runScmRoute<scm.ScmCommitUndoLastRequest, scm.ScmCommitUndoLastResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmCommitUndoLastResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const admission = admitScmCommitUndoLast(selection.backend.getCapabilities({ mode: selection.mode }));
                    if (!admission.success) return admission;
                    return selection.backend.commitUndoLast
                        ? await selection.backend.commitUndoLast({ context, request })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM undo is unavailable' };
                },
            }));
        }
        case 'scm.log.list': {
            const request = params.input as scm.ScmLogListRequest;
            return runScmRoute<scm.ScmLogListRequest, scm.ScmLogListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmLogListResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.logList
                    ? await selection.backend.logList({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.history.entries': {
            const request = params.input as ScmHistoryEntriesRequest;
            return runScmRoute<ScmHistoryEntriesRequest, ScmHistoryEntriesResponse>({ request, ...routeBase,
                onNonRepository: () => notRepositoryResponse<ScmHistoryEntriesResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.historyEntries
                    ? await selection.backend.historyEntries({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'Entry history is unavailable for this backend' },
            });
        }
        case 'scm.branch.list': {
            const request = params.input as scm.ScmBranchListRequest;
            if (request.workEvidence && !await admitReviewScope(params, {
                cwd: request.cwd ?? params.workingDirectory, sessionId: request.workEvidence.sessionId,
            })) return workEvidenceUnavailable;
            return runScmRoute<scm.ScmBranchListRequest, scm.ScmBranchListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchListResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const result = selection.backend.branchList ? await selection.backend.branchList({ context, request })
                        : { success: false as const, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                    if (!result.success || !request.workEvidence) return result;
                    const scope = { cwd: context.cwd, sessionId: request.workEvidence.sessionId };
                    const branchEvidence = context.detection.mode === '.git'
                        ? await readRepositoryCheckpointBranchEvidence({ ...scope, signal: params.signal }).catch(() => null) : null;
                    params.signal?.throwIfAborted();
                    if (!await admitReviewScope(params, scope)) return workEvidenceUnavailable;
                    return { ...result, branchEvidence: branchEvidence ?? [],
                        branchEvidenceStatus: branchEvidence ? 'partial' as const : 'unavailable' as const };
                },
            });
        }
        case 'scm.branch.create': {
            const request = params.input as scm.ScmBranchCreateRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchCreateRequest, scm.ScmBranchCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchCreateResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchCreate
                    ? await selection.backend.branchCreate({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.checkout': {
            const request = params.input as scm.ScmBranchCheckoutRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchCheckoutRequest, scm.ScmBranchCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchCheckoutResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchCheckout
                    ? await selection.backend.branchCheckout({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.merge': {
            const request = params.input as scm.ScmBranchIntegrationRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchIntegrationRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchMerge
                    ? await selection.backend.branchMerge({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.rebase': {
            const request = params.input as scm.ScmBranchIntegrationRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchIntegrationRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchRebase
                    ? await selection.backend.branchRebase({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.operation.continue': {
            const request = params.input as scm.ScmBranchOperationControlRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchOperationControlRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchOperationContinue
                    ? await selection.backend.branchOperationContinue({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.operation.skip': {
            const request = params.input as scm.ScmBranchOperationControlRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchOperationControlRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchOperationSkip
                    ? await selection.backend.branchOperationSkip({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.branch.operation.abort': {
            const request = params.input as scm.ScmBranchOperationControlRequest;
            return runMutation(async () => runScmRoute<scm.ScmBranchOperationControlRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.branchOperationAbort
                    ? await selection.backend.branchOperationAbort({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.conflict.acceptSide': {
            const request = params.input as scm.ScmConflictAcceptSideRequest;
            return runMutation(async () => runScmRoute<scm.ScmConflictAcceptSideRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.conflictAcceptSide
                    ? await selection.backend.conflictAcceptSide({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.conflict.markResolved': {
            const request = params.input as scm.ScmConflictMarkResolvedRequest;
            return runMutation(async () => runScmRoute<scm.ScmConflictMarkResolvedRequest, scm.ScmBranchIntegrationResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmBranchIntegrationResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.conflictMarkResolved
                    ? await selection.backend.conflictMarkResolved({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.worktree.create': {
            const request = params.input as scm.ScmWorktreeCreateRequest;
            return runMutation(async () => runScmRoute<scm.ScmWorktreeCreateRequest, scm.ScmWorktreeCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmWorktreeCreateResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.worktreeCreate
                    ? await selection.backend.worktreeCreate({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.worktree.remove': {
            const request = params.input as scm.ScmWorktreeRemoveRequest;
            return runMutation(async () => runScmRoute<scm.ScmWorktreeRemoveRequest, scm.ScmWorktreeRemoveResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmWorktreeRemoveResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const target = authorizeFilesystemPath({
                        targetPath: request.worktreePath,
                        defaultDirectory: context.cwd,
                        accessPolicy: routeBase.accessPolicy ?? resolveFilesystemAccessPolicy(),
                    });
                    if (!target.valid) {
                        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH, error: target.error };
                    }
                    return selection.backend.worktreeRemove
                        ? await selection.backend.worktreeRemove({ context, request: { ...request, worktreePath: target.resolvedPath } })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                },
            }));
        }
        case 'scm.worktree.prune': {
            const request = params.input as scm.ScmWorktreePruneRequest;
            return runMutation(async () => runScmRoute<scm.ScmWorktreePruneRequest, scm.ScmWorktreePruneResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmWorktreePruneResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.worktreePrune
                    ? await selection.backend.worktreePrune({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.remote.add': {
            const request = params.input as scm.ScmRemoteAddRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteAddRequest, scm.ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteManagementResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.remoteAdd
                    ? await selection.backend.remoteAdd({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.remote.setUrl': {
            const request = params.input as scm.ScmRemoteSetUrlRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteSetUrlRequest, scm.ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteManagementResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.remoteSetUrl
                    ? await selection.backend.remoteSetUrl({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.remote.remove': {
            const request = params.input as scm.ScmRemoteRemoveRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteRemoveRequest, scm.ScmRemoteManagementResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteManagementResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.remoteRemove
                    ? await selection.backend.remoteRemove({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.remote.fetch': {
            const request = params.input as scm.ScmRemoteRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteRequest, scm.ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const admission = admitScmRemotePolicy(request, selection.backend.getCapabilities({ mode: selection.mode }));
                    if (!admission.success) return admission;
                    return selection.backend.remoteFetch
                        ? await selection.backend.remoteFetch({ context, request })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                },
            }));
        }
        case 'scm.remote.pull': {
            const request = params.input as scm.ScmRemoteRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteRequest, scm.ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const admission = admitScmRemotePolicy(request, selection.backend.getCapabilities({ mode: selection.mode }));
                    if (!admission.success) return admission;
                    return selection.backend.remotePull
                        ? await selection.backend.remotePull({ context, request })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                },
            }));
        }
        case 'scm.remote.push': {
            const request = params.input as scm.ScmRemoteRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemoteRequest, scm.ScmRemoteResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemoteResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const admission = admitScmRemotePolicy(request, selection.backend.getCapabilities({ mode: selection.mode }));
                    if (!admission.success) return admission;
                    return selection.backend.remotePush
                        ? await selection.backend.remotePush({ context, request })
                        : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' };
                },
            }));
        }
        case 'scm.remote.publish': {
            const request = params.input as scm.ScmRemotePublishRequest;
            return runMutation(async () => runScmRoute<scm.ScmRemotePublishRequest, scm.ScmRemotePublishResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmRemotePublishResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.remotePublish
                    ? await selection.backend.remotePublish({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.stash.list': {
            const request = params.input as scm.ScmStashListRequest;
            return runScmRoute<scm.ScmStashListRequest, scm.ScmStashListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashListResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashList
                    ? await selection.backend.stashList({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.stash.show': {
            const request = params.input as scm.ScmStashShowRequest;
            return runScmRoute<scm.ScmStashShowRequest, scm.ScmStashShowResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashShowResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashShow
                    ? await selection.backend.stashShow({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            });
        }
        case 'scm.stash.create': {
            const request = params.input as scm.ScmStashCreateRequest;
            return runMutation(async () => runScmRoute<scm.ScmStashCreateRequest, scm.ScmStashCreateResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashCreateResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashCreate
                    ? await selection.backend.stashCreate({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.stash.apply': {
            const request = params.input as scm.ScmStashApplyRequest;
            return runMutation(async () => runScmRoute<scm.ScmStashApplyRequest, scm.ScmStashApplyResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashApplyResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashApply
                    ? await selection.backend.stashApply({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.stash.pop': {
            const request = params.input as scm.ScmStashPopRequest;
            return runMutation(async () => runScmRoute<scm.ScmStashPopRequest, scm.ScmStashPopResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashPopResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashPop
                    ? await selection.backend.stashPop({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.stash.drop': {
            const request = params.input as scm.ScmStashDropRequest;
            return runMutation(async () => runScmRoute<scm.ScmStashDropRequest, scm.ScmStashDropResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<scm.ScmStashDropResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.stashDrop
                    ? await selection.backend.stashDrop({ context, request })
                    : { success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: 'SCM backend operation is unavailable' },
            }));
        }
        case 'scm.pullRequest.list': {
            const request = params.input as ScmPullRequestListRequest;
            if (request.workEvidence && !await admitReviewScope(params, {
                cwd: request.cwd ?? params.workingDirectory, sessionId: request.workEvidence.sessionId,
            })) return workEvidenceUnavailable;
            return runScmRoute<ScmPullRequestListRequest, ScmPullRequestListResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestListResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const result = selection.backend.pullRequestList
                        ? await selection.backend.pullRequestList({ context, request })
                        : notRepositoryResponse<ScmPullRequestListResponse>();
                    if (!result.success || !request.workEvidence) return result;
                    const scope = { cwd: context.cwd, sessionId: request.workEvidence.sessionId };
                    const workEvidence = await readRepositoryCheckpointPullRequestEvidence({ ...scope,
                        pullRequests: result.pullRequests, signal: params.signal }).catch(() => null);
                    params.signal?.throwIfAborted();
                    if (!await admitReviewScope(params, scope)) return workEvidenceUnavailable;
                    // Listing is branch-scoped. Exact rows do not imply complete repository history.
                    return { ...result, workEvidence: workEvidence ?? [], workEvidenceStatus: workEvidence ? 'partial' as const : 'unavailable' as const };
                },
            });
        }
        case 'scm.pullRequest.get': {
            const request = params.input as ScmPullRequestGetRequest;
            if (request.workEvidence && !await admitReviewScope(params, {
                cwd: request.cwd ?? params.workingDirectory, sessionId: request.workEvidence.sessionId,
            })) return workEvidenceUnavailable;
            return runScmRoute<ScmPullRequestGetRequest, ScmPullRequestGetResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestGetResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    const result = selection.backend.pullRequestGet
                        ? await selection.backend.pullRequestGet({ context, request })
                        : notRepositoryResponse<ScmPullRequestGetResponse>();
                    if (!result.success || !request.workEvidence) return result;
                    const scope = { cwd: context.cwd, sessionId: request.workEvidence.sessionId };
                    const workEvidence = await readRepositoryCheckpointPullRequestEvidence({ ...scope,
                        pullRequests: result.pullRequest ? [result.pullRequest] : [], signal: params.signal }).catch(() => null);
                    params.signal?.throwIfAborted();
                    if (!await admitReviewScope(params, scope)) return workEvidenceUnavailable;
                    return { ...result, workEvidence: workEvidence ?? [], workEvidenceStatus: workEvidence ? 'partial' as const : 'unavailable' as const };
                },
            });
        }
        case 'scm.pullRequest.openCompose': {
            const request = params.input as ScmPullRequestOpenComposeRequest;
            return runScmRoute<ScmPullRequestOpenComposeRequest, ScmPullRequestOpenComposeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestOpenCompose
                    ? await selection.backend.pullRequestOpenCompose({ context, request })
                    : notRepositoryResponse<ScmPullRequestOpenComposeResponse>(),
            });
        }
        case 'scm.pullRequest.openOrReuse': {
            const request = params.input as ScmPullRequestOpenOrReuseRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestOpenOrReuseRequest, ScmPullRequestOpenOrReuseResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestOpenOrReuse
                    ? await selection.backend.pullRequestOpenOrReuse({ context, request })
                    : notRepositoryResponse<ScmPullRequestOpenOrReuseResponse>(),
            }));
        }
        case 'scm.pullRequest.checkout': {
            const request = params.input as ScmPullRequestCheckoutRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestCheckoutRequest, ScmPullRequestCheckoutResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestCheckout
                    ? await selection.backend.pullRequestCheckout({ context, request })
                    : notRepositoryResponse<ScmPullRequestCheckoutResponse>(),
            }));
        }
        case 'scm.pullRequest.prepareWorktree': {
            const request = params.input as ScmPullRequestPrepareWorktreeRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestPrepareWorktreeRequest, ScmPullRequestPrepareWorktreeResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestPrepareWorktree
                    ? await selection.backend.pullRequestPrepareWorktree({ context, request })
                    : notRepositoryResponse<ScmPullRequestPrepareWorktreeResponse>(),
            }));
        }
        case 'scm.reviewWorkspace.materializePrepared': {
            const request = params.input as ScmReviewWorkspaceMaterializePreparedRequest;
            return runMutation(async () => await runScmRoute<
                ScmReviewWorkspaceMaterializePreparedRequest,
                ScmReviewWorkspaceMaterializePreparedResponse
            >({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmReviewWorkspaceMaterializePreparedResponse>(),
                runWithBackend: async ({ context, selection }) => {
                    if (request.verification !== undefined) {
                        const verifiedTarget = resolveCwd(
                            request.verification.targetPath,
                            params.workingDirectory,
                            params.accessPolicy,
                        );
                        if (!verifiedTarget.ok) {
                            return {
                                success: false,
                                error: verifiedTarget.error,
                                errorCode: 'INVALID_PATH',
                            };
                        }
                        const verifyPreparedReviewWorkspace = selection.backend.workspaceIntegration
                            ?.verifyPreparedReviewWorkspace;
                        if (!verifyPreparedReviewWorkspace) {
                            return {
                                success: false,
                                error: 'SCM prepared review-workspace verification is unavailable',
                                errorCode: 'FEATURE_UNSUPPORTED',
                            };
                        }
                        return await verifyPreparedReviewWorkspace({
                            context,
                            request: {
                                ...request,
                                verification: { targetPath: verifiedTarget.cwd },
                            },
                        });
                    }
                    const prepareReviewWorkspace = selection.backend.workspaceIntegration?.prepareReviewWorkspace;
                    if (!prepareReviewWorkspace) {
                        return {
                            success: false,
                            error: 'SCM review-workspace materialization is unavailable',
                            errorCode: 'FEATURE_UNSUPPORTED',
                        };
                    }
                    return await prepareReviewWorkspace({ context, request });
                },
            }));
        }
        case 'scm.pullRequest.runStacked': {
            const request = params.input as ScmPullRequestRunStackedRequest;
            return runMutation(async () => await runScmRoute<ScmPullRequestRunStackedRequest, ScmPullRequestRunStackedResponse>({
                request,
                ...routeBase,
                onNonRepository: async () => notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
                runWithBackend: async ({ context, selection }) => selection.backend.pullRequestRunStacked
                    ? await selection.backend.pullRequestRunStacked({ context, request })
                    : notRepositoryResponse<ScmPullRequestRunStackedResponse>(),
            }));
        }
        case 'scm.repository.init':
            return runMutation(async () => await runScmRepositoryInitRoute({
                request: params.input as ScmRepositoryInitRequest,
                ...routeBase,
            }) satisfies ScmRepositoryInitResponse);
        case 'scm.repository.clone':
            return runMutation(async () => await runScmRepositoryCloneRoute({
                request: params.input as ScmRepositoryCloneInput,
                ...routeBase,
            }) satisfies ScmRepositoryCloneOutput);
        case 'scm.repository.removeIndexLock':
            return runMutation(async () => await runScmRepositoryRemoveIndexLockRoute({
                request: params.input as ScmRepositoryRemoveIndexLockRequest,
                ...routeBase,
            }) satisfies ScmRepositoryRemoveIndexLockResponse);
        case 'scm.hostingRepository.describePublishTargets':
            return runScmHostingRepositoryDescribePublishTargetsRoute({
                request: params.input as ScmHostingRepositoryDescribePublishTargetsRequest,
                ...routeBase,
            }) satisfies Promise<ScmHostingRepositoryDescribePublishTargetsResponse>;
        case 'scm.hostingRepository.publish':
            return runMutation(async () => await runScmHostingRepositoryPublishRoute({
                request: params.input as ScmHostingRepositoryPublishRequest,
                ...routeBase,
            }) satisfies ScmHostingRepositoryPublishResponse);
    }
}

/** Canonical semantic owner shared by Action execution and SCM RPC transport bindings. */
export async function executeScmActionOperation(
    params: ExecuteScmActionOperationParams,
): Promise<unknown> {
    const spec = getActionSpec(params.actionId);
    const parsed = params.rpcCompatibility && params.actionId === 'scm.repository.clone'
        ? parseScmRepositoryCloneRpcRequest(params.input)
        : spec.inputSchema.safeParse(params.input);
    if (!parsed.success) {
        if (params.rpcCompatibility) return projectScmLegacyRpcResponse({
            actionId: params.actionId, request: params.input,
            response: { success: false, errorCode: 'INVALID_REQUEST', error: 'Invalid SCM request' },
        });
        throw parsed.error;
    }
    const request = parsed.data;
    if (params.actionId === 'scm.diffSummary.generate') {
        const scopedRequest = request as ScmComparisonCaptureInput;
        const sourceSessionId = typeof scopedRequest.source.sessionId === 'string' ? scopedRequest.source.sessionId : undefined;
        if (!await admitReviewScope(params, { cwd: scopedRequest.cwd,
            ...(params.sessionId ?? scopedRequest.sessionId ? { sessionId: params.sessionId ?? scopedRequest.sessionId } : {}),
            ...(sourceSessionId ? { sourceSessionId } : {}) })) {
            return { success: false, errorCode: 'DIFF_UNAVAILABLE', error: 'Comparison evidence is unavailable for this caller.' };
        }
    }
    const result = params.actionId === 'scm.diffSummary.generate'
        ? await params.executeDiffSummary?.({ request })
        : await runLocalScmAction({
            ...params,
            actionId: params.actionId,
            input: request,
        });
    if (result === undefined) {
        throw new Error(`SCM action operation is unavailable: ${params.actionId}`);
    }
    if (!spec.outputSchema) {
        throw new Error(`SCM action operation has no output schema: ${params.actionId}`);
    }
    // Released read RPCs pass through backend-owned additive projection fields.
    // Action callers still settle against the registry's exact result schema.
    let settled = params.rpcCompatibility && spec.sideEffectClass === 'read'
        ? result : spec.outputSchema.parse(result);
    if (settled && typeof settled === 'object' && !Array.isArray(settled)) {
        const response = settled as Record<string, unknown>;
        // Prepared workspaces publish their closed currentness/verification result, not a Git operation outcome.
        if (!params.actionId.startsWith('scm.diffSummary.') && params.actionId !== 'scm.reviewWorkspace.materializePrepared'
            && spec.sideEffectClass !== 'read' && typeof response.success === 'boolean') {
            const code = ScmOperationErrorCodeSchema.safeParse(response.errorCode);
            settled = { ...response, outcome: normalizeScmOperationOutcome({
                success: response.success,
                ...(response.outcome ? { outcome: ScmOperationOutcomeSchema.parse(response.outcome) } : {}),
                ...(code.success ? { errorCode: code.data } : {}),
                ...(typeof response.error === 'string' ? { error: response.error } : {}),
                ...(typeof response.commitSha === 'string' ? { commitSha: response.commitSha } : {}),
            }) };
        }
    }
    return params.rpcCompatibility && !params.actionId.startsWith('scm.diffSummary.')
        ? projectScmLegacyRpcResponse({ actionId: params.actionId, request: params.input, response: settled })
        : settled;
}
