import { isPluginError, type DeploymentTargetDeployInputV1, type DeploymentTargetObserveInputV1,
  type DeploymentTargetProviderIdentityV1,
  type DeploymentTargetRepositoryAccessV1, type DeploymentTargetRoleFailureV1,
  type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { request, failure, type DeploymentContext } from './deploymentHttp.js';
import { observeBuild } from './builds.js';
import { workerBuildsRepositoryMatches } from './pagesSource.js';
import { type CloudflareRoleInput, type WorkerSelection as WorkerTargetSelection } from './targetSelection.js';

export const workersAddressAccessId = 'cloudflare-workers-address';
export type WorkerContext = DeploymentContext;
export type WorkerSelection = Readonly<{ accountId: string; workerTag: string; scriptName: string; triggerUuid: string;
  repository: DeploymentTargetRepositoryAccessV1['repository'] }>;
export type PreparedWorker = Readonly<{ providerIdentity: DeploymentTargetProviderIdentityV1;
  providerEnvironment: { kind: 'native'; selection: Extract<WorkerTargetSelection, { kind: 'script' }> };
  repositoryAccess: DeploymentTargetRepositoryAccessV1; triggerUuid: string }>;
type WorkerObservation = Pick<CloudflareRoleInput<DeploymentTargetObserveInputV1, WorkerTargetSelection>, 'providerIdentity' | 'providerEnvironment' | 'providerDeploymentId' | 'operation'>;
type Outcome = DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1;
type Phase = DeploymentTargetRoleFailureV1['phase'];
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }

/** The script catalog names each Worker and supplies its immutable native tag. */
export async function readWorkerScripts(accountId: string, context: WorkerContext) {
  const reply = await request(context, accountId, '/workers/scripts', 'link');
  if ('code' in reply) return reply;
  if (!Array.isArray(reply.value)) return failure('provider_response_invalid', 'link');
  const scripts: Array<{ scriptName: string; workerTag: string }> = [];
  for (const row of reply.value) {
    if (!isObject(row) || !text(row.id)) return failure('provider_response_invalid', 'link');
    // A row can omit its optional tag. Such a script cannot supply a link identity.
    if (text(row.tag)) scripts.push({ scriptName: row.id, workerTag: row.tag });
  }
  return scripts;
}

export async function resolveWorkerTag(accountId: string, scriptName: string, context: WorkerContext) {
  const scripts = await readWorkerScripts(accountId, context);
  if ('code' in scripts) return scripts;
  const selected = scripts.find(script => script.scriptName === scriptName);
  return selected?.workerTag ?? failure('deployment_unavailable', 'link');
}

/** Inspect verifies the name of a selected immutable Worker before any name-addressed operation. */
export async function verifyWorkerTag(accountId: string, scriptName: string, workerTag: string, context: WorkerContext) {
  const reply = await request(context, accountId, `/workers/workers/${encodeURIComponent(workerTag)}`, 'link');
  if ('code' in reply) return reply;
  if (!isObject(reply.value) || !text(reply.value.id) || !text(reply.value.name)) return failure('provider_response_invalid', 'link');
  return reply.value.id === workerTag && reply.value.name === scriptName ? workerTag : failure('deployment_unavailable', 'link');
}

/** Git and Upload preparation name the same selected provider Environment. */
export function workerEnvironmentKey(scriptName: string, previewName?: string): string {
  return previewName === undefined ? `script:${scriptName}` : `preview:${JSON.stringify([scriptName, previewName])}`;
}

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
    ready = trigger.deleted_on == null && workerBuildsRepositoryMatches(trigger.repo_connection, input.repository);
  }
  return { providerIdentity: { providerAccountId: input.accountId, providerResourceId: input.workerTag, providerEnvironment: workerEnvironmentKey(input.scriptName) },
    providerEnvironment: { kind: 'native', selection: { kind: 'script', scriptName: input.scriptName } }, triggerUuid: input.triggerUuid,
    repositoryAccess: { status: ready ? 'ready' : 'needsGitAccess', repository: input.repository } };
}

