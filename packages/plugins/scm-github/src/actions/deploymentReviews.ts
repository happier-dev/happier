import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import {
  type ForgeCiActionInputByOperationV1,
  type ForgeCiActionResultByOperationV1,
  type ForgeCiDeploymentApprovalV1,
  type ForgeCiDeploymentReviewV1,
} from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { GithubApiClientV1 } from '../observations/githubApiClient.js';
import { readGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure, isGithubSuccessStatus, isGithubWriteResponseAmbiguous } from '../triage/errors.js';
import { githubCiRepositoryUrl, readExactGithubRun, requestGithubCiJson, GithubCiReadError } from './reads.js';
import { githubRecord as record } from './mapping.js';
import { binding } from './contribution.js';
import { GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTIONS_V1 } from './deploymentReviewTarget.js';

type DeploymentOperation = 'listDeployments' | 'readDeploymentHistory' | 'approveDeployment' | 'rejectDeployment';
type Repository = ForgeCiActionInputByOperationV1['listDeployments']['repository'];
type ReviewInput = ForgeCiActionInputByOperationV1['approveDeployment'];
function runUrl(repository: Repository, runId: string): string {
  return githubCiRepositoryUrl(repository, 'actions', 'runs', readGithubPositiveDecimal(runId, 'run ID'));
}

/** Provider ingress shared by foreground inspection and the enrolled observer. */
export function decodeGithubPendingDeploymentsV1(body: unknown, input: ForgeCiActionInputByOperationV1['listDeployments']): ForgeCiDeploymentApprovalV1[] {
  if (!Array.isArray(body)) throw new RangeError('Invalid pending deployments');
  const selection = { kind: 'run' as const, run: { v: 1 as const, repository: input.repository, runId: input.runId } };
  const seen = new Set<string>();
  return body.map(value => {
    const pending = record(value);
    const environment = record(pending.environment);
    const id = readGithubPositiveDecimal(environment.id, 'environment ID');
    if (seen.has(id) || typeof environment.name !== 'string' || typeof pending.current_user_can_approve !== 'boolean') throw new RangeError('Invalid deployment environment');
    seen.add(id);
    let waitUntilMs: number | undefined;
    if (pending.wait_timer_started_at !== null && pending.wait_timer_started_at !== undefined && pending.wait_timer !== undefined) {
      const startedAt = typeof pending.wait_timer_started_at === 'string' ? Date.parse(pending.wait_timer_started_at) : NaN;
      if (!Number.isSafeInteger(startedAt) || typeof pending.wait_timer !== 'number' || !Number.isSafeInteger(pending.wait_timer) || pending.wait_timer < 0) throw new RangeError('Invalid deployment wait timer');
      waitUntilMs = startedAt + pending.wait_timer * 60_000;
      if (!Number.isSafeInteger(waitUntilMs) || waitUntilMs < 0) throw new RangeError('Invalid deployment wait deadline');
    }
    const reviewers: string[] = [];
    if (pending.reviewers !== undefined) {
      if (!Array.isArray(pending.reviewers)) throw new RangeError('Invalid deployment reviewers');
      for (const value of pending.reviewers) {
        const reviewer = record(record(value).reviewer);
        const label = reviewer.login ?? reviewer.slug ?? reviewer.name;
        if (typeof label !== 'string') throw new RangeError('Invalid deployment reviewer');
        reviewers.push(label);
      }
    }
    return { id, selection, environment: { id, name: environment.name }, eligible: pending.current_user_can_approve,
      ...(waitUntilMs === undefined ? {} : { waitUntilMs }), ...(pending.reviewers === undefined ? {} : { reviewers }) };
  });
}

function page<T>(rows: T[]) {
  return { rows, omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } as const;
}

function invalid(code: string): TriageSourceFailureV1 { return { class: 'unsupportedContract', code }; }

