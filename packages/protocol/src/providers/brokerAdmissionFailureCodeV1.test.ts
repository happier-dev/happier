import { expect, it } from 'vitest';

import { ProviderBrokerAdmissionFailureCodeV1Schema as leafSchema } from './brokerAdmissionFailureCodeV1.js';
import { ProviderBrokerAdmissionFailureCodeV1Schema } from './brokerRouteGrantV1.js';

it('preserves the Provider Broker wire denial codes', () => {
  expect(leafSchema).toBe(ProviderBrokerAdmissionFailureCodeV1Schema);
  expect(leafSchema.options).toEqual([
    'connected_service_credential_reconnect_required',
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
  ]);
});
