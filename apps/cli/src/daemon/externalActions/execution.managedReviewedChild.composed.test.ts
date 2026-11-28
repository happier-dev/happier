import axios from 'axios';
import { tmpdir } from 'node:os';
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
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { mutateMachineAdminAccessV1, readMachineAdminAccessV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { MachineAdminAccessSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machine/adminAccess';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { initializeManagedMachineEnrollmentPolicies } from '@/machines/managed/enrollmentPolicy';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { createEnrollmentJourneyProviderAuthority } from '@/machines/managed/enrollmentJourney.testkit';
import { fixture as createManagedCustodyFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import type { ManagedMachineAcquisitionDriverInput } from '@/machines/managed/acquire';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { dispatchManagedMachineAdminAccess, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeRequesterCredentials } from '@/persistence';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createDaemonApprovalExecutionAuthorizationPreparer } from './approvalExecutionAuthorization';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

// Preset acquisitions (app Create one, CLI preset) omit the controller; Home's continuation names it (#160 op dbe4cd8c).
// A sealed preset's policy children are opened only by its keyholder controller; the public declaration omits them (F14, #161).
it.each([['requester', true, 'one-off', 'ui'], ['team', true, 'one-off', 'ui'], ['team', false, 'one-off', 'ui'],
  ['team', false, 'preset', 'ui'], ['team', true, 'preset', 'ui'], ['requester', true, 'one-off', 'agent'],
  // A controller signed in through terminal pairing carries terminal authentication (L12 r197-r202).
  ['requester', true, 'one-off', 'agent', 'terminal'],
  ['requester', true, 'one-off', 'agent', 'terminal', 'delayed administrator result']] as const)(
  'restores admitted Create review on the guest when controller custody is %s (input names controller: %s, selection: %s, surface: %s, authentication: %s) %s',
  async (controllerAccountId, inputNamesController, selectionKind, surface, authenticationKind: 'account' | 'terminal' = 'account', scenario?: string) => {
  const currentness = await createRequesterCurrentnessSocketHarness();
  onTestFinished(async () => { vi.restoreAllMocks(); await currentness.close(); });
  const homeId = 'srv_reviewed_creation', serverUrl = 'https://reviewed-creation.test';
  const controller = { machineId: 'controller', installationId: 'controller-installation' };
  const guest = { machineId: 'guest', installationId: 'guest-installation' };
  const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(18));
  const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const authentication = { kind: authenticationKind, tokenEpoch: 1 };
  const tokenFor = (accountId: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
    provenance: { v: 1, kind: authenticationKind, authority: 'present_user' } })).toString('base64url')}.signature`;
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
  const delayedChild = scenario === 'delayed administrator result';
  const guestEntered = Promise.withResolvers<void>();
  const releaseGuest = Promise.withResolvers<void>();
  const guestMetadata = {};
  const guestOperations = createHostActionOperationRuntime({ machineId: guest.machineId, resolveAccountId: async () => 'requester',
    generateOperationId: () => 'guest-admin-operation' });
  onTestFinished(() => { releaseGuest.resolve(); });
  let differentInstalledAccountResult: Awaited<ReturnType<typeof executeExternalAction>> | undefined;
  let storedChildRoot: ReturnType<typeof ExternalActionExecutionAuthorizationV1Schema.parse> | undefined;
  const harness = createCliActionExecutorHarness({ token, credentials, mode, ctx: null,
    sessionId: '', serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
    externalActionMachineInstallationId: guest.installationId, externalActionMachineRequestPrivateKey: guestKeys.secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
      accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
        actions: { 'machines.setup.adminAccess.set': { approvalRequiredSurfaces: [surface] } } } }) }),
    // The physical guest Machine RPC is the effect boundary, after real Action policy.
    machineActionDirectTargetTransport: { machineId: guest.machineId, invoke: async (method, value) => {
      expect(method).toBe('machines.setup.adminAccess.set'); nativeEffects.push(value);
      if (delayedChild) {
        const { serverId: _serverId, machineId: _machineId, ...mutation } = MachineAdminAccessSetInputV1Schema.parse(value);
        return mutateMachineAdminAccessV1(mutation, {
          read: async () => {
            guestEntered.resolve();
            await releaseGuest.promise;
            return { status: 'ready', metadata: guestMetadata, metadataVersion: 0 };
          },
          compareAndSwap: async () => { throw new Error('An unchanged default policy must not write'); },
        });
      }
      return { status: 'applied', policy: { version: 1, mode: 'none' }, metadataVersion: 1 };
    } },
  }, { ...(delayedChild ? { runActionOperation: guestOperations.runActionOperation } : {}),
    approvalsCreate: async ({ request }) => { asks.push(request); return { artifactId: 'unexpected-guest-ask' }; } });
  const executor = harness.executor;
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
    if (delayedChild && path === '/v1/actions/machines.agentIsolation.preview') {
      return { status: 503, data: { error: 'target_unavailable' } };
    }
    if (path !== '/v1/actions/machines.setup.adminAccess.set') throw new Error(`Unexpected Home POST ${path}`);
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(rawBody);
    expect(body.envelope.managedCreationCodec).toBeDefined();
    const childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-guest-child', binding: {
      ...authorization.binding, custodianAccountId: 'requester', machineId: guest.machineId,
      installationId: guest.installationId, actionId: 'machines.setup.adminAccess.set',
      target: body.envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
      ...(delayedChild ? { admittedMachineRole: 'manage' } : {}),
      managedContinuation: { ...body.managedContinuation, controller,
        acquireRequestEnvelopeDigest: authorization.binding.requestEnvelopeDigest },
    } });
    storedChildRoot = childAuthorization;
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
  const homeTarget = resolveHomeTargetFromDescriptor({ descriptor: { v: 1, homeServerIdentityId: homeId,
    canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] }, authority: 'current_connection' });
  const dispatchAdmin = (childContext: ActionExecutorContext) => dispatchManagedMachineAdminAccess({ input: adminInput, serverId: homeId,
    context: childContext, authorization, authority, installationId: controller.installationId,
    ...(mode === 'e2ee' ? { material } : {}),
    observeRecordedApprovalExecution: controllerObserver.observeRecordedApprovalExecution,
    privateKey: controllerKeys.secretKey, serverHttpBaseUrl: serverUrl,
    homeTarget,
    continuation: { managedId: 'managed', creationRequestId: authorization.binding.requestId, expectedIntentRevision: 0 } });
  const reviewed = createHostReviewedChildPortV1({ actionId: 'machines.managed.acquire', input, context,
    reviewAdmitted: true, plan: { children }, policies: children.map(child => ({ action: child.action, role: child.role, surface })),
    execute: async (_input, childContext) => dispatchAdmin(childContext),
  });
  if (delayedChild) {
    const controllerRequester = await prepareRequesterAccountActionContext({
      authorization: sealExternalActionRequesterAccountContextV1({ authorization,
        credentials: encodeRequesterCredentials(credentials), purpose: { kind: 'external_action' },
        installationPublicKey: controllerKeys.publicKey, randomBytes: nacl.randomBytes }),
      purpose: { kind: 'external_action' }, ...controller, installationPrivateKey: controllerKeys.secretKey,
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl,
      isCurrent: async () => true, createExecutor: () => controllerObserver,
    });
    if (!controllerRequester) throw new Error('Controller requester preparation failed');
    onTestFinished(() => controllerRequester.dispose?.());
    const launch = { provider: { pluginId: 'example.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
    const enrolled = ManagedMachineFullV1Schema.parse({
      id: 'managed', homeId, custodianAccountId: 'requester', controller, launch, allocation: 'bound',
      resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} }, enrolledMachineId: guest.machineId,
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user',
        role: 'server', adminAccessAtCreation: 'none' },
    });
    const { runtimeRegistry } = createManagedCustodyFixture();
    const driver: ManagedMachineAcquisitionDriverInput = { controller, homeId, homeTarget, serverUrl, credentials, token, runtimeRegistry,
      managedProviderOperationAuthority: createEnrollmentJourneyProviderAuthority(tmpdir()),
      externalActionMachineRequestPrivateKey: controllerKeys.secretKey,
      observeRecordedApprovalExecution: controllerObserver.observeRecordedApprovalExecution,
    };
    const controllerOperations = createHostActionOperationRuntime({ machineId: controller.machineId,
      resolveAccountId: async () => 'requester', generateOperationId: () => 'controller-acquire-operation' });
    const execution = controllerOperations.runActionOperation({ actionId: 'machines.managed.acquire', input,
      context: { ...context, externalActionExecutionAuthorization: controllerRequester.authorization,
        approvedActionReplay: { artifactId: 'reviewed-create-approval' } },
      execute: async operation => {
        try {
          await initializeManagedMachineEnrollmentPolicies(driver, enrolled, { requestId: authorization.binding.requestId,
            signal: operation.signal, context: { ...operation, hostReviewedChild: reviewed } });
          return { ok: true, result: {} };
        } catch (error) {
          if (!(error instanceof ManagedMachineControllerError)) throw error;
          return error.toActionFailure('machines.managed.acquire');
        }
      } });
    onTestFinished(async () => { releaseGuest.resolve(); await execution.catch(() => undefined); });
    await Promise.race([guestEntered.promise, execution]);
    const running = await controllerOperations.handlers.getV2({ operationId: 'controller-acquire-operation' });
    expect(running).toMatchObject({ kind: 'found', operation: { state: 'running', progress: { phase: 'machines.setup.adminAccess.set' } } });
    const settled = controllerOperations.handlers.getV2({ operationId: 'controller-acquire-operation', waitForTerminal: true });
    releaseGuest.resolve();
    expect(await guestOperations.handlers.getV2({ operationId: 'guest-admin-operation', waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded', result: { status: 'unchanged', policy: { mode: 'none' } } } });
    expect(readMachineAdminAccessV1(guestMetadata)).toMatchObject({ policy: { mode: 'none' } });
    expect(asks).toEqual([]);
    // The next child is deliberately unavailable at the HTTP boundary. Its
    // phase proves that the controller consumed the real administrator result.
    expect(await settled).toMatchObject({ kind: 'found', operation: {
      state: 'failed', progress: { phase: 'machines.agentIsolation.preview' }, error: { errorCode: 'target_unavailable' },
    } });
    await execution;
    return;
  }
  // The keyholder controller derives a sealed preset's policy from its opened
  // row and dispatches it directly under the acquire's reviewed context (enrollmentPolicy.ts).
  const result = selectionKind === 'preset' ? await dispatchAdmin({ ...context, hostReviewedChild: reviewed })
    : await reviewed.invoke({ action: 'machines.setup.adminAccess.set', role: 'machines.setup.adminAccess.set',
      input: normalizeStrictJsonValue(adminInput) });
  // A guest Ask on this child stores the root without private ports (L12 r197).
  // Its approved replay reopens the same own-guest-Account custody as ingress.
  const stored = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(storedChildRoot)));
  const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ ...guest, serverId: homeId, serverBaseUrl: serverUrl,
    daemonWorkSignal: new AbortController().signal,
    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: guest.machineId }),
    prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
      purpose: { kind: 'external_action' }, ...guest, installationPrivateKey: guestKeys.secretKey,
      serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl: serverUrl, ownCredentials: credentials,
      isCurrent: async () => true, createExecutor: () => executor }) });
  const prepared = await prepare({ authorization: stored });
  onTestFinished(async () => { await prepared?.dispose?.(); });
  expect(prepared?.authorization.token).toBe(stored.token);
  // The approved replay passes the child's own Project admission on that prepared root (L12 r202:
  // `signed_root_projection` after the replay preparer ran). Only admission is asserted here;
  // the guest Machine RPC behind it is outside this fixture.
  const replayed: unknown = await harness.deps.machineAdminAccessAction!({ actionId: 'machines.setup.adminAccess.set', input: adminInput,
    context: { surface, authority, actionCaller: sessionActionOrigin?.caller ?? { kind: 'host' }, runtimeAccountId: 'requester',
      serverId: homeId, serverIdentityId: homeId, actionRequestId: stored.binding.requestId,
      externalActionExecutionAuthorization: prepared!.authorization, externalActionTarget: stored.binding.target },
    signal: new AbortController().signal }).catch((error: unknown) => error);
  expect(replayed, JSON.stringify(replayed)).not.toMatchObject({ errorCode: 'project_requester_authority_unavailable' });
  expect(readRequesterAccountActionContext(prepared?.authorization)?.credentials.token).toBe(token);
  expect(result, JSON.stringify({ result, asks: asks.length })).toMatchObject({ ok: true, result: { status: 'applied', policy: { mode: 'none' } } });
  if (surface === 'agent') {
    expect(differentInstalledAccountResult).toMatchObject({
      kind: 'invalid_request', errorCode: 'invalid_encrypted_envelope', requestId: authorization.binding.requestId,
    });
  }
  expect(nativeEffects).toEqual([adminInput]);
  expect(asks).toEqual([]);
}, 120_000);