/** The first deployment is the latest actively serving traffic. Builds may run
 * arbitrary commands, so build success is not itself deployment success.
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
 * https://developers.cloudflare.com/api/resources/workers_builds/methods/get_builds_by_version/
 */
async function serving(input: WorkerObservation, buildId: string, context: WorkerContext): Promise<boolean> {
  const active = await servingWorkerVersions(input, context);
  if ('code' in active || active.length === 0) return false;
  // One native version per documented query. Map keys are unspecified: consume
  // associated values, without inventing a unique build→version relationship.
  for (const { versionId } of active) {
    if (await workerVersionHasBuild(input.providerIdentity.providerAccountId, versionId, buildId, context) !== true) return false;
  }
  return true;
}

/** The API map's keys are unspecified; a single-version query proves this association. */
export async function workerVersionHasBuild(accountId: string, versionId: string, buildId: string, context: WorkerContext)
  : Promise<boolean | DeploymentTargetRoleFailureV1> {
  const associated = await request(context, accountId,
    `/builds/builds?${new URLSearchParams({ version_ids: versionId })}`, 'observe');
  if ('code' in associated) return associated;
  if (!isObject(associated.value) || !isObject(associated.value.builds)) return failure('provider_response_invalid', 'observe');
  return Object.values(associated.value.builds).some(value => isObject(value) && value.build_uuid === buildId);
}

async function observation(value: unknown, input: WorkerObservation, context: WorkerContext, phase: Phase, expectedId?: string): Promise<Outcome> {
  const result = await observeBuild(value, context, phase, expectedId, buildId => serving(input, buildId, context));
  return 'state' in result && result.state === 'succeeded' ? withWorkerAddress(result, input, context) : result;
}

/** Verify the public address separately from native version activation.
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/
 * https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/
 */
export async function withWorkerAddress(result: DeploymentTargetRoleResultV1, input: WorkerObservation, context: WorkerContext): Promise<DeploymentTargetRoleResultV1> {
  if (input.providerEnvironment.selection.kind !== 'script') return result;
  try {
    const accountId = input.providerIdentity.providerAccountId;
    const scriptName = input.providerEnvironment.selection.scriptName;
    const route = await request(context, accountId, `/workers/scripts/${encodeURIComponent(scriptName)}/subdomain`, 'observe');
    // A failed address read must not turn proven activation into a failed deployment or claim no address exists.
    if ('code' in route || !isObject(route.value) || typeof route.value.enabled !== 'boolean') return result;
    if (!route.value.enabled) return { ...result, urls: [], builtInUrls: [] };
    const account = await request(context, accountId, '/workers/subdomain', 'observe');
    if ('code' in account || !isObject(account.value) || !text(account.value.subdomain)) return result;
    const url = `https://${scriptName}.${account.value.subdomain}.workers.dev`;
    // A route can be enabled before the deployed Worker serves its public hostname.
    const response = await context.http.request({ url, method: 'GET', redirect: 'manual', responseBody: 'discard' },
      { signal: context.signal });
    if (response.status >= 200 && response.status < 400) return { ...result, urls: [url], builtInUrls: [url] };
    if (response.status >= 400 && response.status < 600) {
      return { ...result, publicAddressFailure: { url, httpStatus: response.status } };
    }
    return result;
  } catch (error) {
    if (context.signal.aborted || isPluginError(error)) return result;
    throw error;
  }
}

/** One finite read; the existing operation/demand owner decides when to observe. */
export async function observeWorker(input: WorkerObservation, context: WorkerContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.selection.kind !== 'script') return failure('unsupported_action', 'admission');
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
    `/builds/triggers/${encodeURIComponent(worker.triggerUuid)}/builds`, 'send', ['write', 'POST'], { commit_hash: input.sourceIntent.sha });
  return 'code' in reply ? reply : observation(reply.value, worker, context, 'send');
}

