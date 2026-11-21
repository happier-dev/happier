import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, SessionSpawnNewInputV2Schema, accountSettingsParse } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import '@/session/services/createSpawnedSession';
import { prepareSessionFollowSourceKey } from '@/agent/runtime/session/follow/prepareSessionFollowSourceKey';
import { createApiSessionSocketStub, bindApiSessionSocketMock } from '@/testkit/backends/apiSessionSocketHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { SessionCreationTargetPreparationRequestV1Schema, SessionCreationTargetPreparationResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { io } from 'socket.io-client';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { CapabilitiesDetectResponse } from '@/capabilities/types';
import { registerMachineSessionServerStartRpcHandler } from '@/rpc/handlers/sessionServerStartMachineBinding';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, ActionAutomationIndexV1Schema } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetServerFeaturesClientForTests(); });

it.each([
  { active: false, protocolVersion: 4, path: false, checkout: false }, { active: true, protocolVersion: 4, path: false, checkout: false },
  { active: false, protocolVersion: 4, path: true, checkout: false }, { active: false, protocolVersion: 3, path: false, checkout: false },
  { active: false, protocolVersion: 4, path: true, checkout: true },
].flatMap(testCase => [
  { ...testCase, localMachineId: undefined, differentRoot: false, admitted: true },
  ...(testCase.protocolVersion === 4 && !testCase.active && testCase.path && !testCase.checkout
    ? [{ ...testCase, localMachineId: 'machine-1', differentRoot: false, admitted: true }] : []),
  ...(testCase.protocolVersion === 4 && !testCase.active && !testCase.path
    ? [{ ...testCase, localMachineId: 'another-local-machine', differentRoot: false, admitted: true },
      { ...testCase, localMachineId: 'parent-machine', differentRoot: true, admitted: true },
      { ...testCase, localMachineId: 'parent-machine', differentRoot: true, admitted: false }] : []),
]))('uses the admitted requester for committed birth ($active, v$protocolVersion, path=$path, checkout=$checkout, local=$localMachineId, differentRoot=$differentRoot, admitted=$admitted)', async ({ active, protocolVersion, path: authoredPath, checkout, localMachineId, differentRoot, admitted }) => {
  const accountId = 'requester';
  const sessionId = `requester-session-${active ? 'active' : 'offline'}-v${protocolVersion}-${authoredPath ? 'path' : 'managed'}-${checkout ? 'checkout' : 'plain'}-${localMachineId ?? 'remote'}`;
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: null };
  const rootMachineId = differentRoot ? 'parent-machine' : 'machine-1';
  const targetInstallationId = differentRoot ? 'target-installation' : 'installation-1';
  const targetKey = nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
  const exactDaemon = localMachineId === 'machine-1';
  const checkoutCreationDraft = checkout ? { kind: 'git_worktree' as const, displayName: 'bot', baseRef: 'main', branchMode: 'new' as const } : undefined;
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'finite-template-birth',
    executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: authoredPath
      ? { kind: 'path', path: exactDaemon ? tmpdir() : 'C:\\Users\\Remote\\project' } : { kind: 'managed' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
    ...(checkoutCreationDraft ? { checkoutCreationDraft } : {}),
  });
  const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'finite-template-birth',
    target: { kind: 'machine', machineId: rootMachineId }, input: { creation: input } });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
    custodianAccountId: accountId, serverIdentityId: 'home-a', machineId: rootMachineId, installationId: 'installation-1',
    admittedMachineRole: 'manage',
    actionId: 'template.instantiate', requestId: envelope.requestId, target: envelope.target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  const events: string[] = [];
  const posts: string[] = [];
  const preparedDirectory = authoredPath ? `${input.directory.kind === 'path' ? input.directory.path : ''}${checkout ? '\\bot' : ''}` : '/remote/managed/bot';
  const socket = createApiSessionSocketStub({ emitWithAck: async (event, rawCall) => {
    if (event !== SOCKET_RPC_EVENTS.CALL || !rawCall || typeof rawCall !== 'object') throw new Error('Unexpected RPC');
    const call = rawCall as { method: string; params: unknown };
    if (differentRoot) expect(rawCall).not.toHaveProperty('externalActionExecution');
    const content = { mode: 'plain' as const };
    const decoded = await socketRpcCodec.decodeRequestParams(content, call.params, call.method);
    try {
      if (differentRoot) {
        const authentication = vi.mocked(io).mock.calls.at(-1)?.[1]?.auth;
        expect(authentication).toMatchObject({ token, authorityCeiling: 'account_automation' });
        // Home's authenticated socket is the network boundary. The native
        // receiver's real admission owner must accept that same requester and
        // ceiling without treating the controller's root as a recipient grant.
        const machineAdmission = { actorAccountId: accountId, custodianAccountId: accountId,
          machineId: 'machine-1', installationId: targetInstallationId, role: 'manage' as const, encryptionMode: 'plain' as const };
        expect(await authorizeMachineRpcRequest({ method: call.method, params: decoded.params,
          callerAuthority: 'account_automation', machineAdmission }, {
          machineId: 'machine-1', resolveCustodianAccountId: async () => accountId,
          resolveHomeServerIdentityId: async () => 'home-a',
          resolveInstallationId: () => targetInstallationId,
          verifyMachineAdmission: async () => { throw new Error('Authenticated Home admission was checked twice'); },
        }, 'authenticated_home_socket')).toMatchObject({ ok: true });
      }
    } catch (error) {
      boundaryFailure ??= { method: call.method, error };
      throw error;
    }
    let result: unknown;
    // The selected Machine's registry and Agent probe are RPC boundaries. Keep
    // readiness, requester admission and Session birth on their real owners.
    if (call.method === `machine-1:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
      result = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
        codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
      } } });
    } else if (call.method === `machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`) {
      result = { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
        installed: true, version: '1.2.3', latestVersion: null, update: { supported: false, command: null },
        signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
        install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
      } } } } satisfies CapabilitiesDetectResponse;
    } else if (call.method === `machine-1:${RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE}`
      || call.method === `machine-1:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
      const request = SessionCreationTargetPreparationRequestV1Schema.parse(decoded.params);
      expect(request.directory).toEqual(input.directory);
      events.push(request.sessionCreationTag ? 'prepare' : 'preflight');
      result = SessionCreationTargetPreparationResultV1Schema.parse({ ok: true, directory: preparedDirectory,
        directoryKind: input.directory.kind, directoryCreationRequired: false,
        checkout: checkout ? { kind: 'git_worktree', finalDirectory: preparedDirectory, baseRef: 'main', branchMode: 'new' } : null });
    } else if (call.method === `machine-1:${RPC_METHODS.SPAWN_HAPPY_SESSION}`
      || call.method === `machine-1:${RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE}`) {
      const request = SpawnDaemonSessionRequestSchema.parse(decoded.params);
      if (request.type === 'resume-session') {
        expect(request).toMatchObject({ directory: preparedDirectory, sessionId });
        events.push('resume');
        result = { type: 'success', sessionId };
      } else {
        expect(request).toMatchObject({ directory: preparedDirectory, existingSessionId: sessionId });
        events.push('spawn');
        result = { success: true, sessionId, sessionCreationOutcome: {
          disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
      }
    } else throw new Error(`Unexpected RPC ${call.method}`);
    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
  } });
  bindApiSessionSocketMock(vi.mocked(io), socket);
  let bornSession: Record<string, unknown> | undefined;
  let boundaryFailure: unknown;
  let machineBound = false;
  vi.spyOn(axios, 'request').mockImplementation(async request => {
    if (!request.url) throw new Error('Expected fixture HTTP URL');
    if ((request.method ?? 'get').toLowerCase() === 'get') return axios.get(request.url, request);
    if (request.method?.toLowerCase() === 'post') return axios.post(request.url, request.data, request);
    throw new Error(`Unexpected HTTP method ${request.method}`);
  });
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/session-organization') return { status: 200, data: { snapshot: {
      schemaVersion: 1, version: 0, pins: [], folders: [], tags: [], folderAssignments: [], tagAssignments: [], orderEntries: [], labels: [],
    } } };
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) return { status: 200,
      data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/machines/machine-1') return { status: 200, data: { machine: { id: 'machine-1', active,
      installationId: targetInstallationId, installationPublicKey: Buffer.from(targetKey.publicKey).toString('base64'),
      kind: 'persistent', managedMachineRef: null, storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
      // Home's opaque projection need not provide the daemon's opened metadata.
      // Target admission remains readable; native spawn uses its held publication.
      metadata: exactDaemon ? null : encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
        host: 'fixture', platform: process.platform, happyCliVersion: '0.0.0-test', homeDir: tmpdir(), happyHomeDir: tmpdir(),
      })), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
      revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: protocolVersion === 4 ? [1, 2, 3, 4] : [1, 2, 3] }, sessionSpawnPlacementOrigin: { protocolVersions: [1] } } } } };
    if (path === `/v1/access-keys/${sessionId}/machine-1`) return { status: 200,
      data: { accessKey: machineBound ? { data: 'bound-key' } : null } };
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: bornSession } };
    const error = new Error(`Unexpected Home read ${path}`);
    boundaryFailure ??= error;
    throw error;
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, raw, config) => {
    try {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: bornSession ? [bornSession] : [] } };
      posts.push(path);
      if (path === '/v1/sessions') {
        events.push('birth');
        expect(raw).not.toHaveProperty('templateRequesterAuthorization');
        expect(AxiosHeaders.from(config?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        if (!raw || typeof raw !== 'object') throw new Error('Missing birth body');
        const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(raw, 'ownerMetadata'));
        expect(ownerMetadata.t === 'plain' && ownerMetadata.v.system?.sessionCreationCorrespondenceV1?.recipe).not.toHaveProperty('machineSetupExecution');
        if (ownerMetadata.t !== 'plain') throw new Error('Expected plain owner metadata');
        expect(ownerMetadata.v.system?.sessionCreationCorrespondenceV1?.recipe.execution.directory).toEqual(
          input.directory.kind === 'managed' ? input.directory : { kind: 'path', path: preparedDirectory });
        if (!authoredPath) expect(ownerMetadata.v.workspace?.sessionDirectoryV1).toMatchObject({ kind: 'managed' });
        if (checkoutCreationDraft) expect(ownerMetadata.v.system?.sessionCreationCorrespondenceV1?.recipe).toMatchObject({ checkoutCreationDraft });
        expect(ownerMetadata.v.workspace?.path).toBe(preparedDirectory);
        const shared = Reflect.get(raw, 'sharedMetadata');
        if (!shared || typeof shared !== 'object') throw new Error('Missing shared metadata');
        bornSession = { id: sessionId, seq: 0, createdAt: 1, updatedAt: 1,
            active: false, activeAt: 1, archivedAt: null, metadataVersion: 1, metadataLayoutVersion: 1,
            metadata: Reflect.get(shared, 'ciphertext'), ownerMetadata, encryptionMode: 'plain', agentState: null,
            agentStateVersion: 0, dataEncryptionKey: null, share: null };
        return { status: 200, data: { created: true, session: bornSession } };
      }
      if (path === `/v1/access-keys/${sessionId}/machine-1`) {
        expect(AxiosHeaders.from(config?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(raw).toMatchObject({ data: expect.any(String) });
        machineBound = true;
        events.push('machine-binding');
        return { status: 200, data: { success: true, accessKey: { data: Reflect.get(raw as object, 'data') } } };
      }
      if (path === `/v2/sessions/${sessionId}/pending/template-onboarding`) {
        events.push('onboarding');
        const body = SessionPendingTemplateOnboardingRequestV1Schema.parse(raw);
        expect(Object.keys(body)).toEqual(['request']);
        expect(AxiosHeaders.from(config?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(body.request).toMatchObject({ v: 1, targetMachineId: 'machine-1', requestedAction: { v: 1, kind: 'send_now' }, content: { t: 'plain' } });
        expect(JSON.stringify(body.request.content)).toContain('hostOnboarding');
        // An admitted explicit path reuses its prepared preflight result; a
        // managed directory or new checkout needs native preparation instead.
        expect(events).toEqual([authoredPath && !checkout ? 'preflight' : 'prepare',
          'birth', 'machine-binding', 'content', 'spawn', 'onboarding']);
        return { status: 200, data: { v: 1, result: { status: 'accepted', localId: body.request.localId } } };
      }
      throw new Error(`Unexpected Home write ${path}`);
    } catch (error) { boundaryFailure ??= error; throw error; }
  });
  vi.stubGlobal('fetch', vi.fn(async url => {
    if (new URL(String(url)).pathname === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1) {
      return Response.json(ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
    }
    if (String(url).endsWith('/v1/account/profile')) return Response.json({ id: accountId });
    if (String(url).endsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true }, sharing: { session: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const executor = createCliActionExecutor({ credentials, token, sessionId: '', mode: 'plain', ctx: null,
    serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    externalActionMachineInstallationId: 'installation-1',
    externalActionMachineRequestPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({ memoryUpkeepInNewBots: false }) }),
    ...(exactDaemon ? { sessionSpawnDirectTargetTransport: (() => {
      const transport = registerMachineSessionServerStartRpcHandler({ registerHandler() {} }, { machineId: 'machine-1',
        token, readCredentials: async () => credentials, resolveAccountId: async () => accountId,
        resolveInstallationId: () => 'installation-1',
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }),
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        spawnLifecycleHandler: async raw => {
          const request = SpawnDaemonSessionRequestSchema.parse(raw);
          expect(request).toMatchObject({ directory: tmpdir(), existingSessionId: sessionId });
          events.push('spawn');
          return { type: 'success', sessionId, sessionCreationOutcome: {
            disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
        },
      });
      return { ...transport, prepare: async (...args: Parameters<typeof transport.prepare>) => {
        events.push(args[0].sessionCreationTag ? 'prepare' : 'preflight');
        return transport.prepare(...args);
      } };
    })() } : localMachineId ? { sessionSpawnDirectTargetTransport: {
      machineId: localMachineId,
      // This daemon adapter is an OS boundary for a different Machine. Its
      // presence must leave the approved remote target on the Home transport.
      prepare: async () => { throw new Error('Remote creation used local preparation'); },
      spawnedSession: {
        spawn: async () => { throw new Error('Remote creation used local spawn'); },
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' as const }),
      },
    } } : {}),
  });
  // The Account-placement root executes on its controller. Its approved child
  // selects another Machine; retain the real admitted custody/sealing owner.
  const projectedAccount = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'home-a',
    invocation: { caller: { kind: 'host' }, surface: 'cli', authority: differentRoot ? 'account_automation' : 'present_user' },
    bootstrap: { credentials, serverHttpBaseUrl: 'https://home-a.example.test', isCurrent: async () => true,
      attribution: { serverId: 'home-a', accountId, machineId: rootMachineId, installationId: 'installation-1' } } });
  const projected = projectedAccount && await projectExternalActionRequesterHttpAuthorization({
    authorization: projectedAccount, serverId: 'home-a', serverIdentityId: 'home-a',
    serverHttpBaseUrl: 'https://home-a.example.test', target: envelope.target, installationId: 'installation-1',
    privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey,
    isCurrent: async () => true, rootAdmitted: true,
  });
  expect(projected).not.toBeNull();
  const context: ActionExecutorContext = exactDaemon ? {
    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: accountId, serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: envelope.requestId,
  } : { surface: 'cli', authority: differentRoot ? 'account_automation' : 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: accountId, serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: envelope.requestId,
    externalActionExecutionAuthorization: projected!, externalActionTarget: authorization.binding.target, originalActionEnvelope: envelope };
  const result = await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: { creation: input } }, context,
    child: { action: 'session.spawn_new', role: 'create_bot', input },
    admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
    invocationServices: { sessionCreation: { beforeLaunch: async () => { events.push('content'); },
      hostOnboarding: { templateName: 'Helper', templateVersion: '1.0.0' } } },
    execute: (childInput, childContext, actionId) => executor.execute(actionId, childInput, admitted ? childContext : context),
  });
  expect(boundaryFailure).toBeUndefined();
  if (!admitted) {
    expect(result).toMatchObject({ ok: false });
    expect(events).toEqual([]);
    expect(posts).toEqual([]);
    return;
  }
  expect(result, JSON.stringify({ result, events, posts })).toMatchObject({ ok: true,
    result: { type: 'success', sessionId, initialInput: { status: 'accepted' } } });
  if (differentRoot) expect(events).toContain('resume');
  expect(posts).toEqual(['/v1/sessions', `/v1/access-keys/${sessionId}/machine-1`,
    `/v2/sessions/${sessionId}/pending/template-onboarding`]);
});

