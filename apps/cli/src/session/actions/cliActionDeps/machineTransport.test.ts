import { resolveExternalActionServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import axios from 'axios';
import nacl from 'tweetnacl';
import { requireExternalActionHeaders } from '@/api/externalActionHeaderRefusal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import type { RpcHandlerContext } from '@/api/rpc/types';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { createCliMachineActionTransport } from './machineTransport';
import { createCliMachineActionDeps } from './machine';
import { createCombinedMachineSetupActionDeps } from '@/machines/setup/composeMachineSetup';
import type { MachineActionDirectTargetTransport } from '../createCliActionDeps';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { AGENT_SIGN_IN_STATUS_RPC_METHOD } from '@happier-dev/protocol/daemon/agentSignIn';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { PluginAgentContributionV2Schema } from '@happier-dev/protocol';
import { readAgentTargetReadinessV1 } from '@happier-dev/protocol/actions/executor/agents/agentBackendReadiness';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { projectManifestAgentContribution } from '@/plugins/projection/registry/projectManifestAgentContribution';
import { buildReviewEngineInventory } from '../inventory/buildReviewEngineInventoryItems';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import { createCliMachineInventoryActionDeps } from './machineInventory';
import type { AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { prepareSessionAgentReadiness } from '@/session/creation/prepareSessionAgentReadiness';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

afterEach(() => vi.restoreAllMocks());

it.each(['owner', 'member'] as const)('prepares a signed Session with %s Machine facts without a serialized self-RPC', async accountId => {
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'spawn-admission', binding: {
    accountId, custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'session.spawn_new', requestId: 'spawn',
    machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  const context: RpcActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: 'home',
    machineAdmission: { actorAccountId: accountId, custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'use', encryptionMode: 'plain' },
    externalActionExecutionAuthorization: authorization, externalActionTarget: target };
  const methods: string[] = [];
  // Only installed RPC and network transport are substituted. The signed child,
  // public Action, inventory projection and pre-birth decision remain real.
  const invoke: MachineActionDirectTargetTransport['invoke'] = async (method, _request, options) => {
    methods.push(method);
    expect(options?.rpcContext?.machineAdmission?.actorAccountId).toBe(accountId);
    expect(options?.localActionContext?.externalActionExecutionAuthorization).toBe(authorization);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
      protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } },
      } },
    };
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
      'cli.codex': { ok: true, checkedAt: 1, data: { installed: true, version: null, latestVersion: null,
        update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
        platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] } },
    } };
    throw new Error(`Unexpected readiness method: ${method}`);
  };
  const network = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new RpcError('Self-RPC must not repeat requester preparation', 'permission_denied'));
  const params = { credentials: { token: 'custodian', encryption: null, credentialProvenance: 'stored_session' as const },
    serverId: 'home', serverIdentityId: 'home',
    externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
    machineActionDirectTargetTransport: { machineId: 'machine', invoke } };
  const transport = createCliMachineActionTransport(params);
  const inventoryDeps = createCliActionInventoryDeps({ ...params, token: 'custodian', sessionId: '', mode: 'plain', ctx: null });
  const machineDeps = createCliMachineInventoryActionDeps(params, { inventoryDeps, callMachineAction: transport.callMachineAction });
  const executor = createActionExecutor({ machinesAgentsList: machineDeps.machinesAgentsList });
  const result = await prepareSessionAgentReadiness({ machineId: 'machine', serverId: 'home', agentId: 'codex',
    invoke: async (actionId, input) => invokeHostAdmittedSignedReviewedChildV1({ context,
      child: { actionId, role: SESSION_AGENT_READINESS_CHILDREN_V1.inventory.role,
        inputDigest: computeActionInputApprovalDigestV1(actionId, input), input: projectNativeJsonValueForTransport(input) },
      execute: (childInput, childContext) => executor.execute(actionId, childInput, childContext),
    }),
  });
  expect(result).toBeNull();
  expect(methods).toEqual([RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, RPC_METHODS.CAPABILITIES_DETECT]);
  expect(network).not.toHaveBeenCalled();
});

