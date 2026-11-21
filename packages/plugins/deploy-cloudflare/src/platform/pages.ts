import { DeploymentTargetRoleResultV1ProtocolSchema, type DeploymentTargetObserveInputV1,
  type DeploymentTargetRoleResultV1, type DeploymentTargetRoleFailureV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { failure, request, type DeploymentContext } from './deploymentHttp.js';
import type { CloudflareRoleInput, PagesSelection } from './targetSelection.js';

type PagesObservation = Pick<CloudflareRoleInput<DeploymentTargetObserveInputV1, PagesSelection>,
  'providerIdentity' | 'providerEnvironment' | 'preparedNative' | 'providerDeploymentId'>;

/** A finite retained-ID read. No native cancel, upload replay or project-config projection.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/get/
 */
export async function observePagesDeployment(input: PagesObservation, context: DeploymentContext): Promise<DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1> {
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'observe');
  if (!input.preparedNative) return failure('deployment_content_unavailable', 'observe');
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}/deployments/${encodeURIComponent(input.providerDeploymentId)}`, 'observe');
  if ('code' in reply) return reply;
  return pagesDeploymentResult(reply.value, input, context, 'observe');
}

export function pagesDeploymentResult(value: unknown, input: PagesObservation, context: DeploymentContext,
  phase: DeploymentTargetRoleFailureV1['phase']): DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1 {
  const environment = input.providerEnvironment.selection;
  if (!isObject(value) || value.id !== input.providerDeploymentId || value.environment !== environment.kind
    || !isObject(value.latest_stage)) return failure('provider_response_invalid', phase);
  if (environment.kind === 'preview' && 'gitBranch' in environment && environment.gitBranch
    && (!isObject(value.deployment_trigger) || !isObject(value.deployment_trigger.metadata)
      || value.deployment_trigger.metadata.branch !== environment.gitBranch)) return failure('provider_response_invalid', phase);
  const stage = value.latest_stage;
  let state: DeploymentTargetRoleResultV1['state'];
  switch (value.is_skipped === true ? 'skipped' : stage.status) {
    case 'failure': state = 'failed'; break;
    case 'canceled': state = 'cancelled'; break;
    case 'skipped': state = 'outcome_unknown'; break;
    case 'success': case 'active': case 'idle':
      switch (stage.name) {
        case 'queued': state = 'queued'; break;
        case 'initialize': case 'clone_repo': case 'build': state = 'running'; break;
        case 'deploy': state = stage.status === 'success' ? 'succeeded' : 'running'; break;
        default: state = 'outcome_unknown';
      }
      break;
    default: state = 'outcome_unknown';
  }
  // The canonical role-result parser is also the public URL boundary; provider
  // config/secret fields never enter the projected result.
  const metadata = isObject(value.deployment_trigger) && isObject(value.deployment_trigger.metadata)
    ? value.deployment_trigger.metadata : undefined;
  const result = DeploymentTargetRoleResultV1ProtocolSchema.safeParse({ v: 1, state,
    providerDeploymentId: input.providerDeploymentId, observedAtMs: context.now(),
    ...(typeof metadata?.commit_hash === 'string' && metadata.commit_hash ? { builtSha: metadata.commit_hash } : {}),
    ...(typeof value.url === 'string' ? { urls: [value.url] } : {}) });
  return result.success ? result.data : failure('provider_response_invalid', phase);
}
