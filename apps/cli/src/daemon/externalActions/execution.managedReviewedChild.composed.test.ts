import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createHostReviewedChildPortV1, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { dispatchManagedMachineAdminAccess, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

it.each(['requester', 'team'] as const)('restores admitted Create review on the guest when controller custody is %s', async controllerAccountId => {
  const currentness = await createRequesterCurrentnessSocketHarness();
  onTestFinished(async () => { vi.restoreAllMocks(); await currentness.close(); });
  const homeId = 'srv_reviewed_creation', serverUrl = 'https://reviewed-creation.test';
  const controller = { machineId: 'controller', installationId: 'controller-installation' };
  const guest = { machineId: 'guest', installationId: 'guest-installation' };
  const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const authentication = { kind: 'account' as const, tokenEpoch: 1 };
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const input = ManagedAcquireInputV1Schema.parse({
    enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'server', adminAccessAtCreation: 'none' },
    selection: { kind: 'one-off', homeId, controller,
      launch: { provider: { pluginId: 'example.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
  });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-create', binding: {
    accountId: 'requester', custodianAccountId: controllerAccountId, authentication, accountEncryptionMode: 'plain',
    serverIdentityId: homeId, actionId: 'machines.managed.acquire', requestId: 'reviewed-create',
    machineId: controller.machineId, installationId: controller.installationId,
    target: { kind: 'machine', machineId: controller.machineId }, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  const adminInput = { serverId: homeId, machineId: guest.machineId, expectedMetadataVersion: 0,
    expectedAdminAccess: { version: 1 as const, mode: 'none' as const },
    adminAccess: { version: 1 as const, mode: 'none' as const }, comparison: 'field' as const };
  const nativeEffects: unknown[] = [], asks: unknown[] = [];
  const executor = createCliActionExecutorHarness({ token, credentials, mode: 'plain', ctx: null,
    sessionId: '', serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
    externalActionMachineInstallationId: guest.installationId, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
      accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
        actions: { 'machines.setup.adminAccess.set': { approvalRequiredSurfaces: ['ui'] } } } }) }),
    // The physical guest Machine RPC is the effect boundary, after real Action policy.
    machineActionDirectTargetTransport: { machineId: guest.machineId, invoke: async (method, value) => {
      expect(method).toBe('machines.setup.adminAccess.set'); nativeEffects.push(value);
      return { status: 'applied', policy: { version: 1, mode: 'none' }, metadataVersion: 1 };
    } },
  }, { approvalsCreate: async ({ request }) => { asks.push(request); return { artifactId: 'unexpected-guest-ask' }; } }).executor;
  // Home credential/currentness and signed-root issuance are network boundaries.
  // The real source dispatcher seals its reviewed parent; the guest opens it,
  // prepares its own Account custody and runs the ordinary CLI Action executor.
  vi.spyOn(axios, 'get').mockImplementation(async rawUrl => {
    const path = new URL(String(rawUrl)).pathname;
    if (path.endsWith('/account/profile')) return { status: 200, data: { id: 'requester' } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path.endsWith('/v1/machines/controller')) return { status: 200, data: { machine: {
      id: controller.machineId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      access: { custodian: { accountId: controllerAccountId, displayName: 'Controller custodian' },
        role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    throw new Error(`Unexpected Home GET ${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (rawUrl, rawBody) => {
    const path = new URL(String(rawUrl)).pathname;
    if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
    if (path.endsWith('/v1/machines/managed/controller/context')) return { status: 200, data: {
      requestId: authorization.binding.requestId, enrollmentInstallation: { ...guest,
        installationPublicKey: Buffer.from(guestKeys.publicKey).toString('base64url') } } };
    if (path !== '/v1/actions/machines.setup.adminAccess.set') throw new Error(`Unexpected Home POST ${path}`);
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(rawBody);
    expect(body.envelope.managedCreationCodec).toBeDefined();
    const childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-guest-child', binding: {
      ...authorization.binding, custodianAccountId: 'requester', machineId: guest.machineId,
      installationId: guest.installationId, actionId: 'machines.setup.adminAccess.set',
      target: body.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
      managedContinuation: { ...body.managedContinuation, controller,
        acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest },
    } });
    const receive = (receivedAuthorization = childAuthorization) => executeExternalAction({ actionId: 'machines.setup.adminAccess.set', envelope: body.envelope,
      executionAuthorization: receivedAuthorization, principal: { accountId: 'requester', authority: 'present_user', authentication },
      currentMachineId: guest.machineId, currentAccountId: 'requester', currentInstallationId: guest.installationId,
      currentServerId: homeId, currentServerHttpBaseUrl: serverUrl, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', ...guest, role: 'manage', encryptionMode: 'plain' },
      verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
        installationId: guest.installationId, privateKey: guestKeys.secretKey, serverHttpBaseUrl: serverUrl }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, ...guest, installationPrivateKey: guestKeys.secretKey,
        serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: credentials,
        isCurrent: async () => !request.signal?.aborted, createExecutor: () => executor }),
    });
    const received = await receive();
    // The verified codec still binds requester, controller and enrolled guest;
    // custody delegation cannot make another root's continuation executable.
    for (const changedBinding of [
      { ...childAuthorization.binding, accountId: 'other-account' },
      { ...childAuthorization.binding, managedContinuation: { ...childAuthorization.binding.managedContinuation,
        controller: { ...controller, machineId: 'other-controller' } } },
      { ...childAuthorization.binding, target: { kind: 'machine' as const, machineId: 'other-guest' } },
    ]) {
      expect(await receive(ExternalActionExecutionAuthorizationV1Schema.parse({ ...childAuthorization,
        binding: changedBinding }))).toMatchObject({ kind: 'invalid_request' });
    }
    expect(received.kind).toBe('response');
    if (received.kind !== 'response') throw new Error(`Guest dispatch refused: ${received.kind}`);
    return { status: 200, data: received.response };
  });
  const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: 'requester', serverId: homeId, serverIdentityId: homeId,
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
    actionRequestId: authorization.binding.requestId, defaultSessionMachineId: controller.machineId };
  const declaration = getActionSpec('machines.managed.acquire').hostReviewedChildren;
  const children = typeof declaration === 'function' ? declaration(input) : declaration ?? [];
  const reviewed = createHostReviewedChildPortV1({ actionId: 'machines.managed.acquire', input, context,
    reviewAdmitted: true, plan: { children }, policies: children.map(child => ({ action: child.action, role: child.role, surface: 'ui' })),
    execute: async (_input, childContext) => dispatchManagedMachineAdminAccess({ input: adminInput, serverId: homeId,
      context: childContext, authorization, authority: 'present_user', installationId: controller.installationId,
      privateKey: controllerKeys.secretKey, serverHttpBaseUrl: serverUrl,
      homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, authority: 'current_connection' }),
      continuation: { managedId: 'managed', creationRequestId: authorization.binding.requestId, expectedIntentRevision: 0 } }),
  });
  const result = await reviewed.invoke({ action: 'machines.setup.adminAccess.set', role: 'machines.setup.adminAccess.set',
    input: normalizeStrictJsonValue(adminInput) });
  expect(asks.length, JSON.stringify(result)).toBe(0);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'applied', policy: { mode: 'none' } } });
  expect(nativeEffects).toEqual([adminInput]);
  expect(asks).toEqual([]);
}, 120_000);
