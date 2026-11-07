import { SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '../../machines/managed/actionIdsV1.js';
import { projectExternalActionMachineRuntimeDemandV1 } from '../../actions/actionSpecs.js';
import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as bootstrap from './sessionRequesterBootstrapV1.js';
import { SessionHandoffPrepareTargetRequestSchema } from '../control/handoff/handoffSchemas.js';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionRequestEnvelopeV2Schema } from '../../actions/externalActionApi.js';
import { ManagedMachineActionInputSchemasV1, readMachineSetupPlanChildInputV1 } from '../../machines/managed/actionsV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { openBoxBundleWithSecretKey } from '../../crypto/boxBundle.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ed25519 } from '@noble/curves/ed25519';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../../actions/externalActionExecutionAuthorization.js';
import { sealExternalActionRequestV2, openExternalActionRequestV2 } from '../../actions/externalActionEncryption.js';
import { WorkflowApprovedOperationParentV1Schema } from '../../actions/approvedOperationV1.js';
import { DeploymentChildRpcV1Schema } from '../../deployments/deploymentChildRpcV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';

const request = {
  kind: 'requester_session_bootstrap_v1',
  input: {
    executionTarget: { serverId: 'home', machineId: 'machine' },
    directory: { kind: 'path', path: '/workspace' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
  },
  requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: {
    token: 'private-bob-token', secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64'),
  } },
} as const;

