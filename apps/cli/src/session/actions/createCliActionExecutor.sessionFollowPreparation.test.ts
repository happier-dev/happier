import { afterEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import nacl from 'tweetnacl';
import {
  accountSettingsParse,
  FeaturesResponseSchema,
  SessionFollowSourceKeyPrepareRequestV1Schema,
  SessionFollowSourceKeyPreparationResultV1Schema,
  computeRunnerMachineContentKeyFingerprintV1,
  computeAccountEncryptionMigrateKeyFingerprintV1,
  normalizeActionsSettingsV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealRunnerMachineContentKeyVerifierFactV1,
  signRunnerMachineContentKeyBindingV1,
} from '@happier-dev/protocol';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { CapabilitiesDetectResponse } from '@happier-dev/protocol/capabilities';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema,
  sealConnectedAccountCatalogContentV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { SessionFollowSourceV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readMachineTargetedActionRpcInputV1 } from '@happier-dev/protocol/actions/actionRpcTransport';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createApiSessionSocketStub, createAvailableSessionSpawnMachineSnapshot,
  createSessionCreationTargetPreparationRpcResult } from '@/testkit/backends/apiSessionSocketHarness';
import {
  createAccountEncryptionCurrentnessFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';

import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import { sealAccountSettingsV2RawContent } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { registerAccountHomeHttp, registerActionHttpBodyBoundary, registerMachineActionHomeHttp, registerPlainArtifactRoutes } from './widgetApproval.testkit';

// Only the network boundary is substituted; credential enrichment, Follow
// mutation/preparation, envelope opening and exact Machine RPC remain real.
const io = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io }));

