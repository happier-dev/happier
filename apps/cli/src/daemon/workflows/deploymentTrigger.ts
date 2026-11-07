import type { ActionExecutorContext, WorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol';
import type { AutomationRunCause } from '@happier-dev/protocol/automations/run-cause';
import { AutomationRunPluginEventTriggerEvidenceV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import type { AutomationDeploymentTriggerV1 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { ProjectSourcesReadOutputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ScmComparisonCaptureOutputSchema } from '@happier-dev/protocol/scm/diffSummary';
import { ScmLogListResponseSchema } from '@happier-dev/protocol/scm';
import type { ScmRevisionRangeV1 } from '@happier-dev/protocol/scm/comparison';
import { ScmPullRequestGetResponseSchema } from '@happier-dev/protocol/scm/pullRequests';
import { readScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';
import { isWorkflowJsonObject } from './input';
import { shouldDeployPushRange, summarizeDeploymentPushCommitMessages } from './deploymentPushFilter';

export type DeploymentTriggerOccurrence = Readonly<{
  kind: 'push' | 'merge'; sha: string; requestKey: string; repository: string;
  trigger: AutomationDeploymentTriggerV1; range?: ScmRevisionRangeV1; pullRequestNumber?: number;
}>;
export type DeploymentTriggerOccurrenceResolution =
  | Readonly<{ kind: 'unrelated' }>
  | Readonly<{ kind: 'skipped' }>
  | Readonly<{ kind: 'refused'; code: string }>
  | Readonly<{ kind: 'available'; occurrence: DeploymentTriggerOccurrence }>;

type DeploymentEnvironmentRead = Extract<ReturnType<typeof DeploymentEnvironmentGetResultV1Schema.parse>, { ok: true }>;
/** Header/Source facts only; this is neither private definition content nor consent. */
export type DeploymentTriggerReadBasis = Readonly<{
  environment: DeploymentEnvironmentRead['environment'];
  targetLink: DeploymentEnvironmentRead['targetLinks'][number];
  source: ProjectSourceV1;
}>;
export type DeploymentTriggerAdmission = Readonly<{ kind: 'deploy'; basis: DeploymentTriggerReadBasis }>
  | Readonly<{ kind: 'skipped' }> | Readonly<{ kind: 'refused'; code: string }>;

/** Only the selected private trigger opts in; generic Workflow evidence stays opaque. */
export function resolveDeploymentTriggerOccurrence(input: Readonly<{
  cause: AutomationRunCause; evidence: unknown; triggers?: readonly AutomationDeploymentTriggerV1[];
}>): DeploymentTriggerOccurrenceResolution {
  const cause = input.cause;
  if (cause.kind !== 'trigger') return { kind: 'unrelated' };
  const trigger = input.triggers?.find(item => item.triggerId === cause.triggerId);
  if (!trigger) return { kind: 'unrelated' };
  if (cause.triggerKind !== 'pluginEvent') return { kind: 'refused', code: 'invalid_input' };
  const parsed = AutomationRunPluginEventTriggerEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success) return { kind: 'refused', code: 'invalid_input' };
  const event = parsed.data;
  const occurrenceKey = deriveAutomationOccurrenceKeyV1({ triggerId: cause.triggerId, evidence: {
    v: event.v, kind: event.kind, eventRef: event.eventRef, sourceSelectorId: event.sourceSelectorId,
    occurrenceId: event.occurrenceId, occurredAt: event.occurredAt, payload: event.payload,
  } });
  if (event.eventRef.pluginId !== cause.evidence.eventRef.pluginId || event.eventRef.localId !== cause.evidence.eventRef.localId
    || event.sourceSelectorId !== cause.evidence.sourceSelectorId || event.occurredAt !== cause.occurredAt
    || occurrenceKey !== cause.occurrenceKey || event.eventRef.pluginId !== 'happier.scm.forge.github') {
    return { kind: 'refused', code: 'invalid_input' };
  }
  if (!isWorkflowJsonObject(event.payload) || !isWorkflowJsonObject(event.payload.repository)) return { kind: 'refused', code: 'invalid_input' };
  const repository = event.payload.repository;
  if (typeof repository.repositoryId !== 'string' || typeof repository.nameWithOwner !== 'string'
    || event.sourceInstanceId !== `github:repository:${repository.repositoryId}`) return { kind: 'refused', code: 'invalid_input' };
  const payload = event.payload;
  const isPush = event.eventRef.localId === 'automation/repository-pushed-v1';
  const pr = isWorkflowJsonObject(payload.pullRequest) ? payload.pullRequest : null;
  if (!isPush && event.eventRef.localId !== 'automation/pull-request-merged-v1') return { kind: 'refused', code: 'invalid_input' };
  const sha = isPush ? payload.after : pr?.mergeCommitSha;
  if (typeof sha === 'string' && /^0+$/u.test(sha)) return { kind: 'skipped' };
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/iu.test(sha)) return { kind: 'refused', code: 'invalid_input' };
  if (isPush) {
    if (typeof payload.ref !== 'string') return { kind: 'refused', code: 'invalid_input' };
    const branch = trigger.branch;
    if (branch !== undefined && payload.ref !== (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`)) return { kind: 'skipped' };
    const before = payload.before;
    return { kind: 'available', occurrence: { kind: 'push', sha, requestKey: cause.occurrenceKey,
      repository: repository.nameWithOwner, trigger,
      ...(typeof before === 'string' && /^[a-f0-9]{40}$/iu.test(before) && !/^0+$/u.test(before)
        ? { range: { kind: 'revisionRange', baseOid: before, headOid: sha } } : {}),
    } };
  }
  if (!pr || typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number < 1) return { kind: 'refused', code: 'invalid_input' };
  return { kind: 'available', occurrence: { kind: 'merge', sha, requestKey: cause.occurrenceKey,
    repository: repository.nameWithOwner, trigger, pullRequestNumber: pr.number } };
}

/** Reads current authorities and exact SCM witnesses through their existing Action front doors. */
export async function admitDeploymentTriggerOccurrence(input: Readonly<{
  occurrence: DeploymentTriggerOccurrence; snapshot: WorkflowAcceptedSnapshotV1;
  machineId: string; executor: RpcActionExecutor; context: ActionExecutorContext;
}>): Promise<DeploymentTriggerAdmission> {
  const { occurrence, snapshot, executor, context } = input;
  const leaves = snapshot.materializedLeaves.filter(leaf => leaf.actionId === 'deployments.deploy');
  if (leaves.length !== 1) return { kind: 'refused', code: 'invalid_input' };
  const effect = leaves[0]!.actionInput;
  const intent = effect && isWorkflowJsonObject(effect.sourceIntent) ? effect.sourceIntent : null;
  if (!effect || typeof effect.environmentId !== 'string' || typeof effect.serverId !== 'string' || typeof effect.targetLinkId !== 'string'
    || (effect.sha ?? intent?.sha) !== occurrence.sha || effect.requestKey !== occurrence.requestKey) return { kind: 'refused', code: 'invalid_input' };
  const detailResult = await executor.execute('deployments.environments.get', { serverId: effect.serverId, environmentId: effect.environmentId }, context);
  if (!detailResult.ok) return { kind: 'refused', code: detailResult.errorCode };
  const detail = DeploymentEnvironmentGetResultV1Schema.parse(detailResult.result);
  if (!detail.ok) return { kind: 'refused', code: detail.error };
  if (detail.environment.id !== effect.environmentId || detail.environment.controllerMachineId !== input.machineId) return { kind: 'refused', code: 'target_mismatch' };
  const targetLink = detail.targetLinks.find(link => link.id === effect.targetLinkId);
  if (!targetLink || targetLink.id !== detail.environment.runtimeTargetLinkId) return { kind: 'refused', code: 'target_mismatch' };
  const sourceResult = await executor.execute('projects.sources.read', { serverId: effect.serverId, sourceId: detail.environment.projectSourceId }, context);
  if (!sourceResult.ok) return { kind: 'refused', code: sourceResult.errorCode };
  const source = ProjectSourcesReadOutputV1Schema.parse(sourceResult.result);
  if (!source.ok) return { kind: 'refused', code: source.error };
  const selected = source.source.repository;
  const expectedRepository = selected && readScmHostingRepositoryIdentity({ ...selected.provider, nameWithOwner: selected.repository.nameWithOwner });
  const eventRepository = readScmHostingRepositoryIdentity({ kind: 'github', baseUrl: 'https://github.com', nameWithOwner: occurrence.repository });
  if (source.source.id !== detail.environment.projectSourceId || !sameScmHostingRepositoryIdentity(expectedRepository, eventRepository)) return { kind: 'refused', code: 'source_mismatch' };
  const deploy = { kind: 'deploy' as const, basis: { environment: detail.environment, targetLink, source: source.source } };
  const cwd = snapshot.workspaceTarget.project.directory;
  if (occurrence.kind === 'merge' && occurrence.trigger.branch !== undefined) {
    const result = await executor.execute('scm.pullRequest.get', { cwd, prReference: { number: occurrence.pullRequestNumber } }, context);
    if (!result.ok) return { kind: 'refused', code: result.errorCode };
    const pr = ScmPullRequestGetResponseSchema.parse(result.result);
    if (!pr.success || !pr.pullRequest || pr.pullRequest.number !== occurrence.pullRequestNumber
      || pr.pullRequest.state !== 'merged'
      || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(pr.pullRequest.provider), expectedRepository)) return { kind: 'refused', code: 'source_unavailable' };
    const branch = occurrence.trigger.branch.replace(/^refs\/heads\//u, '');
    return pr.pullRequest.baseBranch === branch ? deploy : { kind: 'skipped' };
  }
  if (occurrence.kind !== 'push' || !occurrence.range) return deploy;
  // Existing immutable Git objects attest the same trees in any checkout.
  // Missing objects deploy; this read never fetches or scans working-tree state.
  try {
    const captured = await executor.execute('scm.diffSummary.capture', { cwd, source: occurrence.range }, context);
    if (!captured.ok) return deploy;
    const comparison = ScmComparisonCaptureOutputSchema.safeParse(captured.result);
    if (!comparison.success || !comparison.data.success || comparison.data.comparison.inventory.state !== 'complete') return deploy;
    const history = { ...occurrence.range, complete: true, commitCount: 0, allCommitsSkipped: true };
    let totalCount: number | undefined;
    let skip = 0;
    for (;;) {
      context.signal?.throwIfAborted();
      const result = await executor.execute('scm.log.list', { cwd, revisionRange: occurrence.range, skip }, context);
      if (!result.ok) return deploy;
      const page = ScmLogListResponseSchema.safeParse(result.result);
      if (!page.success || !page.data.success || !page.data.entries || !page.data.revisionRange?.historyComplete
        || page.data.revisionRange.baseOid !== occurrence.range.baseOid || page.data.revisionRange.headOid !== occurrence.range.headOid
        || page.data.revisionRange.graphRelation === undefined || page.data.revisionRange.totalCount === undefined
        || totalCount !== undefined && totalCount !== page.data.revisionRange.totalCount) return deploy;
      totalCount = page.data.revisionRange.totalCount;
      const pageSummary = summarizeDeploymentPushCommitMessages(page.data.entries.map(commit => `${commit.subject}\n${commit.body ?? ''}`));
      history.commitCount += pageSummary.commitCount;
      history.allCommitsSkipped &&= pageSummary.allCommitsSkipped;
      const next = page.data.revisionRange.nextSkip;
      if (next === undefined) break;
      if (next !== skip + page.data.entries.length || next <= skip) return deploy;
      skip = next;
    }
    if (totalCount === undefined) return deploy;
    return shouldDeployPushRange({ range: occurrence.range, comparison: comparison.data.comparison,
      history: { ...history, totalCount }, ...(occurrence.trigger.paths ? { paths: occurrence.trigger.paths } : {}) }) ? deploy : { kind: 'skipped' };
  } catch {
    context.signal?.throwIfAborted();
    return deploy;
  }
}
