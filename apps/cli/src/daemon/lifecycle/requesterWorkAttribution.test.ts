import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';

import { canUseLocalRuntimeAccount, canUseLocalRuntimeReviewAccount, isRequesterLaunchAdmissionCurrent } from './requesterWorkAttribution';

it('retains independent API credential and caller scope alongside original own Account custody', async () => {
  const binding = {
    accountId: 'owner', custodianAccountId: 'owner',
    serverIdentityId: 'home', machineId: 'machine', installationId: 'installation', actionId: 'action.invoke',
    requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
  } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-root',
    binding: { ...binding, authentication: { kind: 'account', tokenEpoch: 1 } } });
  const credential = { accountId: 'owner', principalId: 'owner', credentialId: '00000000-0000-4000-8000-000000000001',
    grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['execution.run.start'] }, targets: { sessions: [], machines: ['machine'] },
      approve: false, origins: [], models: null, permissionModes: null, create: null }),
  };
  const context = { externalActionExecutionAuthorization: authorization, runtimeAccountId: 'owner' };
  const workflowAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-workflow',
    binding: { ...binding, authentication: { kind: 'account', tokenEpoch: 1 },
      workflowActionOrigin: { runId: 'workflow', requestId: 'request' } } });
  const workflowContext = { ...context, externalActionExecutionAuthorization: workflowAuthorization };
  for (const canUseAccount of [canUseLocalRuntimeAccount, canUseLocalRuntimeReviewAccount]) {
    expect(await canUseAccount(context, 'owner', 'home')).toBe(true);
    expect(await canUseAccount({ ...context, externalActionCredential: credential }, 'owner', 'home')).toBe(false);
    expect(await canUseAccount({ ...context, callerInputAuthorization:
      ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-caller', binding: { ...binding, ...credential } }),
    }, 'owner', 'home')).toBe(false);
    expect(await canUseAccount(workflowContext, 'owner', 'home')).toBe(true);
    expect(await canUseAccount({ ...workflowContext, externalActionCredential: credential }, 'owner', 'home')).toBe(false);
  }
});

it('denies borrowing the runtime Account for another Account’s attributed work', async () => {
  const context = { runtimeAccountId: 'local-account', requesterWorkAttributionV1: {
    serverId: 'home', accountId: 'foreign-account', machineId: 'machine', installationId: 'installation',
  } };
  expect(await canUseLocalRuntimeAccount(context, 'local-account', 'home')).toBe(false);
  expect(await canUseLocalRuntimeAccount({ runtimeAccountId: 'foreign-account' }, 'local-account', 'home')).toBe(false);
  expect(await canUseLocalRuntimeAccount({ runtimeAccountId: 'local-account' }, 'local-account', 'home')).toBe(true);
});

it('preserves transient Home failures instead of interpreting them as a rejected launch principal', async () => {
  await expect(isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => {
    throw Object.assign(new Error('Home unavailable'), { response: { status: 503 } });
  } })).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
});

it('retains refused launch admission for revoked access, authentication failure and unknown errors', async () => {
  expect(await isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => false })).toBe(false);
  for (const error of [Object.assign(new Error('Forbidden'), { response: { status: 403 } }),
    new Error('Unexpected admission failure'), Object.assign(new Error('Cancelled'), { name: 'AbortError' })]) {
    expect(await isRequesterLaunchAdmissionCurrent({ verifyRequesterMachineAdmissionCurrent: async () => { throw error; } })).toBe(false);
  }
  expect(await isRequesterLaunchAdmissionCurrent({})).toBe(true);
});
