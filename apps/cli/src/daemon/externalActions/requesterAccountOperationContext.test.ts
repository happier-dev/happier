import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApiMachineClient } from '@/api/apiMachine';
import { createRequesterAccountOperationContext } from './execution';

it('refuses foreign Configure before handing the native effect an admission without a Home role', async () => {
  const target = { kind: 'machine', machineId: 'machine' } as const;
  const envelope = { v: 1, target, requestId: 'configure', input: {} } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-fixture',
    binding: {
      accountId: 'requester', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId, installationId: 'installation',
      actionId: 'machines.reachability.configure', target, requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
  const client = new ApiMachineClient('fixture-token', { id: target.machineId, encryptionMode: 'plain',
    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  const createContext = createRequesterAccountOperationContext({ machineId: target.machineId, custodianAccountId: 'owner',
    installationIdentity: { version: 1, installationId: 'installation', createdAt: 1, publicKey: 'public', privateKey: 'private' } });
  const isCurrent = async () => true;
  const requester = { authorization, isCurrent };
  try {
    const homeAdmitted = { ...requester, authorization: { ...authorization,
      binding: { ...authorization.binding, admittedMachineRole: 'manage' as const } } };
    expect(createContext(client, homeAdmitted).machineAdmission).toMatchObject({
      actorAccountId: 'requester', custodianAccountId: 'owner', role: 'manage',
    });
    expect(() => createContext(client, requester)).toThrow(expect.objectContaining({
      code: 'admission_unavailable',
      effectAttempted: false,
    }));
  } finally { await client.shutdown(); }
});
