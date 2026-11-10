import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  type DeploymentTargetRollbackInputV1, type DeploymentTargetRoleResultV1, type DeploymentTargetRoleFailureV1, type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request, failure, type DeploymentContext } from './deploymentHttp.js';
import { uploadedWorkerReference, uploadedWorkerVersion, workerVersionHasBuild } from './workers.js';
import { isUploadedPreviewReference } from './previewDeploy.js';
import { workersCommon, workersIo, workersResult } from './workersActions.js';

type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;

/** A Git receipt names a Build, not a version. Resolve only a unique deployable version of that exact script.
 * Versions deployable=true ignores pagination; Builds' map keys are unspecified, so query each version separately.
 * Official Cloudflare versions.list, workers_builds.get_builds_by_version, deployments.create; inspected 2026-11-10.
 */
async function changeTraffic(input: DeploymentTargetRollbackInputV1, context: DeploymentContext): Promise<Outcome> {
  if (input.providerEnvironment.kind !== 'script') return failure('unsupported_action', 'admission');
  const accountId = input.providerIdentity.providerAccountId;
  const scriptRoot = `/workers/scripts/${encodeURIComponent(input.providerEnvironment.scriptName)}`;
  const priorId = input.priorDeployment.providerDeploymentId;
  if (isUploadedPreviewReference(priorId)) return failure('unsupported_action', 'admission');
  let versionId = uploadedWorkerVersion(priorId);
  if (!versionId) {
    const reply = await request(context, accountId, `${scriptRoot}/versions?deployable=true`, 'observe');
    if ('code' in reply) return reply;
    if (!isObject(reply.value) || !Array.isArray(reply.value.items)) return failure('provider_response_invalid', 'observe');
    for (const version of reply.value.items) {
      if (!isObject(version) || typeof version.id !== 'string' || !version.id) return failure('provider_response_invalid', 'observe');
      const matches = await workerVersionHasBuild(accountId, version.id, priorId, context);
      if (typeof matches !== 'boolean') return matches;
      if (matches) {
        if (versionId && versionId !== version.id) return failure('deployment_conflict', 'admission');
        versionId = version.id;
      }
    }
    if (!versionId) return failure('deployment_unavailable', 'admission');
  }
  const providerDeploymentId = uploadedWorkerReference(versionId);
  // Do not force past Cloudflare's changed-secret/binding refusal.
  const reply = await request(context, accountId, `${scriptRoot}/deployments`, 'send', 'POST',
    { strategy: 'percentage', versions: [{ version_id: versionId, percentage: 100 }] });
  if ('code' in reply) return reply;
  const value = reply.value;
  const confirmed = isObject(value) && typeof value.id === 'string' && value.id.length > 0 && value.strategy === 'percentage'
    && Array.isArray(value.versions) && value.versions.length === 1 && isObject(value.versions[0])
    && value.versions[0].version_id === versionId && value.versions[0].percentage === 100;
  return { v: 1, state: confirmed ? 'succeeded' : 'outcome_unknown', providerDeploymentId, observedAtMs: context.now() };
}

export const workerTrafficActions = {
  'workers-promote': { ...workersCommon, title: 'Promote the selected Cloudflare Worker version', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Send all traffic to this Cloudflare Worker version?' }, inputSchema: inputs.promote.jsonSchema, resultSchema: output.jsonSchema,
    run: async (raw: JsonValue, context: PluginAccountActionContext) => workersResult(await changeTraffic(raw as unknown as DeploymentTargetRollbackInputV1, workersIo(context))) },
  'workers-rollback': { ...workersCommon, title: 'Restore the selected Cloudflare Worker version', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Restore all traffic to this Cloudflare Worker version?' }, inputSchema: inputs.rollback.jsonSchema, resultSchema: output.jsonSchema,
    run: async (raw: JsonValue, context: PluginAccountActionContext) => workersResult(await changeTraffic(raw as unknown as DeploymentTargetRollbackInputV1, workersIo(context))) },
} as const;
