import { DeploymentTargetRoleResultV1ProtocolSchema, PluginError, type DeploymentTargetPreparationBaseV1, type DeploymentTargetDeployInputV1,
  type DeploymentTargetRoleFailureV1, type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { observeBuild } from './builds.js';
import { failure, request, type DeploymentContext } from './deploymentHttp.js';
import type { PreparedPreview } from './preview.js';

export type PreviewDeployment = PreparedPreview & Readonly<{ accountId: string; workerTag: string; scriptName: string }>;
type Observation = Pick<DeploymentTargetDeployInputV1, 'providerDeploymentId'>;
type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;
export type UploadedPreview = Pick<PreviewDeployment, 'accountId' | 'scriptName' | 'previewId'>;
/** Only Connect's captured native identity selects Preview scope; never fall back to its parent script. */
export function uploadedPreviewSelection(input: Pick<DeploymentTargetPreparationBaseV1,
  'providerIdentity' | 'providerEnvironment' | 'preparedNative'>): UploadedPreview | null {
  if (input.providerEnvironment.kind !== 'preview' || !('scriptName' in input.providerEnvironment)) return null;
  if (!input.providerIdentity || !input.preparedNative?.previewId) {
    throw new PluginError({ code: 'deployment_content_unavailable', details: { phase: 'source' } });
  }
  return { accountId: input.providerIdentity.providerAccountId, scriptName: input.providerEnvironment.scriptName,
    previewId: input.preparedNative.previewId };
}
export function uploadedPreviewReference(deploymentId: string): string { return `preview-deployment:${deploymentId}`; }
export function uploadedPreviewDeployment(reference: string | undefined): string | null {
  return reference?.startsWith('preview-deployment:') && reference.length > 'preview-deployment:'.length
    ? reference.slice('preview-deployment:'.length) : null;
}
export function isUploadedPreviewReference(reference: string | undefined): boolean { return uploadedPreviewDeployment(reference) !== null; }

/** Uploaded native Preview deployments have their own identity, independent of Builds and production versions. */
export async function observeUploadedPreview(input: Observation, preview: UploadedPreview, context: DeploymentContext): Promise<Outcome> {
  const deploymentId = uploadedPreviewDeployment(input.providerDeploymentId);
  if (!input.providerDeploymentId || deploymentId === null) return failure('outcome_unknown', 'observe');
  const reply = await request(context, preview.accountId,
    `/workers/workers/${encodeURIComponent(preview.scriptName)}/previews/${encodeURIComponent(preview.previewId)}/deployments/${encodeURIComponent(deploymentId)}`, 'observe');
  if ('code' in reply) return reply;
  if (!isObject(reply.value) || reply.value.id !== deploymentId || !Array.isArray(reply.value.urls)) return failure('provider_response_invalid', 'observe');
  const projected = DeploymentTargetRoleResultV1ProtocolSchema.safeParse({ v: 1,
    state: reply.value.urls.length > 0 ? 'succeeded' : 'outcome_unknown', providerDeploymentId: input.providerDeploymentId,
    urls: reply.value.urls, observedAtMs: context.now() });
  return projected.success ? projected.data : failure('provider_response_invalid', 'observe');
}

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
    'send', ['write', 'POST'], { commit_hash: input.sourceIntent.sha, branch: preview.gitBranch });
  return 'code' in reply ? reply : observation(reply.value, preview, context, 'send');
}

/** Native cancel reports build_outcome directly; no read-back or write replay. */
export async function cancelPreview(input: Observation, preview: PreviewDeployment, context: DeploymentContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'cancel');
  const reply = await request(context, preview.accountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}/cancel`, 'cancel', ['write', 'PUT']);
  if ('code' in reply) return reply;
  return observation(reply.value, preview, context, 'cancel', input.providerDeploymentId);
}
