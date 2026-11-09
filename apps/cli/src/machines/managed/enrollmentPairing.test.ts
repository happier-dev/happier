import { describe, expect, it } from 'vitest';
import { createManagedEnrollmentPairingDelivery, createManagedEnrollmentResponseValidation } from './enrollmentPairing';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';

const resource = { contributionRef: { pluginId: 'test.machine', localId: 'guest' }, schemaVersion: 1, value: { nativeId: 'native' } };
const correlation = { homeId: 'home', managedId: 'managed', requestId: 'create', expectedIntentRevision: 0,
  controller: { machineId: 'controller', installationId: 'installation' }, resource };
const purpose = { ...correlation, operationId: 'operation', taskId: 'task',
  expectedPromptKind: 'auth.approveRemoteProvisioning', phase: 'delivery' };
const authorization = { kind: 'machine.managedInstallation.serverOrigin', actorAccountId: 'member', custodianAccountId: 'company',
  purpose };
const pairing = { secretB64Url: Buffer.alloc(32, 7).toString('base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 };
const context = { publicKey: Buffer.alloc(32, 8).toString('base64'), homeServerIdentityId: 'home', pairing, supportsTokenOnly: true };
const deliver = createManagedEnrollmentPairingDelivery({ correlation, operationId: 'operation', enrollmentAccountId: 'member',
  readTaskId: () => 'task' });

describe('managed pairing requester custody', () => {
  it.each(['admitted', 'absent', 'forged', 'unrelated'] as const)('delivers only the existing issuer’s admitted parent (%s)', async review => {
    const port = createHostReviewedChildPortV1({ actionId: review === 'unrelated' ? 'machines.managed.inspect' : 'machines.managed.acquire',
      input: { selection: { kind: 'preset', homeId: 'home', id: 'team-preset', revision: 1 } }, context: {}, reviewAdmitted: true,
      execute: async () => ({ ok: true, result: {} }) });
    const reviewedChild = review === 'absent' ? undefined : review === 'forged'
      ? { parent: port.parent, invoke: port.invoke } : port;
    const delivery = createManagedEnrollmentPairingDelivery({ correlation, operationId: 'operation',
      enrollmentAccountId: 'member', readTaskId: () => 'task', reviewedChild });
    const result = await delivery({ ...context, request: { request: { kind: 'terminalPairing' }, authorization } });
    expect(result).toEqual({ ...context, pairingRequirement: 'v3', enrollmentAccountId: 'member',
      ...(review === 'admitted' || review === 'unrelated' ? { reviewedParent: { actionId: port.parent?.actionId } } : {}) });
  });

  it('binds the final answer to the same task even after the approved guest registers', async () => {
    const validate = createManagedEnrollmentResponseValidation({ correlation, operationId: 'operation', enrollmentAccountId: 'member',
      readTaskId: () => 'task' },
    { kind: 'auth.approveRemoteProvisioning' });
    await expect(validate({ ...authorization, purpose: { ...purpose, taskId: 'other-task', phase: 'answer' } }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(validate({ ...authorization, purpose: { ...purpose, phase: 'answer' } })).resolves.toBeUndefined();
  });

  it('delivers the guest context only to the current admitted requester', async () => {
    await expect(deliver({ ...context, request: { request: { kind: 'terminalPairing' }, authorization } })).resolves.toEqual({
      ...context, pairingRequirement: 'v3', enrollmentAccountId: 'member' });
  });

  it.each([
    { purpose: { ...purpose, operationId: 'old' } },
    { purpose: { ...purpose, taskId: 'old' } },
    { purpose: { ...purpose, expectedPromptKind: 'other' } },
    { purpose: { ...purpose, expectedPromptId: 'other' } },
    { purpose: { ...purpose, phase: 'answer' } },
  ])('refuses an answer for another task, operation, prompt or phase (%j)', async change => {
    await expect(deliver({ ...context, request: { request: { kind: 'terminalPairing' }, authorization: { ...authorization, ...change } } }))
      .rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('refuses expired guest context', async () => {
    await expect(deliver({ ...context, pairing: { ...pairing, createdAtMs: 1, expiresAtMs: 2 },
      request: { request: { kind: 'terminalPairing' }, authorization } })).rejects.toMatchObject({ code: 'auth_request_expired' });
  });
});
