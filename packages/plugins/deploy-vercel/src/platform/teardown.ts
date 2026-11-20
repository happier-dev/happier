import { isPluginError, PluginError, projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import type { DeploymentTargetTeardownInputV1, DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import type { HttpResponse } from '@happier-dev/plugin-sdk/http';
import { vercelEndpoint, vercelRequest, type VercelPlatformContext } from './operations.js';

type Selection = Pick<DeploymentTargetTeardownInputV1, 'providerIdentity' | 'providerDeploymentId'>;
type Operation = readonly ['read', 'GET'] | readonly ['write', 'DELETE'];

function unknownOutcome(error: unknown, operation: Operation): never {
  const phase = `deployment.vercel.teardown.${operation[0] === 'write' ? 'send' : 'observe'}`;
  throw withActionFailureDiagnostic(new PluginError({ code: 'outcome_unknown', retryable: false,
    details: { phase: 'teardown' }, failureCause: projectActionFailureCauseV1(error, phase) }),
  { phase, causeKind: 'native_failure', error });
}

/** The existing HTTP owner supplies credentials and native causes; only this role interprets absence. */
async function requestProject(input: Selection, operation: Operation, context: VercelPlatformContext) {
  let response: HttpResponse;
  try {
    response = await vercelRequest(context, vercelEndpoint(
      `/v9/projects/${encodeURIComponent(input.providerIdentity.providerResourceId)}`,
      input.providerIdentity.providerAccountId), operation, undefined, 'teardown');
  } catch (error) {
    if (isPluginError(error)) {
      const status = error.data.failureCause?.httpStatus;
      if (status === 404) return undefined;
      // A refused DELETE has a known cause; a failed confirming GET cannot prove the effect absent.
      if (operation[0] === 'write' && status != null && status >= 400 && status < 500) throw error;
    }
    return unknownOutcome(error, operation);
  }
  if (response.status === 404) return undefined;
  if (response.status >= 200 && response.status < 300) return response;
  if (operation[0] === 'write' && response.status >= 400 && response.status < 500) {
    throw new PluginError({ code: response.status === 401 || response.status === 403 ? 'deployment_access_denied'
      : response.status === 409 ? 'deployment_conflict' : 'provider_request_failed', retryable: false,
    details: { phase: 'teardown' }, failureCause: projectActionFailureCauseV1(response, 'deployment.vercel.teardown.send') });
  }
  return unknownOutcome(response, operation);
}

function absent(input: Selection, context: VercelPlatformContext): DeploymentTargetRoleResultV1 {
  return { v: 1, state: 'succeeded', providerResourceAbsent: true, observedAtMs: context.now(),
    ...(input.providerDeploymentId ? { providerDeploymentId: input.providerDeploymentId } : {}) };
}

/** One exact project read; the host owns recovery and when to observe again. */
export async function observeVercelTeardown(input: Selection, context: VercelPlatformContext): Promise<DeploymentTargetRoleResultV1> {
  const response = await requestProject(input, ['read', 'GET'], context);
  return response === undefined ? absent(input, context) : unknownOutcome(response, ['read', 'GET']);
}

/**
 * DELETE /v9/projects/{idOrName} acknowledges removal with 204. Require GET 404 as proof;
 * an already-404 DELETE also proves absence. Never retry an ambiguous mutation.
 * https://vercel.com/docs/rest-api/projects/delete-a-project (inspected 2026-11-15)
 */
export async function teardownVercelProject(input: Selection, context: VercelPlatformContext): Promise<DeploymentTargetRoleResultV1> {
  context.signal.throwIfAborted();
  return await requestProject(input, ['write', 'DELETE'], context) === undefined
    ? absent(input, context) : observeVercelTeardown(input, context);
}
