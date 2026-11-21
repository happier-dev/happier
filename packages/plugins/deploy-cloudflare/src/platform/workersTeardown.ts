import { isPluginError, PluginError, settleDeploymentTargetResourceRemovalV1, type DeploymentTargetObserveInputV1, type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { request, type DeploymentContext } from './deploymentHttp.js';
import { type CloudflareRoleInput, type WorkerSelection } from './targetSelection.js';

type Selection = Pick<CloudflareRoleInput<DeploymentTargetObserveInputV1, WorkerSelection>, 'providerIdentity' | 'providerEnvironment' | 'preparedNative'>;

/** Native Worker IDs survive renames. A Preview has its own identity and never
 * selects the parent Worker or its shared routes/domains for removal.
 * https://developers.cloudflare.com/api/resources/workers/subresources/beta/subresources/workers/methods/delete/
 * GET uses the same resource path. Worker and Preview ID operands and ACKs:
 * cloudflare/api-schemas 8b1a451819bc546d410e41cca71a86bcc2779808,
 * openapi.json (checked 2026-11-15). Legacy scripts.tag is that immutable
 * Worker ID (also named "Worker script tag (worker ID)" by Spectrum's API).
 */
function resourcePath(input: Selection): string {
  const root = `/workers/workers/${encodeURIComponent(input.providerIdentity.providerResourceId)}`;
  if (input.providerEnvironment.selection.kind === 'script') return root;
  const previewId = input.preparedNative?.previewId;
  if (!previewId) throw new PluginError({ code: 'deployment_content_unavailable', details: { phase: 'teardown' } });
  return `${root}/previews/${encodeURIComponent(previewId)}`;
}

async function absentAfterRequest(input: Selection, context: DeploymentContext, path: string, operation: readonly ['read', 'GET'] | readonly ['write', 'DELETE']): Promise<boolean> {
  try {
    const reply = await request(context, input.providerIdentity.providerAccountId, path, 'teardown', operation);
    if ('code' in reply) throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase: 'teardown' },
      failureCause: projectActionFailureCauseV1(reply, 'deployment.cloudflare.teardown') });
    return false;
  } catch (error) {
    if (isPluginError(error) && error.code === 'deployment_unavailable' && error.data.failureCause?.httpStatus === 404) return true;
    throw error;
  }
}

/** Observation is read-only recovery; no retry or DELETE replay. The provider's
 * associated-resource deletion owns cleanup; no Account inventory is swept.
 */
export async function teardownWorker(input: Selection, context: DeploymentContext, observeOnly = false): Promise<DeploymentTargetRoleResultV1> {
  const path = resourcePath(input);
  return settleDeploymentTargetResourceRemovalV1({
    ...(observeOnly ? {} : { remove: () => absentAfterRequest(input, context, path, ['write', 'DELETE']) }),
    observeAbsent: () => absentAfterRequest(input, context, path, ['read', 'GET']),
    now: context.now,
  });
}
