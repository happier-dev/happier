import { createNativeSoftwareInstallFixture, osStore } from '@/testkit/machines/nativeSoftwareInstall';
import type { WorkflowRunStorageOperation } from '@happier-dev/protocol/workflows/workflowRunStorageV1';
import { exercisePublicPackagePlanApply, withNativeConfirmation } from '@/testkit/machines/nativeSoftwareInstallFlow';
import { nativeTerminal } from '@/testkit/machines/nativeSoftwareOs';
import axios, { AxiosHeaders } from 'axios';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ExternalActionMachineBootstrapV1Schema, ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

import { configuration } from '@/configuration';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MachineSetupSourceV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { Machine } from '@/api/types';
import { ApiMachineClient } from './apiMachine';
import { createMachineSetupAction, createMachineSetupPlanAction } from '@/machines/setup/machineSetupAction';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineSetupReportInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { MachineSetupApplyInputV1Schema, MachineSetupResolveInputV1Schema, MachineSetupSourcesApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createWorkflowRunStorageClient, WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { buildMachineSetupWorkflow } from '@/machines/setup/composeMachineSetup';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { AccountSettingsSchema, FeaturesResponseSchema, WorkflowDefinitionV1Schema } from '@happier-dev/protocol';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readMachineSetupAcceptedAppRuns, prepareMachineSetupAcceptedAppRuns } from '@/machines/setup/acceptedAppRuns';
import { sealWorkflowProgressStoredEnvelopeV1, sealWorkflowCheckpointStoredEnvelopeV1,
  serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import type { WorkflowProgressEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { projectManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import { createPlainSetupPresetFixture } from '@/testkit/machines/setupPreset';

describe('ApiMachine own Session Account read custody', () => {
  it.skipIf(process.platform === 'win32')('keeps Plan read-only with or without a carried native confirmation', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'native-confirm' });
    const executor = fixture.createExecutor(osStore.credentials!);
    const input = { homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects' as const, sources: fixture.sources };
    const context = fixture.context('machines.setup.plan');
    expect(await executor.execute('machines.setup.plan', input, withNativeConfirmation('machines.setup.plan', input, context)))
      .toMatchObject({ ok: true });
    expect(await executor.execute('machines.setup.plan', input, context)).toMatchObject({ ok: true });
    expect(await fixture.readInstalled()).toEqual({ installed: false, version: null, effects: [] });
    expect(fixture.metadataWrites).toHaveLength(0);
    expect(fixture.rootLaunches).toHaveLength(0);
  });
  it.skipIf(process.platform === 'win32')('refuses confirmed Apply when the receiving host cannot bind its request owner', async () => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'native-confirm' });
    const planned = MachineSetupPlanResultV1Schema.parse(await fixture.machineSetupPlan({
      input: { homeId: 'srv_home', machineId: fixture.machine.id, mode: 'effects', sources: fixture.sources },
      context: fixture.context('machines.setup.plan'),
    }));
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, desiredRevision: planned.desiredRevision,
        sources: planned.sources, recipePlans: planned.recipePlans ?? [] }] });
    const unavailable = createHostActionOperationRuntime({ machineId: fixture.machine.id, resolveAccountId: async () => null });
    const executor = fixture.createExecutor(osStore.credentials!, { runActionOperation: unavailable.runActionOperation });
    const admitted = fixture.context('machines.setup.apply', 'unowned-native-request');
    const context = withNativeConfirmation('machines.setup.apply', input, { ...admitted, machineAdmission: undefined });
    expect(context.operationAcceptance).toBeUndefined();
    expect(await executor.execute('machines.setup.apply', input, context))
      .toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(await fixture.readInstalled()).toEqual({ installed: false, version: null, effects: [] });
    expect(fixture.metadataWrites).toHaveLength(0);
    expect(fixture.rootLaunches).toHaveLength(0);
  });
  it.skipIf(process.platform === 'win32').each(['first-absent', 'first-present', 'first-arrived', 'first-forged-absent', 'first-absent-e2ee', 'excluded-to-selected'] as const)(
    'publishes native first-presence through exact public Plan → P10 Apply (%s)', scenario => exercisePublicPackagePlanApply(scenario),
  );
  it.skipIf(process.platform === 'win32').each(['remove-absent', 'remove-absent-e2ee'] as const)(
    'removes only selected declared effects after native first-absence (%s)', scenario => exercisePublicPackagePlanApply(scenario),
  );
  it.each(['unchecked-new', 'same-item-second-source', 'unchanged-unknown', 'account-copy', 'foreign-owned-personal-copy', 'foreign-unowned-personal-copy'] as const)('keeps unknown initial presence unknown after real Apply success: %s', async scenario => {
    const personalCopy = scenario === 'foreign-owned-personal-copy' || scenario === 'foreign-unowned-personal-copy';
    const accountCopy = scenario === 'account-copy' || personalCopy;
    const actor = personalCopy ? 'bob' : 'alice';
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    osStore.credentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    const ref = { pluginId: 'com.example.initial-presence', recipeId: 'software', revision: '1' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } };
    const setup = { items: [item] };
    const bundled = { kind: 'bundledPreset' as const, ref: { pluginId: ref.pluginId, localId: 'bundle', revision: '1' }, setup };
    const account = await createPlainSetupPresetFixture({ presetId: 'ordinary-copy', presetRevision: 1,
      setup: { ...setup, ...(personalCopy ? { secretRefs: { v: 1 as const, bindings: { PRIVATE: { ref: 'alice-secret' } } } } : {}) } });
    const candidateRequest = { homeId: 'srv_home', machineId: 'alice-machine',
      candidatePreset: { presetId: account.wire.presetId, presetRevision: account.wire.presetRevision } };
    const originRequest = { homeId: 'srv_home', machineId: 'alice-machine', purpose: 'creationOrigin', candidates: [account.wire] };
    const exclusions = [{ ref, reason: 'not_selected' as const }];
    const previous = scenario !== 'unchecked-new' ? [{ kind: 'direct' as const, setup }] : [{ kind: 'direct' as const, setup: {} }];
    const runtime = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController, coldStart: true,
      plugins: [{ files: {}, manifest: { schemaVersion: 2, id: ref.pluginId, version: '1.0.0', displayName: 'Initial presence',
        runtime: { apiVersion: 1 }, contributes: { machineRecipes: [{ id: ref.recipeId, revision: ref.revision, title: 'Software', software: true,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [] }],
        machineSetupPresets: [{ id: bundled.ref.localId, revision: bundled.ref.revision, title: 'Bundle', description: 'Initial presence fixture bundle', setup }] } } }] });
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    // Home HTTP is the custody boundary: a personal-secret Preset still needs
    // its existing source-owner check, independently of the admitted actor.
    const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, body: unknown, options) => {
      expect(options?.headers).not.toHaveProperty('Authorization');
      if (accountCopy && body !== null && typeof body === 'object'
        && 'purpose' in body && body.purpose === 'creationOrigin') {
        return { status: 200, data: { purpose: 'creationOrigin' } };
      }
      if (accountCopy) {
        expect(body).toEqual(candidateRequest);
        return scenario !== 'foreign-unowned-personal-copy'
          ? { status: 200, data: { sources: [account.resolved, { kind: 'direct', setup: {} }] } }
          : { status: 403, data: { error: 'credential_unavailable' } };
      }
      throw new Error('Ordinary setup copies cannot demand Preset certification');
    });
    const machine: Machine = { id: 'alice-machine', encryptionMode: 'plain', metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
      metadata: { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
        setup: { version: 1, revision: 0, sources: previous, exclusions: scenario === 'unchanged-unknown' ? exclusions : [] } } };
    const client = new ApiMachineClient(token, machine);
    const registration = client.setRPCHandlers({ spawnSession: async () => { throw new Error('Not a Session'); },
      stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} });
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => ({
      result: 'success', version: machine.metadataVersion + 1,
      metadata: payload && typeof payload === 'object' && 'metadata' in payload ? payload.metadata : undefined,
    }) }));
    const apply = createMachineSetupAction({ apiMachine: client, machineId: machine.id, homeId: 'srv_home',
      installation: { installationId: osStore.identity.installationId, privateKey: pair.secretKey } });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupApply: request => apply({ ...request,
      input: request.input.targets[0]!, context: request.context as RpcActionExecutorContext }) });
    const input = { homeId: 'srv_home', machineId: machine.id, targets: [{ homeId: 'srv_home', machineId: machine.id,
      desiredRevision: 0, exclusions, recipePlans: [], sources: scenario === 'unchanged-unknown' ? [
        { kind: 'direct' as const, setup },
      ] : [
        accountCopy ? account.wire : bundled,
        { kind: 'direct' as const, setup: scenario === 'same-item-second-source' ? setup : {} },
      ] }] };
    const operations = createHostActionOperationRuntime({ machineId: machine.id,
      custodyBinding: { serverId: configuration.activeServerId, installationId: osStore.identity.installationId },
      resolveAccountId: async () => 'alice', generateOperationId: () => `initial-${scenario}` });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-initial', binding: {
      accountId: actor, custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      machineId: machine.id, installationId: osStore.identity.installationId, serverIdentityId: 'srv_home',
      actionId: 'machines.setup.apply', requestId: `initial-${scenario}`, requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: machine.id },
    } });
    const context: RpcActionExecutorContext = { surface: 'rpc', actionRequestId: `initial-${scenario}`,
      signal: new AbortController().signal, externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      machineAdmission: { actorAccountId: actor, custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      const before = JSON.stringify(input);
      const result = await operations.observeExecution({ actionId: 'machines.setup.apply', input, actionRequestId: context.actionRequestId,
        rpcContext: context, execute: owned => executor.execute('machines.setup.apply', input,
          withNativeConfirmation('machines.setup.apply', input, { ...context, ...owned })) });
      if (scenario === 'foreign-unowned-personal-copy') {
        expect(result).toMatchObject({ ok: false, errorCode: 'machine_setup_request_failed' });
        expect(post.mock.calls.map(([, body]) => body)).toEqual([candidateRequest]);
        expect(machine.metadataVersion).toBe(0);
        return;
      }
      expect(post.mock.calls.map(([, body]) => body)).toEqual(accountCopy ? [candidateRequest, originRequest] : []);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const saved = await client.getMachineSetupDesiredSnapshot();
      expect(saved.status).toBe('ready');
      if (saved.status !== 'ready') throw new Error('Expected target-owned desired copy');
      expect(saved.policy.sourceFacts).toBeUndefined();
      expect(saved.policy.sources.every(source => !Object.hasOwn(source, 'alreadyPresentAtFirstApply'))).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
      expect(machine.metadataVersion).toBe(scenario === 'unchanged-unknown' ? 0 : 1);
      if (scenario === 'unchanged-unknown') expect(saved.policy.revision).toBe(0);
      expect(post).toHaveBeenCalledTimes(accountCopy ? 2 : 0);
    } finally {
      await registration.dispose(); await runtime.dispose(); profile.mockRestore(); post.mockRestore(); osStore.identity = null; osStore.credentials = null;
    }
  });
  it('signs a Workflow Role RPC with the actual installed executor and exact Session target', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(39));
    osStore.identity = { version: 1, installationId: 'workflow-installation', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const client = new ApiMachineClient('owner-token', { id: 'run-executor', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-workflow-proof', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'home', machineId: 'run-executor', installationId: 'workflow-installation', actionId: 'session.notes.set',
      requestId: 'notes', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'session', sessionId: 'origin' },
      workflowActionOrigin: { runId: 'run', requestId: 'notes', sessionAuthority: { authorization: {
        principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, runDepth: 4,
        runOriginSessionId: 'origin', directory: '/repo', workspaceWrites: 'allow' } },
    } });
    const observed: unknown[] = [];
    // Only Socket.IO delivery is substituted. The production adapter, codec,
    // installed signer and strict schema/signature consumer all remain real.
    const socket = { connected: true, emit() {}, async emitWithAck(event: string, payload: unknown) {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      const wire = JSON.parse(JSON.stringify(payload)) as SocketRpcRequestPayload;
      const execution = ExternalActionMachineRpcExecutionV1Schema.parse(wire.externalActionExecution);
      observed.push(execution);
      expect(verifyExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
        effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
        event: SOCKET_RPC_EVENTS.CALL, method: wire.method, requestId: wire.requestId!, params: wire.params,
        publicKey: pair.publicKey, signature: execution.machineSignature })).toBe(true);
      expect(wire.method).toBe('origin:session.notes.set');
      expect(wire.authorization).toEqual({ kind: 'session.write', sessionId: 'origin' });
      return { ok: true, result: { updated: true } };
    } };
    try {
      Object.defineProperty(client, 'socket', { value: socket, writable: true, configurable: true });
      const request = { sessionId: 'origin', method: 'session.notes.set', input: { sessionId: 'origin', notes: 'Run note' },
        content: { mode: 'plain' as const }, executionAuthorization: authorization };
      expect(await client.callSessionActionRpc(request)).toEqual({ updated: true });
      expect(observed).toHaveLength(1);
      await expect(client.callSessionActionRpc({ ...request, sessionId: 'unrelated' }))
        .rejects.toMatchObject({ code: 'role_rpc_origin_unavailable' });
      expect(observed).toHaveLength(1);
    } finally {
      Object.defineProperty(client, 'socket', { value: null, writable: true, configurable: true });
      osStore.identity = null;
    }
  });
  it('consumes Bob admitted original Account ports for his Session on Alice installation without reading Alice credentials', async () => {
    const installationReads = vi.spyOn(await import('@/daemon/identity/store'), 'readInstallationIdentityIfExistsSync');
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null };
    osStore.reads.length = 0;
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    let live = true;
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'bob-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'stable-home', machineId: machine.id, installationId: osStore.identity.installationId,
      actionId: 'machines.terminal.open', requestId: 'bob-open', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
    } });
    try {
      const http = await projectExternalActionRequesterHttpAuthorization({ authorization: root, serverId: configuration.activeServerId,
        serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://bob-home.test', target: root.binding.target,
        installationId: osStore.identity.installationId, privateKey: pair.secretKey, isCurrent: async () => live });
      if (!http) throw new Error('Original HTTP custody missing');
      const authorization = await projectRequesterAccountActionAuthorization({ authorization: http, serverIdentityId: 'stable-home',
        bootstrap: { credentials: { token: 'bob-token', encryption: null }, serverHttpBaseUrl: 'https://bob-home.test',
          attribution: { serverId: configuration.activeServerId, accountId: 'bob', machineId: machine.id, installationId: osStore.identity.installationId },
          isCurrent: async () => live } });
      if (!authorization) throw new Error('Private custody missing');
      const ingress: RpcHandlerContext = { signal: new AbortController().signal, callerInputAuthorization: authorization,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
          installationId: osStore.identity.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => live };
      installationReads.mockClear();
      const runtime = await client.resolveOwnSessionRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'bob', machineId: machine.id, serverId: configuration.activeServerId });
      expect(runtime).not.toHaveProperty('credentials');
      expect(osStore.reads).toEqual([]);
      expect(installationReads.mock.calls.length, 'requester read custody reads installation only at admission').toBe(1);
      osStore.identity = { ...osStore.identity!, installationId: 'replacement-installation' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      expect(installationReads.mock.calls.length, 'retained requester reads consume admitted installation').toBe(1);
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      osStore.identity = { ...osStore.identity, installationId: root.binding.installationId };
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'cara' } })).resolves.toBeNull();
      live = false;
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      expect(osStore.credentials.token).toBe('alice-token');
      installationReads.mockImplementationOnce(() => { throw new Error('Installation file unavailable'); });
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
    } finally { get.mockRestore(); post.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('supplies installed Account provenance for local observation without granting missing-admission effects or foreign Session reads', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    const lifetime = new AbortController();
    const ingress: RpcHandlerContext = { signal: lifetime.signal };
    try {
      expect(await client.resolveMachineSetupRuntime(ingress)).toBeNull();
      expect(await client.resolveOwnSessionRuntime({ ...ingress,
        machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
          installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true })).toBeNull();
      const runtime = await client.resolveInstalledAccountObservationRuntime(lifetime.signal);
      expect(runtime).toMatchObject({ accountId: 'alice', machineId: machine.id, serverId: configuration.activeServerId,
        credentials: osStore.credentials });
      expect(await runtime?.isCurrent?.()).toBe(true);
      osStore.credentials = { token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session' };
      expect(await runtime?.isCurrent?.()).toBe(true);
      expect(await client.resolveInstalledAccountObservationRuntime(lifetime.signal)).toBeNull();
    } finally { profile.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it.each(['new-preset', 'retained-copy', 'foreign-personal', 'manage-direct', 'owner-direct', 'changed-review', 'report-fallback-retry', 'managed-plan', 'managed-apply-rejected', 'managed-app-item', 'managed-app-child', 'accepted-app-run', 'accepted-app-run-catalog', 'accepted-app-run-unreadable'] as const)('composes source setup (%s) with real installed custody and the registered finite terminal owner', async scenario => {
    const accountChannel = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => accountChannel.close());
    const acceptedApp = scenario === 'accepted-app-run' || scenario === 'accepted-app-run-catalog' || scenario === 'accepted-app-run-unreadable';
    const directScript = scenario === 'manage-direct' || scenario === 'owner-direct';
    const directScriptBody = 'echo raw-direct-setup';
    let refuseRunRead = false;
    let refuseProgressRead = false;
    let progressHttpReads = 0;
    let holdTemplateProgress: Promise<void> | undefined;
    let observeTemplateProgress: (() => void) | undefined;
    let observeDeployProgress: (() => void) | undefined;
    let readExecutor: ReturnType<typeof createCliActionExecutorFromCredentials> | undefined;
    let readCurrent: (() => Promise<boolean>) | undefined;
    let appMemberOrdinal = '';
    let templateMemberOrdinal = '';
    const actor = acceptedApp || scenario === 'owner-direct' ? 'alice' : 'bob';
    const runId = '81111111-1111-4111-8111-111111111111';
    const workflowHostMachineId = 'different-workflow-host';
    const runStorage = createWorkflowRunStorageTestkit({ runId, machineId: workflowHostMachineId, accountId: 'alice', origin: { kind: 'direct' } });
    const templateRef = { sourceId: 'catalog', itemId: 'app', version: '1', ref: { kind: 'version' as const, version: '1' } };
    const appIntent = { name: 'Reviewed app', project: { kind: 'existing' as const, projectSourceId: 'source' },
      definition: scenario === 'accepted-app-run-catalog'
        ? { from: 'catalogApp' as const, templateRef: { ...templateRef, itemId: 'deployed-app' } }
        : { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] }, bindings: [] };
    const templateIntent = { name: 'Reviewed template app', project: { kind: 'existing' as const, projectSourceId: 'source' },
      definition: { from: 'catalogApp' as const, templateRef }, bindings: [] };
    const templateChild = { sourceIndex: 1, itemIndex: 1, actionId: 'deployments.templates.instantiate' as const, input: {
      mode: 'apply' as const, serverId: 'srv_home', machineId: 'alice-machine', projectSourceId: 'source', templateRef,
      environment: { kind: 'create' as const, name: templateIntent.name, requestKey: 'reviewed-template',
        protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
        controllerMachineId: 'alice-machine' },
      target: { kind: 'new' as const, installationId: '11111111-1111-4111-8111-111111111111' },
      destination: { kind: 'stored' as const }, bindings: [],
    } };
    const appChild = { sourceIndex: 1, itemIndex: 0, actionId: 'deployments.deploy' as const, input: {
      serverId: 'srv_home', environmentId: 'environment', expectedRevision: 1, targetLinkId: 'runtime', expectedTargetLinkRevision: 1,
      requestKey: 'reviewed-app', contentArtifactId: 'receipt', contentHeaderVersion: 1, contentBodyVersion: 1,
    } };
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.signature`;
    osStore.credentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    nativeTerminal.launches.length = 0;
    // Reset without narrowing `exit` to undefined for the rest of the scenario; the PTY mock re-binds it.
    Object.assign(nativeTerminal, { exit: undefined });
    const nativeSetupLaunch = new Promise<void>(resolve => { nativeTerminal.onLaunch = resolve; });
    nativeTerminal.autoExit = directScript || scenario === 'changed-review' || scenario === 'managed-app-item' || scenario === 'managed-app-child' || scenario === 'accepted-app-run-unreadable';
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: 'plain' });
    const settings = AccountSettingsSchema.parse({});
    const profile = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200,
      data: acceptedApp && String(url).endsWith('/v1/machines')
        ? [{ ...ExternalActionMachineBootstrapV1Schema.parse({ id: 'alice-machine', active: true,
          revokedAt: null, replacedByMachineId: null }), activeAt: Date.now() }]
        : String(url).endsWith('/v1/account/encryption/currentness')
        ? currentness
        : acceptedApp && /\/v[12]\/account\/settings$/u.test(String(url))
          ? { version: 1, content: { t: 'plain', v: settings } }
        : acceptedApp && String(url).endsWith('/v1/account/encryption') ? { mode: 'plain', updatedAt: 1 }
        : { id: 'alice' } }));
    const reports: string[] = [];
    const preset = await createPlainSetupPresetFixture({ presetId: 'preset', presetRevision: 4,
      setup: { scripts: [{ body: '\r\necho actual-setup\r\n', affects: 'none' }] } });
    const retained = preset.local;
    const retainedScript = retained.setup.scripts?.[0];
    if (!retainedScript) throw new Error('Source setup fixture must retain its authored script');
    const desiredRevision = scenario === 'retained-copy' || acceptedApp ? 2 : 0;
    const sources = [retained, { kind: 'direct' as const, setup: scenario === 'managed-apply-rejected' ? { items: [{ kind: 'setupRecipe' as const,
        selection: { ref: { pluginId: 'com.example.unadmitted', recipeId: 'unadmitted', revision: '1' }, inputs: {} } }] }
        : acceptedApp ? { items: [{ kind: 'app' as const, definition: appIntent,
          ...(appIntent.definition.from === 'compose' ? { authoredKey: 'authored-compose-app' } : {}) },
          { kind: 'app' as const, definition: templateIntent }] }
        : scenario === 'managed-app-item' ? { items: [{ kind: 'app' as const, definition: { name: 'Creation app',
          project: { kind: 'create' as const }, definition: { from: 'compose' as const, document: 'services: {}', profiles: [], services: [] }, bindings: [] } }] } : {} }];
    const wireSources = projectManagedOpaqueSetupSourcesV1(sources);
    let resolves = 0;
    let originReads = 0;
    let succeededReportFailed = false;
    let advanceDesired = () => {};
    const transport = vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      if (String(url).endsWith(WORKFLOW_RUN_STORAGE_HTTP_PATH)) {
        expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid workflow storage request');
        const operation: Record<string, unknown> = Object.fromEntries(Object.entries(body));
        if (refuseRunRead && operation.operation === 'get') throw Object.assign(new Error('Run read denied'), {
          response: { status: 403, data: { error: 'run_access_denied' } },
        });
        if (operation.operation === 'invocations.list') {
          progressHttpReads++;
          if (refuseProgressRead) throw new Error('Progress unavailable at HTTP boundary');
          if (operation.parentRecordId !== null && operation.memberOrdinal === templateMemberOrdinal && holdTemplateProgress) {
            observeTemplateProgress?.();
            await holdTemplateProgress;
          }
        }
        // The server's opaque storage is the genuine network boundary. Run
        // admission, frozen input, envelope opening and public read stay real.
        // The HTTP body is the untyped network boundary; the storage testkit owns operation semantics.
        const data = await runStorage.execute({ ...operation, operation: String(operation.operation) as WorkflowRunStorageOperation['operation'] });
        if (operation.operation === 'invocations.list' && operation.parentRecordId !== null && operation.memberOrdinal === appMemberOrdinal
          && observeDeployProgress) {
          observeDeployProgress();
        }
        return { status: 200, data };
      }
      expect(options?.headers).not.toHaveProperty('Authorization');
      expect(options?.headers).toMatchObject({ [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: scenario === 'managed-plan' ? 'machines.setup.plan' : 'machines.setup.apply',
        [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'home-issued-setup' });
      if (String(url).endsWith('/resolve')) {
        const selected = MachineSetupResolveInputV1Schema.parse(body);
        if ('purpose' in selected) {
          originReads++;
          expect(selected).toEqual({ homeId: 'srv_home', machineId: 'alice-machine', purpose: 'creationOrigin', candidates: [preset.wire] });
          if (scenario === 'changed-review') advanceDesired();
          if (scenario !== 'report-fallback-retry') return { status: 200, data: { purpose: 'creationOrigin' } };
          // Home returns the matching pending creation. A lost terminal report
          // does not undo its target's completed native operation.
          expect(reports).toEqual([]);
          return { status: 200, data: { purpose: 'creationOrigin',
            creation: { managedId: 'managed', preset: { id: retained.presetId, revision: retained.presetRevision } } } };
        }
        resolves++;
        // The original Preset has since changed; its retained Machine copy is
        // not a request for revision history from the Home.
        if (scenario === 'retained-copy' || scenario === 'managed-apply-rejected') return { status: 409, data: { error: 'request_conflict' } };
        if ('candidatePreset' in selected) {
          expect(selected).toEqual({ homeId: 'srv_home', machineId: 'alice-machine',
            candidatePreset: { presetId: retained.presetId, presetRevision: retained.presetRevision } });
          return { status: 200, data: { sources: [preset.resolved, { kind: 'direct', setup: {} }] } };
        }
        if (!('sources' in selected)) throw new Error('Expected canonical source setup');
        expect(selected.sources).toEqual(wireSources);
        return { status: 200, data: { sources: selected.sources.map(source => source.kind === 'accountPresetOpaque' ? preset.resolved : source),
          creation: { managedId: 'managed', preset: { id: retained.presetId, revision: retained.presetRevision } } } };
      }
      expect(String(url)).toMatch(/\/v1\/machines\/setup\/report$/u);
      const report = MachineSetupReportInputV1Schema.parse(body);
      if (!('state' in report)) throw new Error('Expected Setup state report');
      const { state } = report;
      if (scenario === 'report-fallback-retry' && state === 'succeeded' && !succeededReportFailed) {
        succeededReportFailed = true;
        return { status: 503, data: { error: 'temporarily_unavailable' } };
      }
      reports.push(state);
      return { status: 200, data: { ok: true } };
    });
    const metadata = { host: 'worker', platform: 'linux', happyCliVersion: 'dev', homeDir: '/users/worker', happyHomeDir: '/users/worker/.happier',
      ...(scenario === 'retained-copy' || acceptedApp ? { setup: { version: 1 as const, revision: desiredRevision, sources, exclusions: [] } } : {}) };
    const machine: Machine = { id: 'alice-machine', encryptionMode: 'plain',
      metadata, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    advanceDesired = () => {
      // A genuine incoming metadata publication may advance the desired field
      // while the receiving Action is awaiting the Home attachment resolver.
      machine.metadata = { ...metadata, setup: { version: 1, revision: 1, exclusions: [],
        sources: [{ kind: 'direct', setup: { scripts: [{ body: 'new reviewed intent', affects: 'none' }],  } }] } };
      machine.metadataVersion++;
    };
    const client = new ApiMachineClient(token, machine);
    client.setRPCHandlers({ spawnSession: async () => { throw new Error('Not a Session'); },
      stopSession: async () => ({ status: 'not_found' }), requestShutdown() {} });
    Reflect.set(client, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: async (_event, payload) => ({
      result: 'success', version: machine.metadataVersion + 1,
      metadata: payload && typeof payload === 'object' && 'metadata' in payload ? payload.metadata : undefined,
    }) }));
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: machine.id, targets: [{ homeId: 'srv_home', machineId: machine.id,
      desiredRevision, recipePlans: [],
      ...(acceptedApp ? { appChildren: [appChild, templateChild] } : {}),
      ...(scenario === 'managed-app-child' ? { appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.environments.create',
        input: { serverId: 'srv_home', requestKey: 'creation-app', projectSourceId: 'source', contentArtifactId: 'content',
          contentHeaderVersion: 1, contentBodyVersion: 1, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
          controllerMachineId: machine.id } }] } : {}),
      sources: scenario === 'foreign-personal' ? [{ kind: 'direct', setup: {
        scripts: [{ body: 'echo private', affects: 'none' }],  secretRefs: { v: 1, bindings: { PRIVATE: { ref: 'alice-secret' } } },
      } }] : directScript ? [{ kind: 'direct', setup: { scripts: [{ body: directScriptBody, affects: 'none' }] } }] : wireSources }] });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-setup', binding: {
      accountId: actor, custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 7 }, accountEncryptionMode: 'plain',
      machineId: machine.id, installationId: osStore.identity.installationId, serverIdentityId: input.homeId,
      actionId: scenario === 'managed-plan' ? 'machines.setup.plan' : 'machines.setup.apply', requestId: 'setup-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id },
      ...(scenario === 'managed-plan' || scenario === 'managed-apply-rejected' || scenario === 'managed-app-item' || scenario === 'managed-app-child' ? { managedContinuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0,
        controller: { machineId: 'controller', installationId: 'controller-installation' }, acquireRequestEnvelopeDigest: 'b'.repeat(43) } } : {}),
    } });
    let repeatedAdmissionReads = 0;
    const setupLifetime = new AbortController();
    let context: RpcActionExecutorContext = { surface: 'rpc', actionRequestId: 'setup-request', signal: setupLifetime.signal,
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
      machineAdmission: { actorAccountId: actor, custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => { repeatedAdmissionReads++; return true; } };
    let execution: Promise<import('@happier-dev/protocol/actions/actionExecutionResult').ActionExecuteResult> | undefined;
    let operations: ReturnType<typeof createHostActionOperationRuntime> | undefined;
    let observedOperationId: string | undefined;
    try {
      if (acceptedApp) {
        const storage = createWorkflowRunStorageClient({ token, serverHttpBaseUrl: 'https://machine-home.example.test' });
        const owner = createWorkflowRunActionOwner({ storage, resolveAccountId: async () => actor,
          definitions: { get: async () => { throw new Error('Inline setup has no saved definition'); } },
          resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
          prepareWorkspace: async () => ({ ok: true, workspaceTarget: { project: {
            machineId: workflowHostMachineId, directory: '/reviewed', checkoutRootPath: '/reviewed' } } }),
          resolveMaterializationContext: async () => ({ effects: { resolveTargetAvailability: async () => true,
            readActionContract: async actionId => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(actionId)))) } }),
        });
        const produced = buildMachineSetupWorkflow(input);
        const definition = WorkflowDefinitionV1Schema.parse({ ...produced, blocks: produced.blocks.map(block => {
          if (block.kind === 'action' && block.actionId === appChild.actionId) return { ...block, id: 'actual-reviewed-child' };
          if (block.kind === 'action' && block.actionId === templateChild.actionId) return { ...block, id: 'actual-reviewed-template-child' };
          return block;
        }) });
        const child = definition.blocks.find(block => typeof block === 'object' && block.kind === 'action' && block.actionId === appChild.actionId);
        if (!child || typeof child !== 'object') throw new Error('Missing real app child producer');
        appMemberOrdinal = String(definition.blocks.indexOf(child));
        const template = definition.blocks.find(block => block.kind === 'action' && block.actionId === templateChild.actionId);
        if (!template) throw new Error('Missing real template child producer');
        templateMemberOrdinal = String(definition.blocks.indexOf(template));
        const start = WorkflowRunStartRequestV1Schema.parse({ runId, executionTarget: { kind: 'session' }, source: { kind: 'inline', definition } });
        await expect(owner.execute({ actionId: 'workflow.run.start', input: start, context: { surface: 'cli', authority: 'present_user',
          actionCaller: { kind: 'host' }, callerPermissionMode: 'default', externalActionTarget: { kind: 'machine', machineId: workflowHostMachineId,
            project: { machineId: workflowHostMachineId, directory: '/reviewed' } } } })).resolves.toMatchObject({ admission: 'created' });
        // Workflows consumes the canonical Automations feature dependency.
        const features = FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } },
          capabilities: { serverIdentity: { serverIdentityId: input.homeId } } });
        vi.stubGlobal('fetch', async (request: string | URL | Request) => {
          const path = new URL(String(request)).pathname;
          if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
          if (path === '/v1/account/encryption/currentness') return Response.json(currentness);
          throw new Error(`Unexpected requester HTTP read: ${path}`);
        });
        setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: resolveAccountSettingsScopeKeyForToken(token)!,
          loadedAtMs: 1, settingsVersion: 1, settingsSecretsReadKeys: [], settings });
        onTestFinished(() => { vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
        const requesterExecutor = createCliActionExecutorFromCredentials({ credentials: osStore.credentials!,
          serverId: configuration.activeServerId, serverIdentityId: input.homeId, serverApiUrl: 'https://machine-home.example.test',
          pluginActionExecutionOwner: 'current_process' });
        readExecutor = requesterExecutor;
        const acceptedRunRead = await requesterExecutor.execute('workflow.run.get', { runId, includeUsage: false }, {
          surface: 'cli', authority: 'account_automation', actionCaller: { kind: 'host' },
          serverIdentityId: input.homeId,
        });
        if (!acceptedRunRead.ok) throw new Error(`Accepted Run fixture read refused: ${acceptedRunRead.errorCode}`);
        expect(acceptedRunRead).toMatchObject({ ok: true, result: { run: { machineId: workflowHostMachineId },
          acceptedContext: { machineId: workflowHostMachineId, materializedLeaves: expect.arrayContaining([
          expect.objectContaining({ blockId: 'actual-reviewed-child', actionId: appChild.actionId, actionInput: appChild.input }),
        ]) } } });
        const requesterRuntime = await client.resolveOwnSessionRuntime({ ...context, signal: setupLifetime.signal });
        if (!requesterRuntime?.isCurrent) throw new Error('Requester runtime custody missing');
        readCurrent = requesterRuntime.isCurrent;
        const projected = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: input.homeId,
          bootstrap: { credentials: osStore.credentials!, serverHttpBaseUrl: 'https://machine-home.example.test',
            attribution: { serverId: configuration.activeServerId, accountId: actor, machineId: machine.id,
              installationId: osStore.identity.installationId }, isCurrent: requesterRuntime.isCurrent } });
        if (!projected) throw new Error('Requester read custody missing');
        context = { ...context, externalActionExecutionAuthorization: { ...projected, requesterAccountProjection: projected.requesterAccountProjection,
          requesterAccountExecutor: requesterExecutor,
          binding: { ...projected.binding, workflowActionOrigin: { runId, requestId: projected.binding.requestId } } } };
        refuseRunRead = scenario === 'accepted-app-run-unreadable';
      }
      if (scenario === 'managed-plan') {
        const plan = createMachineSetupPlanAction({ apiMachine: client, machineId: machine.id, homeId: input.homeId,
          installation: { installationId: osStore.identity.installationId, privateKey: pair.secretKey } });
        expect(await plan({ input: { homeId: input.homeId, machineId: machine.id, sources: wireSources, mode: 'effects' }, context }))
          .toMatchObject({ desiredRevision: 0, sources: wireSources });
        expect(resolves).toBe(1);
        expect(reports).toEqual([]);
        expect(nativeTerminal.launches).toEqual([]);
        return;
      }
      const apply = createMachineSetupAction({ apiMachine: client, machineId: machine.id, homeId: input.homeId,
        installation: { installationId: osStore.identity.installationId, privateKey: pair.secretKey } });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), machineSetupApply: request => apply({ ...request,
        input: request.input.targets[0]!, context: request.context as RpcActionExecutorContext }) });
      let operationCount = 0;
      operations = createHostActionOperationRuntime({ machineId: machine.id,
        custodyBinding: { serverId: configuration.activeServerId, installationId: osStore.identity.installationId },
        resolveAccountId: async () => 'alice', generateOperationId: () => operationCount++ === 0 ? 'setup-operation' : 'setup-retry-operation' });
      execution = operations.observeExecution({ actionId: 'machines.setup.apply', input,
        actionRequestId: context.actionRequestId, rpcContext: context,
        onOperation: operation => { observedOperationId = operation.operationId; },
        execute: async owned => {
          if (!acceptedApp) return await executor.execute('machines.setup.apply', input,
            withNativeConfirmation('machines.setup.apply', input, { ...context, ...owned }));
          const result = await apply({ input: input.targets[0]!, context: { ...context, ...owned } });
          const refused = ActionExecuteFailureSchema.safeParse(result);
          return refused.success ? refused.data : { ok: true, result };
        },
      });
      void execution.catch(() => undefined);
      if (directScript) {
        expect(await execution).toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(nativeTerminal.launches).toHaveLength(1);
        expect(nativeTerminal.launches[0]?.args).toContain(directScriptBody);
        return;
      }
      if (scenario === 'managed-app-item') {
        // The native leaf may retain inert legacy app intent. Only an actual
        // reviewed app child can publish correspondence or execute deployment.
        expect(await execution).toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(nativeTerminal.launches).toHaveLength(1);
        expect(nativeTerminal.launches[0]?.args).toContain(retainedScript.body);
        expect(reports).toEqual(['running', 'succeeded']);
        expect(resolves).toBe(1);
        expect(transport.mock.calls.some(([url]) => String(url).endsWith(WORKFLOW_RUN_STORAGE_HTTP_PATH))).toBe(false);
        const desired = await client.getMachineSetupDesiredSnapshot();
        expect(desired).toMatchObject({ status: 'ready', policy: { sources } });
        if (desired.status !== 'ready') throw new Error('Missing native settled desired state');
        expect(desired.policy).not.toHaveProperty('sourceFacts');
        return;
      }
      if (scenario === 'managed-app-child') {
        expect(await execution).toMatchObject({ ok: false, errorCode: 'machine_setup_app_preparation_unavailable' });
        expect(nativeTerminal.launches).toEqual([]);
        expect(reports).toEqual([]);
        // The receiving child validates Home's retained creation snapshot once
        // before rejecting the unauthenticated app-child correspondence.
        expect(resolves).toBe(1);
        expect(machine.metadataVersion).toBe(0);
        const observed = await operations.handlers.getV2({ operationId: 'setup-operation' }, context);
        if (observed.kind !== 'found') throw new Error('Missing receiving refusal');
        expect(observed.operation.domainRef?.kind === 'machineSetup' ? observed.operation.domainRef.setupTask : undefined).toBeUndefined();
        return;
      }
      if (scenario === 'managed-apply-rejected') {
        expect(await execution).toMatchObject({ ok: false, errorCode: 'machine_setup_request_failed' });
        expect(resolves).toBe(1);
        expect(nativeTerminal.launches).toEqual([]);
        expect(reports).toEqual([]);
        return;
      }
      if (scenario === 'changed-review') {
        expect(await execution).toMatchObject({ ok: false, errorCode: 'plan_changed' });
        // An admitted finite Apply consumes its captured script. A competing
        // desired edit is preserved by final CAS, not re-admitted per step.
        expect(nativeTerminal.launches).toHaveLength(1);
        expect(nativeTerminal.launches[0]?.args).toContain(retainedScript.body);
        expect(machine.metadataVersion).toBe(1);
        expect(await client.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready', policy: { revision: 1,
          sources: [{ kind: 'direct', setup: { scripts: [{ body: 'new reviewed intent' }] } }] } });
        return;
      }
      if (scenario === 'foreign-personal') {
        expect(await execution).toMatchObject({ ok: false, errorCode: 'credential_unavailable' });
        expect(nativeTerminal.launches).toHaveLength(0);
        expect(machine.metadataVersion).toBe(0);
        expect(resolves).toBe(0);
        expect(reports).toEqual([]);
        return;
      }
      if (scenario === 'accepted-app-run-unreadable') {
        expect(await execution).toMatchObject({ ok: false, errorCode: 'machine_setup_app_preparation_unavailable' });
        expect(nativeTerminal.launches).toEqual([]);
        expect(machine.metadataVersion).toBe(0);
        expect(reports).toEqual([]);
        return;
      }
      let earlyResult: Awaited<typeof execution> | undefined;
      void execution.then(result => { earlyResult = result; });
      try {
        await Promise.race([nativeSetupLaunch, execution.then(result => {
          throw new Error(result.ok ? 'Setup settled before native launch' : `Setup refused before native launch: ${result.errorCode}`);
        })]);
      } catch (cause) {
        throw new Error(JSON.stringify({ phase: 'await_native_setup_launch', launches: nativeTerminal.launches.length,
          settled: earlyResult !== undefined, errorCode: earlyResult && !earlyResult.ok ? earlyResult.errorCode : null,
          resolves, originReads, repeatedAdmissionReads,
          homeReadPaths: profile.mock.calls.map(([url]) => new URL(String(url), 'https://fixture.invalid').pathname),
          homeWritePaths: transport.mock.calls.map(([url]) => new URL(String(url), 'https://fixture.invalid').pathname),
          accountSocketCount: accountChannel.clients.length,
          accountSockets: accountChannel.clients.map(socket => ({ connected: socket.connected, active: socket.active,
            transport: socket.io.engine?.transport.name ?? null, engineState: socket.io.engine?.readyState ?? null })),
          accountServerPeers: accountChannel.server.sockets.sockets.size,
        }), { cause });
      }
      expect(reports).toEqual(scenario === 'report-fallback-retry' ? ['running'] : []);
      expect(nativeTerminal.launches[0]?.args).toContain(retainedScript.body);
      const running = await operations.handlers.getV2({ operationId: 'setup-operation' }, context);
      expect(running).toMatchObject({ kind: 'found', operation: { state: 'running', domainRef: {
        kind: 'machineSetup', setupTask: { id: expect.any(String), taskKind: 'machine.setup.apply.v1' },
        terminalId: expect.any(String),
      } } });
      if (running.kind !== 'found' || running.operation.domainRef?.kind !== 'machineSetup'
        || !running.operation.domainRef.setupTask) throw new Error('Missing receiving setup task');
      const task = { taskId: running.operation.domainRef.setupTask.id };
      nativeTerminal.exit!(0);
      if (scenario === 'report-fallback-retry') {
        const completed = await execution;
        expect(completed).toMatchObject({ ok: true, result: { operationId: 'setup-operation' } });
        expect(succeededReportFailed).toBe(true);
        expect(reports).toEqual(['running']);
        const current = await client.getMachineSetupDesiredSnapshot();
        if (current.status !== 'ready') throw new Error('Missing successful desired write before Report failure');
        expect(current.policy.revision).toBe(1);
        // Re-observing this accepted invocation returns its settled native
        // result, without a second script run or another Home report.
        expect(await operations.observeExecution({ actionId: 'machines.setup.apply', input,
          actionRequestId: context.actionRequestId, rpcContext: context,
          execute: owned => executor.execute('machines.setup.apply', input,
            withNativeConfirmation('machines.setup.apply', input, { ...context, ...owned })),
        })).toEqual(completed);
        expect(nativeTerminal.launches).toHaveLength(1);
        expect(reports).toEqual(['running']);
        expect(resolves).toBe(1);
        expect(originReads).toBe(1);
        expect(machine.metadataVersion).toBe(1);
        expect(await client.getMachineSetupDesiredSnapshot()).toEqual(current);
        expect(await operations.handlers.getV2({ operationId: 'setup-operation' }, context))
          .toMatchObject({ kind: 'found', operation: { state: 'succeeded', domainRef: {
            managedId: 'managed', preset: { id: retained.presetId, revision: retained.presetRevision },
          } } });
        return;
      }
      expect(await execution).toMatchObject({ ok: true, result: { operationId: 'setup-operation', terminalId: expect.any(String) } });
      if (scenario === 'retained-copy') expect(repeatedAdmissionReads).toBe(0);
      expect(await getLiveSystemTasksRunnerAdapter().wait(task)).toMatchObject({ ok: true, data: { operationId: 'setup-operation' } });
      const terminal = await operations.handlers.getV2({ operationId: 'setup-operation' }, context);
      if (terminal.kind !== 'found') throw new Error('Missing receiving setup outcome');
      const reloaded = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(terminal.operation)));
      expect(reloaded).toMatchObject({ state: 'succeeded', domainRef: { ...running.operation.domainRef, exitCode: 0,
        steps: running.operation.domainRef.steps?.map(step => ({ ...step, state: 'succeeded' })),
      } });
      expect(reports).toEqual([]);
      expect(resolves).toBe(scenario === 'new-preset' ? 1 : 0);
      expect(originReads).toBe(1);
      if (acceptedApp) {
        expect(await client.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready', policy: {
          sources, sourceFacts: { direct: { acceptedAppRuns: [
            { intent: appIntent, ...(appIntent.definition.from === 'compose' ? { authoredKey: 'authored-compose-app' } : {}),
              homeId: input.homeId, runId, sourceKey: '$root', blockId: 'actual-reviewed-child', actionId: appChild.actionId },
            { intent: templateIntent, homeId: input.homeId, runId, sourceKey: '$root', blockId: 'actual-reviewed-template-child', actionId: templateChild.actionId },
          ] } },
        } });
        const desired = await client.getMachineSetupDesiredSnapshot();
        if (desired.status !== 'ready' || !readExecutor || !readCurrent) throw new Error('Missing actual settled source/read runtime');
        const references = desired.policy.sourceFacts?.direct?.acceptedAppRuns;
        const deployReference = references?.find(reference => reference.actionId === appChild.actionId);
        const templateReference = references?.find(reference => reference.actionId === templateChild.actionId);
        if (!deployReference || !templateReference) throw new Error('Missing settled exact app correspondence');
        const boundExecutor = readExecutor;
        const boundCurrent = readCurrent;
        const apps: Parameters<typeof readMachineSetupAcceptedAppRuns>[0]['apps'] = [
          { intent: appIntent, ...(appIntent.definition.from === 'compose' ? { authoredKey: 'authored-compose-app' } : {}),
            reference: deployReference }, { intent: templateIntent, reference: templateReference },
        ];
        const read = (requests: typeof apps = apps, homeId = input.homeId, machineId = machine.id) =>
          readMachineSetupAcceptedAppRuns({ homeId, machineId, apps: requests,
            execute: (actionId, actionInput, actionContext) => boundExecutor.execute(actionId, actionInput, actionContext),
            isCurrent: boundCurrent, signal: context.signal });
        const rootId = 'accepted-app-root';
        const childId = 'accepted-app-child';
        const templateId = 'accepted-template-child';
        const checkpoint = { kind: 'happier.workflow-checkpoint.v1' as const, rootRecordId: rootId,
          nextSequence: '3', frontier: { nextBlockOrdinal: 0, paused: false } };
        const checkpointEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowCheckpointStoredEnvelopeV1({ mode: 'plain',
          binding: { v: 1, purpose: 'checkpoint', accountId: actor, runId }, checkpoint }));
        const seal = (id: string, sequence: string, parentRecordId: string | null, memberOrdinal: string, progress: WorkflowProgressEnvelopeV1) =>
          serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain',
            binding: { v: 1, purpose: 'invocation_progress', accountId: actor, runId, recordId: id, sequence,
              parentRecordId, memberOrdinal, attempt: progress.attempt }, progress }));
        const rootProgress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'root', attempt: '0',
          invocationPath: { blockId: '$root', scope: [] }, logicalInvocationRecordId: rootId };
        const appProgress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action', attempt: '0',
          invocationPath: { blockId: deployReference.blockId, scope: [] }, logicalInvocationRecordId: childId,
          execution: { kind: 'action', localInputId: 'local-app-input', actionRequestId: 'opaque-app-request',
            actionId: appChild.actionId, input: appChild.input }, result: { ok: false, error: 'deployment_unavailable' } };
        const templateProgress: WorkflowProgressEnvelopeV1 = { kind: 'happier.workflow-progress.v1', blockKind: 'action', attempt: '0',
          invocationPath: { blockId: templateReference.blockId, scope: [] }, logicalInvocationRecordId: templateId,
          execution: { kind: 'action', localInputId: 'local-template-input', actionRequestId: 'opaque-template-request',
            actionId: templateChild.actionId, input: templateChild.input },
          result: { kind: 'applied', environmentId: 'template-environment', revision: 1, targetLinkId: 'template-target',
            definition: { kind: 'stored', contentRevision: 1, composeDigest: 'sha256:' + 'a'.repeat(64) }, savedSecrets: [] } };
        // Opaque sealed progress is seeded only at the existing HTTP/DB boundary.
        await runStorage.execute({ operation: 'initialize', runId, expectedRevision: runStorage.run().revision, checkpointEnvelope,
          rootInvocation: { id: rootId, contentEnvelope: seal(rootId, '0', null, '0', rootProgress) } });
        await runStorage.execute({ operation: 'invocations.admit', runId, expectedRevision: runStorage.run().revision, checkpointEnvelope,
          invocations: [
            { id: childId, sequence: '1', parentRecordId: rootId, memberOrdinal: appMemberOrdinal, lifecycle: 'failed',
              contentEnvelope: seal(childId, '1', rootId, appMemberOrdinal, appProgress) },
            { id: templateId, sequence: '2', parentRecordId: rootId, memberOrdinal: templateMemberOrdinal, lifecycle: 'completed',
              contentEnvelope: seal(templateId, '2', rootId, templateMemberOrdinal, templateProgress) },
          ] });
        if (appIntent.definition.from === 'catalogApp') {
          const changedPin = { ...appIntent, definition: { from: 'catalogApp' as const,
            templateRef: { ...appIntent.definition.templateRef, version: '2', ref: { kind: 'version' as const, version: '2' } } } };
          expect(await read([{ intent: changedPin, reference: deployReference }])).toMatchObject([
            { environmentId: appChild.input.environmentId, outcome: { kind: 'failed' } },
          ]);
        }
        expect(await read()).toMatchObject([
          { environmentId: appChild.input.environmentId, outcome: { kind: 'failed' } },
          { outcome: { kind: 'unknown' } },
        ]);
        const root = runStorage.rowById(rootId)!;
        await runStorage.execute({ operation: 'transition', runId, expectedRevision: runStorage.run().revision, state: 'interrupted', checkpointEnvelope,
          invocationTransitions: [{ id: rootId, expectedLifecycle: root.index.lifecycle, expectedContentRevision: root.index.contentRevision, lifecycle: 'failed' }] });
        const nextRootId = 'accepted-app-root-recovered';
        const nextChildId = 'accepted-app-child-recovered';
        const nextRootProgress: WorkflowProgressEnvelopeV1 = { ...rootProgress, attempt: '1', previousAttemptRecordId: rootId };
        const { execution: _oldExecution, result: _oldResult, ...reusableApp } = appProgress;
        const nextAppProgress: WorkflowProgressEnvelopeV1 = { ...reusableApp, attempt: '1', previousAttemptRecordId: childId };
        // Keep a pre-replacement checkpoint while exact root-slot/ancestry reads
        // resolve current physical attempts; the successful template is inherited.
        await runStorage.execute({ operation: 'invocations.recover', runId, expectedRevision: runStorage.run().revision,
          accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, checkpointEnvelope,
          recoveries: [
            { invocationId: rootId, newInvocationId: nextRootId, contentEnvelope: seal(nextRootId, '3', null, '0', nextRootProgress) },
            { invocationId: childId, newInvocationId: nextChildId,
              contentEnvelope: seal(nextChildId, '4', nextRootId, appMemberOrdinal, nextAppProgress) },
          ] });
        expect((await read()).map(observation => observation.outcome.kind)).toEqual(['not_completed', 'unknown']);
        const failed = runStorage.rowById(nextChildId)!;
        await runStorage.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: nextChildId, invocationAttempt: '1',
          expectedLifecycle: failed.index.lifecycle, expectedContentRevision: failed.index.contentRevision, lifecycle: 'failed',
          contentEnvelope: seal(nextChildId, '4', nextRootId, appMemberOrdinal, { ...nextAppProgress,
            execution: appProgress.execution, result: appProgress.result }) });
        expect((await read()).map(observation => observation.outcome.kind)).toEqual(['failed', 'unknown']);
        await runStorage.execute({ operation: 'transition', runId, expectedRevision: runStorage.run().revision,
          state: 'interrupted', checkpointEnvelope });
        const completedId = 'accepted-app-child-completed';
        const completedProgress: WorkflowProgressEnvelopeV1 = { ...nextAppProgress, attempt: '2', previousAttemptRecordId: nextChildId,
          execution: appProgress.execution, result: { ok: true, environmentId: appChild.input.environmentId, revision: 2,
            deploymentId: 'deployment', deploymentRevision: 1, state: 'succeeded' } };
        await runStorage.execute({ operation: 'invocations.recover', runId, expectedRevision: runStorage.run().revision,
          accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null }, checkpointEnvelope,
          recoveries: [{ invocationId: nextChildId, newInvocationId: completedId,
            contentEnvelope: seal(completedId, '5', nextRootId, appMemberOrdinal, completedProgress) }] });
        const completed = runStorage.rowById(completedId)!;
        await runStorage.execute({ operation: 'invocations.fact', runId, parentAttempt: 0, invocationId: completedId, invocationAttempt: '2',
          expectedLifecycle: completed.index.lifecycle, expectedContentRevision: completed.index.contentRevision, lifecycle: 'completed',
          contentEnvelope: seal(completedId, '5', nextRootId, appMemberOrdinal, completedProgress) });
        const beforeBatch = runStorage.calls.length;
        expect(await read()).toMatchObject([{ intent: appIntent, reference: deployReference, outcome: { kind: 'completed' } },
          { intent: templateIntent, reference: templateReference, outcome: { kind: 'unknown' } }]);
        expect(runStorage.calls.slice(beforeBatch).filter(call => call.operation === 'get')).toHaveLength(1);
        // Exercise the public composer through the real installed target Plan
        // and Account Run storage, not a replacement completion classifier.
        const continuitySources = projectManagedOpaqueSetupSourcesV1(MachineSetupSourceV1Schema.parse(sources).map(source => ({ ...source, setup: { ...source.setup,
          ...(source.setup.items ? { items: source.setup.items.map(item => item.kind === 'app'
            && item.definition.definition.from === 'catalogApp' && appIntent.definition.from === 'catalogApp'
            && item.definition.definition.templateRef.itemId === appIntent.definition.templateRef.itemId
            ? { ...item, definition: { ...appIntent, definition: { ...appIntent.definition,
              templateRef: { ...appIntent.definition.templateRef, version: '2', ref: { kind: 'version' as const, version: '2' } } } } }
            : item) } : {}),
        } })));
        // App outcome reads moved to the receiving Plan owner. Supply its real
        // Account transport, as the daemon host does, rather than a bare Plan.
        const targetPlan = createMachineSetupPlanAction({ apiMachine: client, machineId: machine.id, homeId: input.homeId,
          installation: { installationId: osStore.identity.installationId, privateKey: pair.secretKey },
          appPreparation: { readAppRuntime: () => ({
            execute: (actionId, actionInput, actionContext) => boundExecutor.execute(actionId, actionInput, actionContext),
            isCurrent: boundCurrent,
          }) } });
        const composer = createActionExecutor(createCliActionDeps({ token, credentials: osStore.credentials!, sessionId: 'cli-global',
          mode: 'plain', ctx: null, serverId: configuration.activeServerId, serverIdentityId: input.homeId,
          serverHttpBaseUrl: 'https://machine-home.example.test',
          resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'https://machine-home.example.test', token }),
          machineActionDirectTargetTransport: { machineId: machine.id, invoke: async (method, request) => {
            expect(method).toBe(RPC_METHODS.MACHINE_SETUP_PLAN);
            return targetPlan({ input: MachineSetupPlanInputV1Schema.parse(request), context });
          } },
        }));
        const beforeContinuity = { reads: runStorage.calls.length, launches: nativeTerminal.launches.length,
          metadataVersion: machine.metadataVersion };
        const continuityPlan = await composer.execute('machines.setup.plan', { homeId: input.homeId, machineId: machine.id,
          targets: [{ homeId: input.homeId, machineId: machine.id, sources: continuitySources,
            mode: 'effects', appChildren: [] }],
        }, { surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId });
        expect(continuityPlan, JSON.stringify(continuityPlan)).toMatchObject({ ok: true, result: {
          targets: [{ appChildren: [], plan: { sources: continuitySources, review: { apps: [
            { sourceIndex: 1, itemIndex: 0, kind: 'completed', environmentId: appChild.input.environmentId },
            { sourceIndex: 1, itemIndex: 1, kind: 'unknown' },
          ] } } }],
        } });
        expect(runStorage.calls.slice(beforeContinuity.reads).filter(call => call.operation === 'get')).toHaveLength(1);
        expect(nativeTerminal.launches).toHaveLength(beforeContinuity.launches);
        expect(machine.metadataVersion).toBe(beforeContinuity.metadataVersion);
        const changedIntent = { ...appIntent, name: 'Different reviewed app' };
        const mismatches = [
          { ...apps[0]!, reference: { ...deployReference, intent: changedIntent } },
          { intent: appIntent, reference: { ...deployReference, homeId: 'different-home' } },
          { intent: appIntent, reference: { ...deployReference, blockId: 'unrelated-child' } },
        ];
        refuseProgressRead = true;
        const beforeMismatches = runStorage.calls.length;
        const beforeMismatchHttp = progressHttpReads;
        expect((await read(mismatches)).map(observation => observation.outcome.kind)).toEqual(['unknown', 'unknown', 'unknown']);
        expect((await read(apps, input.homeId, 'another-machine')).map(observation => observation.outcome.kind)).toEqual(['unknown', 'unknown']);
        expect(runStorage.calls.slice(beforeMismatches).filter(call => call.operation === 'invocations.list')).toEqual([]);
        expect(progressHttpReads).toBe(beforeMismatchHttp);
        // No eager progress Promise may survive an exact-binding refusal and
        // reject later; Vitest also observes any unhandled rejection globally.
        await Promise.resolve();
        refuseProgressRead = false;
        const beforeMissing = runStorage.calls.length;
        expect(await readMachineSetupAcceptedAppRuns({ homeId: input.homeId, machineId: machine.id,
          apps: [{ intent: appIntent }], execute: (actionId, actionInput, actionContext) => boundExecutor.execute(actionId, actionInput, actionContext),
          isCurrent: boundCurrent })).toMatchObject([{ intent: appIntent, outcome: { kind: 'unknown' } }]);
        expect(runStorage.calls.length).toBe(beforeMissing);
        if (appIntent.definition.from === 'compose') {
          const beforeLegacy = runStorage.calls.length;
          const { authoredKey: _oldAuthoredKey, ...legacyReference } = deployReference;
          expect(await read([{ intent: appIntent, reference: legacyReference }]))
            .toMatchObject([{ outcome: { kind: 'unknown' } }]);
          expect(await read([{ ...apps[0]!, authoredKey: 'another-authored-app' }]))
            .toMatchObject([{ outcome: { kind: 'unknown' } }]);
          expect(runStorage.calls.length).toBe(beforeLegacy);
          expect(await read([{ ...apps[0]!, intent: changedIntent }]))
            .toMatchObject([{ environmentId: appChild.input.environmentId, outcome: { kind: 'completed' } }]);
        }
        // Native-only edits add no app facts and need no private Run reads;
        // canonical desired-state CAS alone retains incumbent references.
        const target = input.targets[0]!;
        const { appChildren: _reviewedAppChildren, ...nativeOnly } = target;
        const beforeNativeOnly = runStorage.calls.length;
        expect(await prepareMachineSetupAcceptedAppRuns({ input: nativeOnly, context, isCurrent: boundCurrent })).toEqual({});
        expect(runStorage.calls.length).toBe(beforeNativeOnly);
        let releaseTemplateProgress = () => {};
        holdTemplateProgress = new Promise<void>(resolve => { releaseTemplateProgress = resolve; });
        const templateWaiting = new Promise<void>(resolve => { observeTemplateProgress = resolve; });
        const deployDelivered = new Promise<void>(resolve => { observeDeployProgress = resolve; });
        const beforeDeferred = runStorage.calls.length;
        let templateReleased = false;
        const deferredBatch = read();
        try {
          await Promise.race([Promise.all([templateWaiting, deployDelivered]), deferredBatch.then(() => {
            throw new Error('Batch settled without both real progress reads');
          })]);
          // One natural event-loop turn drains that finite first-app work while
          // the second genuine HTTP response remains withheld (no timer/poll).
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(templateReleased).toBe(false);
          expect(runStorage.calls.slice(beforeDeferred)).toContainEqual(expect.objectContaining({ operation: 'invocations.list',
            parentRecordId: nextRootId, memberOrdinal: appMemberOrdinal, progressEnvelopes: true }));
          // Finite Account reads retain their admitted installation. The
          // request's local cancellation invalidates the in-flight batch.
          setupLifetime.abort();
        } finally {
          templateReleased = true;
          releaseTemplateProgress();
        }
        expect((await deferredBatch).map(observation => observation.outcome.kind)).toEqual(['unknown', 'unknown']);
        return;
      }
      expect(await client.getMachineSetupDesiredSnapshot()).toMatchObject({ status: 'ready', policy: {
        sources: [retained, { kind: 'direct', setup: {} }],
      } });
    } finally {
      const cancelled = operations && observedOperationId
        // Cleanup is a separate request after the retained reader may have aborted.
        ? operations.handlers.cancel({ operationId: observedOperationId }, { ...context, signal: new AbortController().signal }) : undefined;
      nativeTerminal.exit?.(0);
      try {
        await cancelled;
        await execution?.catch(() => undefined);
      } finally {
        setupLifetime.abort();
        await client.shutdown(); profile.mockRestore(); transport.mockRestore(); osStore.identity = null; osStore.credentials = null;
        nativeTerminal.onLaunch = undefined;
        nativeTerminal.autoExit = false;
      }
    }
  });
  it.each([false, true])('applies a Manage grantee operation without catalog equality (additional step: %s)', async additionalStep => {
    const fixture = await createNativeSoftwareInstallFixture({ scenario: 'apt' });
    const context = (actionId: 'machines.setup.plan' | 'machines.setup.apply'): RpcActionExecutorContext => {
      const admitted = fixture.context(actionId);
      return { ...admitted,
        machineAdmission: { ...admitted.machineAdmission!, actorAccountId: 'bob' },
        externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
          ...admitted.externalActionExecutionAuthorization,
          binding: { ...admitted.externalActionExecutionAuthorization!.binding, accountId: 'bob' },
        }),
      };
    };
    const operations = createHostActionOperationRuntime({ machineId: fixture.machine.id,
      custodyBinding: { serverId: configuration.activeServerId, installationId: fixture.installation.installationId },
      resolveAccountId: async () => 'bob' });
    const executor = createActionExecutor({ ...fixture.nativeDeps, runActionOperation: operations.runActionOperation });
    const planned = await executor.execute('machines.setup.plan', { homeId: 'srv_home', machineId: fixture.machine.id,
      mode: 'effects', sources: fixture.sources }, context('machines.setup.plan'));
    expect(planned).toMatchObject({ ok: true });
    if (!planned.ok) throw new Error('The Manage grantee must reach the real catalog Plan');
    const reviewed = MachineSetupPlanResultV1Schema.parse(planned.result);
    const entry = reviewed.recipePlans?.[0];
    if (!entry?.plan.steps[0] || !entry.plan.nativeFacts[0]) throw new Error('Expected the native package review');
    const { v: _version, planDigest: _digest, ...contents } = entry.plan;
    // Manage permits editing the operation. The admitted input, not catalog equality, binds execution.
    const extended = additionalStep ? createMachineSetupEffectPlan({ ...contents,
      steps: [...contents.steps, { ...contents.steps[0]!, id: 'extra-root-step' }],
      nativeFacts: [...contents.nativeFacts, { ...contents.nativeFacts[0]!, stepId: 'extra-root-step' }],
    }) : entry.plan;
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: fixture.machine.id,
      targets: [{ homeId: 'srv_home', machineId: fixture.machine.id, sources: reviewed.sources,
        desiredRevision: reviewed.desiredRevision, recipePlans: [{ ...entry, plan: extended }] }] });
    const admitted = context('machines.setup.apply');
    const result = await operations.observeExecution({ actionId: 'machines.setup.apply', input,
      actionRequestId: admitted.actionRequestId, rpcContext: admitted,
      execute: owned => executor.execute('machines.setup.apply', input,
        withNativeConfirmation('machines.setup.apply', input, { ...admitted, ...owned })),
    });
    expect(result, result.ok ? undefined : result.errorCode).toMatchObject({ ok: true });
    expect(fixture.rootLaunches).toHaveLength(1);
    expect(fixture.rootPlans).toMatchObject([[{ plan: { steps: extended.steps } }]]);
    expect(fixture.metadataWrites).toHaveLength(1);
    expect(await fixture.readInstalled()).toEqual({ installed: true, version: '1.0', effects: ['apt-get'], updatesChecks: 1 });
  });
  it('uses installed custodian material for a foreign admitted machine setup actor without exposing Session reads', async () => {
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    const lifetime = new AbortController();
    const ingress: RpcHandlerContext = { signal: lifetime.signal,
      machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    try {
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      const runtime = await client.resolveMachineSetupRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'alice', machineId: machine.id, credentials: osStore.credentials });
      expect(await client.resolveMachineSetupRuntime({ ...ingress, machineAdmission: { ...ingress.machineAdmission!, custodianAccountId: 'bob' } })).toBeNull();
      lifetime.abort();
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(runtime?.isCustodyCurrent()).resolves.toBe(true);
      osStore.credentials = { token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(false);
      await expect(runtime?.isCustodyCurrent()).resolves.toBe(false);
    } finally { profile.mockRestore(); osStore.identity = null; osStore.credentials = null; }
  });
  it('admits verified owner material once and keeps local retirement plus fresh next-operation admission', async () => {
    const installationReads = vi.spyOn(await import('@/daemon/identity/store'), 'readInstallationIdentityIfExistsSync');
    const pair = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    osStore.identity = { version: 1, installationId: '11111111-1111-4111-8111-111111111111', createdAt: 1,
      publicKey: Buffer.from(pair.publicKey).toString('base64url'), privateKey: Buffer.from(pair.secretKey).toString('base64url') };
    osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
    osStore.reads.length = 0;
    // Authenticated Home profile is the network boundary; Account resolution stays real.
    const profile = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, statusText: 'OK',
      headers: {}, config: { headers: new AxiosHeaders() }, data: { id: 'alice' } });
    const machine: Machine = { id: 'alice-machine', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy',
      metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 };
    const client = new ApiMachineClient('alice-token', machine);
    const ingress: RpcHandlerContext = { signal: new AbortController().signal,
      machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice', machineId: machine.id,
        installationId: osStore.identity.installationId, role: 'manage', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true };
    try {
      await expect(client.resolveOwnSessionRuntime({ ...ingress,
        machineAdmission: { ...ingress.machineAdmission!, actorAccountId: 'bob' } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      expect(profile).not.toHaveBeenCalled();
      // The connection captured its installation before this request.
      installationReads.mockClear();
      const runtime = await client.resolveOwnSessionRuntime(ingress);
      expect(runtime).toMatchObject({ accountId: 'alice', serverId: configuration.activeServerId,
        machineId: machine.id, credentials: osStore.credentials });
      expect(installationReads.mock.calls.length,
        'one installed identity read admits the operation').toBe(1);
      expect(profile).toHaveBeenCalledWith(expect.stringContaining('/v1/account/profile'),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-token' }) }));
      osStore.reads.length = 0;
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, actorAccountId: 'bob', custodianAccountId: 'bob',
      } })).resolves.toBeNull();
      expect(osStore.reads).toEqual([]);
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      osStore.credentials = { token: 'replacement-token', encryption: null, credentialProvenance: 'stored_session' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      await expect(client.resolveOwnSessionRuntime(ingress)).resolves.toBeNull();
      const readsAfterAdmissions = installationReads.mock.calls.length;
      osStore.credentials = { token: 'alice-token', encryption: null, credentialProvenance: 'stored_session' };
      osStore.identity = { ...osStore.identity!, installationId: '22222222-2222-4222-8222-222222222222' };
      await expect(runtime?.isCurrent?.()).resolves.toBe(true);
      expect(installationReads.mock.calls.length,
        'retained operation currentness consumes admission without rereading identity').toBe(readsAfterAdmissions);
      await expect(client.resolveOwnSessionRuntime({ ...ingress, machineAdmission: {
        ...ingress.machineAdmission!, installationId: osStore.identity.installationId,
      } })).resolves.toBeNull();
    } finally {
      profile.mockRestore();
      osStore.identity = null;
      osStore.credentials = null;
    }
  });
});
