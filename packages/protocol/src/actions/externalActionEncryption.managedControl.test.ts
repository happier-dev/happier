import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';
import { openExternalActionRequestV2, sealExternalActionRequestV2 } from './externalActionEncryption.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '../approvals/approvalArtifactHeaderV1.js';

it.each(['stop', 'start', 'delete'] as const)('retains encrypted managed %s admission through the signed approval Artifact', intent => {
  const actionId = intent === 'delete' ? 'machines.managed.delete' : 'machines.managed.power.set';
  const input = { homeId: 'srv_home', managedId: 'managed', when: 'now', expectedRevision: 0,
    ...(intent === 'delete' ? { intent, reviewedDependencies: true } : { intent }) };
  const target = { kind: 'machine' as const, machineId: 'controller' };
  const binding = { serverIdentityId: input.homeId, accountId: 'account', actionId, requestId: 'request', target,
    authentication: { kind: 'terminal' as const, tokenEpoch: 0 } };
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
  const envelope = sealExternalActionRequestV2({ binding, input, material,
    randomBytes: length => new Uint8Array(length).fill(2) });
  expect(envelope.managedAdmission).toEqual({ actionId, input });
  expect(openExternalActionRequestV2({ envelope, binding, material })).toEqual({ input });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-proof', binding: {
    ...binding, machineId: target.machineId, custodianAccountId: binding.accountId, installationId: 'installation',
    accountEncryptionMode: 'e2ee', managedAdmission: envelope.managedAdmission,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'system' }, requestedSurface: 'mcp', actionId, actionArgs: input, summary: 'Reviewed effect',
    approval: { flow: 'deferred', result: 'required' },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'ui', caller: { kind: 'host' },
      serverId: 'creator-profile', serverIdentityId: input.homeId, accountId: binding.accountId,
      machineId: target.machineId, target, actionId, requestId: binding.requestId,
      externalActionExecutionAuthorization: authorization, externalActionInputSignature: 'a'.repeat(86) } });
  expect(approvalArtifactBodyMatchesHeaderV1(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)))
    .toMatchObject({ family: 'built_in', request: { status: 'open', actionId,
      executionOriginV1: { externalActionExecutionAuthorization: authorization } } });
});
