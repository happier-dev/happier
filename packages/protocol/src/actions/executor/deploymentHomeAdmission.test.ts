import { expect, it } from 'vitest';
import { admitDeploymentHomeInputV1 } from './deploymentHomeAdmission.js';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '../externalActionApi.js';

it('preserves canonical signed input bytes and refuses to normalize an already signed alias', () => {
  const canonical = { mode: 'confirm' as const, serverId: 'srv_home', environmentId: 'environment',
    machineId: 'machine', installationId: 'installed', targetLinkId: 'link', deploymentId: 'deployment',
    expectedRevision: 1, prepareOperationId: 'prepared', source: { kind: 'repository' as const, snapshotId: 'snapshot' } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-fixture', binding: {
    serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
    authentication: { kind: 'account', tokenEpoch: 1 }, actionId: 'deployments.backups.restore',
    requestId: 'request', target: { kind: 'machine', machineId: 'machine' }, machineId: 'machine',
    installationId: 'installed', environmentId: 'environment', accountEncryptionMode: 'plain', requestEnvelopeDigest: 'A'.repeat(43),
    deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.restore', canonical),
  } });
  const context = { serverId: 'profile', serverIdentityId: 'srv_home', externalActionExecutionAuthorization: authorization };
  const result = admitDeploymentHomeInputV1(canonical, context, undefined);
  expect('input' in result && JSON.stringify(result.input)).toBe(JSON.stringify(canonical));
  expect(admitDeploymentHomeInputV1({ ...canonical, serverId: 'profile' }, context, undefined))
    .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
});
