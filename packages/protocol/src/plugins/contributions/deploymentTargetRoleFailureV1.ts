import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const DeploymentTargetRoleFailureV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), code: z.enum(['deployment_invalid', 'deployment_unavailable', 'deployment_access_denied',
    'deployment_conflict', 'deployment_content_unavailable', 'unsupported_action', 'client_required',
    'needsGitAccess', 'provider_request_failed', 'provider_response_invalid', 'outcome_unknown',
    'secret_use_client_required', 'secret_save_client_required', 'authorityChanged']),
  phase: z.enum(['admission', 'link', 'source', 'build', 'send', 'observe', 'cancel', 'teardown']), retryable: z.boolean(),
}));
export type DeploymentTargetRoleFailureV1 = z.infer<typeof DeploymentTargetRoleFailureV1Schema>;
