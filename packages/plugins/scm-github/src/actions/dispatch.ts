import type { ForgeCiActionInputByOperationV1, ForgeCiMutationResultV1, ForgeCiTriggerValuesV1 } from '@happier-dev/triage-protocol/ci/v1';
import { decodeGithubJsonResponse, type GithubApiClientV1 } from '../observations/githubApiClient.js';
import { classifyGithubResponseFailure, classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { readGithubPositiveDecimal } from '../observations/githubProviderContracts.js';
import { githubRecord, mapGithubWorkflow } from './mapping.js';
import { GithubCiReadError, githubCiRepositoryUrl, requestGithubCiJson } from './reads.js';
import { readGithubWorkflowDefinitionV1 } from './workflowInputs.js';
import { GithubWorkflowDefinitionError, type GithubWorkflowDefinitionV1 } from './workflowDefinition.js';

export function validateGithubWorkflowInputsV1(definition: GithubWorkflowDefinitionV1, values: ForgeCiTriggerValuesV1): void {
  if (!definition.dispatchable) throw new GithubWorkflowDefinitionError('This ref does not declare workflow_dispatch.');
  const names = new Set(definition.inputs.map(field => field.name));
  if (Object.keys(values).some(name => !names.has(name))) throw new GithubWorkflowDefinitionError('An input is not declared at the selected ref.');
  for (const field of definition.inputs) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : field.default;
    if (value === undefined) { if (field.required) throw new GithubWorkflowDefinitionError(`Input ${field.name} is required.`); continue; }
    if (field.type === 'boolean' ? typeof value !== 'boolean' : field.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value)
      : typeof value !== 'string' || (field.type === 'choice' && !field.options?.includes(value))) throw new GithubWorkflowDefinitionError(`Input ${field.name} is invalid.`);
  }
}
export async function readGithubTrigger(client: GithubApiClientV1, input: ForgeCiActionInputByOperationV1['readTrigger']) {
  const metadata = await requestGithubCiJson(client, githubCiRepositoryUrl(input.repository, 'actions', 'workflows', readGithubPositiveDecimal(input.workflowId, 'workflow ID')));
  if (metadata.kind !== 'value') throw new RangeError('Workflow metadata is unavailable');
  const workflow = mapGithubWorkflow(metadata.value);
  if (workflow.id !== input.workflowId || workflow.path === undefined) throw new RangeError('Workflow identity mismatch');
  const { revision, definition } = await readGithubWorkflowDefinitionV1(client, { repository: input.repository, workflowPath: workflow.path, ref: input.ref });
  // The immutable SHA is the definition validator. Mutable refs always resolve
  // freshly; metadata ETags alone cannot prove selected-ref dispatchability.
  if (input.validator === revision) return { kind: 'notModified', validator: revision };
  return { kind: 'value', validator: revision, value: { workflowId: workflow.id, ref: input.ref, revision, path: workflow.path,
    dispatchable: definition.dispatchable, inputs: definition.inputs, triggers: definition.triggers, jobs: definition.jobs } };
}
export async function dispatchGithubWorkflow(client: GithubApiClientV1, input: ForgeCiActionInputByOperationV1['dispatchWorkflow']): Promise<ForgeCiMutationResultV1> {
  let dispatched = false;
  const affected = { repository: input.repository, workflowId: input.workflowId, ref: input.ref };
  try {
    const metadata = await requestGithubCiJson(client, githubCiRepositoryUrl(input.repository, 'actions', 'workflows', readGithubPositiveDecimal(input.workflowId, 'workflow ID')));
    if (metadata.kind !== 'value') throw new RangeError('Workflow metadata is unavailable');
    const workflow = mapGithubWorkflow(metadata.value);
    if (workflow.id !== input.workflowId || workflow.path === undefined || workflow.nativeState !== 'active') throw new RangeError('The selected workflow is not enabled');
    const selected = await readGithubWorkflowDefinitionV1(client, { repository: input.repository, workflowPath: workflow.path, ref: input.ref });
    validateGithubWorkflowInputsV1(selected.definition, input.inputs);
    const url = githubCiRepositoryUrl(input.repository, 'actions', 'workflows', input.workflowId, 'dispatches');
    // Keep typed values through form/admission. GitHub's native dispatch boundary
    // uses string inputs (as does gh workflow run), including false and zero.
    const inputs = Object.fromEntries(Object.entries(input.inputs).map(([name, value]) => [name, String(value)]));
    dispatched = true;
    const response = await client.request({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ ref: input.ref, inputs })) });
    if (response.status !== 200) {
      if (response.status >= 500 || (response.status >= 200 && response.status < 300)) return { kind: 'outcome_unknown', affected };
      return { kind: 'rejected', failure: classifyGithubResponseFailure(response, Date.now()) };
    }
    const receipt = githubRecord(decodeGithubJsonResponse(response));
    const runId = readGithubPositiveDecimal(receipt.workflow_run_id, 'dispatched run ID');
    const runUrl = githubCiRepositoryUrl(input.repository, 'actions', 'runs', runId);
    const htmlUrl = new URL(`https://github.com/${input.repository.repository}/actions/runs/${runId}`).toString();
    const matches = (value: unknown, expected: string) => {
      if (typeof value !== 'string') return false;
      try {
        const actual = new URL(value);
        const target = new URL(expected);
        return actual.origin === target.origin && !actual.username && !actual.password && !actual.search && !actual.hash
          && actual.pathname.toLowerCase() === target.pathname.toLowerCase();
      } catch { return false; }
    };
    if (!matches(receipt.run_url, runUrl) || !matches(receipt.html_url, htmlUrl)) return { kind: 'outcome_unknown', affected };
    return { kind: 'confirmed', affected: { ...affected, run: { v: 1, repository: input.repository, runId } }, receipt: { id: runId, webUrl: String(receipt.html_url) } };
  } catch (error) {
    if (dispatched) return { kind: 'outcome_unknown', affected, failure: { class: 'unknown', code: 'github_dispatch_receipt_unknown' } };
    return { kind: 'rejected', failure: error instanceof GithubCiReadError ? error.failure : error instanceof GithubWorkflowDefinitionError || error instanceof RangeError
      ? { class: 'unsupportedContract', code: error instanceof GithubWorkflowDefinitionError ? error.code : 'github_ci_target_invalid' } : classifyGithubTransportFailure(error) };
  }
}