const sourceSessionId = 'c111111111111111111111111';
const destinationSessionId = 'c222222222222222222222222';
const machineId = 'runner-machine';
const serverIdentityId = 'srv_follow_home';
const accountId = 'account-1';
const machineKey = new Uint8Array(32).fill(7);
const credentials = {
  token: `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`,
  credentialProvenance: 'stored_session' as const,
  encryption: {
    type: 'dataKey' as const,
    publicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey,
    machineKey,
  },
};
const sourceKey = new Uint8Array(32).fill(11);
const runnerKey = new Uint8Array(32).fill(13);
const randomBytes = (length: number) => new Uint8Array(length).fill(17);
const sealKey = (dataKey: Uint8Array) => encodeBase64(sealEncryptedDataKeyEnvelopeV1({
  dataKey, recipientPublicKey: credentials.encryption.publicKey, randomBytes,
}));

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('credentialed CLI relation source-key preparation composition', () => {
  it.each(['disabled', 'approval'] as const)('retains %s Follow admission before the credentialed CLI transport', async policy => {
    const app = fastify();
    const serverUrl = 'https://follow-admission.test';
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'follow.set': policy === 'disabled' ? { enabled: false } : { approvalRequiredSurfaces: ['cli'] },
    } } });
    registerAccountHomeHttp(app, { accountId, serverId: serverIdentityId, settings });
    registerPlainArtifactRoutes(app, accountId);
    const snapshot = FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, following: { enabled: true } } },
      capabilities: { serverIdentity: { serverIdentityId } } });
    app.get('/v1/features', async () => snapshot);
    app.get('/v1/features/authenticated', async () => snapshot);
    app.get('/v2/sessions/:sessionId', async request => ({ session: createSessionRecordFixture({
      id: (request.params as { sessionId: string }).sessionId, encryptionMode: 'plain', metadata: '{}',
    }) }));
    const effects: string[] = [];
    app.put(`/v2/sessions/${destinationSessionId}/follows/sessions/${sourceSessionId}`, async () => {
      effects.push('edge');
      return { changed: true, source: { sourceSessionId, destinationSessionId,
        policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false } };
    });
    const restore = installAxiosFastifyAdapter({ app, origin: serverUrl });
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = await app.inject({ method: 'GET', url: url.pathname + url.search });
      return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const executor = createCliActionExecutorFromCredentials({ credentials: { token: credentials.token,
        encryption: null, credentialProvenance: 'stored_session' }, serverId: 'follow-home', serverApiUrl: serverUrl,
        serverIdentityId, pluginActionExecutionOwner: 'current_process', actionsSettingsProvider: {
          getActionsSettings: () => settings.actionsSettingsV1, getAccountSettings: () => settings,
        } });
      const result = await executor.execute('follow.set', { receiver: { kind: 'session', sessionId: destinationSessionId },
        source: { kind: 'session', sessionId: sourceSessionId }, policy: { preset: 'quiet' } },
      { surface: 'cli', actionCaller: { kind: 'host' }, actionRequestId: `follow-${policy}` });
      expect(result).toMatchObject(policy === 'disabled' ? { ok: false, errorCode: 'action_disabled' }
        : { ok: true, result: { kind: 'approval_request_created', actionId: 'follow.set' } });
      expect(effects).toEqual([]);
    } finally { restore(); await app.close(); }
  });
  it.each(([
    { name: 'active Home authenticated context', fixed: false, provenance: 'authenticated', plain: false, prepares: true },
    { name: 'explicit verified Home', fixed: true, provenance: 'public', plain: false, prepares: true },
    { name: 'layout-one Runner destination', fixed: true, provenance: 'public', plain: false, prepares: true,
      layoutOne: true },
    { name: 'layout-one persistent destination', fixed: true, provenance: 'public', plain: false, prepares: false,
      layoutOne: true, persistent: true },
    { name: 'unverified active Home', fixed: false, provenance: 'public', plain: false, prepares: false },
    { name: 'Plain source without Home identity', fixed: false, provenance: 'public', plain: true, prepares: false },
    { name: 'persistent destination without standalone source key', fixed: true, provenance: 'public', plain: false, prepares: false,
      persistent: true, standaloneSourceKey: false },
    { name: 'Runner destination without standalone source key', fixed: true, provenance: 'public', plain: false, prepares: false,
      persistent: false, standaloneSourceKey: false },
    ...(['source_missing', 'destination_missing', 'source_read_failed', 'destination_read_failed',
      'destination_locality_missing', 'machine_read_failed', 'invalid_response'] as const)
      .map(fault => ({ name: fault, fixed: true, provenance: 'public' as const, plain: false, prepares: false, fault })),
  ] as const).flatMap((scenario) => (['follow', 'manager', 'spawn'] as const).map((relation) => ({
    persistent: false, standaloneSourceKey: true, layoutOne: false, fault: undefined, ...scenario, relation,
  }))))('$name ($relation)', async ({ fixed, provenance, plain, prepares, persistent, standaloneSourceKey, layoutOne, relation, fault }) => {
    const serverUrl = normalizeServerHttpBaseUrl(fixed ? 'https://fixed-follow.example.test' : configuration.apiServerUrl);
    // Follow-source mutation is a dangerous CLI Action. Keep the production
    // approval owner wired (the credentialed artifact store remains available)
    // while using the canonical persisted waiver for this focused transport
    // composition, so the assertion reaches the Follow key-preparation seam.
    const actionsSettings = normalizeActionsSettingsV1({
      v: 1,
      approvalWaivedSurfaces: { 'follow.set': ['cli'], 'session.manager.set': ['cli'], 'session.spawn_new': ['cli'] },
    });
    const app = fastify();
    registerActionHttpBodyBoundary(app);
    const restore = installAxiosFastifyAdapter({ app, origin: new URL(serverUrl).origin });
    const events: string[] = [];
    app.get(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, async () => ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }));
    const homeFeatures = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } });
    app.get('/v1/features', async () => homeFeatures);
    app.get('/v1/features/authenticated', async () => homeFeatures);
    let creationCorrespondence: unknown;
    // Account validation and exact daemon creation are network boundaries;
    // target normalization, create settlement and key preparation remain real.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: accountId }), { status: 200 }));
    app.post('/v2/sessions/lookup-by-tags', async () => ({ sessions: [] }));
    app.get('/v2/sessions', async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    app.get('/v2/sessions/archived', async () => ({ sessions: [], nextCursor: null, hasNext: false }));
    const homeDefaultsRequest = bindHomeDomainActionHttpRequestV1('home.governance.get', { projection: 'session_defaults' });
    app.post(new URL(homeDefaultsRequest.path, serverUrl).pathname,
      async () => HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }));
    app.get('/v1/account/profile', async () => ({ id: accountId }));
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ version: 1, content: sealAccountSettingsV2RawContent({
      credentials, raw: { actionsSettingsV1: actionsSettings }, envelopeKind: 'encrypted', randomBytes,
    }) }));
    app.get(`${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`, async () =>
      ConnectedAccountCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
        content: sealConnectedAccountCatalogContentV1({ mode: 'e2ee', material: credentials.encryption,
          record: { key: 'purposes', value: { v: 1, bindings: [] } }, randomBytes }),
      }));
    const senderSigning = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    const installation = { version: 1 as const, installationId: '11111111-1111-4111-8111-111111111113', createdAt: 1,
      publicKey: encodeBase64(senderSigning.publicKey, 'base64url'), privateKey: encodeBase64(senderSigning.secretKey, 'base64url') };
    app.get('/v1/machines/sender-machine', async () => ({ machine: { ...MachinePublishedRowV1Schema.parse({
      ...createAvailableSessionSpawnMachineSnapshot('sender-machine', { dataEncryptionKey: sealKey(runnerKey) }),
      active: true, storageMode: 'e2ee', managedMachineRef: null,
      installationId: installation.installationId, installationPublicKey: encodeBase64(senderSigning.publicKey),
      metadata: encodeBase64(encrypt(runnerKey, 'dataKey', MachinePublishedMetadataV1Schema.parse({
        host: 'sender', platform: 'linux', happyCliVersion: '0.3', homeDir: '/home/sender', happyHomeDir: '/home/sender/.happier',
        installationPublicKey: installation.publicKey,
      }))), metadataVersion: 1, daemonState: null, daemonStateVersion: 0,
    }), access: { custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'e2ee', accessState: 'ready' } } }));
    const source = SessionFollowSourceV1Schema.parse({
      sourceSessionId, destinationSessionId, policy: { preset: 'important' },
      deliveryState: 'eligible', hasPendingUpdates: false,
    });
    app.put(`/v2/sessions/${destinationSessionId}/follows/sessions/${sourceSessionId}`, async () => {
      events.push('edge_committed');
      return { changed: true, source };
    });
    const manager = { ok: true, sessionId: sourceSessionId, managerSessionId: destinationSessionId, attachedAt: 100 };
    app.post(`/v1/sessions/${sourceSessionId}/manager`, async () => {
      events.push('edge_committed');
      return manager;
    });
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'e2ee',
      contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(credentials.encryption.publicKey) }));
    app.get('/v2/sessions/:sessionId', async (request, reply) => {
      const id = (request.params as { sessionId: string }).sessionId;
      if (events.includes('edge_committed') && (fault === 'source_read_failed' && id === sourceSessionId
        || fault === 'destination_read_failed' && id === destinationSessionId)) {
        return reply.code(403).send({ error: 'private boundary detail' });
      }
      if (events.includes('edge_committed') && (fault === 'source_missing' && id === sourceSessionId
        || fault === 'destination_missing' && id === destinationSessionId)) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return { session: createSessionRecordFixture({
        id,
        ...(layoutOne && id === destinationSessionId ? {
          metadataLayoutVersion: 1,
          share: null,
          ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: credentials.encryption,
            ownerMetadata: { v: 1, workspace: { machineId } }, randomBytes }),
        } : {}),
        encryptionMode: plain && id === sourceSessionId ? 'plain' : 'e2ee',
        dataEncryptionKey: id === sourceSessionId && (plain || !standaloneSourceKey) ? null : sealKey(sourceKey),
        metadata: plain && id === sourceSessionId
          ? JSON.stringify({ sessionCreationCorrespondenceV1: creationCorrespondence })
          : encodeBase64(encrypt(id === sourceSessionId && !standaloneSourceKey ? machineKey : sourceKey, 'dataKey',
            layoutOne && id === destinationSessionId ? { v: 1 }
              : { ...(fault === 'destination_locality_missing' && id === destinationSessionId ? {} : { machineId }),
                sessionCreationCorrespondenceV1: creationCorrespondence })),
      }) };
    });
    const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const bindingPayload = {
      v: 1 as const,
      purpose: 'happier.ephemeral-runner.machine-content-key' as const,
      homeServerIdentityId: serverIdentityId,
      activationId: '11111111-1111-4111-8111-111111111111',
      creatorAccountId: accountId,
      machineId,
      installationId: 'runner-installation',
      machineContentKeyFingerprint: computeRunnerMachineContentKeyFingerprintV1(runnerKey),
    };
    app.get(`/v1/machines/${machineId}`, async (_request, reply) => {
      events.push('exact_machine');
      if (fault === 'machine_read_failed') return reply.code(403).send({ error: 'private boundary detail' });
      return { machine: {
        id: machineId,
        kind: persistent ? 'persistent' : 'ephemeral_session_runner',
        storageMode: 'e2ee',
        installationId: bindingPayload.installationId,
        revokedAt: null,
        replacedByMachineId: null,
        dataEncryptionKey: sealKey(runnerKey),
        runnerContentKeyBinding: {
          ...signRunnerMachineContentKeyBindingV1({ payload: bindingPayload, activationSigningSecretKey: signing.secretKey }),
          creatorVerifierFactCiphertext: sealRunnerMachineContentKeyVerifierFactV1({
            payload: { v: 1, activationId: bindingPayload.activationId, machineId,
              activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url') },
            material: credentials.encryption,
            randomBytes,
          }),
        },
      } };
    });
    const preparedRequests: unknown[] = [];
    const runnerContent: SocketRpcContent = { mode: 'e2ee', cipher: {
      encryptRaw: async value => encodeBase64(encrypt(runnerKey, 'dataKey', value)),
      decryptRaw: async ciphertext => decrypt(runnerKey, 'dataKey', decodeBase64(ciphertext)),
    } };
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, rawCall) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      // This is the untyped socket network boundary, narrowed before use.
      const call = rawCall as { method: string; params: string; authorization: unknown };
      const decoded = await socketRpcCodec.decodeRequestParams(runnerContent, call.params, call.method);
      if (call.method === `sender-machine:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
        const request = SessionCreationTargetPreparationRequestV1Schema.parse(readMachineTargetedActionRpcInputV1(decoded.params));
        return { ok: true, result: await socketRpcCodec.encodeResponse(runnerContent,
          createSessionCreationTargetPreparationRpcResult(request), decoded.callId) };
      }
      if (call.method === `sender-machine:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
        const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
          projection: { v: 2, generation: 1, familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex',
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } } });
        return { ok: true, result: await socketRpcCodec.encodeResponse(runnerContent, response, decoded.callId) };
      }
      if (call.method === `sender-machine:${RPC_METHODS.CAPABILITIES_DETECT}`) {
        const response = { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } } } satisfies CapabilitiesDetectResponse;
        return { ok: true, result: await socketRpcCodec.encodeResponse(runnerContent, response, decoded.callId) };
      }
      expect(call.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_SESSION_FOLLOW_SOURCE_KEY_PREPARE}`);
      const request = SessionFollowSourceKeyPrepareRequestV1Schema.parse(decoded.params);
      preparedRequests.push(request);
      expect(call.authorization).toEqual({ kind: 'session.follow.sourceKey.prepare', sourceSessionId, destinationSessionId });
      return {
        ok: true, result: await socketRpcCodec.encodeResponse(runnerContent,
          fault === 'invalid_response' ? { v: 1, outcome: 'private boundary detail' } : { v: 1, outcome: 'installed' }, decoded.callId),
      };
    } });
    io.mockReturnValue(socket);
    const executorBase = {
      credentials,
      machineId: 'sender-machine',
      externalActionMachineRequestPrivateKey: senderSigning.secretKey,
      externalActionMachineInstallationId: installation.installationId,
      resolveServerFeaturesSnapshot: async () => ({
        status: 'ready' as const, provenance,
        features: FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId } } }),
      }),
      actionsSettingsProvider: {
        getActionsSettings: () => actionsSettings,
        getAccountSettings: () => accountSettingsParse({ actionsSettingsV1: actionsSettings }),
      },
      pluginActionExecutionOwner: 'current_process',
      sessionSpawnDirectTargetTransport: {
        machineId: 'sender-machine',
        readMachineMetadataSnapshot: () => ({ status: 'ready' as const, metadataVersion: 1, metadata: {} }),
        prepare: async () => ({ ok: true as const, directory: '/repo', directoryKind: 'path' as const,
          directoryCreationRequired: false, checkout: null }),
        spawnedSession: {
          spawn: async (request: import('@/rpc/handlers/spawnSessionOptionsContract').SpawnDaemonSessionRequest) => {
            creationCorrespondence = request.sessionCreationCorrespondence;
            events.push('edge_committed');
            return { type: 'success', sessionId: sourceSessionId, sessionCreationOutcome: {
              disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
            } };
          },
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' as const }),
        },
      },
    } as const;
    const executor = createCliActionExecutorFromCredentials(fixed
      ? { ...executorBase, serverId: 'fixed-home', serverApiUrl: serverUrl, serverIdentityId }
      : executorBase);
    if (relation === 'spawn') await registerMachineActionHomeHttp(app, { accountId, machineId: 'sender-machine',
      serverId: fixed ? 'fixed-home' : configuration.activeServerId, serverIdentityId, serverHttpBaseUrl: serverUrl,
      credentials, installation, executor, actionId: 'session.spawn_new', accountEncryptionMode: 'e2ee' });
    if (relation === 'spawn') await registerMachineActionHomeHttp(app, { accountId, machineId: 'sender-machine',
      serverId: fixed ? 'fixed-home' : configuration.activeServerId, serverIdentityId, serverHttpBaseUrl: serverUrl,
      credentials, installation, executor, actionId: 'machines.agents.list', accountEncryptionMode: 'e2ee' });
    try {
      const result = relation === 'follow'
        ? await executor.execute('follow.set', { receiver: { kind: 'session', sessionId: destinationSessionId },
          source: { kind: 'session', sessionId: sourceSessionId }, policy: { preset: 'important' } }, { surface: 'cli' })
        : relation === 'manager'
          ? await executor.execute('session.manager.set', { sessionId: sourceSessionId, managerSessionId: destinationSessionId, expectedManagerSessionId: null }, { surface: 'cli' })
          : await executor.execute('session.spawn_new', { creationKey: 'source-key-child',
            executionTarget: { serverId: fixed ? 'fixed-home' : configuration.activeServerId, machineId: 'sender-machine' },
            directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
            connectedServices: { v: 2, bindingsByServiceId: {} }, manager: { sessionId: destinationSessionId },
          }, { surface: 'cli' });
      if (relation === 'spawn' && !fixed && provenance !== 'authenticated') {
        // E2EE origination requires the independently verified Home before
        // Session creation; Follow/manager above retain postcommit key checks.
        expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable',
          failureCause: { phase: 'dispatch.home_identity' } });
        expect(events).toEqual([]);
        expect(preparedRequests).toEqual([]);
        return;
      }
      if (fault) {
        const preparation = { kind: 'waiting', reason: fault === 'source_missing' ? 'source_key_unavailable' : 'runner_unreachable',
          cause: ({ source_missing: 'source_transport_unavailable', destination_missing: 'destination_transport_unavailable',
            source_read_failed: 'source_transport_exception', destination_read_failed: 'destination_transport_exception',
            destination_locality_missing: 'destination_machine_missing', machine_read_failed: 'machine_rpc_failed',
            invalid_response: 'machine_rpc_invalid_response' } as const)[fault] };
        // Follow projects the same typed diagnostics into its partial-failure envelope;
        // Reports-to/spawn retain them inside their strict committed result schemas.
        expect(result, JSON.stringify({ result, events })).toMatchObject(relation === 'follow'
          ? { ok: false, errorCode: 'session_follow_source_key_preparation_waiting', details: {
            edgeCommitted: true, reason: preparation.reason, cause: preparation.cause } }
          : { ok: true, result: { sourceKeyPreparation: preparation } });
        expect(SessionFollowSourceKeyPreparationResultV1Schema.parse(preparation)).toEqual(preparation);
        return;
      }
      if (!prepares && !plain && !persistent && standaloneSourceKey) {
        expect(result).toMatchObject(relation === 'follow'
          ? { details: { cause: 'home_identity_unavailable' } }
          : { result: { sourceKeyPreparation: { cause: 'home_identity_unavailable' } } });
      }
      if (relation === 'spawn') {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: true, result: {
          type: 'success', sessionId: sourceSessionId,
          sourceKeyPreparation: prepares ? { kind: 'prepared' } : plain || persistent ? { kind: 'not_needed' }
            : { kind: 'waiting', reason: standaloneSourceKey ? 'runner_unreachable' : 'source_key_unavailable' },
        } });
      } else if (relation === 'manager') {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: true, result: {
          ...manager,
          ...(!prepares && !plain && !persistent ? { sourceKeyPreparation: {
            kind: 'waiting', reason: standaloneSourceKey ? 'runner_unreachable' : 'source_key_unavailable',
          } } : {}),
        } });
      } else if (prepares || plain || persistent) {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: true, result: relation === 'follow' ? { changed: true, source }
          : relation === 'manager' ? manager : { type: 'success', sessionId: sourceSessionId } });
      } else {
        expect(result, JSON.stringify({ result, events })).toMatchObject({ ok: false, errorCode: 'session_follow_source_key_preparation_waiting',
          details: { edgeCommitted: true, reason: standaloneSourceKey ? 'runner_unreachable' : 'source_key_unavailable' } });
      }
      expect(events).toEqual(prepares || persistent || !standaloneSourceKey ? ['edge_committed', 'exact_machine'] : ['edge_committed']);
      expect(preparedRequests).toEqual(prepares ? [{
        v: 1, sourceSessionId, destinationSessionId, sourceDataEncryptionKeyBase64: encodeBase64(sourceKey),
      }] : []);
      if (prepares) expect(io).toHaveBeenCalledWith(serverUrl, expect.objectContaining({
        auth: expect.objectContaining({ token: credentials.token, clientType: 'user-scoped' }),
      }));
    } finally {
      restore();
      await app.close();
    }
  });
});
