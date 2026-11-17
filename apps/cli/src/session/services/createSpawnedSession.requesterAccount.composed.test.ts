import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { io } from 'socket.io-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createApiSessionSocketStub, respondToExactMachineSessionSpawnRpc } from '@/testkit/backends/apiSessionSocketHarness';
import { afterEach, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1, FeaturesResponseSchema, SessionSpawnNewInputV2Schema, accountSettingsParse } from '@happier-dev/protocol';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionPendingTemplateOnboardingRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createLocalMachineActionTransportFixture } from '@/testkit/apiMachineTransport';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
// Load the real lazy creation graph during collection, before the test budget.
import '@/session/services/createSpawnedSession';

// HTTP and the remote Machine socket are replaced boundaries: requester scope, Action admission,
// creation, mode resolution and metadata serialization remain real.
vi.mock('socket.io-client', () => ({ io: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn(), post: vi.fn(), request: vi.fn() } };
});
let runningInvocation: Promise<unknown> | undefined;
let cancellation: AbortController | undefined;
afterEach(async () => {
  // Vitest timing out does not cancel an async Action. Settle it while its own
  // HTTP boundaries are still installed, before the next Account fixture.
  cancellation?.abort();
  try {
    await runningInvocation?.catch(() => undefined);
  } finally {
    runningInvocation = undefined;
    cancellation = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
  }
});