/** Native cancel response reports build_outcome directly; no read-back or retry.
 * https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/cancel/
 */
export async function cancelWorker(input: WorkerObservation, context: WorkerContext): Promise<Outcome> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.selection.kind !== 'script') return failure('unsupported_action', 'admission');
  if (!input.providerDeploymentId) return failure('outcome_unknown', 'cancel');
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/builds/builds/${encodeURIComponent(input.providerDeploymentId)}/cancel`, 'cancel', ['write', 'PUT']);
  if ('code' in reply) return reply;
  return observation(reply.value, input, context, 'cancel', input.providerDeploymentId);
}


async function servingWorkerVersions(input: WorkerObservation, context: WorkerContext)
  : Promise<readonly Readonly<{ versionId: string; percentage: number }>[] | DeploymentTargetRoleFailureV1> {
  if (input.providerEnvironment.selection.kind !== 'script') return failure('unsupported_action', 'admission');
  const reply = await request(context, input.providerIdentity.providerAccountId,
    `/workers/scripts/${encodeURIComponent(input.providerEnvironment.selection.scriptName)}/deployments`, 'observe');
  if ('code' in reply) return reply;
  if (!isObject(reply.value) || !Array.isArray(reply.value.deployments)) return failure('provider_response_invalid', 'observe');
  const latest: unknown = reply.value.deployments[0];
  if (!isObject(latest) || !Array.isArray(latest.versions)) return failure('provider_response_invalid', 'observe');
  const active: { versionId: string; percentage: number }[] = [];
  for (const version of latest.versions) {
    if (!isObject(version) || !text(version.version_id) || typeof version.percentage !== 'number'
      || !Number.isFinite(version.percentage) || version.percentage < 0 || version.percentage > 100) {
      return failure('provider_response_invalid', 'observe');
    }
    if (version.percentage > 0) active.push({ versionId: version.version_id, percentage: version.percentage });
  }
  // Cloudflare owns total allocation, including valid decimal percentages.
  return active;
}

/** Workers Builds and uploaded Worker versions have independent native UUID
 * spaces. This tagged reference keeps their identity in the existing receipt
 * field and selects the correct native observer without another state store.
 */
function canonicalWorkerVersionId(versionId: string): string {
  // Legacy script PUT returns the compact UUID; deployments expose its hyphenated
  // form. Match pinned Wrangler's parseNonHyphenedUuid for new and retained receipts.
  return versionId.replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/i, '$1-$2-$3-$4-$5');
}
export function uploadedWorkerReference(versionId: string): string { return `version:${canonicalWorkerVersionId(versionId)}`; }
export function uploadedWorkerVersion(reference: string | undefined): string | null {
  return reference?.startsWith('version:') && reference.length > 'version:'.length ? canonicalWorkerVersionId(reference.slice('version:'.length)) : null;
}
export function isUploadedWorkerReference(reference: string | undefined): boolean { return uploadedWorkerVersion(reference) !== null; }

/** A finite serving read is driven by the existing operation / explicit Check
 * status owner, never an upload retry. Acceptance alone is not success.
 */
export async function observeUploadedWorker(input: WorkerObservation, context: WorkerContext): Promise<Outcome> {
  if (input.providerEnvironment.selection.kind !== 'script') return failure('unsupported_action', 'admission');
  const versionId = uploadedWorkerVersion(input.providerDeploymentId);
  if (!input.providerDeploymentId || versionId === null) return failure('outcome_unknown', 'observe');
  const versions = await servingWorkerVersions(input, context);
  if ('code' in versions) return versions;
  const allTraffic = input.operation === 'promote' || input.operation === 'rollback';
  const active = versions.some(version => version.versionId === versionId && (!allTraffic || version.percentage === 100));
  const result: DeploymentTargetRoleResultV1 = { v: 1, state: active ? 'succeeded' : 'outcome_unknown', providerDeploymentId: input.providerDeploymentId, observedAtMs: context.now() };
  return active ? withWorkerAddress(result, input, context) : result;
}
