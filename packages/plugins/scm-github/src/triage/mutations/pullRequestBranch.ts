import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { settleAtMostOnceProviderWrite } from '@happier-dev/triage-sources/runtime';
import { decodeGithubJsonResponse } from '../../observations/githubApiClient.js';
import { admitGithubEntryInvocation } from '../admission.js';
import { classifyGithubResponseFailure, GITHUB_ROUTE_BODY_MISMATCH_FAILURE, isGithubSuccessStatus, isGithubWriteResponseAmbiguous } from '../errors.js';
import { readGithubPullRequest } from '../get.js';
import { buildGithubApiUrl } from '../locator.js';
import { toTriageFailure } from '../mapping/protocol.js';
import { createGithubRepositoryReader } from '../repositories.js';
import { GithubPullRequestHeadBranchRestoreInputV1Schema, type GithubPullRequestHeadBranchRestoreResultV1,
  type GithubPullRequestHeadBranchDeleteResultV1 } from './contracts.js';
import { sendGithubRestRequest } from './http.js';
import { reduceGithubPullRequestMutationRead } from './pullRequest.js';

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function changeBranch(input: unknown, context: PluginInvocationContext, operation: 'restore'): Promise<GithubPullRequestHeadBranchRestoreResultV1>;
function changeBranch(input: unknown, context: PluginInvocationContext, operation: 'delete'): Promise<GithubPullRequestHeadBranchDeleteResultV1>;
async function changeBranch(input: unknown, context: PluginInvocationContext, operation: 'restore' | 'delete'):
  Promise<GithubPullRequestHeadBranchRestoreResultV1 | GithubPullRequestHeadBranchDeleteResultV1> {
  const parsed = GithubPullRequestHeadBranchRestoreInputV1Schema.safeParse(input);
  if (!parsed.success) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_mutation_input_invalid' } };
  const admitted = await admitGithubEntryInvocation({ ...parsed.data, admissibleKinds: ['pull-request'] }, context);
  if (!admitted.ok) return { kind: 'failed', failure: admitted.failure };
  const dependencies = { client: admitted.client, now: Date.now, signal: admitted.signal };
  const current = reduceGithubPullRequestMutationRead(await readGithubPullRequest(admitted.localRef, admitted.route,
    createGithubRepositoryReader(dependencies), dependencies));
  if (!current.ok) return { kind: 'failed', failure: current.failure };
  if (operation === 'restore' && current.facts.headRevision !== parsed.data.headRevision) return { kind: 'refused', reason: 'head_advanced', observation: current.observation };
  const tip = current.facts.sourceTip;
  if (tip === null || current.facts.nodeId === null) return { kind: 'failed',
    failure: { class: 'unsupportedContract', code: 'github_entity_id_unavailable' } };
  const ref = `refs/heads/${tip.branch}`;
  const path = ['repos', tip.owner, tip.name, 'git', 'refs'];
  if (operation === 'delete') {
    // Lead ruling 2026-10-31: one exact-ref check at the point of effect. The
    // read→delete race is accepted; Restore stays create-only from an observed head.
    const live = await sendGithubRestRequest(dependencies, { method: 'GET',
      url: buildGithubApiUrl(['repos', tip.owner, tip.name, 'git', 'ref', 'heads', ...tip.branch.split('/')]) });
    if (!live.ok) return { kind: 'failed', failure: live.failure };
    if (!isGithubSuccessStatus(live.response.status)) return { kind: 'failed', failure: toTriageFailure(classifyGithubResponseFailure(live.response, dependencies.now())) };
    let body: unknown;
    try { body = decodeGithubJsonResponse(live.response); }
    catch { return { kind: 'failed', failure: GITHUB_ROUTE_BODY_MISMATCH_FAILURE }; }
    if (!record(body) || body.ref !== ref || !record(body.object) || typeof body.object.sha !== 'string' || !body.object.sha) {
      return { kind: 'failed', failure: GITHUB_ROUTE_BODY_MISMATCH_FAILURE };
    }
    if (body.object.sha !== parsed.data.headRevision) return { kind: 'refused', reason: 'branch_moved', currentBranchRevision: body.object.sha };
  }
  const request = operation === 'restore' ? { method: 'POST' as const, url: buildGithubApiUrl(path), body: { ref, sha: parsed.data.headRevision } }
    : { method: 'DELETE' as const, url: buildGithubApiUrl([...path, 'heads', ...tip.branch.split('/')]) };
  let confirmed = false;
  const settled = await settleAtMostOnceProviderWrite({
    dispatch: async () => {
      const response = await sendGithubRestRequest(dependencies, request);
      if (response.ok && isGithubSuccessStatus(response.response.status)) {
        if (operation === 'delete') confirmed = response.response.status === 204;
        else try {
          const body: unknown = decodeGithubJsonResponse(response.response);
          confirmed = record(body) && body.ref === ref && record(body.object) && body.object.sha === parsed.data.headRevision;
        } catch { /* An unreadable acknowledgement is uncertain, never a second POST. */ }
      }
      return response;
    },
    mayHaveChanged: response => !response.ok || isGithubSuccessStatus(response.response.status) || isGithubWriteResponseAmbiguous(response.response),
    confirm: async () => confirmed ? { kind: 'applied' as const, observation: true } : { kind: 'uncertain' as const },
  });
  if (settled.kind === 'applied') return { kind: 'applied', effect: 'changed', entry: { id: current.facts.nodeId,
    branch: { name: tip.branch, exists: operation === 'restore' } } };
  if (settled.kind === 'settled') return { kind: 'failed', failure: settled.result.ok
    ? toTriageFailure(classifyGithubResponseFailure(settled.result.response, dependencies.now())) : settled.result.failure };
  return { kind: 'uncertain' };
}
export const restoreGithubPullRequestHeadBranchAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestHeadBranchRestoreResultV1> => changeBranch(input, context, 'restore');
export const deleteGithubPullRequestHeadBranchAction = (input: unknown, context: PluginInvocationContext): Promise<GithubPullRequestHeadBranchDeleteResultV1> => changeBranch(input, context, 'delete');
