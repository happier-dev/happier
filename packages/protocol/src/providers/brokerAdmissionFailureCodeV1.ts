import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../connect/connectedServiceUxDiagnostics.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ProviderBrokerAdmissionFailureCodeV1Schema = lazyZodSchema(() => z.enum([
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired,
  'invalid_request',
  'resource_forbidden',
  'access_removed',
  'resource_unavailable',
  'resource_changed',
  'session_not_active',
  'operation_not_current',
  'execution_run_not_found',
  'execution_run_terminal',
  'execution_run_authority_unavailable',
  'broker_unavailable',
  'update_required',
  'team_credential_usage_limit',
  'token_limit_unavailable',
  'cost_limit_unavailable',
  'duplicate_request',
]));

export type ProviderBrokerAdmissionFailureCodeV1 = z.infer<typeof ProviderBrokerAdmissionFailureCodeV1Schema>;
