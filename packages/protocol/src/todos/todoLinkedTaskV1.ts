import type { ScmPullRequestSummary } from '../scm/pullRequests.js';
import { transitionTodoItemV1, resolveTodoStateV1, type TodoClaimAttemptBindingV1,
  type TodoClaimMutationV1, type TodoItemV1, type TodoStateV1 } from './todoSessionLinkV1.js';

export type TodoLinkedEvidenceReaderV1 = Readonly<{
  readPullRequest(input: Readonly<{ sessionId: string; prRef: { url: string } }>): Promise<
    Pick<ScmPullRequestSummary, 'url' | 'state' | 'headBranch' | 'mergeCommitSha'> | null>;
  readDeployment(input: Readonly<{ serverId: string; environmentId: string; deploymentId: string }>): Promise<
    Readonly<{ deploymentId: string; environmentId: string; projectSourceId: string; state: 'succeeded' | 'failed'; sha: string }> | null>;
}>;
type LinkedMutation = Extract<TodoClaimMutationV1, { kind: 'merge' | 'deployment' }>;

export async function writeTodoPullRequestHandoffV1(input: Readonly<{
  todo: TodoItemV1; claimant: TodoClaimAttemptBindingV1;
  finish: NonNullable<Extract<TodoClaimMutationV1, { kind: 'result' }>['finish']>;
  branch?: string;
  evidence?: TodoLinkedEvidenceReaderV1;
}>) {
  const { todo, claimant, finish, branch, evidence } = input;
  if (todo.state !== 'ready_for_review' || (finish.deployTo !== undefined && finish.sentryIssueId === undefined)) {
    return { ok: false as const, reason: 'invalid_input' };
  }
  const pr = await evidence?.readPullRequest({ sessionId: claimant.sessionId, prRef: finish.prRef });
  if (!pr) return { ok: false as const, reason: 'task_pr_unavailable' };
  if (pr.url !== finish.prRef.url || (branch !== undefined && branch !== pr.headBranch)) {
    return { ok: false as const, reason: 'task_pr_mismatch' };
  }
  if (pr.state !== 'open') return { ok: false as const, reason: 'task_pr_not_open' };
  return { ok: true as const, todo: { ...todo, branch: pr.headBranch,
    handoff: { ...finish, taskId: todo.id, attempt: claimant } } };
}

export async function settleTodoLinkedWorkV1(input: Readonly<{
  todo: TodoItemV1; state: TodoStateV1; claim: LinkedMutation; serverId: string;
  now: number; evidence?: TodoLinkedEvidenceReaderV1;
}>) {
  const { todo, state, claim, serverId, evidence, now } = input;
  const handoff = todo.handoff;
  const current = resolveTodoStateV1(todo);
  if (!handoff || handoff.taskId !== todo.id || todo.attemptBinding || handoff.deploymentId
    || (current !== 'ready_for_review' && !(claim.kind === 'deployment' && current === 'completed' && handoff.mergeCommitSha))) {
    return { ok: false as const, reason: 'task_handoff_mismatch' };
  }
  if (claim.kind === 'merge' && (state !== 'completed' || handoff.kind !== 'mark_completed_on_merge')) {
    return { ok: false as const, reason: 'task_handoff_mismatch' };
  }
  let mergeCommitSha = handoff.mergeCommitSha;
  if (!mergeCommitSha) {
    const pr = await evidence?.readPullRequest({ sessionId: handoff.attempt.sessionId, prRef: handoff.prRef });
    if (!pr) return { ok: false as const, reason: 'task_pr_unavailable' };
    if (pr.url !== handoff.prRef.url) return { ok: false as const, reason: 'task_pr_mismatch' };
    if (pr.state !== 'merged' || !pr.mergeCommitSha) return { ok: false as const, reason: 'task_pr_not_merged' };
    mergeCommitSha = pr.mergeCommitSha;
  }
  if (claim.kind === 'merge') return { ok: true as const,
    todo: { ...transitionTodoItemV1(todo, state, now), handoff: { ...handoff, mergeCommitSha } } };

  if (!handoff.deployTo || !handoff.sentryIssueId) return { ok: false as const, reason: 'task_handoff_mismatch' };
  const deployment = await evidence?.readDeployment({ serverId, environmentId: handoff.deployTo.environmentId, deploymentId: claim.deploymentId });
  if (!deployment) return { ok: false as const, reason: 'task_deployment_unavailable' };
  const outcome = deployment.state === 'succeeded' ? 'completed' : 'unstarted';
  if (deployment.deploymentId !== claim.deploymentId || deployment.environmentId !== handoff.deployTo.environmentId
    || deployment.projectSourceId !== handoff.deployTo.projectSourceId || deployment.sha !== mergeCommitSha || state !== outcome) {
    return { ok: false as const, reason: 'task_deployment_mismatch' };
  }
  return { ok: true as const, todo: { ...transitionTodoItemV1(todo, outcome, now), handoff: {
    ...handoff, mergeCommitSha, deploymentId: deployment.deploymentId,
  } } };
}