it.each(['admitted', 'missing-proof', 'wrong-role', 'foreign-machine', 'foreign-installation', 'foreign-account', 'unrelated-method'] as const)(
  'retains authenticated transport for a readiness child with %s', async control => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'spawn-admission', binding: {
      accountId: 'member', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'session.spawn_new', requestId: 'spawn',
      machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context: RpcActionExecutorContext = { surface: 'cli', authority: 'present_user', serverId: 'home',
      machineAdmission: { actorAccountId: control === 'foreign-account' ? 'other-member' : 'member',
        custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    const local = vi.fn<MachineActionDirectTargetTransport['invoke']>().mockResolvedValue({ localAdmission: true });
    const network = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ authenticatedTransport: true });
    const transport = createCliMachineActionTransport({ credentials: { token: 'member', encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: control === 'foreign-installation' ? 'other-installation' : 'installation',
      externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: local } });
    const child = SESSION_AGENT_READINESS_CHILDREN_V1.inventory;
    const input = { machineId: 'machine', serverId: 'home', agentId: 'codex', refresh: true };
    const call = (childContext: RpcActionExecutorContext) => transport.callMachineAction({
      serverId: 'home',
      machineId: control === 'foreign-machine' ? 'other-machine' : 'machine',
      method: control === 'unrelated-method' ? RPC_METHODS.STOP_SESSION : RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      effectActionId: child.action, request: { machineId: 'machine', selection: 'agents' }, context: childContext,
    });
    const result = control === 'missing-proof' ? await call(context)
      : await invokeHostAdmittedSignedReviewedChildV1({ context, child: { actionId: child.action,
        role: control === 'wrong-role' ? 'forged' : child.role,
        inputDigest: computeActionInputApprovalDigestV1(child.action, input), input }, execute: (_input, childContext) => call(childContext) });
    expect(result).toEqual(control === 'admitted' ? { localAdmission: true } : { authenticatedTransport: true });
    expect(local).toHaveBeenCalledTimes(control === 'admitted' ? 1 : 0);
    expect(network).toHaveBeenCalledTimes(control === 'admitted' ? 0 : 1);
  },
);

it('delivers the reviewed Agent install operand to Home and retains the receiving installer failure', async () => {
  const target = { kind: 'machine' as const, machineId: 'machine' };
  const actionId = 'machines.agents.install';
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'parent-proof', binding: {
    accountId: 'member', custodianAccountId: 'member', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', actionId: 'machines.setup.apply', requestId: 'apply',
    machineId: target.machineId, installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  const requestId = 'run/invocation/0';
  const input = { machineId: target.machineId, agentId: 'pi', intent: 'install' as const,
    waitForTerminal: true, consent: { vendorRecipe: true } };
  const context: RpcActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'srv_home',
    actionRequestId: requestId, executionRunWorkflowRunId: 'run', externalActionExecutionAuthorization: authorization,
    externalActionTarget: target, actionCaller: { kind: 'workflowRun', runId: 'run', authorization: {
      principal: { kind: 'host' }, externalActionExecutionAuthorization: authorization,
    } } };
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'member', tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const outcome = { kind: 'failed' as const, code: 'rate_limited', message: 'The registry is rate limited.' };
  const execution = { ok: false, errorCode: 'native_effect_failed', error: outcome.message,
    details: { jobId: 'job', outcome } };
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    expect(request.envelope).toMatchObject({ requestId, target, input });
    if (!String(url).endsWith('/execution-authorization')) {
      return { status: 200, data: { v: 1, actionId, requestId, execution } };
    }
    expect(request.workflowActionOrigin).toMatchObject({ runId: 'run', requestId });
    expect(request.installationProof).toBeDefined();
    return { status: 200, data: { v: 1, token: 'child-proof', binding: {
      ...authorization.binding, actionId, requestId, workflowActionOrigin: request.workflowActionOrigin,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
    } } };
  });
  // Home and generic Machine RPC are transport boundaries. The latter cannot
  // spend a parent Apply proof as a separate native install invocation.
  vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('No receiving child admission'));
  const params = { credentials: { token, encryption: null, credentialProvenance: 'stored_session' as const },
    serverId: 'srv_home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
    externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey,
    machineActionDirectTargetTransport: { machineId: target.machineId, invoke: vi.fn() } };
  const deps = createCliMachineActionDeps(params, { ...createCliMachineActionTransport(params),
    resolveServerRequestHeaders: () => ({}) });
  await expect(deps.machineAgentInstallStart!({ ...input, serverId: params.serverId, context, effectActionId: actionId }))
    .rejects.toMatchObject(execution);
  expect(post).toHaveBeenCalledTimes(2);
});

