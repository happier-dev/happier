import { expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '../externalActionExecutionAuthorization.js';
import { buildApprovalExecutionOriginV1 } from './approvalOrigins.js';

it.each(['workspace.sync.relationship.create'] as const)(
  'retains the original signed %s root through approval replay', actionId => {
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const input = { v: 1, sourceWorkspaceRefId: 'source-ref', targetMachineId: 'target-machine',
      targetPath: '/target', mode: 'mirror_exactly', purpose: 'worker_clean_copy',
      destinationIntent: 'materialize_from_source_workspace' };
    const envelope = { v: 1 as const, requestId: 'sync-request', target, input };
    const binding = { serverIdentityId: 'home', accountId: 'requester', authentication: { kind: 'account' as const, tokenEpoch: 0 },
      accountEncryptionMode: 'plain' as const, machineId: target.machineId, actionId, requestId: envelope.requestId,
      custodianAccountId: 'custodian', installationId: 'installation', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) };
    const origin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
      surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
      runtimeAccountId: 'requester', actionRequestId: envelope.requestId, originalActionEnvelope: envelope,
      externalActionExecutionAuthorization: { v: 1, token: 'verified-at-ingress', binding }, externalActionTarget: target,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: args.authorization.token,
        actionId: args.actionId, target: args.target, input: args.input, privateKey: keys.secretKey }),
    } });
    expect(origin).not.toBeNull();
    expect(origin?.originalActionEnvelope).toEqual(envelope);
  });
