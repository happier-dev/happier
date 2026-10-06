import { ScmCommitPlanAcceptInputSchema, ScmCommitPlanControlInputSchema, ScmCommitPlanIncludeHookChangesInputSchema, isScmCommitPlanApplicationLocked } from '@happier-dev/protocol/scm/diffSummaryCommitPlan';
import { ScmDiffSummaryResultResponseSchema } from '@happier-dev/protocol/scm/diffSummaryResult';
import type { ScmActionId, ScmCommitPlanApplication, ScmDiffSummaryResult, ScmDiffSummaryResultResponse, ScmDiffSummaryResultFailure, ScmCommitCreateResponse } from '@happier-dev/protocol';
import { scmDiffSummaryResultStore, type ScmDiffSummaryResultScope, type ScmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { captureScmPendingTree, readCapturedScmComparison } from '../comparisons/captureScmComparison';
import { runGitCheckpointCommand } from '../checkpoints/gitCheckpointCommands';
import { readGitComparisonFiles } from '../comparisons/readGitComparisonFiles';
import { runScmRoute } from '../rpc/dispatch';
import type { ScmBackendRegistry } from '../registry';
import type { ScmBackend, ScmBackendContext } from '../types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { materializeScmCommitPlan, mergeScmCommitPlanHookTree, validateScmCommitPlanHookSelections } from './materializeCommitPlan';

type CommitPlanActionId = Extract<ScmActionId, `scm.diffSummary.commitPlan.${string}`>;
type Params = Readonly<{ actionId: CommitPlanActionId; input: unknown; cwd: string; sessionId?: string;
  signal?: AbortSignal; registry?: ScmBackendRegistry; accessPolicy?: FilesystemAccessPolicy; store?: ScmDiffSummaryResultStore }>;
function failure(errorCode: ScmDiffSummaryResultFailure['errorCode'], error: string, latestRevision?: number): ScmDiffSummaryResultFailure {
  return { success: false, errorCode, error, ...(latestRevision !== undefined ? { latestRevision } : {}) };
}
function conflict(result: ScmDiffSummaryResult, revision: number) {
  return result.revision === revision ? null : failure('revision_conflict', 'Read the current application revision before applying this intent.', result.revision);
}
async function git(cwd: string, args: readonly string[]) {
  const response = await runGitCheckpointCommand({ cwd, args });
  if (!response.success) throw new Error(response.stderr || 'Git evidence could not be verified');
  return response.stdout.trim();
}
async function target(backend: ScmBackend, context: ScmBackendContext) {
  const captured = await backend.commitCaptureTarget?.({ context });
  if (!captured?.success) throw new Error(captured?.error ?? 'The backend cannot verify the commit target');
  return { expectedHeadOid: captured.target.headOid, expectedRef: captured.target.ref };
}
function reasonFor(response: ScmCommitCreateResponse): ScmCommitPlanApplication['reason'] {
  if (response.errorCode === 'SCM_SOURCE_CHANGED') return 'source_changed';
  if (response.hookContentChanges) return 'hook_content_changed';
  if (response.publication?.state === 'unknown') return 'outcome_unknown';
  if (response.errorCode?.includes('HEAD') || response.errorCode?.includes('REF')) return 'head_moved';
  if (response.errorCode?.includes('SIGNING')) return 'signing_failed';
  if (response.errorCode?.includes('HOOK')) return 'hook_failed';
  if (response.errorCode?.includes('STAGING') || response.errorCode === 'INDEX_LOCKED') return 'staging_conflict';
  return response.publication?.state === 'published' ? 'publication_warning' : 'writer_failed';
}

/** One sequential host consumer of U1. No ref mutation, rollback or unresolved-outcome retry here. */
async function applyRemaining(input: Readonly<{ store: ScmDiffSummaryResultStore; scope: ScmDiffSummaryResultScope;
  backend: ScmBackend; context: ScmBackendContext }>): Promise<ScmDiffSummaryResultResponse> {
  const { store, scope, backend, context } = input;
  let current = await store.read(scope);
  if (!current.success || !current.result.application) return current;
  const initialApplication = current.result.application;
  const savedScope = await store.readStoredScope(scope);
  const comparison = (await readCapturedScmComparison({ cwd: scope.cwd,
    comparisonId: current.result.application.acceptance.comparisonId,
    ...(savedScope?.sessionId ? { sessionId: savedScope.sessionId } : {}) })).comparison;
  const plan = current.result.output.outputs?.commitPlan?.value;
  if (!plan) return failure('plan_unavailable', 'Commit proposal disappeared.');
  let materialized: Awaited<ReturnType<typeof materializeScmCommitPlan>>;
  try { materialized = await materializeScmCommitPlan({ cwd: scope.cwd, comparison, groups: plan.groups,
    ...(savedScope?.sessionId ? { sessionId: savedScope.sessionId } : {}) }); }
  catch (error) {
    return store.mutateApplication(scope, (result) => ({ ...result.application!, status: 'failed', reason: 'selection_conflict',
      steps: result.application!.steps.map((step, index) => index === result.application!.nextGroupIndex
        ? { ...step, state: 'not_published', errorCode: 'selection_conflict', error: error instanceof Error ? error.message : 'Selection cannot be materialized' } : step) }));
  }
  let expectedSourceTree = comparison.endpoints.after!;
  // Retained hook amendments are exact tree deltas. Reconstruct them before admitting any later step.
  for (const step of initialApplication.steps) {
    if ((step.state === 'published' || initialApplication.steps[initialApplication.nextGroupIndex] === step)
      && step.acceptedHookTreeOid && step.targetTreeOid) {
      const stepIndex = initialApplication.steps.indexOf(step);
      await validateScmCommitPlanHookSelections({ cwd: scope.cwd, comparison, originalTreeOid: step.targetTreeOid,
        acceptedHookTreeOid: step.acceptedHookTreeOid, remainingSteps: materialized.steps.slice(stepIndex + 1).map((candidate) => ({
          ...candidate, changeRefs: plan.groups.find((group) => group.id === candidate.groupId)!.changeRefs,
        })) });
      expectedSourceTree = (await mergeScmCommitPlanHookTree({ cwd: scope.cwd, originalTreeOid: step.targetTreeOid,
        acceptedHookTreeOid: step.acceptedHookTreeOid, targetTreeOid: expectedSourceTree })).targetTreeOid;
      if (step.state === 'published') materialized = { ...materialized, steps: await Promise.all(materialized.steps.map(async (candidate, index) => ({ ...candidate,
        targetTreeOid: index < stepIndex ? candidate.targetTreeOid
          : candidate.groupId === step.groupId ? step.acceptedHookTreeOid!
          : (await mergeScmCommitPlanHookTree({ cwd: scope.cwd, originalTreeOid: step.targetTreeOid!,
            acceptedHookTreeOid: step.acceptedHookTreeOid!, targetTreeOid: candidate.targetTreeOid })).targetTreeOid }))) };
    }
  }
  while (true) {
    current = await store.read(scope);
    if (!current.success || !current.result.application) return current;
    const application = current.result.application;
    if (application.status !== 'applying') return current;
    if (application.stopAfterCurrent || context.signal?.aborted) return store.mutateApplication(scope, (result) => ({
      ...result.application!, status: 'stopped', reason: context.signal?.aborted ? 'cancelled' : result.application!.reason ?? 'stopped' }));
    const index = application.nextGroupIndex;
    const step = application.steps[index];
    if (!step) return store.mutateApplication(scope, (result) => ({ ...result.application!, status: 'complete', reason: undefined }));
    // Interrupted in-flight writer admission is unresolved, never replayed by accept/recover.
    if (step.state === 'writing' || step.state === 'unknown') return store.mutateApplication(scope, (result) => ({
      ...result.application!, status: 'unknown', reason: 'outcome_unknown' }));
    const group = plan.groups.find((candidate) => candidate.id === step.groupId)!;
    const expectedParent = index === 0 ? application.acceptance.expectedHeadOid : application.steps[index - 1]?.commitSha;
    if (expectedParent === undefined) return failure('application_unavailable', 'The preceding commit has no verified publication.');
    const expectedIndexTreeOid = index === 0 ? materialized.indexTreeOid : application.steps[index - 1]?.publication?.indexTreeOid;
    if (!expectedIndexTreeOid) return store.mutateApplication(scope, (result) => ({ ...result.application!,
      status: 'failed', reason: 'staging_conflict', steps: result.application!.steps.map((entry, position) => position === index
        ? { ...entry, state: 'not_published', error: 'The previous publication has no verified reconciled index. Capture a fresh pending proposal before continuing.' } : entry) }));
    const observed = await target(backend, context);
    if (observed.expectedHeadOid !== expectedParent || observed.expectedRef !== application.acceptance.expectedRef) {
      return store.mutateApplication(scope, (result) => ({ ...result.application!, status: 'failed', reason: 'head_moved' }));
    }
    const remainingRefs = new Set(plan.groups.slice(index).flatMap((candidate) => candidate.changeRefs));
    const paths = [...new Set(comparison.inventory.files.filter((file) => file.occurrences.some((occurrence) => remainingRefs.has(occurrence.id)))
      .flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]))];
    const observedSourceTree = await captureScmPendingTree(scope.cwd);
    const sourceCheck = await readGitComparisonFiles({ cwd: scope.cwd, before: expectedSourceTree, after: observedSourceTree });
    if (!sourceCheck?.enumerationComplete || sourceCheck.files.some((file) => paths.includes(file.path) || (file.previousPath && paths.includes(file.previousPath)))) {
      return store.mutateApplication(scope, (result) => ({ ...result.application!, status: 'failed', reason: 'source_changed' }));
    }
    const candidate = materialized.steps.find((entry) => entry.groupId === step.groupId)!;
    const previousTreeOid = expectedParent ? await git(scope.cwd, ['rev-parse', `${expectedParent}^{tree}`]) : materialized.baseTreeOid;
    if (previousTreeOid === candidate.targetTreeOid) throw new Error('The accepted group has no remaining exact changes; reselect it before accepting.');
    const writing = await store.mutateApplication(scope, (result) => {
      if (result.application!.status !== 'applying' || result.application!.stopAfterCurrent) return result.application!;
      return { ...result.application!, steps: result.application!.steps.map((entry, position) => position === index
        ? { ...entry, state: 'writing', targetTreeOid: candidate.targetTreeOid, expectedHeadOid: expectedParent } : entry) };
    });
    if (!writing.success) return writing;
    if (writing.result.application?.steps[index]?.state !== 'writing') continue;
    let response: ScmCommitCreateResponse;
    try {
      response = await backend.commitCreate({ context, request: { cwd: scope.cwd, message: group.message,
        preparedTreeOid: candidate.targetTreeOid, expectedHeadOid: expectedParent, expectedRef: application.acceptance.expectedRef,
        expectedCandidateTreeOid: candidate.targetTreeOid, expectedIndexTreeOid, outcomeVersion: 1,
        ...(step.acceptedHookTreeOid ? { acceptedHookTreeOid: step.acceptedHookTreeOid } : {}) } });
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : 'Writer response was lost',
        publication: { state: 'unknown', expectedHeadOid: expectedParent, expectedRef: application.acceptance.expectedRef, indexReconciliation: 'pending' } };
    }
    const publication = response.publication;
    const published = publication?.state === 'published' && Boolean(response.commitSha ?? publication.candidateOid);
    const unknown = !publication || publication.state === 'unknown';
    const landedSha = published ? response.commitSha ?? publication?.candidateOid : undefined;
    // Verify the exact object/tree/parent returned by the owner; a later HEAD is not attribution evidence.
    let verified = false;
    if (landedSha) {
      const object = await git(scope.cwd, ['rev-list', '--parents', '-n', '1', landedSha]);
      const actualTree = await git(scope.cwd, ['rev-parse', `${landedSha}^{tree}`]);
      verified = object === [landedSha, ...(expectedParent ? [expectedParent] : [])].join(' ')
        && actualTree === (step.acceptedHookTreeOid ?? candidate.targetTreeOid);
    }
    const recorded = await store.mutateApplication(scope, (result) => ({ ...result.application!,
      status: published && verified && response.success ? 'applying' : response.hookContentChanges ? 'paused'
        : unknown || (published && !verified) ? 'unknown' : 'failed',
      reason: published && verified && response.success ? result.application!.stopAfterCurrent ? result.application!.reason : undefined : reasonFor(response),
      nextGroupIndex: published && verified ? index + 1 : index,
      steps: result.application!.steps.map((entry, position) => position === index ? { ...entry,
        state: published && verified ? 'published' : unknown || (published && !verified) ? 'unknown' : 'not_published',
        ...(landedSha ? { commitSha: landedSha } : {}), ...(publication ? { publication } : {}),
        ...(publication?.actualMessage !== undefined ? { actualMessage: publication.actualMessage } : {}),
        ...(response.hookContentChanges ? { hookContentChanges: response.hookContentChanges } : {}),
        ...(response.errorCode ? { errorCode: response.errorCode } : {}), ...(response.error ? { error: response.error } : {}),
      } : entry) }));
    if (!recorded.success || recorded.result.application?.status !== 'applying') return recorded;
    if (step.acceptedHookTreeOid) {
      expectedSourceTree = (await mergeScmCommitPlanHookTree({ cwd: scope.cwd, originalTreeOid: candidate.targetTreeOid,
        acceptedHookTreeOid: step.acceptedHookTreeOid, targetTreeOid: expectedSourceTree })).targetTreeOid;
      materialized = { ...materialized, steps: await Promise.all(materialized.steps.map(async (entry, position) => position <= index ? entry : ({ ...entry,
        targetTreeOid: (await mergeScmCommitPlanHookTree({ cwd: scope.cwd, originalTreeOid: candidate.targetTreeOid,
          acceptedHookTreeOid: step.acceptedHookTreeOid!, targetTreeOid: entry.targetTreeOid })).targetTreeOid }))) };
    }
  }
}

