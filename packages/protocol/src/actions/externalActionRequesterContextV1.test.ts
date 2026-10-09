import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as requester from '../sessions/creation/sessionRequesterBootstrapV1.js';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from './externalActionExecutionAuthorization.js';
import { ManagedWakeTargetV1Schema } from '../machines/managed/managedIntentV1.js';

describe('private requester Account context on an external Action', () => {
  it.each(['plain', 'e2ee'] as const)('retains the guest box and opens %s custody only at the exact finite-wake controller', mode => {
    const seal = Reflect.get(requester, 'sealExternalActionRequesterAccountContextV1');
    const open = Reflect.get(requester, 'openExternalActionRequesterAccountContextV1');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing canonical requester context transport');
    const guest = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
    const controller = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
    const target = ManagedWakeTargetV1Schema.parse({ homeId: 'home', managedId: 'managed', enrolledMachineId: 'guest',
      expectedIntentRevision: 4, controller: { machineId: 'controller', installationId: 'controller-installation' },
      origin: { kind: 'finite-command', actionRequestId: 'request' }, reason: 'admitted-work' });
    const authorization = { v: 1, token: 'home-guest-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: mode, serverIdentityId: 'home', machineId: 'guest', installationId: 'guest-installation',
      actionId: 'projects.prepare', requestId: 'request', target: { kind: 'machine', machineId: 'guest' },
      requestEnvelopeDigest: 'a'.repeat(43),
    }, managedFiniteWake: { target, installationPublicKey: Buffer.from(controller.publicKey).toString('base64url') } };
    const credentials = { token: 'private-bob', ...(mode === 'e2ee' ? { secret: Buffer.from(new Uint8Array(32).fill(12)).toString('base64') } : {}) };
    const guestCarrier = seal({ authorization, credentials, purpose: { kind: 'external_action' },
      installationPublicKey: guest.publicKey, randomBytes: tweetnacl.randomBytes });
    const controllerCarrier = seal({ authorization: guestCarrier, credentials, purpose: { kind: 'managed_finite_wake', target },
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(controllerCarrier.requesterAccountContext).toEqual(guestCarrier.requesterAccountContext);
    expect(controllerCarrier.binding).toEqual(authorization.binding);
    expect(controllerCarrier.managedFiniteWake.requesterAccountContext.installationId).toBe('controller-installation');
    const receive = { authorization: controllerCarrier, purpose: { kind: 'managed_finite_wake', target },
      machineId: 'controller', installationId: 'controller-installation', serverIdentityId: 'home',
      installationPrivateKey: controller.secretKey };
    expect(open(receive)).toEqual(credentials);
    expect(open({ authorization: controllerCarrier, purpose: { kind: 'external_action' }, machineId: 'guest',
      installationId: 'guest-installation', serverIdentityId: 'home', installationPrivateKey: guest.secretKey })).toEqual(credentials);
    expect(open({ ...receive, installationPrivateKey: guest.secretKey })).toBeNull();
    expect(open({ ...receive, purpose: { kind: 'managed_finite_wake', target: { ...target, expectedIntentRevision: 5 } } })).toBeNull();
    expect(open({ ...receive, authorization: { ...controllerCarrier, binding: { ...controllerCarrier.binding, requestId: 'other-request' } } })).toBeNull();
    expect(open({ ...receive, machineId: 'another-controller' })).toBeNull();
    expect(JSON.stringify(controllerCarrier)).not.toContain(credentials.token);
  });
  it('keeps private RPC custody bound to its exact existing method and payload', () => {
    const seal = Reflect.get(requester, 'sealExternalActionRequesterAccountContextV1');
    const open = Reflect.get(requester, 'openExternalActionRequesterAccountContextV1');
    expect(typeof seal).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing canonical requester context transport');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const authorization = { v: 1, token: 'home-rpc-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      actionId: 'projects.open', requestId: 'request', target: { kind: 'machine', machineId: 'machine' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } };
    const purpose = { kind: 'machine_rpc', method: 'machine:projects.open', params: { workspaceRefId: 'workspace' } };
    const sealed = seal({ authorization, credentials: { token: 'bob-private' }, purpose,
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const receive = (scope = purpose) => open({ authorization: sealed, purpose: scope, machineId: 'machine',
      installationId: 'installation', serverIdentityId: 'home', installationPrivateKey: installation.secretKey });
    expect(receive()).toEqual({ token: 'bob-private' });
    expect(receive({ ...purpose, method: 'machine:terminal.ensure' })).toBeNull();
    expect(receive({ ...purpose, params: { workspaceRefId: 'different' } })).toBeNull();
  });
  it('opens token-only custody only for the same Home, requester, purpose, input and installed receiver', () => {
    const seal = Reflect.get(requester, 'sealExternalActionRequesterAccountContextV1');
    const open = Reflect.get(requester, 'openExternalActionRequesterAccountContextV1');
    expect(typeof seal).toBe('function');
    expect(typeof open).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing canonical requester context transport');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const envelope = { v: 1 as const, requestId: 'request', target: { kind: 'machine' as const, machineId: 'machine' },
      input: { homeId: 'home', managedId: 'managed', expectedIntentRevision: 1 } };
    const binding = { serverIdentityId: 'home', accountId: 'bob', accountEncryptionMode: 'plain' as const,
      actionId: 'machines.managed.stop', machineId: 'machine', installationId: 'installation',
      requestId: envelope.requestId, target: envelope.target };
    const credentials = { token: 'private-bob-sign-in' };
    const authorization = { v: 1, token: 'home-proof', binding: { ...binding, custodianAccountId: 'alice',
      authentication: { kind: 'account', tokenEpoch: 3 }, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
    const purpose = { kind: 'external_action' as const };
    const sealed = seal({ authorization, credentials, purpose, installationPublicKey: installation.publicKey,
      randomBytes: tweetnacl.randomBytes });
    expect(ExternalActionExecutionAuthorizationV1Schema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(credentials.token);
    const relay = { v: 1, machineId: 'machine', envelope, executionAuthorization: sealed };
    expect(ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(relay).success).toBe(true);
    expect(ExternalActionExecutionAuthorizationRequestV1Schema.safeParse({ ...relay,
      managedContinuation: { managedId: 'managed', creationRequestId: 'request', expectedIntentRevision: 1 } }).success).toBe(false);
    const receive = (request: unknown, proof = authorization, installationPrivateKey = installation.secretKey) =>
      open({ authorization: { ...proof, requesterAccountContext: Reflect.get(request as object, 'requesterAccountContext') },
        purpose, machineId: 'machine', installationId: 'installation',
        serverIdentityId: 'home', installationPrivateKey });
    expect(receive(sealed)).toEqual(credentials);
    expect(receive(sealed, { ...authorization, binding: { ...authorization.binding, accountId: 'alice' } })).toBeNull();
    expect(receive(sealed, { ...authorization, binding: { ...authorization.binding, serverIdentityId: 'other-home' } })).toBeNull();
    expect(receive(sealed, { ...authorization, binding: { ...authorization.binding, actionId: 'machines.managed.delete' } })).toBeNull();
    expect(receive(sealed, authorization, tweetnacl.sign.keyPair().secretKey)).toBeNull();
    expect(receive(sealed, { ...authorization, token: 'another-home-proof' })).toBeNull();
    expect(open({ authorization: sealed, purpose: { kind: 'machine_rpc', method: 'machine:terminal.ensure', params: {} },
      machineId: 'machine', installationId: 'installation', serverIdentityId: 'home', installationPrivateKey: installation.secretKey })).toBeNull();
  });
});
