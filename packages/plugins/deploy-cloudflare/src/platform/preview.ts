import type { DeploymentTargetRepositoryAccessV1, DeploymentTargetRoleFailureV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { failure, request, type DeploymentContext } from './deploymentHttp.js';

export type PreviewSelection = Readonly<{ accountId: string; workerTag: string; scriptName: string; previewName: string;
  repository: DeploymentTargetRepositoryAccessV1['repository'] }>;
export type PreparedPreview = Readonly<{ previewId: string; previewName: string; gitBranch: string;
  repositoryAccess: DeploymentTargetRepositoryAccessV1 }>;

/** Both source methods consume the captured native Preview identity. */
export async function inspectPreviewIdentity(input: Pick<PreviewSelection, 'accountId' | 'scriptName' | 'previewName'>,
  context: DeploymentContext): Promise<Readonly<{ previewId: string; previewName: string }> | DeploymentTargetRoleFailureV1> {
  const native = await request(context, input.accountId,
    `/workers/workers/${encodeURIComponent(input.scriptName)}/previews/${encodeURIComponent(input.previewName)}`, 'link');
  if ('code' in native) return native;
  if (!isObject(native.value) || typeof native.value.id !== 'string' || !/^[0-9a-f]{32}$/.test(native.value.id)
    || native.value.name !== input.previewName) return failure('provider_response_invalid', 'link');
  return { previewId: native.value.id, previewName: input.previewName };
}

/** Connect / explicit Check again only. Native Preview GET accepts an encoded
 * name beneath the documented Worker name; Builds uses the distinct Worker tag.
 * https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
 * Official OpenAPI: workers_Preview / builds_PreviewId / builds_PreviewResponse.
 * No value-bearing Preview/Base configuration is projected into this result.
 */
export async function preparePreview(input: PreviewSelection, context: DeploymentContext): Promise<PreparedPreview | DeploymentTargetRoleFailureV1> {
  const native = await inspectPreviewIdentity(input, context);
  if ('code' in native) return native;
  const previewId = native.previewId;
  const builds = await request(context, input.accountId,
    `/builds/workers/${encodeURIComponent(input.workerTag)}/previews/${encodeURIComponent(previewId)}`, 'link');
  if ('code' in builds) return builds;
  if (!isObject(builds.value) || builds.value.preview_id !== previewId
    || typeof builds.value.branch !== 'string' || builds.value.branch.trim().length === 0) {
    return failure('provider_response_invalid', 'link');
  }
  const worker = await request(context, input.accountId, `/builds/workers/${encodeURIComponent(input.workerTag)}`, 'link');
  if ('code' in worker) return worker;
  if (!isObject(worker.value) || worker.value.script_tag !== input.workerTag) return failure('provider_response_invalid', 'link');
  const git = worker.value.git_repository;
  const ready = worker.value.previews_enabled === true && isObject(git) && git.provider_type === 'github'
    && typeof git.repo_id === 'string' && git.repo_id.length > 0
    && typeof git.provider_account_name === 'string' && typeof git.repo_name === 'string'
    && input.repository.kind === 'github' && input.repository.deployment === 'https://github.com'
    && `${git.provider_account_name}/${git.repo_name}`.toLowerCase() === input.repository.repository.toLowerCase();
  return { previewId, previewName: input.previewName, gitBranch: builds.value.branch,
    repositoryAccess: { status: ready ? 'ready' : 'needsGitAccess', repository: input.repository } };
}
