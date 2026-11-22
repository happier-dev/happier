import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createHostReviewedChildPortV1, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { dispatchManagedMachineAdminAccess, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

// Preset acquisitions (app Create one, CLI preset) omit the controller; Home's continuation names it (#160 op dbe4cd8c).
// A sealed preset's policy children are opened only by its keyholder controller; the public declaration omits them (F14, #161).
it.each([['requester', true, 'one-off', 'ui'], ['team', true, 'one-off', 'ui'], ['team', false, 'one-off', 'ui'],
  ['team', false, 'preset', 'ui'], ['team', true, 'preset', 'ui'], ['requester', true, 'one-off', 'agent']] as const)(
  'restores admitted Create review on the guest when controller custody is %s (input names controller: %s, selection: %s, surface: %s)',
  async (controllerAccountId, inputNamesController, selectionKind, surface) => {
  const currentness = await createRequesterCurrentnessSocketHarness();
  onTestFinished(async () => { vi.restoreAllMocks(); await currentness.close(); });
  const homeId = 'srv_reviewed_creation', serverUrl = 'https://reviewed-creation.test';
  const controller = { machineId: 'controller', installationId: 'controller-installation' };
  const guest = { machineId: 'guest', installationId: 'guest-installation' };
  const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const authentication = { kind: 'account' as const, tokenEpoch: 1 };
  const tokenFor = (accountId: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const token = tokenFor('requester');
  const secret = new Uint8Array(32).fill(20);
  const mode = surface === 'agent' ? 'e2ee' : 'plain';
  const credentials = { token, encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
  const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
  const sourceSession = createSessionRecordFixture({ id: 'reviewed-create-source-session', active: true, share: null,
    encryptionMode: 'e2ee', machineId: controller.machineId, metadata: encryptSessionPayload({
      ctx: { encryptionVariant: 'legacy', encryptionKey: secret }, payload: { machineId: controller.machineId },
    }) });
  const sessionActionOrigin = surface === 'agent' ? SessionActionRpcOriginV1Schema.parse({ v: 1,
    caller: { kind: 'session', sessionId: sourceSession.id, starterDepth: 0, turnDepth: 1 }, sourceTurnId: 'agent-turn',
    callerPermissionMode: 'yolo', causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
    requestId: 'reviewed-create' }) : undefined;
  const authority = sessionActionOrigin ? 'account_automation' : 'present_user';
  const input = ManagedAcquireInputV1Schema.parse(selectionKind === 'preset'
    ? { selection: { kind: 'preset', homeId, id: 'sealed-preset', revision: 1 }, ...(inputNamesController ? { controller } : {}) }
    : {
    enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
      role: 'server', adminAccessAtCreation: 'none' },
    selection: { kind: 'one-off', homeId, ...(inputNamesController ? { controller } : {}),
      launch: { provider: { pluginId: 'example.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
  });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-create', binding: {
    accountId: 'requester', custodianAccountId: controllerAccountId, authentication, accountEncryptionMode: mode,
    serverIdentityId: homeId, actionId: 'machines.managed.acquire', requestId: 'reviewed-create',
    machineId: controller.machineId, installationId: controller.installationId,
    target: { kind: 'machine', machineId: controller.machineId }, requestEnvelopeDigest: 'a'.repeat(43),
    ...(sessionActionOrigin ? { sessionActionOrigin, sessionActionSource: controller } : {}),
  } });
  const adminInput = { serverId: homeId, machineId: guest.machineId, expectedMetadataVersion: 0,
    expectedAdminAccess: { version: 1 as const, mode: 'none' as const },
    adminAccess: { version: 1 as const, mode: 'none' as const }, comparison: 'field' as const };
  const nativeEffects: unknown[] = [], asks: unknown[] = [];
  let differentInstalledAccountResult: Awaited<ReturnType<typeof executeExternalAction>> | undefined;
  const executor = createCliActionExecutorHarness({ token, credentials, mode, ctx: null,
    sessionId: '', serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
    externalActionMachineInstallationId: guest.installationId, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
      accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
        actions: { 'machines.setup.adminAccess.set': { approvalRequiredSurfaces: [surface] } } } }) }),
    // The physical guest Machine RPC is the effect boundary, after real Action policy.
    machineActionDirectTargetTransport: { machineId: guest.machineId, invoke: async (method, value) => {
      expect(method).toBe('machines.setup.adminAccess.set'); nativeEffects.push(value);
      return { status: 'applied', policy: { version: 1, mode: 'none' }, metadataVersion: 1 };
    } },
  }, { approvalsCreate: async ({ request }) => { asks.push(request); return { artifactId: 'unexpected-guest-ask' }; } }).executor;
  // The original approval may precede a daemon reload. Model the source
  // observer's installed credential read as unavailable after the child replies.
  const controllerObserver = createCliActionExecutorFromCredentials({ credentials, serverId: homeId, serverApiUrl: serverUrl,
    readCredentials: async () => null });
  // Home credential/currentness and signed-root issuance are network boundaries.
  // The real source dispatcher seals its reviewed parent; the guest opens it,
  // prepares its own Account custody and runs the ordinary CLI Action executor.
  const differentAccountToken = tokenFor('different-installed-account');
  vi.spyOn(axios, 'get').mockImplementation(async (rawUrl, config) => {
    const path = new URL(String(rawUrl)).pathname;
    if (path.endsWith('/account/profile')) return { status: 200, data: {
      id: config?.headers?.Authorization === `Bearer ${differentAccountToken}` ? 'different-installed-account' : 'requester',
    } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
    if (path.endsWith('/encryption/currentness')) return { status: 200, data: { mode, version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 } };
    if (path.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1,
      content: mode === 'plain' ? { t: 'plain', v: {} } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
        kind: 'account_settings', material: { type: 'legacy', secret }, payload: {}, randomBytes: nacl.randomBytes }) } } };
    if (path.endsWith(`/v2/sessions/${sourceSession.id}`)) return { status: 200, data: { session: sourceSession } };
    if (path === '/v1/artifacts') return { status: 200, data: { items: [], hasUnclassified: false } };
    if (path.endsWith('/v1/machines/controller')) return { status: 200, data: { machine: {
      id: controller.machineId, metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      access: { custodian: { accountId: controllerAccountId, displayName: 'Controller custodian' },
        role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
    throw new Error(`Unexpected Home GET ${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    if (request.url === `${serverUrl}${AUTOMATION_ACTION_INDEX_HTTP_PATH_V1}` && request.method === 'GET') {
      return { status: 200, data: { v: 1, rows: [] } };
    }
    throw new Error('Unexpected Home request');
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
    const receive = (receivedAuthorization = childAuthorization, installedCredentials = credentials) => executeExternalAction({
      actionId: 'machines.setup.adminAccess.set', envelope: body.envelope,
      executionAuthorization: receivedAuthorization, principal: { accountId: 'requester', authority, authentication,
        ...(sessionActionOrigin ? { sessionActionOrigin } : {}) },
      currentMachineId: guest.machineId, currentAccountId: 'requester', currentInstallationId: guest.installationId,
      currentServerId: homeId, currentServerHttpBaseUrl: serverUrl, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'requester', ...guest, role: 'manage', encryptionMode: mode },
      signal: new AbortController().signal,
      ...(mode === 'e2ee' ? { resolveEncryption: async () => ({ serverIdentityId: homeId, material }) } : {}),
      verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
        installationId: guest.installationId, privateKey: guestKeys.secretKey, serverHttpBaseUrl: serverUrl }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: installedCredentials }), executor,
      prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
        purpose: { kind: 'external_action' }, ...guest, installationPrivateKey: guestKeys.secretKey,
        serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: installedCredentials,
        isCurrent: async () => !request.signal?.aborted, createExecutor: () => executor }),
    });
    const received = await receive();
    // The verified codec still binds requester, controller and enrolled guest;
    // custody delegation cannot make another root's continuation executable.
    for (const changedBinding of [
      { ...childAuthorization.binding, accountId: 'other-account' },
      { ...childAuthorization.binding, custodianAccountId: 'other-account' },
      { ...childAuthorization.binding, managedContinuation: { ...childAuthorization.binding.managedContinuation,
        controller: { ...controller, machineId: 'other-controller' } } },
      { ...childAuthorization.binding, target: { kind: 'machine' as const, machineId: 'other-guest' } },
    ]) {
      expect(await receive(ExternalActionExecutionAuthorizationV1Schema.parse({ ...childAuthorization,
        binding: changedBinding }))).toMatchObject({ kind: 'invalid_request' });
    }
    if (surface === 'agent') {
      // Even with a genuine sealed child and unchanged requested Account, a
      // different installed holder may never perform the native effect.
      differentInstalledAccountResult = await receive(childAuthorization, { ...credentials, token: differentAccountToken });
    }
    expect(received.kind).toBe('response');
    if (received.kind !== 'response') throw new Error(`Guest dispatch refused: ${received.kind}`);
    return { status: 200, data: received.response };
  });
  const context: ActionExecutorContext = { surface, authority, actionCaller: sessionActionOrigin?.caller ?? { kind: 'host' },
    runtimeAccountId: 'requester', serverId: homeId, serverIdentityId: homeId,
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
    actionRequestId: authorization.binding.requestId, defaultSessionMachineId: controller.machineId,
    signal: new AbortController().signal };
  const declaration = getActionSpec('machines.managed.acquire').hostReviewedChildren;
  const children = typeof declaration === 'function' ? declaration(input) : declaration ?? [];
  const dispatchAdmin = (childContext: ActionExecutorContext) => dispatchManagedMachineAdminAccess({ input: adminInput, serverId: homeId,
    context: childContext, authorization, authority, installationId: controller.installationId,
    ...(mode === 'e2ee' ? { material } : {}),
    observeRecordedApprovalExecution: controllerObserver.observeRecordedApprovalExecution,
    privateKey: controllerKeys.secretKey, serverHttpBaseUrl: serverUrl,
    homeTarget: resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
      canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, authority: 'current_connection' }),
    continuation: { managedId: 'managed', creationRequestId: authorization.binding.requestId, expectedIntentRevision: 0 } });
  const reviewed = createHostReviewedChildPortV1({ actionId: 'machines.managed.acquire', input, context,
    reviewAdmitted: true, plan: { children }, policies: children.map(child => ({ action: child.action, role: child.role, surface })),
    execute: async (_input, childContext) => dispatchAdmin(childContext),
  });
  // The keyholder controller derives a sealed preset's policy from its opened
  // row and dispatches it directly under the acquire's reviewed context (enrollmentPolicy.ts).
  const result = selectionKind === 'preset' ? await dispatchAdmin({ ...context, hostReviewedChild: reviewed })
    : await reviewed.invoke({ action: 'machines.setup.adminAccess.set', role: 'machines.setup.adminAccess.set',
      input: normalizeStrictJsonValue(adminInput) });
  expect(result, JSON.stringify({ result, asks: asks.length })).toMatchObject({ ok: true, result: { status: 'applied', policy: { mode: 'none' } } });
  if (surface === 'agent') {
    expect(differentInstalledAccountResult).toMatchObject({
      kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: authorization.binding.requestId,
    });
  }
  expect(nativeEffects).toEqual([adminInput]);
  expect(asks).toEqual([]);
}, 120_000);
