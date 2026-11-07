import type { ForgeCiActionInputByOperationV1, ForgeCiMutationResultV1 } from '@happier-dev/triage-protocol/ci/v1';
import { sameScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import type { GithubApiClientV1 } from '../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { githubRunSelection, mapGithubCiState, mapGithubRun, mapGithubWorkflow } from './mapping.js';
import { GithubCiReadError, githubCiRepositoryUrl, readExactGithubRun, readSelectedGithubJob, requestGithubCiJson } from './reads.js';

export type GithubCiControlOperation = 'enableWorkflow' | 'disableWorkflow' | 'rerunAll' | 'rerunFailed' | 'rerunJob' | 'cancelRun' | 'forceCancelRun' | 'approveForkRun';

/** Fresh exact provider admission, followed by one write. A receipt is never terminal execution. */
export async function mutateGithubCi<K extends GithubCiControlOperation>(operation: K, input: ForgeCiActionInputByOperationV1[K], client: GithubApiClientV1): Promise<ForgeCiMutationResultV1> {
  let dispatched = false;
  let affected: Extract<ForgeCiMutationResultV1, { kind: 'accepted' }>['affected'] = { repository: input.repository };
  try {
    let url: string;
    let method: 'PUT' | 'POST' = 'POST';
    let expectedStatus: number;
    let body: Uint8Array | undefined;
    if (operation === 'enableWorkflow' || operation === 'disableWorkflow') {
      const operands = input as ForgeCiActionInputByOperationV1['enableWorkflow'];
      const response = await requestGithubCiJson(client, githubCiRepositoryUrl(input.repository, 'actions', 'workflows', operands.workflowId));
      if (response.kind !== 'value' || mapGithubWorkflow(response.value).id !== operands.workflowId) throw new RangeError('Workflow identity mismatch');
      affected = { repository: input.repository, workflowId: operands.workflowId };
      url = githubCiRepositoryUrl(input.repository, 'actions', 'workflows', operands.workflowId, operation === 'enableWorkflow' ? 'enable' : 'disable');
      method = 'PUT'; expectedStatus = 204;
    } else {
      const operands = input as ForgeCiActionInputByOperationV1['rerunJob'];
      const raw = await readExactGithubRun(client, input.repository, operands.runId);
      if (operands.attempt !== undefined && String(raw.run_attempt) !== operands.attempt) throw new RangeError('The selected attempt is stale');
      const selection = githubRunSelection(input.repository, operands.runId, String(raw.run_attempt));
      const run = selection.kind === 'run' ? selection.run : selection.attempt.run;
      affected = { repository: input.repository, run, selection };
      const state = mapGithubCiState(raw);
      const rerun = operation === 'rerunAll' || operation === 'rerunFailed' || operation === 'rerunJob';
      if (rerun && state.phase !== 'completed') throw new RangeError('The workflow run has not completed');
      if (operation === 'rerunFailed' && state.outcomeBucket !== 'failed') throw new RangeError('The workflow run has no failed outcome');
      if ((operation === 'cancelRun' || operation === 'forceCancelRun') && (state.phase === 'completed' || state.phase === 'unknown')) throw new RangeError('The workflow run is not cancellable');
      if (operation === 'approveForkRun') {
        const run = mapGithubRun(raw, input.repository);
        if (run.forkApproval?.required !== true || run.forkApproval.sourceRepository === undefined
          || run.forkApproval.contributor === undefined || run.headSha === undefined || !run.headSha) throw new RangeError('The run is not awaiting fork approval');
        const reviewed = input as ForgeCiActionInputByOperationV1['approveForkRun'];
        if (reviewed.headSha !== run.headSha || reviewed.contributor !== run.forkApproval.contributor
          || !sameScmHostingRepositoryIdentity(reviewed.sourceRepository, run.forkApproval.sourceRepository)) {
          throw new RangeError('The reviewed fork provenance changed');
        }
      }
      if (operation === 'rerunJob') {
        // The native job lookup is read-only. Effects require membership in the
        // exact selected attempt and SHA, proven by its authoritative jobs page.
        const job = await readSelectedGithubJob(client, { ...operands, attempt: String(raw.run_attempt) }, raw);
        if (job.state.phase !== 'completed') throw new RangeError('The job has not completed');
        affected = { ...affected, jobId: operands.jobId };
        url = githubCiRepositoryUrl(input.repository, 'actions', 'jobs', operands.jobId, 'rerun');
        expectedStatus = 201;
      } else {
        const suffix = { rerunAll: 'rerun', rerunFailed: 'rerun-failed-jobs', cancelRun: 'cancel', forceCancelRun: 'force-cancel', approveForkRun: 'approve' } as const;
        url = githubCiRepositoryUrl(input.repository, 'actions', 'runs', operands.runId, suffix[operation as keyof typeof suffix]);
        expectedStatus = operation === 'cancelRun' || operation === 'forceCancelRun' ? 202 : 201;
      }
      if (rerun && operands.enableDebugLogging !== undefined) body = new TextEncoder().encode(JSON.stringify({ enable_debug_logging: operands.enableDebugLogging }));
    }
    dispatched = true;
    const response = await client.request({ url, method, ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }) });
    if (response.status === expectedStatus) return { kind: 'accepted', affected };
    if (response.status >= 500 || (response.status >= 200 && response.status < 300)) return { kind: 'outcome_unknown', affected };
    return { kind: 'rejected', failure: classifyGithubResponseFailure(response, Date.now()) };
  } catch (error) {
    if (dispatched) return { kind: 'outcome_unknown', affected, failure: classifyGithubTransportFailure(error) };
    return { kind: 'rejected', failure: error instanceof GithubCiReadError ? error.failure : error instanceof RangeError
      ? { class: 'unsupportedContract', code: 'github_ci_target_invalid' } : classifyGithubTransportFailure(error) };
  }
}
