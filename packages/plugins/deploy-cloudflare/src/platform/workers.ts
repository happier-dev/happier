import { type DeploymentTargetDeployInputV1, type DeploymentTargetObserveInputV1,
  type DeploymentTargetProviderIdentityV1, type DeploymentTargetProviderEnvironmentV1,
  type DeploymentTargetRepositoryAccessV1, type DeploymentTargetRoleFailureV1,
  type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { request, failure, type DeploymentContext } from './deploymentHttp.js';
import { observeBuild } from './builds.js';

export type WorkerContext = DeploymentContext;
export type WorkerSelection = Readonly<{ accountId: string; workerTag: string; scriptName: string; triggerUuid: string;
  repository: DeploymentTargetRepositoryAccessV1['repository'] }>;
export type PreparedWorker = Readonly<{ providerIdentity: DeploymentTargetProviderIdentityV1;
  providerEnvironment: Extract<DeploymentTargetProviderEnvironmentV1, { kind: 'script' }>;
  repositoryAccess: DeploymentTargetRepositoryAccessV1; triggerUuid: string }>;
type WorkerObservation = Pick<DeploymentTargetObserveInputV1, 'providerIdentity' | 'providerEnvironment' | 'providerDeploymentId'>;
type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;
type Phase = DeploymentTargetRoleFailureV1['phase'];
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** Connect / explicit Check again only. The selection carries the actual native
 * script tag and name from provider options, never a tag derived from its name.
 * https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/list/
 */
export async function prepareWorker(input: WorkerSelection, context: WorkerContext): Promise<PreparedWorker | DeploymentTargetRoleFailureV1> {
  const reply = await request(context, input.accountId, `/builds/workers/${encodeURIComponent(input.workerTag)}/triggers`, 'link');
  if ('code' in reply) return reply;
  if (!Array.isArray(reply.value)) return failure('provider_response_invalid', 'link');
  const trigger: unknown = reply.value.find((row: unknown) => isObject(row) && row.trigger_uuid === input.triggerUuid);
  let ready = false;
  if (trigger !== undefined) {
    if (!isObject(trigger) || trigger.external_script_id !== input.workerTag) return failure('provider_response_invalid', 'link');
    const repository = trigger.repo_connection;
    ready = (trigger.deleted_on === undefined || trigger.deleted_on === null) && isObject(repository)
      && (repository.deleted_on === undefined || repository.deleted_on === null)
      && repository.provider_type === 'github' && text(repository.repo_id)
      && text(repository.provider_account_name) && text(repository.repo_name)
      && input.repository.kind === 'github' && input.repository.deployment === 'https://github.com'
      && `${repository.provider_account_name}/${repository.repo_name}`.toLowerCase() === input.repository.repository.toLowerCase();
  }
  return { providerIdentity: { providerAccountId: input.accountId, providerResourceId: input.workerTag, providerEnvironment: `script:${input.scriptName}` },
    providerEnvironment: { kind: 'script', scriptName: input.scriptName }, triggerUuid: input.triggerUuid,
    repositoryAccess: { status: ready ? 'ready' : 'needsGitAccess', repository: input.repository } };
}

/** The first deployment is the latest actively serving traffic. Builds may run
 * arbitrary commands, so build success is not itself deployment success.
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
 * https://developers.cloudflare.com/api/resources/workers_builds/methods/get_builds_by_version/
 */
async function serving(input: WorkerObservation, buildId: string, context: WorkerContext): Promise<boolean> {
  if (input.providerEnvironment.kind !== 'script') return false;
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/workers/scripts/${encodeURIComponent(input.providerEnvironment.scriptName)}/deployments`, 'observe');
  // Unavailable serving evidence cannot turn an already successful build into
  // a failed workload. Canonical HTTP owner exceptions still propagate unchanged.
  if ('code' in reply) return false;
  if (!isObject(reply.value) || !Array.isArray(reply.value.deployments)) return false;
  const latest: unknown = reply.value.deployments[0];
  if (!isObject(latest) || !Array.isArray(latest.versions) || latest.versions.length === 0) return false;
  const active: string[] = [];
  for (const version of latest.versions) {
    if (!isObject(version) || !text(version.version_id) || typeof version.percentage !== 'number'
      || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100) return false;
    if (version.percentage > 0) active.push(version.version_id);
  }
  // Cloudflare owns total traffic allocation; do not re-enforce it with a
  // competing floating-point sum that rejects valid decimal percentages.
  if (active.length === 0) return false;
  // One native version per documented query. Map keys are unspecified: consume
  // associated values, without inventing a unique build→version relationship.
  for (const versionId of active) {
    const associated = await request(context, input.providerIdentity.providerAccountId,
      `/builds/builds?${new URLSearchParams({ version_ids: versionId })}`, 'observe');
    if ('code' in associated) return false;
    if (!isObject(associated.value) || !isObject(associated.value.builds)
      || !Object.values(associated.value.builds).some(value => isObject(value) && value.build_uuid === buildId)) return false;
  }
  return true;
}

async function observation(value: unknown, input: WorkerObservation, context: WorkerContext, phase: Phase, expectedId?: string): Promise<Outcome> {
  return observeBuild(value, context, phase, expectedId, buildId => serving(input, buildId, context));
}

/** One finite read; the existing operation/demand owner decides when to observe. */
export async function observeWorker(input: WorkerObservation, context: WorkerContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.kind !== 'script') return failure('unsupported_action', 'admission');
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'observe');
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}`, 'observe');
  return 'code' in reply ? reply : observation(reply.value, input, context, 'observe', input.providerDeploymentId);
}

/** Exact-SHA contract allows commit_hash without branch. Never re-probe Git or
 * repeat a mutation to recover an already retained native build identity.
 * https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/create_build/
 */
export async function deployWorker(input: Pick<DeploymentTargetDeployInputV1, 'sourceIntent' | 'providerDeploymentId'>,
  worker: PreparedWorker, context: WorkerContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerDeploymentId) return observeWorker({ ...worker, providerDeploymentId: input.providerDeploymentId }, context);
  if (input.sourceIntent.kind !== 'repository') return failure('unsupported_action', 'source');
  if (worker.repositoryAccess.status !== 'ready') return failure('needsGitAccess', 'source');
  const reply = await request(context, worker.providerIdentity.providerAccountId,
    `/builds/triggers/${encodeURIComponent(worker.triggerUuid)}/builds`, 'send', 'POST', { commit_hash: input.sourceIntent.sha });
  return 'code' in reply ? reply : observation(reply.value, worker, context, 'send');
}

/** Native cancel response reports build_outcome directly; no read-back or retry.
 * https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/cancel/
 */
export async function cancelWorker(input: WorkerObservation, context: WorkerContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.kind !== 'script') return failure('unsupported_action', 'admission');
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'cancel');
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}/cancel`, 'cancel', 'PUT');
  if ('code' in reply) return reply;
  return observation(reply.value, input, context, 'cancel', input.providerDeploymentId);
}
