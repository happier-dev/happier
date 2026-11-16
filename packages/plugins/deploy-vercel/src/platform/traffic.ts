import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { PluginError, isPluginError, type DeploymentTargetRoleFailureV1, type DeploymentTargetObserveInputV1, type DeploymentTargetRollbackInputV1,
  type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { vercelEndpoint, vercelRequest, type VercelPlatformContext } from './operations.js';

type Operation = 'promote' | 'rollback';
type Selection = Pick<DeploymentTargetObserveInputV1, 'providerIdentity' | 'providerDeploymentId'>;
const fail = (code: DeploymentTargetRoleFailureV1['code'], phase: DeploymentTargetRoleFailureV1['phase'] = 'observe'): never => {
  const error = new PluginError({ code, retryable: false, details: { phase },
    ...(code === 'deployment_unavailable' ? { failureCause: projectActionFailureCauseV1({ code }, 'deployment.vercel.traffic') } : {}) });
  throw code === 'deployment_unavailable' ? withActionFailureDiagnostic(error, { phase: 'deployment.vercel.traffic', causeKind: 'not_found' }) : error;
};
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** Vercel acknowledges the alias job before it settles. Observe that job, never the old build's READY state.
 * openapi.vercel.sh requestPromote (v10), requestRollback (v1), getProject (v9), inspected 2026-11-10.
 * A superseding or missing alias job is unknown unless production already serves the deployment;
 * existing receipt recovery owns the next user decision.
 */
export async function observeVercelTraffic(input: Selection, operation: Operation, context: VercelPlatformContext): Promise<DeploymentTargetRoleResultV1> {
  if (!input.providerDeploymentId) return fail('outcome_unknown');
  let response;
  try { response = await vercelRequest(context, vercelEndpoint(`/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}`,
    input.providerIdentity.providerAccountId), 'GET'); }
  catch (error) { context.signal.throwIfAborted(); if (isPluginError(error)) throw error; return fail('provider_request_failed'); }
  if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403 ? 'deployment_access_denied'
    : response.status === 404 ? 'deployment_unavailable' : 'provider_request_failed');
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
  if (state === 'outcome_unknown' && object(production) && production.id === input.providerDeploymentId
    && (typeof production.aliasAssigned === 'number' || production.aliasAssigned === true) && production.aliasError == null) state = 'succeeded';
  return { v: 1, state, providerDeploymentId: input.providerDeploymentId, observedAtMs: context.now() };
}

export async function changeVercelTraffic(input: DeploymentTargetRollbackInputV1, operation: Operation, context: VercelPlatformContext): Promise<DeploymentTargetRoleResultV1> {
  context.signal.throwIfAborted();
  if (input.providerEnvironment.kind !== 'production') return fail('unsupported_action', 'admission');
  const providerDeploymentId = input.priorDeployment.providerDeploymentId;
  let response;
  try { response = await vercelRequest(context, vercelEndpoint(`/v${operation === 'promote' ? '10' : '1'}/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}/${operation}/${encodeURIComponent(providerDeploymentId)}`,
    input.providerIdentity.providerAccountId), 'POST'); }
  catch (error) { if (isPluginError(error)) throw error; return fail('outcome_unknown', 'send'); }
  if (response.status < 200 || response.status >= 300) return fail(response.status === 401 || response.status === 403 ? 'deployment_access_denied'
    : response.status === 404 ? 'deployment_unavailable' : response.status === 409 ? 'deployment_conflict'
      : response.status >= 500 ? 'outcome_unknown' : 'provider_request_failed', 'send');
  // The write was acknowledged. A failed following read must retain the exact native id for recovery.
  try { return await observeVercelTraffic({ ...input, providerDeploymentId }, operation, context); }
  catch { return { v: 1, state: 'outcome_unknown', providerDeploymentId, observedAtMs: context.now() }; }
}