it.each([
  { mode: 'plain', credentialAccountId: 'custodian' },
  { mode: 'e2ee', credentialAccountId: 'custodian' },
  { mode: 'e2ee', credentialAccountId: 'requester' },
] as const)('creates only with the no-box PAT requester Account custody ($mode, $credentialAccountId)', async ({ mode, credentialAccountId }) => {
  cancellation = new AbortController();
  const sessionId = `requester-${mode}-${credentialAccountId}-session`;
  const keys = nacl.sign.keyPair();
  // Socket.IO is the remote Machine boundary used for directory preflight.
  // The published Machine is Plain independently of the requester's Account mode.
  vi.mocked(io).mockImplementation(() => createApiSessionSocketStub({
    emitWithAck: (event, payload) => new Promise(resolve => {
      const method = payload && typeof payload === 'object' ? Reflect.get(payload, 'method') : null;
      // The Machine's installed catalog and CLI probe are native transport facts.
      if (event === 'rpc-call' && method === `machine-1:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
        resolve({ ok: true, result: { protocolVersion: 1, projection: { v: 2, generation: 1,
          familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex', capabilities: {
            sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } } } });
        return;
      }
      if (event === 'rpc-call' && method === `machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`) {
        resolve({ ok: true, result: { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] } } } } });
        return;
      }
      if (!respondToExactMachineSessionSpawnRpc({ event, args: [payload, resolve], machineId: 'machine-1', sessionId })) {
        throw new Error(`Unexpected Machine socket event ${event}:${payload && typeof payload === 'object' ? Reflect.get(payload, 'method') : ''}`);
      }
    }),
  }) as ReturnType<typeof io>);
  const token = `e30.${Buffer.from(JSON.stringify({ sub: credentialAccountId })).toString('base64url')}.signature`;
  const credentials = { token, encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };
  const grant = { ...API_TOKEN_FULL_GRANT_V1,
    targets: { sessions: [], machines: ['machine-1'], environments: [] } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-template-root', binding: {
    accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant, accountEncryptionMode: mode,
    custodianAccountId: 'custodian', serverIdentityId: 'home-a', machineId: 'machine-1', installationId: 'installation-1',
    actionId: 'template.instantiate', requestId: 'requester-birth', target: { kind: 'machine', machineId: 'machine-1' },
    requestEnvelopeDigest: 'a'.repeat(43),
  } });
  const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'requester-birth',
    executionTarget: { serverId: 'home-a', machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false });
  const signed = { authorizationToken: authorization.token, effectActionId: 'template.instantiate',
    target: authorization.binding.target, installationId: 'installation-1', requestId: authorization.binding.requestId,
    publicKey: keys.publicKey };
  const currentnessReads: string[] = [];
  const births: unknown[] = [];
  const events: string[] = [];
  const unexpectedRequests: string[] = [];
  let bornSession: Record<string, unknown> | undefined;
  vi.mocked(axios.request).mockImplementation(async config => {
    const url = new URL(String(config.url));
    const headers = AxiosHeaders.from(config.headers);
    expect(headers.has('Authorization')).toBe(false);
    if (url.pathname === '/v1/home/governance/get') {
      expect(config.data).toEqual({ projection: 'session_defaults' });
      expect(verifyExternalActionMachineRequestV1({ ...signed, effectActionId: 'home.governance.get',
        method: 'POST', path: url.pathname, body: config.data,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { homeDefaults: null } };
    }
    unexpectedRequests.push(`REQUEST ${url}`);
    throw new Error(`Unexpected HTTP request ${url}`);
  });
  vi.mocked(axios.get).mockImplementation(async (url, config) => {
    if (String(url).includes('/v2/session-organization?')) {
      const path = new URL(String(url)).pathname + new URL(String(url)).search;
      const headers = AxiosHeaders.from(config?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'GET', path,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [],
        folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] } } };
    }
    if (String(url).endsWith(`/v2/sessions/${sessionId}`)) {
      const headers = AxiosHeaders.from(config?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'GET', path: `/v2/sessions/${sessionId}`,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { session: bornSession } };
    }
    if (String(url).endsWith('/v1/machines/machine-1')) {
      const headers = AxiosHeaders.from(config?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'GET', path: '/v1/machines/machine-1',
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { machine: { id: 'machine-1', active: true, storageMode: 'plain', dataEncryptionKey: null,
        access: { custodian: { accountId: 'custodian', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' },
        revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2, 3, 4] },
          sessionSpawnPlacementOrigin: { protocolVersions: [1] } } } } };
    }
    if (String(url).includes('/v1/access-keys/')) {
      // The real binding owner requires the Session owner's Account, not the
      // selected Machine custodian's bearer (sessionMachineAccessKeyMutations).
      const headers = AxiosHeaders.from(config?.headers);
      if (headers.has('Authorization') && credentialAccountId !== 'requester') {
        return { status: 404, data: { error: 'Session or machine not found' } };
      }
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'GET', path: `/v1/access-keys/${sessionId}/machine-1`,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      events.push('machine-binding-read');
      return { status: 200, data: { accessKey: null } };
    }
    if (String(url).endsWith('/v1/account/encryption/currentness')) {
      const headers = AxiosHeaders.from(config?.headers);
      currentnessReads.push(headers.has('Authorization') ? 'custodian' : 'requester');
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'GET', path: '/v1/account/encryption/currentness',
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    }
    unexpectedRequests.push(`GET ${url}`);
    throw new Error(`Unexpected HTTP read ${url}`);
  });
  vi.mocked(axios.post).mockImplementation(async (url, body: unknown, config) => {
    if (String(url).includes('/v1/access-keys/')) {
      expect(AxiosHeaders.from(config?.headers).has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'POST', path: `/v1/access-keys/${sessionId}/machine-1`, body,
        signature: String(AxiosHeaders.from(config?.headers).get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      events.push('machine-binding-write');
      return { status: 200, data: { success: true } };
    }
    if (String(url).endsWith(`/v2/sessions/${sessionId}/pending/template-onboarding`)) {
      const admission = SessionPendingTemplateOnboardingRequestV1Schema.parse(body);
      const headers = AxiosHeaders.from(config?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'POST',
        path: `/v2/sessions/${sessionId}/pending/template-onboarding`, body,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      events.push('onboarding');
      return { status: 200, data: { v: 1, result: { status: 'accepted', localId: admission.request.localId } } };
    }
    if (String(url).endsWith('/lookup-by-tags')) {
      const headers = AxiosHeaders.from(config?.headers);
      expect(headers.has('Authorization')).toBe(false);
      expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'POST', path: '/v2/sessions/lookup-by-tags', body,
        signature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
      return { status: 200, data: { sessions: [] } };
    }
    if (!String(url).endsWith('/v1/sessions')) {
      unexpectedRequests.push(`POST ${url}`);
      throw new Error(`Unexpected HTTP write ${url}`);
    }
    births.push(body);
    expect(AxiosHeaders.from(config?.headers).has('Authorization')).toBe(false);
    expect(verifyExternalActionMachineRequestV1({ ...signed, method: 'POST', path: '/v1/sessions', body,
      signature: String(AxiosHeaders.from(config?.headers).get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)) })).toBe(true);
    events.push('birth');
    if (!body || typeof body !== 'object') throw new Error('Missing birth');
    const ownerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(Reflect.get(body, 'ownerMetadata'));
    const sharedMetadata: unknown = Reflect.get(body, 'sharedMetadata');
    if (!sharedMetadata || typeof sharedMetadata !== 'object') throw new Error('Missing shared metadata');
    expect(ownerMetadata.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    expect(Reflect.get(body, 'encryptionMode')).toBe(mode);
    bornSession = { id: sessionId, seq: 0,
      createdAt: 1, updatedAt: 1, active: false, activeAt: 1, archivedAt: null,
      metadataVersion: 1, metadataLayoutVersion: 1, metadata: Reflect.get(sharedMetadata, 'ciphertext'),
      ownerMetadata, encryptionMode: mode, agentState: null, agentStateVersion: 0,
      dataEncryptionKey: Reflect.get(body, 'dataEncryptionKey') ?? null, share: null };
    return { status: 200, data: { created: true, session: bornSession } };
  });
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    if (String(url).endsWith('/v1/features')) return Response.json(FeaturesResponseSchema.parse({ features: { sessions: { enabled: true }, sharing: { session: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } } }));
    unexpectedRequests.push(`FETCH ${url}`);
    throw new Error(`Unexpected fetch ${url}`);
  }));
  const spawn = vi.fn(async () => ({ type: 'success', sessionId }));
  const executor = createCliActionExecutor({ credentials, token, sessionId: '', mode: 'plain', ctx: null, rawSession: {},
    serverId: 'home-a', serverIdentityId: 'home-a', serverHttpBaseUrl: 'https://home-a.example.test',
    externalActionMachineInstallationId: 'installation-1', externalActionMachineRequestPrivateKey: keys.secretKey,
    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
    machineActionDirectTargetTransport: createLocalMachineActionTransportFixture('machine-1'),
    sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
      // The daemon supplies its already-opened local metadata at this boundary.
      readMachineMetadataSnapshot: () => ({ status: 'ready', metadata: {}, metadataVersion: 1 }),
      prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
      spawnedSession: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
  });
  const context: ActionExecutorContext = { surface: 'rpc', authority: 'account_automation', actionCaller: { kind: 'host' }, signal: cancellation.signal,
    runtimeAccountId: 'requester', serverId: 'home-a', serverIdentityId: 'home-a', actionRequestId: 'requester-birth',
    externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target,
    externalActionCredential: { accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant },
    machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine-1',
      installationId: 'installation-1', role: 'use', encryptionMode: 'e2ee' },
  };
  const invocation = invokeHostReviewedChildV1({ parent: { actionId: 'template.instantiate', input: { creation: input } }, context,
    child: { action: 'session.spawn_new', role: 'create_bot', input },
    admittedReview: { action: 'session.spawn_new', role: 'create_bot', surface: 'rpc' },
    invocationServices: { sessionCreation: { beforeLaunch: async () => {},
      hostOnboarding: { templateName: 'Scoped helper', templateVersion: '1.0.0' } } },
    execute: (childInput, childContext, actionId) => executor.execute(actionId, childInput, childContext),
  });
  runningInvocation = invocation;
  const result = await invocation;
  if (mode === 'plain' || credentialAccountId === 'requester') {
    expect(result, JSON.stringify({ result, currentnessReads, birthCount: births.length, events, unexpectedRequests })).toMatchObject({ ok: true, result: { type: 'success', sessionId } });
    expect(currentnessReads).toEqual(['requester', 'requester']);
    expect(births).toHaveLength(1);
    expect(unexpectedRequests).toEqual([]);
    expect(events).toEqual(['birth', 'machine-binding-read', 'machine-binding-write', 'onboarding']);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ existingSessionId: sessionId, freshSessionCreation: true }),
      expect.objectContaining({ localActionContext: expect.objectContaining({ runtimeAccountId: 'requester' }) }));
  } else {
    expect(result, JSON.stringify({ result, currentnessReads, birthCount: births.length })).toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
    // A readable plugin release supplies content, never the requester's E2EE custody.
    runningInvocation = executor.execute('template.instantiate', {
      source: { kind: 'plugin', registryItem: { sourceId: 'npm', itemId: 'helper', version: '1.0.0' }, contributionId: 'template' },
      expectedVersion: '1.0.0', creation: input,
    }, context);
    expect(await runningInvocation).toMatchObject({ ok: false, errorCode: 'requester_account_material_unavailable' });
    expect(currentnessReads).toEqual([]);
    expect(births).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  }
});
