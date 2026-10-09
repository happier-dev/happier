import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { AgentRuntimeDaemonServiceRequestV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createDaemonSessionAccountActionExecutor } from './createDaemonSessionAccountActionExecutor';
import nacl from 'tweetnacl';
import { mintExternalActionExecutionAuthorization, projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1, verifyExternalActionApprovalInputV1,
  verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionRequestEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { prepareExternalActionRequesterAccountAuthorization } from '@/api/externalActionExecutionAuthorization';
import { ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createDaemonManagedMachineActionAdapter } from '../startup/managedMachineActionAdapter';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { configuration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { tmpdir } from 'node:os';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { resolveExternalActionMachineTarget } from '../externalActions/reconcileExternalActionTarget';
import { registerActionSpecRpcHandlers } from '@/rpc/handlers/registerActionSpecRpcHandlers';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

type Operation = Extract<AgentRuntimeDaemonServiceRequestV1['operation'], { kind: 'action.execute' }>;
const operation: Operation = {
  kind: 'action.execute', requestId: 'request-1', actionId: 'notifications.notify_me', input: { message: 'Finished' },
  witness: { turnId: 'turn-1', inputId: 'input-1', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
    agentStartCaller: { kind: 'session', sessionId: 'bob-session', starterDepth: 1, turnDepth: 2 } },
};

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function createHarness() {
  const delivered: unknown[] = [];
  let current: (() => Promise<boolean>) | undefined;
  const params = {
    serverId: 'alice-home', serverHttpBaseUrl: 'https://alice-home.test', token: 'alice-daemon-token',
    createExecutor: (_depth: (turnId?: string) => number | undefined, isCallerCurrent: () => Promise<boolean>) => {
      current = isCallerCurrent;
      return createActionExecutor({
        ...createCliActionDeps({ token: 'alice-daemon-token', sessionId: '', mode: 'plain', ctx: null }),
        // Account notification delivery is an external network boundary.
        notificationsNotifyMe: async (input, context) => {
          delivered.push({ input, context });
          return { attemptedChannels: 1, deliveredChannels: 1 };
        },
      });
    },
  };
  return { execute: createDaemonSessionAccountActionExecutor(params), delivered,
    isCallerCurrent: () => current?.() };
}

describe('daemon Session Account authority', () => {
  it('selects the reviewed managed controller before minting rather than the originating Session Machine', () => {
    const controller = { machineId: 'remote-controller', installationId: 'remote-installation' };
    const common = { homeId: 'srv_source', controller, contribution: { pluginId: 'acme.compute', localId: 'vm' } };
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.managed.acquire', rawInput: { selection: {
      kind: 'one-off', homeId: common.homeId, controller,
      launch: { provider: common.contribution, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } }, fallbackMachineId: 'source-machine' })).toEqual({ kind: 'ready', machineId: controller.machineId });
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.provisioners.check', rawInput: common,
      target: { kind: 'machine', machineId: 'source-machine' } })).toMatchObject({ kind: 'rejected',
      execution: { errorCode: 'target_not_local' } });
  });

  it.each([
    ['agent', 'machines.provisioners.check', 'local'], ['mcp', 'machines.provisioners.check', 'local'],
    ['agent', 'machines.managed.inspect', 'local'], ['mcp', 'machines.managed.inspect', 'local'],
    ['agent', 'machines.provisioners.check', 'rpc'], ['agent', 'machines.managed.inspect', 'rpc'],
    ['agent', 'machines.managed.acquire', 'rpc'],
    ['agent', 'machines.managed.acquire', 'foreign-custodian-rpc'],
    ['agent', 'machines.provisioners.check', 'foreign-custodian-rpc'], ['agent', 'machines.managed.inspect', 'foreign-custodian-rpc'],
  ] as const)('executes %s %s through the original Home and current native owner over %s', async (surface, actionId, delivery) => {
    const serverHttpBaseUrl = 'https://managed-source.test';
    const homeId = 'srv_source';
    const source = { machineId: 'source-machine', installationId: 'source-installation' };
    const controller = delivery !== 'local' ? { machineId: 'remote-controller', installationId: 'receiver-installation' } : source;
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'source-account', tokenEpoch: 0,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const sourceKeys = delivery !== 'local' ? nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32)) : keys;
    const custodianAccountId = delivery === 'foreign-custodian-rpc' ? 'custodian-account' : 'source-account';
    const receiverCredentials = delivery === 'foreign-custodian-rpc'
      ? { token: `fixture.${Buffer.from(JSON.stringify({ sub: custodianAccountId, tokenEpoch: 0,
        provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null } : credentials;
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Source Home', serverUrl: serverHttpBaseUrl,
        webappUrl: serverHttpBaseUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId,
          canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] } },
    } }));
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: {
        v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] },
      } }), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(receiverCredentials) });
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const native = nativeFixture({ privateNative: true });
    let machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId, controller,
      launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
      allocation: 'bound', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const input = ManagedMachineActionInputSchemasV1[actionId].parse(actionId === 'machines.provisioners.check'
      ? { homeId, controller, contribution: machine.launch.provider }
      : actionId === 'machines.managed.acquire' ? { selection: { kind: 'one-off', homeId, controller,
        launch: machine.launch, retention: machine.retention, wakeOnAcceptedMessage: false } } : { homeId, managedId: machine.id });
    const target = { kind: 'machine' as const, machineId: controller.machineId };
    const proofRequests: unknown[] = [];
    const paths: string[] = [];
    let storedApproval: Readonly<{ id: string; dataEncryptionKey: string; request: ReturnType<typeof StoredApprovalRequestSchema.parse> }> | undefined;
    // Only Home HTTP is substituted. The source owner, original proof signer,
    // shared Action policy, registry, custody and native invocation remain real.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (storedApproval && path === `/v1/artifacts/${storedApproval.id}`) {
        const original = storedApproval.request;
        const rejected = StoredApprovalRequestSchema.parse({ ...original, status: 'rejected', updatedAtMs: original.updatedAtMs + 1,
          decision: { kind: 'reject', decidedAtMs: original.updatedAtMs + 1 } });
        return { status: 200, data: { id: storedApproval.id, dataEncryptionKey: storedApproval.dataEncryptionKey,
          ownerAccountId: 'source-account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
          headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: original.createdAtMs, updatedAt: rejected.updatedAtMs,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected, { legacyServerId: configuration.activeServerId })),
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }) } };
      }
      return String(url).endsWith('/v2/account/settings') ? { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } }
        : { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path.endsWith('/execution-authorization')) {
        expect(config?.headers).toMatchObject({ Authorization: `Bearer ${credentials.token}` });
        const request = ExternalActionRequestEnvelopeV1Schema.parse(Reflect.get(body, 'envelope'));
        proofRequests.push(body);
        return { status: 200, data: { v: 1, token: 'source-home-proof', binding: {
          accountId: 'source-account', custodianAccountId, authentication: { kind: 'account', tokenEpoch: 0 },
          serverIdentityId: homeId, ...controller, installationId: controller.installationId,
          actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
          sessionActionOrigin: Reflect.get(body, 'sessionActionOrigin'), sessionActionSource: source,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request),
        } } };
      }
      if (path.endsWith('/verify')) {
        const signature = config?.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
        expect(typeof signature).toBe('string');
        const signed = { authorizationToken: 'source-home-proof', effectActionId: actionId, target,
          installationId: controller.installationId, requestId: operation.requestId, method: 'POST', path, body,
          signature: String(signature) };
        expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
        if (delivery !== 'local') expect(verifyExternalActionMachineRequestV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
        return { status: 200, data: { ok: true } };
      }
      if (path === '/v1/artifacts') {
        const content = decodePlainArtifactStoredContent(String(Reflect.get(body, 'body')));
        const request = StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
        storedApproval = { id: String(Reflect.get(body, 'id')), dataEncryptionKey: String(Reflect.get(body, 'dataEncryptionKey')), request };
        return { status: 200, data: { id: storedApproval.id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.endsWith('/admit')) return { status: 200, data: { machine, replayed: true } };
      if (path.endsWith('/actions/get')) return { status: 200, data: machine };
      if (delivery !== 'local' && /\/(?:context|current|report)$/.test(path)) {
        expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: 'source-home-proof' });
      }
      if (path.endsWith('/context')) return { status: 200, data: { machine, requestId: operation.requestId } };
      if (path.endsWith('/report')) machine = ManagedMachineV1Schema.parse({ ...machine, observation: Reflect.get(body, 'observation') });
      if (path.endsWith('/current') || path.endsWith('/report')) return { status: 200, data: { machine } };
      throw new Error(`Unexpected family source path ${path}`);
    });
    const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential materialization'); };
    const providerAuthority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
      }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const managedMachineAction = createDaemonManagedMachineActionAdapter({ credentials: receiverCredentials, machineId: controller.machineId,
      serverBaseUrl: serverHttpBaseUrl, serverId: configuration.activeServerId,
      installationIdentity: { installationId: controller.installationId, privateKey: keys.secretKey },
      managedProviderOperationAuthority: providerAuthority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: serverHttpBaseUrl, resolveCurrentMachineId: () => controller.machineId }),
      acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: receiverCredentials, serverId: configuration.activeServerId,
      serverApiUrl: serverHttpBaseUrl, serverIdentityId: homeId, externalActionMachineRequestPrivateKey: keys.secretKey,
      externalActionMachineInstallationId: controller.installationId, managedMachineAction, pluginActionExecutionOwner: 'current_process' });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl, token: credentials.token,
      prepareExternalActionAuthorization: async admission => {
        const authorization = await prepareExternalActionRequesterAccountAuthorization({ actionId, input, requestId: operation.requestId,
          target, machineId: controller.machineId, sourceMachineId: source.machineId, accountId: 'source-account',
          accountEncryptionMode: 'plain', tokenEpochHint: 0, token: credentials.token,
          serverId: configuration.activeServerId, serverIdentityId: homeId, serverHttpBaseUrl,
          installationId: source.installationId, privateKey: sourceKeys.secretKey, sessionActionOrigin: admission.sessionActionOrigin,
          isCurrent: admission.isCallerCurrent, signal: admission.authority.signal });
        return authorization ? { authorization, target } : null;
      }, createExecutor: () => delivery === 'local' ? executor : { execute: async (_id, actionInput, context) => {
        const rpc = new RpcHandlerManager({ scopePrefix: controller.machineId, localMachineId: controller.machineId,
          encryptionMode: 'plain', logger: () => {}, authorizeRequest: async () => ({ ok: true }) });
        registerActionSpecRpcHandlers({ rpcHandlerManager: rpc,
          actionIds: [actionId], targetMachineId: controller.machineId, actionExecutor: executor,
          ...(actionId === 'machines.managed.acquire' ? { observeExecution: request =>
            createHostActionOperationRuntime({ machineId: controller.machineId, serverId: configuration.activeServerId,
              custodyBinding: { serverId: configuration.activeServerId, installationId: controller.installationId },
              resolveAccountId: async () => custodianAccountId })
              .observeExecution(request) } : {}) });
        // Private producer callbacks do not ride the existing socket wire.
        const authorization = context?.externalActionExecutionAuthorization;
        if (!authorization) throw new Error('Missing original source proof');
        const wireAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse(JSON.parse(JSON.stringify(authorization)));
        const result = await rpc.handleRequest({ method: `${controller.machineId}:${actionId}`,
          params: { v: 1, kind: 'targeted_action_rpc', target, input: actionInput },
          requestId: 'home-relay-correlation', callerAuthority: 'account_automation',
          sessionActionOrigin: authorization.binding.sessionActionOrigin,
          callerInputAuthorization: wireAuthorization,
          machineAdmission: { actorAccountId: 'source-account', custodianAccountId, ...controller,
            role: 'manage', encryptionMode: 'plain' },
        });
        return { ok: true, result };
      } },
    });
    const result = await execute({ ...operation, actionId, input, surface }, { sessionId: 'bob-session', isCurrent: async () => true });
    if (delivery === 'foreign-custodian-rpc' && actionId === 'machines.managed.acquire') {
      expect(result).toEqual({ ok: true, result: { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' } });
      expect(storedApproval).toBeUndefined();
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    if (actionId === 'machines.managed.acquire') {
      expect(result).toEqual({ ok: true, result: { ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' } });
      const approval = storedApproval?.request;
      if (!approval || approval.v !== 2 || !approval.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed receiver approval');
      expect(approval.executionOriginV1).toMatchObject({ accountId: 'source-account', machineId: controller.machineId,
        caller: operation.witness.agentStartCaller, externalActionExecutionAuthorization: { binding: { sessionActionSource: source } } });
      const signed = { authorizationToken: 'source-home-proof', actionId, input: approval.actionArgs, target,
        signature: approval.executionOriginV1.externalActionInputSignature };
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: keys.publicKey })).toBe(true);
      expect(verifyExternalActionApprovalInputV1({ ...signed, publicKey: sourceKeys.publicKey })).toBe(false);
      expect(native.effects()).toBe(0);
      expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
      return;
    }
    expect(result, JSON.stringify(result)).toEqual({ ok: true, result: ManagedMachineActionOutputSchemasV1[actionId].parse(
      actionId === 'machines.provisioners.check' ? { available: true } : { machine }) });
    expect(proofRequests).toEqual([expect.objectContaining({ sessionActionOrigin: expect.objectContaining({
      caller: operation.witness.agentStartCaller, sourceTurnId: operation.witness.turnId, requestId: operation.requestId,
    }), installationProof: expect.any(Object) })]);
    expect(native.effects()).toBe(1);
    expect(paths.some(path => /\/(?:admit|submit|enrollment-context)$/.test(path))).toBe(false);
    if (actionId === 'machines.managed.inspect') expect(machine.observation).toEqual({ observedAt: 0, availability: 'present' });
  });

  it('reaches the canonical handoff Action with its actual original Session witness and Home-issued root instead of upgrading to human authority', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const handoff: Operation = { ...operation, actionId: 'session.handoff',
      input: { sessionId: 'bob-session', targetMachineId: 'target-machine', targetPath: '/target' } };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
      expect(request.envelope.handoffAdmission).toEqual({ sessionId: 'bob-session',
        sourceMachineId: 'source-machine', targetMachineId: 'target-machine' });
      return { status: 200, data: { v: 1, token: 'home-issued-handoff-root', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, serverIdentityId: 'srv_home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'source-installation',
        actionId: handoff.actionId, requestId: handoff.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin,
        sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
        handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId, targetMachineId: 'target-machine',
          sourceInstallationId: 'source-installation', targetInstallationId: 'target-installation' },
      } } };
    });
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'bob-profile',
      serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      prepareExternalActionAuthorization: async ({ sessionActionOrigin }) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: handoff.requestId,
          target, input: handoff.input, handoffAdmission: { sessionId: 'bob-session', sourceMachineId: target.machineId,
            targetMachineId: 'target-machine' } });
        const minted = await mintExternalActionExecutionAuthorization({ actionId: handoff.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test',
          sessionActionOrigin, sessionActionSource: { machineId: target.machineId, installationId: 'source-installation' },
          installationProof: signMachineInstallationProof({ privateKey: keys.secretKey, payload: {
            version: 1, accountId: 'bob', machineId: target.machineId, installationId: 'source-installation',
            externalActionOrigin: { homeId: 'srv_home', actionId: handoff.actionId, requestId: handoff.requestId,
              requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin },
          } }) });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        // Machine RPC delivery is the genuine effect boundary.
        sessionHandoffStart: async () => ({ ok: false, errorCode: 'handoff_owner_reached', error: 'handoff_owner_reached' }),
      }),
    });
    expect(await execute(handoff, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'handoff_owner_reached' });
    expect(network).toHaveBeenCalled();
  });

  it('refuses the originating Account creation preference before minting its managed Action proof', async () => {
    const serverHttpBaseUrl = 'https://source-home.test';
    const token = 'source-account-token';
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ managedMachineCreationEnabled: false }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token)) });
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post');
    const admitted: string[] = [];
    const acquire: Operation = { ...operation, actionId: 'machines.managed.acquire', input: { selection: {
      kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'source-machine', installationId: 'installation' },
      launch: { provider: { pluginId: 'compute.example', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } } };
    const target = { kind: 'machine' as const, machineId: 'source-machine' };
    const execute = createDaemonSessionAccountActionExecutor({ serverId: 'source-profile', serverHttpBaseUrl, token,
      prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: acquire.actionId, machineId: target.machineId,
          envelope: ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: acquire.requestId, target, input: acquire.input }),
          pat: token, serverHttpBaseUrl });
        return minted.ok ? { authorization: minted.authorization, target } : null;
      },
      createExecutor: () => createActionExecutor({ ...createCliActionDeps({ token, sessionId: '', mode: 'plain', ctx: null }),
        // Durable acquisition is the effect boundary, not an admission mock.
        managedMachineAction: async ({ actionId }) => { admitted.push(actionId); return { managedId: 'managed' }; },
      }),
    });
    expect(await execute(acquire, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: false, errorCode: 'creation_disabled', error: 'creation_disabled' });
    expect(network).not.toHaveBeenCalled();
    expect(admitted).toEqual([]);
  });

  it('carries original requester Home authorization from the admitted Session into Account effects', async () => {
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const target = { kind: 'machine' as const, machineId: 'alice-machine' };
    const envelope = { v: 1 as const, requestId: operation.requestId, target, input: operation.input };
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const network = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
      if (String(url).endsWith('/verify')) return { status: 200, data: { ok: true } };
      expect(config?.headers).toMatchObject({ Authorization: 'Bearer bob-session-token' });
      return { status: 200, data: { v: 1, token: 'bob-home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 4 }, serverIdentityId: 'bob-home',
        machineId: target.machineId, custodianAccountId: 'alice', installationId: 'alice-installation',
        actionId: operation.actionId, requestId: operation.requestId, target, accountEncryptionMode: 'plain',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } } };
    });
    let delivered = 0;
    const execute = createDaemonSessionAccountActionExecutor({
      serverId: 'bob-profile', serverHttpBaseUrl: 'https://bob-home.test', token: 'bob-session-token',
      ...{ prepareExternalActionAuthorization: async () => {
        const minted = await mintExternalActionExecutionAuthorization({ actionId: operation.actionId, envelope,
          machineId: target.machineId, pat: 'bob-session-token', serverHttpBaseUrl: 'https://bob-home.test' });
        if (!minted.ok) return null;
        const authorization = await projectExternalActionRequesterHttpAuthorization({ authorization: minted.authorization,
          serverId: 'bob-profile', serverIdentityId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test',
          target, installationId: 'alice-installation', privateKey: installation.secretKey });
        return authorization ? { authorization, target } : null;
      } },
      createExecutor: () => createActionExecutor({
        ...createCliActionDeps({ token: 'bob-session-token', sessionId: '', mode: 'plain', ctx: null }),
        notificationsNotifyMe: async (_input, context) => {
          const headers = await context.externalActionExecutionAuthorization?.requesterHttpProjection?.createRequestHeaders({
            effectActionId: operation.actionId, method: 'POST', path: '/v1/projects/account-rows/list', body: {},
          });
          if (headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'bob-home-proof') delivered += 1;
          return { attemptedChannels: 1, deliveredChannels: delivered };
        },
      }),
    });
    expect(await execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(delivered).toBe(1);
    expect(network).toHaveBeenCalled();
  });

  it.each(['recipient', 'missing'] as const)('refuses a %s Session before using the daemon Account', async (kind) => {
    vi.spyOn(axios, 'get').mockResolvedValue(kind === 'missing'
      ? { status: 404, data: {} }
      : { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session',
          share: { accessLevel: 'admin', canApprovePermissions: true } }) } });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(harness.delivered).toEqual([]);
  });

  it('preserves owner execution and rechecks the exact Home owner after admission changes', async () => {
    const read = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200,
      data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => true }))
      .toEqual({ ok: true, result: { attemptedChannels: 1, deliveredChannels: 1 } });
    expect(harness.delivered).toHaveLength(1);
    expect(read).toHaveBeenCalledWith('https://alice-home.test/v2/sessions/bob-session',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer alice-daemon-token' }) }));
    read.mockResolvedValue({ status: 404, data: {} });
    expect(await harness.isCallerCurrent()).toBe(false);
  });

  it('refuses retired runtime custody before reading the Account or delivering', async () => {
    const read = vi.spyOn(axios, 'get');
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => false }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(read).not.toHaveBeenCalled();
    expect(harness.delivered).toEqual([]);
  });

  it('refuses custody retired while the authenticated owner read is pending', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { session: createSessionRecordFixture({ id: 'bob-session', share: null }) } };
    });
    const harness = createHarness();
    expect(await harness.execute(operation, { sessionId: 'bob-session', isCurrent: async () => live }))
      .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(harness.delivered).toEqual([]);
  });
});
