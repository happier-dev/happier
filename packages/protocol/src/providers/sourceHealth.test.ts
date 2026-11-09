import { expect, it } from 'vitest';

import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '../connect/connectedServiceUxDiagnostics.js';
import { admitTeamCredentialSourceModelRowsV1, DaemonProviderModelProjectionResponseV1Schema } from '../rpc/providers.js';
import { SessionRuntimeIssueV1Schema } from '../sessions/control/runtimeIssueV1.js';
import { TeamCredentialResourceReadinessV1Schema } from '../teams/credentials/readinessV1.js';
import { SessionTeamCredentialBindingRejectionV1Schema } from '../teams/credentials/sessionBindingV1.js';
import { ProviderBrokerOpenResponseV1Schema, ProviderBrokerRefusalV1Schema } from './brokerRouteGrantV1.js';
import { providerErrorFromRpcFailure } from './errors.js';

it('preserves confirmed source reconnect through catalog, readiness, admission and stored runtime readers', () => {
  const code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  const error = providerErrorFromRpcFailure(Object.assign(new Error('Source requires owner action'), { code }), { machineId: 'broker' });
  expect(error).toMatchObject({ code, retryable: false });

  const response = DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'error', error });
  expect(admitTeamCredentialSourceModelRowsV1(response)).toEqual({ status: 'unavailable', reason: code, error });
  expect(TeamCredentialResourceReadinessV1Schema.safeParse({ kind: 'source_unavailable', reason: code }).success).toBe(true);
  expect(SessionTeamCredentialBindingRejectionV1Schema.safeParse(code).success).toBe(true);
  const broker = ProviderBrokerOpenResponseV1Schema.parse({ ok: false, reasonCode: code });
  expect(broker).toEqual({ ok: false, reasonCode: code });
  const refusal = ProviderBrokerRefusalV1Schema.parse({ error: {
    type: 'happier_provider_broker_error', code, resourceId: 'shared-resource',
  } });
  const issue = SessionRuntimeIssueV1Schema.parse({ v: 1, scope: 'primary_session', status: 'failed',
    code: 'team_credential', source: 'team_credential', occurredAt: 1,
    sanitizedPreview: 'Shared credential requires owner action', teamCredential: {
      v: 1, resourceId: refusal.error.resourceId, reasonCode: refusal.error.code,
    } });
  expect(issue.teamCredential?.reasonCode).toBe(code);
  expect(admitTeamCredentialSourceModelRowsV1({ status: 'error', error: {
    v: 1, code: 'provider_catalog_unavailable', retryable: true, action: 'retry',
  } })).toMatchObject({ reason: 'projection_unavailable' });
});

it.each(['refresh', 'denied group'])('preserves the same source fact inside a Gateway %s', kind => {
  const code = CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired;
  const error = providerErrorFromRpcFailure(Object.assign(new Error('Source requires owner action'), { code }));
  const base = { status: 'success', agentTargetKey: 'agent:happier.agent.codex/codex', groups: [] };
  const response = DaemonProviderModelProjectionResponseV1Schema.parse({ ...base,
    ...(kind === 'refresh' ? { refreshFailures: [{ connectionId: 'pc_gateway', error }] } : {
      groups: [{ connectionId: 'pc_gateway', providerName: 'Gateway', connectionName: 'Gateway',
        connectionRole: 'named', connectionDisplayNameMode: 'automatic', connectionRevision: 1,
        modelLoadAction: 'descriptor_absent', authorization: { authorized: false, error },
        manualModelPolicy: 'catalog-only', supportsFreeformModelIds: false, suppressedConnectedServiceIds: [], rows: [] }],
    }),
  });
  expect(admitTeamCredentialSourceModelRowsV1(response)).toMatchObject({ reason: code, error });
});
