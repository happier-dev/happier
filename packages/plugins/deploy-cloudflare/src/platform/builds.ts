import type { DeploymentTargetRoleFailureV1, DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import { isObject } from '../connectedAccounts/probe.js';
import { failure, type DeploymentContext } from './deploymentHttp.js';

type ServingProof = (buildId: string, build: Readonly<Record<string, unknown>>) => Promise<boolean>;

/** Workers and native Previews share Builds state, but each product owns proof
 * that a successful build is actually serving its exact deployment scope. */
export async function observeBuild(value: unknown, context: DeploymentContext,
  phase: DeploymentTargetRoleFailureV1['phase'], expectedId: string | undefined,
  serving: ServingProof,
): Promise<DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1> {
  if (!isObject(value) || typeof value.build_uuid !== 'string' || value.build_uuid.trim().length === 0
    || expectedId !== undefined && value.build_uuid !== expectedId) {
    return failure(phase === 'send' || phase === 'cancel' ? 'outcome_unknown' : 'provider_response_invalid', phase);
  }
  // Native cancel supplies build_outcome without status. Identity is checked
  // once above, retaining the uncertain cancel outcome when it does not match.
  let state: DeploymentTargetRoleResultV1['state'];
  switch (phase === 'cancel' ? 'stopped' : value.status) {
    case 'queued': state = 'queued'; break;
    case 'initializing': case 'running': state = 'running'; break;
    case 'stopped':
      switch (value.build_outcome) {
        case 'fail': state = 'failed'; break;
        case 'cancelled': case 'terminated': state = 'cancelled'; break;
        case 'success': state = await serving(value.build_uuid, value) ? 'succeeded' : 'outcome_unknown'; break;
        default: state = 'outcome_unknown';
      }
      break;
    default: return failure(phase === 'send' ? 'outcome_unknown' : 'provider_response_invalid', phase);
  }
  return { v: 1, state, providerDeploymentId: value.build_uuid, observedAtMs: context.now() };
}