it('classifies a persistent template manager through the admitted child requester before requiring a source key', async () => {
  const accountId = 'requester';
  const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'manager-source-key',
    executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: { kind: 'managed' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false, manager: { sessionId: 'manager' },
  });
  const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'manager-source-key',
    target: { kind: 'machine', machineId: 'machine-1' }, input: { creation: input } });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'e2ee',
    custodianAccountId: accountId, serverIdentityId: 'home-a', machineId: 'machine-1', installationId: 'installation-1',
    admittedMachineRole: 'manage', actionId: 'template.instantiate', requestId: envelope.requestId, target: envelope.target,
    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
  } });
  let machineRead = false;
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    if (new URL(String(url)).pathname !== '/v1/machines/machine-1') throw new Error('Unexpected Home read');
    // Home's account-authenticated Machine route rejects a signed template
    // root presented as a separately authorized spawn effect (live R14: 401).
    if (AxiosHeaders.from(config?.headers).get('Authorization') !== `Bearer ${token}`) {
      throw Object.assign(new Error('Unauthorized'), { response: { status: 401 } });
    }
    machineRead = true;
    return { status: 200, data: { machine: { id: 'machine-1', kind: 'persistent', revokedAt: null, replacedByMachineId: null } } };
  });
  const context: ActionExecutorContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
    runtimeAccountId: accountId, serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: envelope.requestId,
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target, originalActionEnvelope: envelope };
  let preparation: Awaited<ReturnType<typeof prepareSessionFollowSourceKey>> | undefined;
  bindApiSessionSocketMock(vi.mocked(io), createApiSessionSocketStub());
  await invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: { creation: input } }, context,
    child: { action: 'session.spawn_new', role: 'create_bot', input },
    admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'cli' },
    execute: async (_input, childContext) => {
      preparation = await prepareSessionFollowSourceKey({ credentials: { token,
          encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) } },
        homeServerIdentityId: 'home-a', machineId: 'machine-1', serverUrl: 'https://home-a.example.test',
        sourceSessionId: 'child', destinationSessionId: 'manager', sourceDataEncryptionKey: null,
        externalAction: { context: childContext, effectActionId: 'session.spawn_new', installationId: 'installation-1',
          privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey },
      });
      return { ok: true, result: { type: 'success', sessionId: 'child' } };
    },
  });
  expect(preparation).toEqual({ kind: 'not_needed' });
  expect(machineRead).toBe(true);
});
