import { DeploymentTargetRoleResultV1ProtocolSchema, type DeploymentTargetDeployInputV1,
  type DeploymentTargetRoleFailureV1, type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { observeBuild } from './builds.js';
import { failure, request, type DeploymentContext } from './deploymentHttp.js';
import type { PreparedPreview } from './preview.js';

export type PreviewDeployment = PreparedPreview & Readonly<{ accountId: string; workerTag: string; scriptName: string }>;
type Observation = Pick<DeploymentTargetDeployInputV1, 'providerDeploymentId'>;
type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;

/** Native Preview deployment URLs identify an immutable artifact, unlike the
 * stable Preview alias. Build success alone does not prove code was deployed.
 * https://developers.cloudflare.com/workers/previews/#urls
 */
async function serving(build: Readonly<Record<string, unknown>>, preview: PreviewDeployment, context: DeploymentContext): Promise<string | undefined> {
  if (typeof build.preview_url !== 'string' || build.preview_url.length === 0) return undefined;
  const reply = await request(context, preview.accountId,
    `/workers/workers/${encodeURIComponent(preview.scriptName)}/previews/${encodeURIComponent(preview.previewId)}/deployments/latest`, 'observe');
  return !('code' in reply) && isObject(reply.value) && typeof reply.value.id === 'string'
    && Array.isArray(reply.value.urls) && reply.value.urls.includes(build.preview_url) ? build.preview_url : undefined;
}

async function observation(value: unknown, preview: PreviewDeployment, context: DeploymentContext,
  phase: DeploymentTargetRoleFailureV1['phase'], expectedId?: string): Promise<Outcome> {
  let url: string | undefined;
  const result = await observeBuild(value, context, phase, expectedId, async (_buildId, build) => {
    url = await serving(build, preview, context);
    return url !== undefined;
  });
  if ('code' in result || url === undefined) return result;
  // Reuse the canonical public URL boundary; never publish raw provider URLs.
  const projected = DeploymentTargetRoleResultV1ProtocolSchema.safeParse({ ...result, urls: [url] });
  return projected.success ? projected.data : failure('provider_response_invalid', phase);
}

/** One finite read; retained build identity is recovered without another write. */
export async function observePreview(input: Observation, preview: PreviewDeployment, context: DeploymentContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'observe');
  const reply = await request(context, preview.accountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}`, 'observe');
  return 'code' in reply ? reply : observation(reply.value, preview, context, 'observe', input.providerDeploymentId);
}

/** Native Builds Preview scope is the parent Worker tag and captured Preview
 * tag. Branch is independently observed at Connect, never derived from name.
 * https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
 */
export async function deployPreview(input: Pick<DeploymentTargetDeployInputV1, 'sourceIntent' | 'providerDeploymentId'>,
  preview: PreviewDeployment, context: DeploymentContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerDeploymentId) return observePreview(input, preview, context);
  if (input.sourceIntent.kind !== 'repository') return failure('unsupported_action', 'source');
  if (preview.repositoryAccess.status !== 'ready') return failure('needsGitAccess', 'source');
  const reply = await request(context, preview.accountId,
    `/builds/workers/${encodeURIComponent(preview.workerTag)}/previews/${encodeURIComponent(preview.previewId)}/builds`,
    'send', 'POST', { commit_hash: input.sourceIntent.sha, branch: preview.gitBranch });
  return 'code' in reply ? reply : observation(reply.value, preview, context, 'send');
}

/** Native cancel reports build_outcome directly; no read-back or write replay. */
export async function cancelPreview(input: Observation, preview: PreviewDeployment, context: DeploymentContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'cancel');
  const reply = await request(context, preview.accountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}/cancel`, 'cancel', 'PUT');
  if ('code' in reply) return reply;
  return observation(reply.value, preview, context, 'cancel', input.providerDeploymentId);
}