describe('requester bootstrap installation confidentiality', () => {
  it.each((['plain', 'e2ee'] as const).flatMap((accountEncryptionMode) =>
    (['account', 'api'] as const).flatMap((requesterKind) =>
      [undefined, SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role, 'other_admitted_setup_role'].map((role) => ({ accountEncryptionMode, requesterKind, role })))))(
    'carries only a bound codec for an admitted shared setup child ($accountEncryptionMode/$requesterKind/$role)', ({ accountEncryptionMode, requesterKind, role }) => {
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const target = { kind: 'machine' as const, machineId: 'shared-machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'scoped-setup-leaf', binding: {
      accountId: 'requester', custodianAccountId: 'custodian', ...(requesterKind === 'account'
        ? { authentication: { kind: 'account', tokenEpoch: 1 } }
        : { principalId: 'requester', credentialId: 'scoped-pat', grant: API_TOKEN_FULL_GRANT_V1 }),
      serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation', accountEncryptionMode,
      actionId: 'machines.setup.apply', requestId: 'native-child', requestEnvelopeDigest: 'a'.repeat(43), target,
      admittedMachineRole: 'manage', workflowActionOrigin: { runId: 'accepted-run', requestId: 'native-child',
        ...(role ? { reviewedChild: { actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
          role, inputDigest: 'b'.repeat(43) } } : {}) },
    } });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(22) };
    const sealed = bootstrap.sealManagedControllerActionCodecV1({ authorization, material,
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, machineId: target.machineId, installationId: 'installation',
      serverIdentityId: 'home', installationPrivateKey: receiver.secretKey };
    expect(bootstrap.openManagedControllerActionCodecV1(input)).toEqual(material);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { kind: 'external_action' } })).toBeNull();
    expect(bootstrap.openManagedControllerActionCodecV1({ ...input, authorization: { ...sealed,
      binding: { ...sealed.binding, admittedMachineRole: 'use' } } })).toBeNull();
    expect(bootstrap.openManagedControllerActionCodecV1({ ...input, installationId: 'another-installation' })).toBeNull();
    const genericWorkflow = { ...authorization, binding: { ...authorization.binding, workflowActionOrigin: undefined } };
    expect(() => bootstrap.sealManagedControllerActionCodecV1({ authorization: genericWorkflow, material,
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });

  it.each(['ui', 'voice', 'cli'] as const)('carries one native operation confirmation in the existing exact installation-sealed invocation (%s)', surface => {
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
    const target = { kind: 'machine' as const, machineId: 'computer' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'confirmed-operation', binding: {
      accountId: 'person', custodianAccountId: 'person', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: target.machineId, installationId: 'installation', accountEncryptionMode: 'plain',
      actionId: 'machines.setup.apply', requestId: 'install', requestEnvelopeDigest: 'a'.repeat(43), target,
    } });
    const invocation = { caller: { kind: 'host' as const }, surface, authority: 'present_user' as const,
      reviewedParent: WorkflowApprovedOperationParentV1Schema.parse({ actionId: 'machines.managed.acquire', input: { selection: { homeId: 'home' } } }),
      presentUserConfirmation: { actionId: 'machines.setup.apply' as const, inputDigest: 'b'.repeat(43), requestId: 'install',
        accountId: 'person', serverId: 'home', target } };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization,
      credentials: { token: 'fixture-person-credential', secret: null, encryption: null }, invocation,
      purpose: { kind: 'external_action' }, installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
    const opened = { authorization: sealed, purpose: { kind: 'external_action' as const }, machineId: target.machineId,
      installationId: 'installation', serverIdentityId: 'home', installationPrivateKey: receiver.secretKey, includeInvocation: true as const };
    expect(bootstrap.openExternalActionRequesterAccountContextV1(opened)?.invocation).toEqual(invocation);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...opened, authorization: { ...sealed,
      binding: { ...sealed.binding, requestId: 'another-operation' } } })).toBeNull();
    expect(bootstrap.ExternalActionRequesterInvocationV1Schema.safeParse({ ...invocation,
      surface: 'mcp', authority: 'account_automation' }).success).toBe(false);
    const { presentUserConfirmation: _confirmation, ...reviewedInvocation } = invocation;
    expect(bootstrap.ExternalActionRequesterInvocationV1Schema.safeParse({ ...reviewedInvocation,
      caller: { kind: 'plugin', pluginId: 'acme.fixture', contributionLocalId: 'inspect' },
      surface: 'plugin', authority: 'account_automation' }).success).toBe(false);
    for (const surface of ['agent', 'mcp'] as const) expect(bootstrap.ExternalActionRequesterInvocationV1Schema.safeParse({
      ...invocation, surface }).success).toBe(false);
    expect(bootstrap.ExternalActionRequesterInvocationV1Schema.safeParse({ ...invocation, reviewedParent: undefined,
      caller: { kind: 'plugin', pluginId: 'acme.fixture', contributionLocalId: 'inspect' },
      surface: 'plugin', authority: 'account_automation' }).success).toBe(false);
    expect(bootstrap.ExternalActionRequesterInvocationV1Schema.safeParse({ ...invocation, authority: 'account_automation' }).success).toBe(false);
  });
  it('opens a managed creation child only under its exact Home continuation and invocation digest', () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'parent-home-proof', binding: {
      accountId: 'requester', custodianAccountId: 'company', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'srv_home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode: 'e2ee',
      actionId: 'machines.managed.acquire', requestId: 'create', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const binding = { serverIdentityId: 'srv_home', accountId: 'requester', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      actionId: 'machines.setup.plan', requestId: 'create', target: { kind: 'machine' as const, machineId: 'guest' } };
    const continuation = { managedId: 'managed', creationRequestId: 'create', expectedIntentRevision: 3 };
    const envelope = bootstrap.sealManagedCreationActionCodecV1({ authorization: parent, actionId: 'machines.setup.plan', continuation,
      envelope: sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: { homeId: 'srv_home', machineId: 'guest' }, material, randomBytes: tweetnacl.randomBytes }),
      recipient: { machineId: 'guest', installationId: 'guest-installation', installationPublicKey: encodeBase64(installation.publicKey, 'base64url') },
      material, randomBytes: tweetnacl.randomBytes });
    const authorization = { ...parent, token: 'child-home-proof', binding: { ...parent.binding, ...binding,
      machineId: 'guest', installationId: 'guest-installation', custodianAccountId: 'requester',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      managedContinuation: { ...continuation, controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest } } };
    const input = { authorization, envelope, machineId: 'guest', installationId: 'guest-installation',
      serverIdentityId: 'srv_home', installationPrivateKey: installation.secretKey };
    expect(bootstrap.openManagedCreationActionCodecV1(input)).toEqual(material);
    expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input).toEqual({ homeId: 'srv_home', machineId: 'guest' });
    const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(envelope.managedCreationCodec!.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(installation.secretKey.subarray(0, 32)) });
    const plaintext = JSON.parse(new TextDecoder().decode(bytes!));
    expect(Object.keys(plaintext).sort()).toEqual(['authorization', 'codec', 'purpose', 'v']);
    expect(plaintext.authorization).toEqual(parent);
    for (const changed of [
      { ...authorization.binding, managedContinuation: undefined },
      { ...authorization.binding, actionId: 'session.send_message' },
      { ...authorization.binding, accountId: 'company', custodianAccountId: 'company' },
      { ...authorization.binding, serverIdentityId: 'other-home' },
      ...[{ controller: undefined }, { controller: { machineId: 'replaced-controller', installationId: 'controller-installation' } },
        { acquireRequestEnvelopeDigest: 'b'.repeat(43) }, { expectedIntentRevision: 4 }, { managedId: 'other' }]
        .map(change => ({ ...authorization.binding, managedContinuation: { ...authorization.binding.managedContinuation, ...change } })),
    ]) expect(bootstrap.openManagedCreationActionCodecV1({ ...input, authorization: { ...authorization, binding: changed } })).toBeNull();
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, installationId: 'replaced-installation' })).toBeNull();
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, machineId: 'other-guest' })).toBeNull();
    const substituted = { ...envelope, payload: { t: 'encrypted' as const, c: `${envelope.payload.c}changed` } };
    // Even a newly signed outer digest cannot rebind the installed box to another payload.
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, envelope: substituted, authorization: { ...authorization,
      binding: { ...authorization.binding, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(substituted) } } })).toBeNull();
    expect(bootstrap.openManagedControllerActionCodecV1({ ...input, authorization: { ...authorization,
      requesterAccountContext: envelope.managedCreationCodec } })).toBeNull();
  });
  it('accepts the closed installed codec carrier on a sealed managed creation child', () => {
    expect(ExternalActionRequestEnvelopeV2Schema.safeParse({ v: 2, requestId: 'child', target: { kind: 'machine', machineId: 'guest' },
      payload: { t: 'encrypted', c: 'sealed' }, managedCreationCodec: { kind: 'installation_sealed_v1',
        installationId: 'guest-installation', ciphertext: encodeBase64(new Uint8Array(100), 'base64url') } }).success).toBe(true);
  });
  it.each(['plain', 'e2ee'] as const)('retains signed source creation custody for an own-Account %s guest without inventing Account material', mode => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const target = { kind: 'machine' as const, machineId: 'guest' };
    const parent = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-source-proof', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'srv_home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode: mode,
      actionId: 'machines.managed.acquire', requestId: 'create', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const binding = { serverIdentityId: 'srv_home', accountId: 'requester', authentication: { kind: 'account' as const, tokenEpoch: 1 },
      actionId: 'machines.agentIsolation.preview', requestId: 'create', target };
    const requestInput = { serverId: 'srv_home', machineId: 'guest', enabled: true };
    const material = mode === 'e2ee' ? { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) } : undefined;
    const base = material ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, input: requestInput, material, randomBytes: tweetnacl.randomBytes })
      : ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'create', target, input: requestInput });
    const continuation = { managedId: 'managed', creationRequestId: 'create', expectedIntentRevision: 3 };
    const reviewedParent = WorkflowApprovedOperationParentV1Schema.parse({ actionId: parent.binding.actionId,
      input: { selection: { kind: 'preset', homeId: 'srv_home', id: 'preset', revision: 1 } } });
    const invocation = { caller: { kind: 'host' as const }, surface: 'ui' as const, authority: 'present_user' as const };
    const envelope = bootstrap.sealManagedCreationActionCodecV1({ authorization: parent, actionId: 'machines.agentIsolation.preview',
      continuation, invocation, reviewedParent, envelope: base,
      recipient: { machineId: 'guest', installationId: 'guest-installation', installationPublicKey: encodeBase64(installation.publicKey, 'base64url') },
      ...(material ? { material } : {}), randomBytes: tweetnacl.randomBytes });
    const authorization = { ...parent, token: 'own-guest-proof', binding: { ...parent.binding, ...binding,
      machineId: 'guest', installationId: 'guest-installation', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      managedContinuation: { ...continuation, controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest } } };
    const input = { authorization, envelope, machineId: 'guest', installationId: 'guest-installation', serverIdentityId: 'srv_home',
      installationPrivateKey: installation.secretKey, includeInvocation: true as const };
    // The guest's existing Account material owner opens E2EE content. Only a
    // foreign controller's established codec needs to transfer a fresh key.
    expect(bootstrap.openManagedCreationActionCodecV1(input)).toEqual({ material: null, invocation, reviewedParent });
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, authorization: { ...authorization,
      binding: { ...authorization.binding, accountId: 'another-account', custodianAccountId: 'another-account' } } })).toBeNull();
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, authorization: { ...authorization,
      binding: { ...authorization.binding, managedContinuation: { ...authorization.binding.managedContinuation,
        acquireRequestEnvelopeDigest: 'b'.repeat(43) } } } })).toBeNull();
    expect(bootstrap.openManagedCreationActionCodecV1({ ...input, machineId: 'another-guest' })).toBeNull();
    if (envelope.v === 1) {
      const changed = { ...envelope, input: { ...requestInput, enabled: false } };
      expect(bootstrap.openManagedCreationActionCodecV1({ ...input, envelope: changed,
        authorization: { ...authorization, binding: { ...authorization.binding,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(changed) } } })).toBeNull();
    }
    if (mode === 'plain') expect(envelope).toMatchObject({ v: 1, input: requestInput });
    const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(envelope.managedCreationCodec!.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(installation.secretKey.subarray(0, 32)) });
    expect(JSON.parse(new TextDecoder().decode(bytes!))).not.toHaveProperty('codec');
  });
  it.each(['machines.managed.acquire', 'machines.managed.credentials.install'] as const)('refuses requester credential custody for foreign %s', actionId => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'managed-root', binding: {
      accountId: 'requester', custodianAccountId: 'company', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode: 'plain',
      actionId, requestId: 'create', requestEnvelopeDigest: 'a'.repeat(43),
      ...(actionId === 'machines.managed.credentials.install' ? { managedAdmission: { actionId, input: {
        homeId: 'home', managedId: 'managed', sessionId: 'session', bindingKey: 'binding',
        expectedResourceRevision: 1, expectedSourceRevision: 'source', expectedProviderTicket: 'ticket',
      } } } : {}),
      target: { kind: 'machine', machineId: 'controller' },
    } });
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization,
      credentials: { token: 'requester-private-bearer' }, purpose: { kind: 'external_action' },
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it.each(['plain', 'e2ee'].flatMap(accountEncryptionMode => ['machines.managed.acquire', 'machines.managed.credentials.install']
    .map(actionId => ({ accountEncryptionMode, actionId }))))('seals only an invocation codec for $actionId ($accountEncryptionMode)', ({ accountEncryptionMode, actionId }) => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-managed-root', binding: {
      accountId: 'requester', custodianAccountId: 'company', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode,
      actionId, requestId: 'create', requestEnvelopeDigest: 'a'.repeat(43),
      ...(actionId === 'machines.managed.credentials.install' ? { managedAdmission: { actionId, input: {
        homeId: 'home', managedId: 'managed', sessionId: 'session', bindingKey: 'binding',
        expectedResourceRevision: 1, expectedSourceRevision: 'source', expectedProviderTicket: 'ticket',
      } } } : {}),
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const sealed = bootstrap.sealManagedControllerActionCodecV1({ authorization, material,
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, machineId: 'controller', installationId: 'controller-installation',
      serverIdentityId: 'home', installationPrivateKey: installation.secretKey };
    expect(bootstrap.openManagedControllerActionCodecV1(input)).toEqual(material);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { kind: 'external_action' } })).toBeNull();
    const bytes = openBoxBundleWithSecretKey({ bundle: decodeBase64(sealed.requesterAccountContext!.ciphertext, 'base64url'),
      recipientSecretKey: ed25519.utils.toMontgomerySecret(installation.secretKey.subarray(0, 32)) });
    expect(JSON.parse(new TextDecoder().decode(bytes!))).toEqual({ v: 1, authorization,
      purpose: { kind: 'managed_controller_codec' }, codec: { machineKey: encodeBase64(material.machineKey) } });
    for (const changed of [{ ...input, machineId: 'other' }, { ...input, installationId: 'other' },
      { ...input, serverIdentityId: 'other' }, { ...input, authorization: { ...sealed, token: 'different-root' } }]) {
      expect(bootstrap.openManagedControllerActionCodecV1(changed)).toBeNull();
    }
    for (const actionId of ['notifications.notify_me', 'action.operations.list', 'action.operations.get']) {
      const changed = { ...authorization, binding: { ...authorization.binding, actionId } };
      expect(() => bootstrap.sealManagedControllerActionCodecV1({ authorization: changed, material,
        installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
      expect(bootstrap.openManagedControllerActionCodecV1({ ...input, authorization: { ...sealed, binding: changed.binding } })).toBeNull();
    }
  });
  it.each(['machines.setup.plan', 'machines.setup.apply', 'machines.setup.remove'] as const)('seals %s target Plan custody only to its exact native read and installed receiver', actionId => {
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
    const sourceMachineId = actionId === 'machines.setup.remove' ? 'receiver' : 'controller';
    const sourceInstallationId = actionId === 'machines.setup.remove' ? 'receiver-installation' : 'controller-installation';
    const appOperands = actionId === 'machines.setup.remove' ? {} : { appChildren: [{
      sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: {
        serverId: 'home', environmentId: 'environment', expectedRevision: 1, targetLinkId: 'runtime',
        expectedTargetLinkRevision: 1, requestKey: 'deploy', contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1,
      },
    }] };
    const params = { homeId: 'home', machineId: 'receiver', mode: 'effects',
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo reviewed' }] } }],
      ...appOperands,
      ...(actionId === 'machines.setup.remove' ? { removeItemKeys: [] } : {}) };
    const rootInput = actionId === 'machines.setup.remove'
      ? { homeId: 'home', machineId: sourceMachineId, sources: params.sources, desiredRevision: 3, removeItemKeys: [], removalPlans: [] }
      : { homeId: 'home', machineId: sourceMachineId, targets: [actionId === 'machines.setup.apply'
        ? { homeId: 'home', machineId: 'receiver', sources: params.sources, desiredRevision: 3, recipePlans: [], ...appOperands } : params] };
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'plan',
      target: { kind: 'machine', machineId: sourceMachineId }, input: ManagedMachineActionInputSchemasV1[actionId].parse(rootInput) });
    expect(readMachineSetupPlanChildInputV1({ rootActionId: actionId, rootInput: envelope.input,
      machineId: 'receiver', input: params })).toEqual(params);
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'setup-root', binding: {
      accountId: 'bob', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: sourceMachineId, installationId: sourceInstallationId, accountEncryptionMode: 'plain',
      actionId, requestId: 'plan', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
    } });
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.MACHINE_SETUP_PLAN,
      params,
      recipient: { machineId: 'receiver', installationId: 'receiver-installation' } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, purpose, machineId: 'receiver', installationId: 'receiver-installation',
      serverIdentityId: 'home', installationPrivateKey: receiver.secretKey };
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input,
      purpose: { ...purpose, params: { ...purpose.params, mode: 'check' } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, machineId: 'other' })).toBeNull();
    if (actionId !== 'machines.setup.remove') {
      const { appChildren: _reviewedApps, ...unreviewedParams } = params;
      expect(readMachineSetupPlanChildInputV1({ rootActionId: actionId, rootInput: envelope.input,
        machineId: 'receiver', input: unreviewedParams })).toBeNull();
      expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input,
        purpose: { ...purpose, params: unreviewedParams } })).toBeNull();
    }
    for (const changed of [{ ...purpose, method: RPC_METHODS.MACHINE_SETUP_REMOVE },
      { ...purpose, recipient: { ...purpose.recipient, machineId: 'other' } },
      { ...purpose, params: { ...purpose.params, homeId: 'other' } }]) {
      expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose: changed,
        installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    }
  });
  it('seals an original deployment root only for its exact referenced child job and installed receiver', () => {
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'deployment-root', binding: {
      accountId: 'bob', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode: 'plain',
      actionId: 'deployments.deploy', requestId: 'deploy', requestEnvelopeDigest: 'a'.repeat(43), deploymentChildRoot: true,
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
      input: { serverId: 'home', environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1,
        expectedTargetLinkRevision: 1, requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
      machineId: 'receiver', installationId: 'receiver-installation', phase: 'activate',
      selectedDeploymentId: 'deployment', deploymentId: 'deployment', actionOperationId: 'operation' });
    const purpose = { kind: 'machine_rpc', method: 'daemon.deployments.child.v1', params: job,
      recipient: { machineId: job.machineId, installationId: job.installationId } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, purpose, machineId: job.machineId, installationId: job.installationId,
      serverIdentityId: 'home', installationPrivateKey: receiver.secretKey };
    expect(sealed.binding).toEqual(authorization.binding);
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    for (const changed of [{ ...job, actionOperationId: 'other' }, { ...job, deploymentId: 'other' },
      { ...job, selectedDeploymentId: 'other' }, { ...job, installationId: 'retired' }]) {
      expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose, params: changed } })).toBeNull();
    }
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      purpose: { ...purpose, recipient: { ...purpose.recipient, installationId: 'retired' } },
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      purpose: { ...purpose, params: { ...job, actionId: 'deployments.rollback' } },
      installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it('keeps read-only builder preparation and first-deploy cleanup on their exact original deployment root', () => {
    const receiver = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'deployment-root', binding: {
      accountId: 'bob', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'controller', installationId: 'controller-installation', accountEncryptionMode: 'plain',
      actionId: 'deployments.deploy', requestId: 'deploy', requestEnvelopeDigest: 'a'.repeat(43), deploymentChildRoot: true,
      target: { kind: 'machine', machineId: 'controller' },
    } });
    const input = { serverId: 'home', environmentId: 'environment', targetLinkId: 'link' };
    const placement = { v: 1, actionId: 'deployments.deploy', machineId: 'receiver', installationId: 'receiver-installation' } as const;
    const jobs = [{ ...placement, kind: 'prepare', input, expectedRevision: 1, expectedTargetLinkRevision: 1 },
      { ...placement, kind: 'member', input: { ...input, expectedRevision: 1, expectedTargetLinkRevision: 1,
        requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 },
      phase: 'cleanup', selectedDeploymentId: 'deployment', deploymentId: 'deployment', actionOperationId: 'operation' }];
    for (const fixture of jobs) {
      const params = DeploymentChildRpcV1Schema.parse(fixture);
      const purpose = { kind: 'machine_rpc', method: 'daemon.deployments.child.v1', params,
        recipient: { machineId: placement.machineId, installationId: placement.installationId } } as const;
      const credentials = { token: 'bob-private', secret: null, encryption: null };
      const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
        installationPublicKey: receiver.publicKey, randomBytes: tweetnacl.randomBytes });
      expect(bootstrap.openExternalActionRequesterAccountContextV1({ authorization: sealed, purpose,
        machineId: placement.machineId, installationId: placement.installationId,
        serverIdentityId: 'home', installationPrivateKey: receiver.secretKey })).toEqual(credentials);
    }
  });
  it('retains the reviewed second-opinion root when sealing exact public spawn custody to its selected installation', () => {
    const recipient = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'opinion-root', binding: {
      accountId: 'bob', custodianAccountId: 'source-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'source', installationId: 'source-installation', accountEncryptionMode: 'plain',
      actionId: 'discussion.second_opinion.start', requestId: 'opinion', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.SESSION_SPAWN_NEW, params: request.input,
      recipient: { machineId: 'machine', installationId: 'recipient-installation' } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: recipient.publicKey, randomBytes: tweetnacl.randomBytes });
    const input = { authorization: sealed, purpose, machineId: 'machine', installationId: 'recipient-installation',
      serverIdentityId: 'home', installationPrivateKey: recipient.secretKey };
    expect(sealed.binding).toEqual(authorization.binding);
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      params: { ...request.input, directory: { kind: 'path', path: '/unreviewed' } } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      method: RPC_METHODS.SPAWN_HAPPY_SESSION } })).toBeNull();
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials,
      purpose: { ...purpose, method: RPC_METHODS.SPAWN_HAPPY_SESSION },
      installationPublicKey: recipient.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it.each(['projects.script.run', 'localServices.launcher.start'] as const)('seals %s Sync preparation only to its named controller and exact request while retaining the worker root', actionId => {
    const worker = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
    const controller = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      serverIdentityId: 'home', machineId: 'worker', installationId: 'worker-installation', accountEncryptionMode: 'plain',
      actionId, requestId: 'run', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'worker' },
    } });
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'controller-installation' },
      request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } } as const;
    const credentials = { token: 'bob-private', secret: null, encryption: null };
    const sealed = bootstrap.sealExternalActionRequesterAccountContextV1({ authorization, credentials, purpose,
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(sealed.binding).toEqual(authorization.binding);
    expect(sealed.requesterAccountContext?.installationId).toBe('controller-installation');
    const input = { authorization: sealed, purpose, machineId: 'controller', installationId: 'controller-installation',
      serverIdentityId: 'home', installationPrivateKey: controller.secretKey };
    expect(bootstrap.openExternalActionRequesterAccountContextV1(input)).toEqual(credentials);
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      request: { ...purpose.request, targetWorkspaceRefId: 'substituted' } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { ...purpose,
      request: { ...purpose.request, sourceWorkspaceRefId: 'substituted' } } })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input,
      installationId: 'another-installation' })).toBeNull();
    expect(bootstrap.openExternalActionRequesterAccountContextV1({ ...input, purpose: { kind: 'external_action' },
      machineId: 'worker', installationId: 'worker-installation', installationPrivateKey: worker.secretKey })).toBeNull();
    expect(() => bootstrap.sealExternalActionRequesterAccountContextV1({ authorization: { ...authorization,
      binding: { ...authorization.binding, actionId: 'projects.open' } }, credentials, purpose,
      installationPublicKey: controller.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
  });
  it('seals a read-only handoff preflight without transfer custody and refuses changed Session input', () => {
    const preflight = { kind: 'requester_session_handoff_preflight_bootstrap_v1', input: {
      sessionId: 'same-session', sourceMachineId: 'source', targetMachineId: 'machine',
      sourceSessionStorageMode: 'persisted', targetPath: '/destination',
    }, requesterBootstrap: request.requesterBootstrap } as const;
    const seal = Reflect.get(bootstrap, 'sealSessionRequesterHandoffPreflightBootstrapRpcRequestV1');
    const open = Reflect.get(bootstrap, 'openSessionRequesterHandoffPreflightBootstrapRpcRequestV1');
    expect(typeof seal).toBe('function');
    expect(typeof open).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing private preflight carrier');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = seal({ request: preflight, installationId: 'installation',
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const read = (value: unknown, installationId = 'installation') => open({ request: value, machineId: 'machine',
      installationId, installationPrivateKey: installation.secretKey });
    expect(read(sealed)).toEqual(preflight);
    expect(read(sealed, 'replacement')).toBeNull();
    expect(read({ ...sealed, input: { ...preflight.input, sessionId: 'another-session' } })).toBeNull();
    expect(bootstrap.openSessionRequesterHandoffBootstrapRpcRequestV1({ request: sealed, machineId: 'machine',
      installationId: 'installation', installationPrivateKey: installation.secretKey })).toBeNull();
  });
  it('seals the existing-Session handoff on the same installed-key carrier without changing its identity', () => {
    const handoff = { kind: 'requester_session_handoff_bootstrap_v1', input: {
      handoffId: 'handoff', operationId: 'operation', sessionId: 'same-session',
      sourceMachineId: 'source', targetMachineId: 'machine', sourceSessionStorageMode: 'persisted',
      negotiatedTransportStrategy: 'server_routed_stream', targetPath: '/destination', endpointCandidates: [],
    }, requesterBootstrap: request.requesterBootstrap } as const;
    const seal = Reflect.get(bootstrap, 'sealSessionRequesterHandoffBootstrapRpcRequestV1');
    const open = Reflect.get(bootstrap, 'openSessionRequesterHandoffBootstrapRpcRequestV1');
    expect(typeof seal).toBe('function');
    expect(typeof open).toBe('function');
    if (typeof seal !== 'function' || typeof open !== 'function') throw new Error('Missing private handoff carrier');
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = seal({ request: handoff, installationId: 'installation',
      installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const read = (value: unknown, installationId = 'installation', installationPrivateKey = installation.secretKey) =>
      open({ request: value, machineId: 'machine', installationId, installationPrivateKey });
    expect(read(sealed)).toEqual(handoff);
    expect(read(sealed, 'replacement')).toBeNull();
    expect(read(sealed, 'installation', tweetnacl.sign.keyPair().secretKey)).toBeNull();
    expect(read({ ...sealed, input: { ...handoff.input, sessionId: 'different-session' } })).toBeNull();
    expect(read({ ...sealed, input: { ...handoff.input, sourceMachineId: 'different-source' } })).toBeNull();
    expect(SessionHandoffPrepareTargetRequestSchema.safeParse({ ...handoff.input, predecessorExtension: true }).success).toBe(true);
    expect(() => seal({ request: { ...handoff, input: { ...handoff.input, predecessorExtension: true } },
      installationId: 'installation', installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    expect(bootstrap.openSessionRequesterBootstrapRpcRequestV1({ request: sealed, machineId: 'machine',
      installationId: 'installation', installationPrivateKey: installation.secretKey })).toBeNull();
  });
  it.each(['retain', 'retire'] as const)('seals %s Workflow custody on the existing private installation carrier', operation => {
    const scoped = { kind: 'requester_session_bootstrap_v1', scope: 'workflow_trigger',
      input: { executionTarget: { serverId: 'server', machineId: 'machine' }, scopeId: 'trigger-or-direct-run', automationId: 'automation', operation },
      requesterBootstrap: request.requesterBootstrap } as const;
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = bootstrap.sealSessionRequesterBootstrapRpcRequestV1({ request: scoped,
      installationId: 'installation', installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(bootstrap.SessionRequesterBootstrapRpcRequestV1Schema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const open = (value: unknown, installationId = 'installation') => bootstrap.openSessionRequesterBootstrapRpcRequestV1({
      request: value, machineId: 'machine', installationId, installationPrivateKey: installation.secretKey });
    expect(open(sealed)).toEqual(scoped);
    expect(open(sealed, 'another-installation')).toBeNull();
    expect(open({ ...sealed, input: { ...scoped.input, scopeId: 'another-trigger' } })).toBeNull();
    expect(open({ ...sealed, input: { ...scoped.input, automationId: 'another-automation' } })).toBeNull();
    expect(open({ ...sealed, input: { ...scoped.input, operation: operation === 'retain' ? 'retire' : 'retain' } })).toBeNull();
    expect(open({ ...sealed, scope: 'session' })).toBeNull();
  });

  it('carries no requester sign-in bytes and opens only for the current exact installation and authored input', () => {
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const sealed = bootstrap.sealSessionRequesterBootstrapRpcRequestV1({ request,
      installationId: 'installation', installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    expect(bootstrap.SessionRequesterBootstrapRpcRequestV1Schema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.token);
    expect(JSON.stringify(sealed)).not.toContain(request.requesterBootstrap.credentials.secret);
    const open = (value: unknown, installationId = 'installation', installationPrivateKey = installation.secretKey) =>
      bootstrap.openSessionRequesterBootstrapRpcRequestV1({ request: value, machineId: 'machine', installationId, installationPrivateKey });
    expect(open(sealed)).toEqual(request);
    expect(open(sealed, 'replacement-installation')).toBeNull();
    expect(open(sealed, 'installation', tweetnacl.sign.keyPair().secretKey)).toBeNull();
    expect(open(sealed, 'installation', installation.secretKey.subarray(0, 32))).toBeNull();
    expect(open({ ...sealed, input: { ...request.input, directory: { kind: 'path', path: '/another' } } })).toBeNull();
    const ciphertext = sealed.requesterBootstrap.ciphertext;
    expect(open({ ...sealed, requesterBootstrap: { ...sealed.requesterBootstrap,
      ciphertext: `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}` } })).toBeNull();
  });

  it('rejects malformed or small-order installation keys before sealing sensitive material', () => {
    for (const installationPublicKey of [new Uint8Array(31), new Uint8Array(32)]) {
      expect(() => bootstrap.sealSessionRequesterBootstrapRpcRequestV1({ request, installationId: 'installation',
        installationPublicKey, randomBytes: tweetnacl.randomBytes })).toThrow();
    }
  });
});