describe('Machine capability observation during unsigned approval replay', () => {
  it.each([
    { signed: false, includeDisabled: true },
    { signed: false, includeDisabled: undefined },
    { signed: true, includeDisabled: true },
    { signed: true, includeDisabled: undefined },
  ])('preserves unavailable Review engines through Machine readiness (signed=$signed, includeDisabled=$includeDisabled)', async ({ signed, includeDisabled }) => {
    const agents = ['coderabbit', 'deepsec'].map(id => projectManifestAgentContribution({
      pluginId: `happier.review.${id}`, provenance: 'first_party', source: { kind: 'bundled' },
      definition: PluginAgentContributionV2Schema.parse({ id, title: id, primary: 'executionRuns', runtime: { kind: 'custom' },
        capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }),
    }));
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'review.engines.list', requestId: 'review-inventory',
      machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context = { surface: signed ? 'ui' : 'cli', authority: 'present_user',
      ...(signed ? { actionRequestId: 'review-inventory',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine',
          installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        externalActionExecutionAuthorization: authorization, externalActionTarget: target } : {}),
    } satisfies RpcActionExecutorContext;
    const methods: string[] = [];
    // Installed Machine RPC is the boundary. Keep the Action, transport,
    // Machine projection and Review readiness producers real beneath it.
    const invoke: MachineActionDirectTargetTransport['invoke'] = async method => {
      methods.push(method);
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
        protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: Object.fromEntries(agents.map(agent =>
          [agent.id, { id: agent.identity?.localId ?? agent.id, title: agent.id, capabilities: { executionRuns: { open: ['create'], checkpoint: false, stop: true } } }])) },
      };
      if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: Object.fromEntries(agents.map(agent =>
        [`cli.${agent.id}`, { ok: true, checkedAt: 1, data: { installed: false, version: null, latestVersion: null,
          update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
          platform: { supported: true }, install: { available: true, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] } }])) };
      throw new Error(`Unexpected native inventory method: ${method}`);
    };
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async input => {
      if (input.externalAction) throw new RpcError('A receiving Action proof cannot be spent as a fresh native RPC.', 'permission_denied');
      return invoke(input.method, input.request);
    });
    const params = { credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' as const },
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke } };
    const transport = createCliMachineActionTransport(params);
    const inventoryDeps = createCliActionInventoryDeps({ ...params, token: 'fixture', sessionId: '', mode: 'plain', ctx: null });
    const catalog = { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } satisfies AcpCatalogSnapshotV1;
    const machineDeps = createCliMachineInventoryActionDeps(params, { inventoryDeps, callMachineAction: transport.callMachineAction });
    const executor = createActionExecutor({ reviewEnginesList: async ({ machineId, includeDisabled }, actionContext) =>
      buildReviewEngineInventory({ acpCatalogSnapshot: catalog, includeDisabled,
        registrySnapshot: { agentDefinitionsById: new Map(agents.map(agent => [agent.id, agent])), executionRunProfiles: [] },
        readReadiness: targets => readAgentTargetReadinessV1({ machinesAgentsList: (args, ctx) => machineDeps.machinesAgentsList(args, ctx, catalog) },
          machineId ?? 'machine', targets.map(parseBackendTargetKeyV2), actionContext ?? {}),
      }),
    });
    const result = await executor.execute('review.engines.list', {
      ...(signed ? { sessionId: null, machineId: 'machine' } : { sessionId: 'source-session' }),
      ...(includeDisabled !== undefined ? { includeDisabled } : {}),
    }, context);
    expect(result).toMatchObject({ ok: true, result: { items: agents.map(agent => ({ engineId: agent.id,
      available: false, enabled: false, readiness: 'notInstalled', unavailableCode: 'notInstalled' })) } });
    expect(methods).toEqual([RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, RPC_METHODS.CAPABILITIES_DETECT]);
  });
  it('preserves a confirmed original-account refusal through thrown Action normalization', async () => {
    // Legacy token provenance can select the bridge, but the receiving admission
    // owner refuses it before any HTTP request or effect.
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.fixture`;
    const transport = createCliMachineActionTransport({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    let thrown: unknown;
    try {
      await transport.callMachineAction({ machineId: 'machine', method: 'fixture.stop', effectActionId: 'localServices.actions.stopManaged', request: {},
        context: { surface: 'cli', authority: 'present_user', actionRequestId: 'stop-request' } });
    } catch (error) { thrown = error; }
    expect(normalizeActionExecutorThrownError(thrown)).toMatchObject({ errorCode: 'admission_unavailable', effectAttempted: false });
  });
  it('preserves which combined target refused planning and its original typed cause', async () => {
    const params = { token: 'fixture', credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' as const },
      serverId: 'home', serverIdentityId: 'home' };
    const deps = createCliMachineActionDeps(params, { ...createCliMachineActionTransport(params),
      resolveServerRequestHeaders: (context, effectActionId, request) => requireExternalActionHeaders(
        resolveExternalActionServerRequestHeaders({ context, effectActionId, ...request, daemonToken: params.token })) });
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new RpcError('Machine access was refused.', 'permission_denied'));
    const combined = createCombinedMachineSetupActionDeps({ readDeps: () => deps, targetPlan: deps.machineSetupPlan!,
      readHostFacts: async () => ({ machines: [{ machineId: 'second', online: true }] }), orchestrationDirectory: '.',
      startCombined: async () => { throw new Error('Plan cannot start a Run'); },
      waitForRun: async () => { throw new Error('Plan cannot wait for a Run'); },
      readInvocations: async () => { throw new Error('Plan cannot read a Run'); },
    });
    await expect(combined.machineSetupPlan!({ input: { homeId: 'home', machineId: 'controller',
      targets: [{ homeId: 'home', machineId: 'second' }] },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home' } })).resolves.toMatchObject({
        ok: false, errorCode: 'permission_denied', error: 'Machine access was refused.',
        details: { target: { homeId: 'home', machineId: 'second' } },
      });
  });
  it.each([
    ['machines.agents.list', RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, true],
    ['machines.agents.list', RPC_METHODS.CAPABILITIES_DETECT, true],
    ['review.engines.list', RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, true],
    ['review.engines.list', RPC_METHODS.CAPABILITIES_DETECT, true],
    ['agents.models.list', RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, true],
    ['agents.config_options.list', RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, false],
    ['machines.agents.signIn.status', AGENT_SIGN_IN_STATUS_RPC_METHOD, true],
    ['machines.command.run', RPC_METHODS.BASH, true],
    ['machines.agents.list', 'undeclared.fixture.read', false],
  ] as const)('spends the admitted %s root only on its declared method %s', async (actionId, method, local) => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: 'guest', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId, requestId: 'root-read',
      machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'root-read',
      machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target } satisfies RpcActionExecutorContext;
    // Only the installed Machine RPC boundary is substituted. Root classification
    // and private admission/identity propagation use the real transport.
    const invoke = vi.fn<MachineActionDirectTargetTransport['invoke']>(async (_method, _request, options) => ({
      role: options?.rpcContext?.machineAdmission?.role,
      actor: options?.rpcContext?.machineAdmission?.actorAccountId,
    }));
    const transport = createCliMachineActionTransport({ serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke } });
    const result = transport.callMachineAction({ machineId: 'machine', method, effectActionId: actionId, request: {}, context });
    if (local) await expect(result).resolves.toEqual({ role: 'use', actor: 'guest' });
    else {
      await expect(result).rejects.toMatchObject({ rpcErrorCode: 'not_authenticated' });
      expect(invoke).not.toHaveBeenCalled();
    }
  });

  it('passes the caller context signal to the installed workspace-sync preflight owner', async () => {
    const target = { kind: 'machine' as const, machineId: 'machine' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-admission', binding: {
      accountId: 'guest', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
      accountEncryptionMode: 'plain', serverIdentityId: 'home', actionId: 'workspace.sync.relationship.create', requestId: 'root-sync',
      machineId: 'machine', installationId: 'installation', target, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const caller = new AbortController();
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home', actionRequestId: 'root-sync',
      signal: caller.signal,
      machineAdmission: { actorAccountId: 'guest', custodianAccountId: 'owner', machineId: 'machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      externalActionExecutionAuthorization: authorization, externalActionTarget: target } satisfies RpcActionExecutorContext;
    // Only the installed preflight owner is substituted; the real transport routes to it.
    const workspaceSyncPreflightTarget = vi.fn<NonNullable<MachineActionDirectTargetTransport['workspaceSyncPreflightTarget']>>(
      async () => ({ type: 'not_required' as const }));
    const transport = createCliMachineActionTransport({ serverId: 'home', serverIdentityId: 'home',
      externalActionMachineInstallationId: 'installation', externalActionMachineRequestPrivateKey: new Uint8Array(64),
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: vi.fn(), workspaceSyncPreflightTarget } });
    await transport.callMachineAction({ machineId: 'machine', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT,
      effectActionId: 'workspace.sync.relationship.create', context,
      request: { v: 1, serverId: 'home', machineId: 'machine', operationId: 'op-1', targetPath: '/work/target' } });
    expect(workspaceSyncPreflightTarget).toHaveBeenCalledTimes(1);
    expect(workspaceSyncPreflightTarget.mock.calls[0]?.[1].signal).toBe(caller.signal);
  });

  it.each([RPC_METHODS.DAEMON_BROWSER_PROFILE_LOGIN_SOURCES, RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIE_SOURCE_READ,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_COOKIES_APPLY,
    RPC_METHODS.DAEMON_BROWSER_PROFILE_PASSKEYS_APPLY,
  ])('keeps native credential %s on authenticated Machine ingress', async method => {
      const local = vi.fn<MachineActionDirectTargetTransport['invoke']>();
      const admitted = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'unavailable', code: 'permission_denied' });
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: local },
      });
      expect(await transport.callMachineAction({ machineId: 'machine', method, request: {} }))
        .toEqual({ status: 'unavailable', code: 'permission_denied' });
      expect(local).not.toHaveBeenCalled();
      expect(admitted).toHaveBeenCalledOnce();
    });
  it.each(['current', 'foreign_requester'] as const)(
    'uses receiving Home admission rather than an unadmitted local hop (%s)', async control => {
      const admission = createFilesystemEffectAdmission({
        resolveHomeServerIdentityId: async () => 'srv_home',
        resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation' }),
      });
      const ingress: RpcHandlerContext = {
        signal: new AbortController().signal,
        callerAuthority: 'present_user',
        machineAdmission: { actorAccountId: control === 'foreign_requester' ? 'member' : 'owner',
          custodianAccountId: 'owner', machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => !ingress.signal.aborted,
      };
      const observed = { results: { 'tool.executionRuns': { ok: true, data: { backends: {}, features: {} } } } };
      // Only the authenticated RPC boundary is substituted. Its native-effect
      // admission is the real owner, including local cancellation and Account identity.
      const detect = async (context?: RpcHandlerContext) => {
        const refused = await admission.rpc(context);
        if (refused) throw new RpcError(refused.error, refused.errorCode);
        return observed;
      };
      const homeRead = vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async () => detect(ingress));
      const localRead = vi.fn<MachineActionDirectTargetTransport['invoke']>(async (_method, _request, options) => detect(options?.rpcContext
        ? { ...options.rpcContext, signal: options.signal ?? ingress.signal } : undefined));
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture-owner', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: localRead },
      });
      const read = transport.callMachineAction({ machineId: 'machine', method: RPC_METHODS.CAPABILITIES_DETECT,
        request: { requests: [{ id: 'tool.executionRuns' }] } });
      if (control === 'current') await expect(read).resolves.toEqual(observed);
      else await expect(read).rejects.toMatchObject({ rpcErrorCode: 'filesystem_identity_custody_unavailable' });
      expect(homeRead).toHaveBeenCalledOnce();
      expect(localRead).not.toHaveBeenCalled();
    },
  );
});
