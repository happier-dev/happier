import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { PluginError, isPluginError, type DeploymentTargetRoleFailureV1, type DeploymentTargetObserveInputV1, type DeploymentTargetRollbackInputV1,
  type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { createVercelDeployment, observeVercelDeployment, requestVercelDeployment, sendVercelDeploymentMutation, vercelEndpoint, vercelRequest,
  type VercelPlatformContext } from './operations.js';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { projectVercelDeploymentAddresses } from './addresses.js';

type Operation = 'promote' | 'rollback';
type Selection = Pick<DeploymentTargetObserveInputV1, 'providerIdentity' | 'providerDeploymentId'>;
const fail = (code: DeploymentTargetRoleFailureV1['code'], phase: DeploymentTargetRoleFailureV1['phase'] = 'observe',
  cause?: Readonly<{ error: unknown }>): never => {
  const error = new PluginError({ code, retryable: false, details: { phase },
    ...(cause || code === 'deployment_unavailable'
      ? { failureCause: projectActionFailureCauseV1(cause ? cause.error : { code }, 'deployment.vercel.traffic') } : {}) });
  throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(error, { phase: 'deployment.vercel.traffic', causeKind: 'not_found' }) : error;
};
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

async function readTrafficResponse(read: () => Promise<HttpResponse>, context: VercelPlatformContext, phase: 'observe' | 'send') {
  let response: HttpResponse;
  try { response = await read(); }
  catch (error) {
    context.signal.throwIfAborted();
    if (isPluginError(error)) throw error;
    return fail('provider_request_failed', phase, { error });
  }
  if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403 ? 'deployment_access_denied'
    : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed', phase,
    { error: { name: 'Error', status: response.status } });
  return response;
}

/** Production traffic settles from the alias job or the project's current production target.
 * openapi.vercel.sh requestPromote (v10), requestRollback (v1), getProject (v9), inspected 2026-11-10.
 * An exact deployment read can confirm alias assignment for the current Production rebuild.
 */
export async function observeVercelTraffic(input: Selection, operation: Operation, context: VercelPlatformContext): Promise<DeploymentTargetRoleResultV1> {
  if (!input.providerDeploymentId) return fail('outcome_unknown');
  const url = vercelEndpoint(`/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}`, input.providerIdentity.providerAccountId);
  const response = await readTrafficResponse(() => vercelRequest(context, url, 'GET'), context, 'observe');
  let project: unknown;
  try { project = JSON.parse(new TextDecoder().decode(response.body)); } catch { return fail('provider_response_invalid'); }
  if (!object(project) || project.id !== input.providerIdentity.providerResourceId || project.accountId !== input.providerIdentity.providerAccountId) return fail('provider_response_invalid');
  const job = project.lastAliasRequest;
  let state: DeploymentTargetRoleResultV1['state'] = 'outcome_unknown';
  if (object(job) && job.type === operation && job.toDeploymentId === input.providerDeploymentId) {
    switch (job.jobStatus) {
      case 'pending': state = 'queued'; break;
      case 'in-progress': state = 'running'; break;
      case 'succeeded': state = 'succeeded'; break;
      case 'failed': state = 'failed'; break;
    }
  }
  // Vercel can clear lastAliasRequest once the job completes (live, 2026-11-15). The project's current
  // production target, with its aliases assigned and no alias error, is then the settled traffic fact.
  const production = object(project.targets) ? project.targets.production : undefined;
  const currentProduction = object(production) && production.id === input.providerDeploymentId ? production : undefined;
  if (state === 'outcome_unknown' && currentProduction
    && (typeof currentProduction.aliasAssigned === 'number' || currentProduction.aliasAssigned === true)
    && currentProduction.aliasError == null) state = 'succeeded';
  if (state === 'outcome_unknown' && operation === 'promote') {
    const deployment = await observeVercelDeployment(input, context, { promotion: true });
    if ('code' in deployment) return { v: 1, state, providerDeploymentId: input.providerDeploymentId, observedAtMs: context.now(),
      failureCause: projectActionFailureCauseV1(deployment, 'deployment.vercel.traffic') };
    if (deployment.state !== 'outcome_unknown'
      && (deployment.state !== 'succeeded' || (currentProduction && currentProduction.aliasError == null))) return deployment;
  }
  return { v: 1, state, providerDeploymentId: input.providerDeploymentId, observedAtMs: context.now(),
    ...(state === 'succeeded' && currentProduction ? projectVercelDeploymentAddresses(currentProduction, true) : {}) };
}

export async function changeVercelTraffic(input: DeploymentTargetRollbackInputV1, operation: Operation, context: VercelPlatformContext)
  : Promise<DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.kind !== 'production') return fail('unsupported_action', 'admission');
  if (input.providerDeploymentId) return observeVercelTraffic(input, operation, context);
  const providerDeploymentId = input.priorDeployment.providerDeploymentId;
  if (operation === 'promote') {
    const response = await readTrafficResponse(() => requestVercelDeployment(input.providerIdentity, providerDeploymentId, context), context, 'send');
    let source: unknown;
    try { source = JSON.parse(new TextDecoder().decode(response.body)); } catch { return fail('provider_response_invalid', 'send'); }
    if (!object(source) || source.id !== providerDeploymentId || source.projectId !== input.providerIdentity.providerResourceId) {
      return fail('provider_response_invalid', 'send');
    }
    // Vercel's CLI uses v13 deployment creation for Preview and v10 alias promotion for Production.
    if (source.target !== 'production') {
      if (typeof source.name !== 'string' || source.name.trim().length === 0) return fail('provider_response_invalid', 'send');
      const deployment = await createVercelDeployment({ providerIdentity: input.providerIdentity,
        providerEnvironment: input.providerEnvironment, projectName: source.name },
        { deploymentId: providerDeploymentId, meta: { action: 'promote' } }, context);
      if ('code' in deployment) return deployment;
      // Persist the returned native id even when the build is already READY. Traffic still needs observation.
      return deployment.state === 'succeeded' ? { ...deployment, state: 'running' } : deployment;
    }
  }
  const response = await sendVercelDeploymentMutation(context, vercelEndpoint(`/v${operation === 'promote' ? '10' : '1'}/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/${operation}/${encodeURIComponent(providerDeploymentId)}`,
    input.providerIdentity.providerAccountId));
  if ('code' in response) return response;
  if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403 ? 'deployment_access_denied'
    : response.status === 404 ? 'deployment_unavailable' : response.status === 409 ? 'deployment_conflict'
      : 'provider_request_failed', 'send', { error: { name: 'Error', status: response.status } });
  // The write was acknowledged. A failed following read must retain the exact native id for recovery.
  try { return await observeVercelTraffic({ ...input, providerDeploymentId }, operation, context); }
  catch (error) {
    return { v: 1, state: 'outcome_unknown', providerDeploymentId, observedAtMs: context.now(),
      failureCause: projectActionFailureCauseV1(error, 'deployment.vercel.traffic') };
  }
}
