import { tmpdir } from 'node:os';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { deriveSessionCreationTagV1, SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerSessionCreationTargetPreparationRpc } from '@/session/creation/registerSessionCreationTargetPreparationRpc';
import { createCliActionDeps } from './createCliActionDeps';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import nacl from 'tweetnacl';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

describe('Session spawn Home admission', () => {
  afterEach(() => vi.restoreAllMocks());
  it('does not preflight a Project guest directory on the controller', async () => {
    const controller = { machineId: 'target-machine', installationId: 'installation' };
    const signal = new AbortController().signal;
    const rpc = vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new Error('Controller directory read'));
    const credentials = { token: 'fixture-owner', encryption: null };
    const deps = createCliActionDeps({
      credentials, token: credentials.token, sessionId: 'cli', mode: 'plain', ctx: null,
      serverId: 'portable-home', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test',
    });
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'guest-project-session', executionTarget: { serverId: 'portable-home', machineId: controller.machineId },
      directory: { kind: 'path', path: '/guest/project' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      sessionPlacement: { kind: 'in_place', workspace: {
        v: 2, kind: 'managed', serverId: 'portable-home', workspaceId: 'retained-project',
        managedId: 'guest', controller, rootPath: '/guest/project',
      } },
    });
    await expect(deps.sessionSpawnNewDirectoryApprovalPreflight!({ input, signal })).resolves.toEqual({ type: 'not_required' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses an unsigned foreign bound spawn with secret Setup before Account HTTP or native effects', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'controller-account' })).toString('base64url')}.signature`;
    // Home HTTP and Machine RPC are the boundaries. Keep spawn parsing,
    // requester custody selection and admission real; no Setup context is authored.
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected controller Account read'));
    const post = vi.spyOn(axios, 'post').mockRejectedValue(new Error('Unexpected controller Account write'));
    const native = vi.spyOn(machineRpc, 'callExactMachineRpc').mockRejectedValue(new Error('Unexpected native effect'));
    const legacyNative = vi.spyOn(machineRpc, 'callMachineRpc').mockRejectedValue(new Error('Unexpected native effect'));
    const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test' });
    const request = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
      managedTargetPlacement: { managedId: 'bound-secret-sandbox', workspaceRoot: '/workspace' },
      machineSetupPlanInput: { homeId: 'portable-home', machineId: 'target-machine', sources: [
        { kind: 'bundledPreset', ref: { pluginId: 'acme.setup', localId: 'script-secret', revision: '1' }, setup: {
          scripts: [{ body: 'test -n "$SETUP_KEY"' }],
          secretRefs: { v: 1, bindings: { SETUP_KEY: { ref: 'happier:shared-secret:v1:controller-setup-secret', revision: 1 } } },
        } },
        { kind: 'direct', setup: {} },
      ] },
    });
    const creationKey = SessionCreationKeyV1Schema.parse('unsigned-foreign-bound-spawn');
    await expect(deps.sessionSpawnNew({ ...request, creationKey,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey }),
      actionCaller: { kind: 'host' },
      context: { externalActionCredential: { accountId: 'foreign-requester', principalId: 'foreign-requester',
        credentialId: 'foreign-service', grant: API_TOKEN_FULL_GRANT_V1 } },
    })).rejects.toMatchObject({ code: 'action_failed', effectAttempted: false,
      details: { authorizationRefusalReason: 'external_credential_without_authorization' } });
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(legacyNative).not.toHaveBeenCalled();
  });
  it('retains machine admission cause on a refused /tmp directory spawn', async () => {
    const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
      errorCode: 'machine_unavailable', httpStatus: 403 };
    // Home Machine RPC is the transport boundary; creation decoding and projection stay real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockResolvedValue({
      error: 'Forbidden', errorCode: 'RPC_FORBIDDEN', failureCause,
    });
    const deps = createCliActionDeps({ token: 'fixture-token',
      credentials: { token: 'fixture-token', encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test' });
    const input = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: '/tmp' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
    });
    const preflight = deps.sessionSpawnNewDirectoryApprovalPreflight;
    if (!preflight) throw new Error('Missing Session directory preflight');
    await expect(preflight({ input })).resolves.toEqual({ type: 'error',
      result: { type: 'error', code: 'permission_denied', retryable: false, failureCause } });
  });
  it('keeps an admitted requester directory preflight inside its receiving Machine', async () => {
    // Receiving authorization is the Home/native-ingress boundary; registration,
    // transport selection, parsing and filesystem preparation remain real.
    const rpc = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {},
      authorizeRequest: async () => ({ ok: true }) });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc });
    // Home HTTP is the boundary. An admitted local preparation must not need
    // another Machine codec read or serialize its private receiving custody.
    const home = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Unexpected Machine codec read'));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-root', binding: {
      accountId: 'requester', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'portable-home', machineId: 'target-machine', installationId: 'installation',
      actionId: 'session.spawn_new', requestId: 'requester-start', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'target-machine' },
    } });
    const deps = createCliActionDeps({ token: 'fixture-owner', credentials: { token: 'fixture-owner', encryption: null },
      sessionId: 'cli', mode: 'plain', ctx: null, serverId: 'local-profile', serverIdentityId: 'portable-home',
      serverHttpBaseUrl: 'https://home.test', externalActionMachineInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: nacl.sign.keyPair().secretKey,
      machineActionDirectTargetTransport: { machineId: 'target-machine', invoke: (method, request, options) =>
        rpc.invokeLocal(method, request, options) },
    });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'requester-start',
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' }, directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    await expect(deps.sessionSpawnNewDirectoryApprovalPreflight!({ input, context: {
      externalActionExecutionAuthorization: authorization,
      externalActionTarget: { kind: 'machine', machineId: 'target-machine' },
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner', machineId: 'target-machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' },
    } })).resolves.toMatchObject({ type: 'not_required' });
    expect(home).not.toHaveBeenCalled();
  });
  it.each(['controller', 'native_rpc'] as const)('preflights an owner Workflow Session through receiving Machine admission (%s)', async boundary => {
    // Authorization is the Home boundary; all controller and filesystem logic
    // remains real. The native transport also exercises the loaded refusal
    // before the newer controller's earlier requester-admission guard.
    const rpc = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {},
      authorizeRequest: async () => ({ ok: true }) });
    const handlers = new Map<string, (input: unknown, context: RpcHandlerContext) => Promise<unknown>>();
    const nativeRpc: RpcHandlerRegistrar = { registerHandler(method, handler) {
      // RPC input is untyped at this transport boundary; the registered owner parses it.
      handlers.set(method, async (input, context) => await handler(input as never, context));
    } };
    const invoke: typeof rpc.invokeLocal = async (method, input, options) => boundary === 'controller'
      ? await rpc.invokeLocal(method, input, options)
      : await handlers.get(method)!(input, { signal: options?.signal ?? new AbortController().signal,
          ...options?.rpcContext, localActionContext: options?.localActionContext });
    const admission = createFilesystemEffectAdmission({
      resolveHomeServerIdentityId: async () => 'portable-home',
      resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'target-machine', installationId: 'installation' }),
    });
    const registrar = boundary === 'controller' ? rpc : nativeRpc;
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: registrar, directoryPreflightAdmission: admission });
    const signal = new AbortController().signal;
    // Only Home's authenticated RPC transport is substituted; Workflow context,
    // startup preflight, receiving custody and filesystem preparation stay real.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => invoke(request.method, request.request, {
      signal, rpcContext: { callerAuthority: 'account_automation',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'target-machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => !signal.aborted },
    }));
    const deps = createCliActionDeps({ credentials: { token: 'fixture-owner', encryption: null }, token: 'fixture-owner',
      sessionId: 'cli', mode: 'plain', ctx: null, serverId: 'local-profile', serverIdentityId: 'portable-home',
      serverHttpBaseUrl: 'https://home.test',
      machineActionDirectTargetTransport: { machineId: 'target-machine', invoke },
    });
    const context = buildWorkflowActionContext({ runId: 'owner-workflow',
      authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      workspace: { machineId: 'target-machine' }, signal },
    { serverId: 'portable-home', accountId: 'owner', machineId: 'target-machine', installationId: 'installation' });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'owner-workflow-session',
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' }, directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    await expect(deps.sessionSpawnNewDirectoryApprovalPreflight!({ input, context, signal })).resolves.toMatchObject({ type: 'not_required' });
  });
  it('keeps a member requester\'s isolation refusal and Security remedy through the directory preflight', async () => {
    // C54: a failed Separate users Apply left member preparation refusing. The
    // refusal reached New Session as a bare code with no reason or Security action.
    const rpc = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {},
      authorizeRequest: async () => ({ ok: true }) });
    const remedy = { kind: 'open_machine_security', target: { serverId: 'portable-home', machineId: 'target-machine' } } as const;
    const admission = createFilesystemEffectAdmission({
      resolveHomeServerIdentityId: async () => 'portable-home',
      resolveHostIdentity: async () => ({ custodianAccountId: 'owner', machineId: 'target-machine', installationId: 'installation' }),
      // Native member preparation is the OS boundary; it refuses exactly as the daemon's member provisioner does.
      executeNativeRpc: async () => { throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Member execution requires owner setup', retryable: false, details: {
          reason: 'member_setup_required', phase: 'native_execution_preparation', reasonCode: 'native_check_unavailable',
          nativeFailure: { kind: 'native_check_unavailable', reason: 'foreign_effect_conflict', requiredFact: 'member-workspaces' },
          remedy } }); },
    });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc, directoryPreflightAdmission: admission });
    const signal = new AbortController().signal;
    // Only Home's authenticated RPC transport is substituted.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => rpc.invokeLocal(request.method, request.request, {
      signal, rpcContext: { machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'owner',
        machineId: 'target-machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => !signal.aborted },
    }));
    const deps = createCliActionDeps({ credentials: { token: 'fixture-requester', encryption: null }, token: 'fixture-requester',
      sessionId: 'cli', mode: 'plain', ctx: null, serverId: 'local-profile', serverIdentityId: 'portable-home',
      serverHttpBaseUrl: 'https://home.test' });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'member-start',
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' }, directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
    await expect(deps.sessionSpawnNewDirectoryApprovalPreflight!({ input, signal })).resolves.toEqual({ type: 'error',
      result: { type: 'error', code: 'spawn_failed', retryable: false, launchError: { kind: 'launch_error',
        code: 'agent_isolation_unavailable', message: 'Member execution setup is unavailable.',
        agentIsolationRefusal: { reason: 'member_setup_required', phase: 'native_execution_preparation',
          reasonCode: 'native_check_unavailable',
          nativeFailure: { kind: 'native_check_unavailable', reason: 'foreign_effect_conflict' }, remedy } } } });
  });
  it.each(['checkout_failed', 'checkout_unavailable', 'agent_isolation_unavailable'] as const)('preserves %s from target preparation at the CLI preflight sink', async code => {
    const input = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
    });
    // Target preparation crosses authenticated Home RPC, even on this Machine.
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockResolvedValue(code === 'agent_isolation_unavailable'
      ? { error: 'private native requester detail', errorCode: code }
      : SessionCreationTargetPreparationResultV1Schema.parse({ ok: false, code }));
    const deps = createCliActionDeps({
      token: 'fixture-token', credentials: { token: 'fixture-token', encryption: null },
      sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test',
    });
    const preflight = deps.sessionSpawnNewDirectoryApprovalPreflight;
    if (!preflight) throw new Error('Missing Session directory preflight');
    await expect(preflight({ input })).resolves.toEqual({ type: 'error', result: code === 'agent_isolation_unavailable'
      ? { type: 'error', code: 'spawn_failed', retryable: false,
          launchError: { kind: 'launch_error', code, message: code } }
      : code === 'checkout_failed'
      ? { type: 'error', code: 'spawn_failed', retryable: true,
          launchError: { kind: 'launch_error', code, message: code } }
      : { type: 'error', code: 'incompatible_target', retryable: false,
          incompatibleTarget: { reason: 'checkout_unavailable' } } });
  });

  it('refuses a private-origin handoff when the target only advertises ordinary spawn', async () => {
    const request = SessionSpawnNewInputV2Schema.parse({
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
      authoringOrigin: { kind: 'project', accountId: 'source-account',
        workspace: { serverId: 'source-home', workspaceId: 'source-workspace', machineId: 'source-machine', rootPath: '/source/repo' }, page: 'scripts' },
    });
    // Only Home HTTP is replaced: the real capability reader and spawn
    // admission must refuse before target preparation or any native create.
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { machine: {
      id: 'target-machine', revokedAt: null, replacedByMachineId: null,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1] } },
      operationProtocolCapabilitiesRevision: 1,
    } } });
    const post = vi.spyOn(axios, 'post');
    const deps = createCliActionDeps({
      token: 'fixture-token', credentials: { token: 'fixture-token', encryption: null },
      sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test',
    });
    const creationKey = SessionCreationKeyV1Schema.parse('private-origin-capability');
    await expect(deps.sessionSpawnNew({ ...request, creationKey,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey }),
      actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ type: 'error', code: 'update_required', retryable: false,
      details: { reason: 'session_spawn_authoring_origin_update_required' } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  it('admits a portable Home identity through the registered target preparation and refuses another Home', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'target-machine', encryptionMode: 'plain', logger() {} });
    registerSessionCreationTargetPreparationRpc({ rpcHandlerManager: rpc });
    const lifetime = new AbortController();
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request =>
      rpc.invokeLocal(request.method, request.request, { signal: request.signal }));
    const creationKey = 'channel-thread:router:thread';
    const input = SessionSpawnNewInputV2Schema.parse({
      creationKey,
      executionTarget: { serverId: 'portable-home', machineId: 'target-machine' },
      directory: { kind: 'path', path: tmpdir() },
      agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'worker' } },
      attestedContext: { externalPrincipalId: 'principal-1', sourceMessageId: 'message-1' },
    });
    const deps = createCliActionDeps({
      token: 'fixture-token', credentials: { token: 'fixture-token', encryption: null },
      sessionId: '', mode: 'plain', ctx: null,
      serverId: 'local-profile', serverIdentityId: 'portable-home', serverHttpBaseUrl: 'https://home.test',
      // Substitute only Machine RPC transport. Registration, request parsing,
      // target filesystem preparation and the CLI admission owner remain real.
      machineActionDirectTargetTransport: { machineId: 'target-machine', invoke: (method, request, options) =>
        rpc.invokeLocal(method, request, { signal: options?.signal }) },
    });
    const preflight = deps.sessionSpawnNewDirectoryApprovalPreflight;
    if (!preflight) throw new Error('Missing Session directory preflight');
    await expect(preflight({ input, signal: lifetime.signal })).resolves.toMatchObject({ type: 'not_required' });
    await expect(preflight({ input: { ...input, executionTarget: { ...input.executionTarget, serverId: 'local-profile' } },
      signal: lifetime.signal })).resolves.toMatchObject({ type: 'not_required' });
    await expect(preflight({ input: { ...input, executionTarget: { ...input.executionTarget, serverId: 'other-home' } },
      signal: lifetime.signal })).resolves.toEqual({ type: 'error',
      result: { type: 'error', code: 'target_unavailable', retryable: false } });

    // Home admission must also reach the actual spawn owner's capability gate.
    // A Home HTTP absence is a genuine boundary refusal; no native Session is created.
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
    const spawnInput = { ...input, creationKey: SessionCreationKeyV1Schema.parse(creationKey),
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'plugin:acme.channels', creationKey }),
      actionCaller: { kind: 'plugin' as const, pluginId: 'acme.channels' }, signal: lifetime.signal };
    await expect(deps.sessionSpawnNew(spawnInput)).resolves.toMatchObject({
      type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'session_spawn_protocol_unavailable' },
    });
    await expect(deps.sessionSpawnNew({ ...spawnInput,
      executionTarget: { ...input.executionTarget, serverId: 'other-home' } })).resolves.toEqual({
      type: 'error', code: 'target_unavailable', retryable: false,
    });

    // A disconnected registration must not pass on Home equality alone.
    rpc.unregisterHandler(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT);
    await expect(preflight({ input, signal: lifetime.signal })).resolves.toEqual({ type: 'error', result: {
      type: 'error', code: 'incompatible_target', retryable: false,
      incompatibleTarget: { reason: 'target_preparation_rpc_unavailable' },
    } });
  });
});