async function readDeployments(input: ForgeCiActionInputByOperationV1['listDeployments'], client: GithubApiClientV1): Promise<ForgeCiActionResultByOperationV1['listDeployments']> {
  try {
    const result = await requestGithubCiJson(client, `${runUrl(input.repository, input.runId)}/pending_deployments`, input.validator);
    if (result.kind !== 'value') return result;
    return { kind: 'value', value: page(decodeGithubPendingDeploymentsV1(result.value, input)), ...(result.validator === undefined ? {} : { validator: result.validator }) };
  } catch (error) { return { kind: 'unavailable', failure: error instanceof GithubCiReadError ? error.failure : error instanceof RangeError ? invalid('github_deployment_response_invalid') : classifyGithubTransportFailure(error) }; }
}

async function readHistory(input: ForgeCiActionInputByOperationV1['readDeploymentHistory'], client: GithubApiClientV1): Promise<ForgeCiActionResultByOperationV1['readDeploymentHistory']> {
  if (input.cursor !== undefined) return { kind: 'unavailable', failure: invalid('github_deployment_history_cursor_invalid') };
  try {
    const result = await requestGithubCiJson(client, `${runUrl(input.repository, input.runId)}/approvals`, input.validator);
    if (result.kind !== 'value') return result;
    const body = result.value;
    if (!Array.isArray(body)) throw new RangeError('Invalid deployment history');
    const rows: ForgeCiDeploymentReviewV1[] = body.map(value => {
      const review = record(value);
      if (!Array.isArray(review.environments) || typeof review.comment !== 'string') throw new RangeError('Invalid deployment history');
      const environmentIds = review.environments.map(environment => readGithubPositiveDecimal(record(environment).id, 'environment ID'));
      const reviewer = record(review.user);
      const reviewerId = readGithubPositiveDecimal(reviewer.id, 'reviewer ID');
      if (typeof reviewer.login !== 'string') throw new RangeError('Invalid deployment reviewer');
      const decision = review.state === 'approved' || review.state === 'rejected' ? review.state : 'unknown';
      // GitHub returns no native review id or timestamp. Its immutable review
      // facts identify a display row; they confer no mutation authority.
      const id = JSON.stringify([input.runId, environmentIds, reviewerId, review.state, review.comment]);
      return { id, environmentIds, decision, comment: review.comment, reviewer: reviewer.login };
    });
    return { kind: 'value', value: page(rows), ...(result.validator === undefined ? {} : { validator: result.validator }) };
  } catch (error) { return { kind: 'unavailable', failure: error instanceof GithubCiReadError ? error.failure : error instanceof RangeError ? invalid('github_deployment_history_invalid') : classifyGithubTransportFailure(error) }; }
}

