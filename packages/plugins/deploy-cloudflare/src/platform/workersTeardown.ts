import { PluginError, settleDeploymentTargetResourceRemovalV1, type DeploymentTargetObserveInputV1, type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { requestTeardownResource, type DeploymentContext } from './deploymentHttp.js';
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

/** Observation is read-only recovery; no retry or DELETE replay. The provider's
 * associated-resource deletion owns cleanup; no Account inventory is swept.
 */
export async function teardownWorker(input: Selection, context: DeploymentContext, observeOnly = false): Promise<DeploymentTargetRoleResultV1> {
  const path = resourcePath(input);
  const accountId = input.providerIdentity.providerAccountId;
  return settleDeploymentTargetResourceRemovalV1({
    ...(observeOnly ? {} : { remove: async () => (await requestTeardownResource(context, accountId, path, ['write', 'DELETE'])).kind === 'absent' }),
    observeAbsent: async () => (await requestTeardownResource(context, accountId, path, ['read', 'GET'])).kind === 'absent',
    now: context.now,
  });
}
