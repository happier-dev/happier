import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ApiMachineClient } from '@/api/apiMachine';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
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

it('names the missing Home role on that refusal and the managed controller receipt keeps it unchanged', async () => {
  const target = { kind: 'machine', machineId: 'machine' } as const;
  const envelope = { v: 1, target, requestId: 'admin-access', input: {} } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-fixture',
    binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId, installationId: 'installation',
      actionId: 'machines.setup.adminAccess.set', target, requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
  // A Session-origin enrollment child is not original custody; without a Home role it is refused.
  const binding = { ...authorization.binding, sessionActionOrigin: { sessionId: 'session' } } as typeof authorization.binding;
  const client = new ApiMachineClient('fixture-token', { id: target.machineId, encryptionMode: 'plain',
    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
  const createContext = createRequesterAccountOperationContext({ machineId: target.machineId, custodianAccountId: 'owner',
    installationIdentity: { version: 1, installationId: 'installation', createdAt: 1, publicKey: 'public', privateKey: 'private' } });
  const cause = { phase: 'dispatch', errorClass: 'Error', errorCode: 'admission_unavailable', httpStatus: null,
    nativeErrorReason: 'admitted_machine_role' };
  try {
    let thrown: unknown;
    try { createContext(client, { authorization: { ...authorization, binding }, isCurrent: async () => true }); }
    catch (error) { thrown = error; }
    // The guest executor projects the throw; the controller receipt carries the child's cause.
    const child = { ok: false as const, ...normalizeActionExecutorThrownError(thrown) };
    expect(child).toMatchObject({ errorCode: 'admission_unavailable', effectAttempted: false, failureCause: cause });
    const receipt = ManagedMachineControllerError.fromActionFailure(child, 'machines.setup.adminAccess.set')
      .toActionFailure('machines.managed.acquire');
    expect(receipt).toMatchObject({ errorCode: 'admission_unavailable', effectAttempted: false });
    expect(receipt.failureCause).toEqual(cause);
  } finally { await client.shutdown(); }
});