export async function executeScmCommitPlanAction(params: Params): Promise<ScmDiffSummaryResultResponse> {
  const store = params.store ?? scmDiffSummaryResultStore;
  const request = params.actionId === 'scm.diffSummary.commitPlan.accept' ? ScmCommitPlanAcceptInputSchema.parse(params.input)
    : params.actionId === 'scm.diffSummary.commitPlan.includeHookChanges' ? ScmCommitPlanIncludeHookChangesInputSchema.parse(params.input)
      : ScmCommitPlanControlInputSchema.parse(params.input);
  // Cancellation may stop the native writer, but cannot discard its known publication result.
  const scope = { cwd: params.cwd, resultId: request.resultId, ...(params.sessionId ? { sessionId: params.sessionId } : {}) };
  const saved = await store.read(scope);
  if (!saved.success) return saved;
  const stale = conflict(saved.result, request.expectedRevision); if (stale) return stale;
  if (saved.result.output.comparison?.source.kind !== 'workingTree') return failure('source_not_pending', 'Historical comparisons cannot authorize local commits.');
  if (params.actionId === 'scm.diffSummary.commitPlan.accept' && isScmCommitPlanApplicationLocked(saved.result.application)) {
    return failure('application_locked', 'Resolve the current accepted application before accepting another revision.', saved.result.revision);
  }
  if (params.actionId === 'scm.diffSummary.commitPlan.stop' || params.actionId === 'scm.diffSummary.commitPlan.cancel') {
    return store.mutateApplication(scope, (result) => {
      const outdated = conflict(result, request.expectedRevision); if (outdated) return outdated;
      const application = result.application!;
      const writing = application.steps[application.nextGroupIndex]?.state === 'writing';
      return { ...application, stopAfterCurrent: true,
        status: writing || application.status === 'unknown' ? application.status : 'stopped',
        reason: params.actionId === 'scm.diffSummary.commitPlan.cancel' ? 'cancelled' : 'stopped' };
    });
  }
  const routed = await runScmRoute({ request: { cwd: params.cwd }, workingDirectory: params.cwd,
    ...(params.registry ? { registry: params.registry } : {}), ...(params.accessPolicy ? { accessPolicy: params.accessPolicy } : {}),
    ...(params.signal ? { signal: params.signal } : {}), onNonRepository: () => failure('backend_unsupported', 'A supporting repository backend is required.'),
    runWithBackend: async ({ context, selection }) => {
      if (!selection.backend.getCapabilities({ mode: selection.mode }).writeCommitSafePlan || !selection.backend.commitResolveOutcome || !selection.backend.commitCaptureTarget) return failure('backend_unsupported', 'This backend does not support safe accepted commit plans.');
      if (params.actionId === 'scm.diffSummary.commitPlan.recover') {
        const application = saved.result.application;
        if (!application) return failure('application_unavailable', 'No application exists.');
        const step = application.steps[application.nextGroupIndex];
        if (!step || !['unknown', 'writing'].includes(step.state)) return saved;
        if (!step.publication?.candidateOid || step.expectedHeadOid === undefined) return store.mutateApplication(scope, (result) => ({
          ...result.application!, status: 'unknown', reason: 'outcome_unknown', stopAfterCurrent: true }));
        const resolved = await selection.backend.commitResolveOutcome({ context, request: { cwd: params.cwd,
          candidateOid: step.publication.candidateOid, expectedHeadOid: step.expectedHeadOid, expectedRef: application.acceptance.expectedRef } });
        return store.mutateApplication(scope, (result) => {
          const outdated = conflict(result, request.expectedRevision); if (outdated) return outdated;
          const publication = resolved.publication;
          const published = publication?.state === 'published' && resolved.candidateTreeOid === (step.acceptedHookTreeOid ?? step.targetTreeOid);
          const uncertain = !publication || publication.state === 'unknown' || (publication.state === 'published' && !published);
          return { ...result.application!, status: uncertain ? 'unknown' : 'stopped', stopAfterCurrent: true,
            reason: uncertain ? 'outcome_unknown' : 'stopped',
            nextGroupIndex: published ? application.nextGroupIndex + 1 : application.nextGroupIndex,
            steps: result.application!.steps.map((entry, index) => index === application.nextGroupIndex ? { ...entry,
              state: uncertain ? 'unknown' : publication!.state, ...(publication ? { publication } : {}),
              ...(published ? { commitSha: publication!.candidateOid, actualMessage: publication!.actualMessage } : {}) } : entry) };
        });
      }
      if (params.actionId === 'scm.diffSummary.commitPlan.accept') {
        const acceptRequest = ScmCommitPlanAcceptInputSchema.parse(params.input);
        const observed = await target(selection.backend, context);
        if (observed.expectedHeadOid !== acceptRequest.acceptance.expectedHeadOid || observed.expectedRef !== acceptRequest.acceptance.expectedRef) return failure('head_moved', 'The checkout parent or target ref changed.');
        const comparison = saved.result.output.comparison!;
        const prefix = saved.result.application?.steps.filter((step) => step.state === 'published') ?? [];
        if (!comparison.commitTarget) return failure('source_changed', 'Capture a fresh pending proposal with a verified commit target.');
        if (observed.expectedRef !== comparison.commitTarget.ref) return failure('head_moved', 'The proposal was captured for a different checkout target.');
        if (!prefix.length && observed.expectedHeadOid !== comparison.commitTarget.headOid) return failure('source_changed', 'The proposal was captured from a different parent.');
        if (prefix.length && prefix.at(-1)?.commitSha !== observed.expectedHeadOid) return failure('head_moved', 'Fresh acceptance must continue from the verified landed prefix.');
        const begun = await store.beginApplication({ ...scope, expectedRevision: acceptRequest.expectedRevision, acceptance: acceptRequest.acceptance });
        if (!begun.success) return begun;
      } else if (params.actionId === 'scm.diffSummary.commitPlan.includeHookChanges') {
        const includeRequest = ScmCommitPlanIncludeHookChangesInputSchema.parse(params.input);
        const included = await store.mutateApplication(scope, (result) => {
          const outdated = conflict(result, request.expectedRevision); if (outdated) return outdated;
          const application = result.application!;
          const step = application.steps[application.nextGroupIndex];
          const hookChanges = step?.hookContentChanges;
          if (application.status !== 'paused' || step?.groupId !== includeRequest.groupId
            || hookChanges?.beforeTreeOid !== includeRequest.beforeTreeOid || hookChanges?.afterTreeOid !== includeRequest.afterTreeOid) {
            return failure('acceptance_mismatch', 'Include must bind the exact displayed hook expansion.');
          }
          return { ...application, status: 'applying', reason: undefined, steps: application.steps.map((entry, index) => index === application.nextGroupIndex
            ? { ...entry, state: 'pending', acceptedHookTreeOid: includeRequest.afterTreeOid } : entry) };
        });
        if (!included.success) return included;
      }
      try { return await applyRemaining({ store, scope, backend: selection.backend, context }); }
      catch (error) {
        return store.mutateApplication(scope, (result) => {
          const application = result.application!;
          const writing = application.steps[application.nextGroupIndex]?.state === 'writing';
          return { ...application, status: writing ? 'unknown' : 'failed', reason: writing ? 'outcome_unknown' : 'selection_conflict',
            steps: application.steps.map((step, index) => index === application.nextGroupIndex ? { ...step,
              state: writing ? 'unknown' : 'not_published', error: error instanceof Error ? error.message : 'Application evidence is unavailable' } : step) };
        });
      }
    },
  });
  // The shared backend router also returns native SCM failures. Translate those
  // at this saved-result boundary rather than widening its closed error vocabulary.
  const parsed = ScmDiffSummaryResultResponseSchema.safeParse(routed);
  return parsed.success ? parsed.data : failure('result_unavailable', !routed.success ? routed.error : 'The commit application response could not be validated.');
}