async function reviewDeployments(input: ReviewInput, decision: 'approved' | 'rejected', client: GithubApiClientV1, context: GithubHttpInvocationContextV1): Promise<ForgeCiActionResultByOperationV1['approveDeployment']> {
  const affected = { repository: input.repository, run: { v: 1 as const, repository: input.repository, runId: input.runId }, environmentIds: input.environmentIds };
  let url: string;
  try { url = runUrl(input.repository, input.runId); }
  catch { return { kind: 'rejected', failure: invalid('github_deployment_target_invalid') }; }
  const webUrl = `https://github.com/${input.repository.repository}/actions/runs/${input.runId}`;
  try {
    const run = await readExactGithubRun(client, input.repository, input.runId);
    if (input.attempt !== undefined && readGithubPositiveDecimal(run.run_attempt, 'attempt') !== input.attempt) {
      return { kind: 'rejected', failure: invalid('github_deployment_selection_stale') };
    }
    const pending = await readDeployments({ repository: input.repository, runId: input.runId }, client);
    if (pending.kind !== 'value') return { kind: 'rejected', failure: pending.kind === 'unavailable' ? pending.failure : invalid('github_deployment_freshness_unavailable') };
    const environments = new Map(pending.value.rows.map(environment => [environment.id, environment]));
    if (input.environmentIds.some(id => environments.get(id)?.eligible !== true)) return { kind: 'rejected', failure: { class: 'permission', code: 'github_deployment_not_eligible' } };
    const environmentIds = input.environmentIds.map(id => {
      const numeric = Number(readGithubPositiveDecimal(id, 'environment ID'));
      if (!Number.isSafeInteger(numeric)) throw new RangeError('GitHub environment ID cannot be represented safely');
      return numeric;
    });
    context.signal.throwIfAborted();
    // Only this call can change GitHub. A transport loss from here is unknown,
    // including cancellation; no retry or optimistic notice resolution follows.
    try {
      const response = await client.request({ url: `${url}/pending_deployments`, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ environment_ids: environmentIds, state: decision, comment: input.comment })) });
      if (isGithubWriteResponseAmbiguous(response) || (isGithubSuccessStatus(response.status) && response.status !== 200)) return { kind: 'outcome_unknown', affected, webUrl, failure: classifyGithubResponseFailure(response, context.invokedAtMs) };
      if (!isGithubSuccessStatus(response.status)) return { kind: 'rejected', failure: classifyGithubResponseFailure(response, context.invokedAtMs) };
      return { kind: 'accepted', affected };
    } catch (error) { return { kind: 'outcome_unknown', affected, webUrl, failure: classifyGithubTransportFailure(error) }; }
  } catch (error) { return { kind: 'rejected', failure: error instanceof GithubCiReadError ? error.failure : error instanceof RangeError ? invalid('github_deployment_response_invalid') : classifyGithubTransportFailure(error) }; }
}

export async function executeGithubDeploymentActionV1<K extends DeploymentOperation>(operation: K, input: ForgeCiActionInputByOperationV1[K], client: GithubApiClientV1, context: GithubHttpInvocationContextV1): Promise<ForgeCiActionResultByOperationV1[K]> {
  let result: ForgeCiActionResultByOperationV1[DeploymentOperation];
  switch (operation) {
    case 'listDeployments': result = await readDeployments(input as ForgeCiActionInputByOperationV1['listDeployments'], client); break;
    case 'readDeploymentHistory': result = await readHistory(input as ForgeCiActionInputByOperationV1['readDeploymentHistory'], client); break;
    case 'approveDeployment': case 'rejectDeployment': result = await reviewDeployments(input as ReviewInput, operation === 'approveDeployment' ? 'approved' : 'rejected', client, context); break;
    default: throw new RangeError('Unsupported deployment operation');
  }
  return result as ForgeCiActionResultByOperationV1[K];
}

export const GITHUB_DEPLOYMENT_ACTIONS_V1 = {
  ...GITHUB_DEPLOYMENT_REVIEW_TARGET_ACTIONS_V1,
  'github/actions/deployments-list': binding('listDeployments', 'Read pending deployments', 'Reads the selected run pending deployment environments and current eligibility.'),
  'github/actions/deployment-history-read': binding('readDeploymentHistory', 'Read deployment review history', 'Reads deployment review history only when requested.'),
  'github/actions/deployment-approve': {
    ...binding('approveDeployment', 'Approve deployment', 'Approves exactly the selected pending environments with the supplied comment after fresh eligibility checks.', 'writesRemote', {
      title: 'Approve this deployment?', body: 'Approve only the selected pending environments with the supplied review comment.', confirmLabel: 'Approve',
    }), confirmationWhen: { presentUserUi: false as const },
  },
  'github/actions/deployment-reject': {
    ...binding('rejectDeployment', 'Reject deployment', 'Rejects exactly the selected pending environments with the supplied comment after fresh eligibility checks.', 'writesRemote', {
      title: 'Reject this deployment?', body: 'Reject only the selected pending environments with the supplied review comment.', confirmLabel: 'Reject',
    }), confirmationWhen: { presentUserUi: false as const },
  },
};
