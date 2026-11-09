import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as requester from '../sessions/creation/sessionRequesterBootstrapV1.js';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1,
  verifyExternalActionMachineRpcRequestV1 } from './externalActionExecutionAuthorization.js';
import { ManagedWakeTargetV1Schema } from '../machines/managed/managedIntentV1.js';

describe('private requester Account context on an external Action', () => {
  it.each(['plain', 'e2ee'] as const)('rejects replacement of the installed-signed %s private invocation with an independently sealed host invocation', mode => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const authorization = { v: 1 as const, token: 'original-plugin-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 3 },
      accountEncryptionMode: mode, serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      actionId: 'session.agent.transition', requestId: 'request', target: { kind: 'machine' as const, machineId: 'machine' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } };
    const credentials = { token: 'private-account', ...(mode === 'e2ee'
      ? { secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64') } : {}) };
    const purpose = { kind: 'machine_rpc' as const, method: 'stop-session', params: { sessionId: 'session' } };
    const seal = (invocation: requester.ExternalActionRequesterInvocationV1) => requester.sealExternalActionRequesterAccountContextV1({
      authorization, credentials, invocation, purpose, installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes,
    });
    const original = seal({ caller: { kind: 'plugin', pluginId: 'acme.switch', contributionLocalId: 'switch' },
      surface: 'plugin', authority: 'account_automation', callerInputConstraints: { models: null, permissionModes: ['read-only'] } });
    const substituted = seal({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
    // The public recipient key can create a valid box. Only the installed
    // producer's unchanged signature establishes which invocation it admitted.
    expect(requester.openExternalActionRequesterAccountContextV1({ authorization: substituted, purpose,
      machineId: 'machine', installationId: 'installation', serverIdentityId: 'home',
      installationPrivateKey: installation.secretKey, includeInvocation: true })?.invocation?.authority).toBe('present_user');
    const request = { authorizationToken: authorization.token, effectActionId: 'session.agent.transition',
      target: { kind: 'session' as const, sessionId: 'session' }, installationId: 'installation',
      method: 'machine:stop-session', requestId: 'child-request', params: purpose.params,
      requesterAccountContext: original.requesterAccountContext };
    const signature = signExternalActionMachineRpcRequestV1({ ...request, privateKey: installation.secretKey });
    const verify = (requesterAccountContext: typeof original.requesterAccountContext) => verifyExternalActionMachineRpcRequestV1({
      ...request, requesterAccountContext, signature, publicKey: installation.publicKey,
    });
    expect(verify(original.requesterAccountContext)).toBe(true);
    expect(verify(substituted.requesterAccountContext)).toBe(false);
    expect(verify(undefined)).toBe(false);
  });
  it.each(['plain', 'e2ee'] as const)('preserves private Plugin invocation facts inside the exact %s installed-key carrier', mode => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const authorization = { v: 1 as const, token: 'home-proof', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account' as const, tokenEpoch: 3 },
      accountEncryptionMode: mode, serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
      actionId: 'session.agent.transition', requestId: 'request', target: { kind: 'machine' as const, machineId: 'machine' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } };
    const credentials = { token: 'private-account', ...(mode === 'e2ee' ? { secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64') } : {}) };
    const invocation = { caller: { kind: 'plugin' as const, pluginId: 'acme.switch', contributionLocalId: 'switch' },
      surface: 'plugin' as const, authority: 'account_automation' as const, callerPermissionMode: 'read-only' as const,
      callerInputConstraints: { models: null, permissionModes: ['read-only'] } } satisfies requester.ExternalActionRequesterInvocationV1;
    const sealed = requester.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      invocation, purpose: { kind: 'external_action' }, installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const receive = { authorization: sealed, purpose: { kind: 'external_action' as const }, machineId: 'machine',
      installationId: 'installation', serverIdentityId: 'home', installationPrivateKey: installation.secretKey, includeInvocation: true as const };
    expect(requester.openExternalActionRequesterAccountContextV1(receive)).toEqual({ credentials, invocation });
    expect(JSON.stringify(sealed)).not.toContain('acme.switch');
    expect(requester.openExternalActionRequesterAccountContextV1({ ...receive,
      authorization: { ...sealed, binding: { ...sealed.binding, requestId: 'other' } } })).toBeNull();
    expect(() => requester.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      invocation: { ...invocation, authority: 'present_user' }, purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
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
    const { controller: _controller, ...portableTarget } = target;
    expect(() => seal({ authorization: { ...guestCarrier, managedFiniteWake: { ...guestCarrier.managedFiniteWake,
      target: portableTarget } }, credentials, purpose: { kind: 'managed_finite_wake', target: portableTarget },
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes }))
      .toThrow('requester_account_controller_mismatch');
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
