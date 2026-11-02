import axios from 'axios';
import { expect, onTestFinished, vi } from 'vitest';
import { FeaturesResponseSchema, SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { configuration, reloadConfiguration } from '@/configuration';
import type { RpcHandler } from '@/api/rpc/types';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { createSpawnNewSessionLifecycleActionHandler } from '@/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler';
import { createMachineSessionDirectTargetTransport } from '@/rpc/handlers/sessionServerStartLifecycleAdapter';
import { registerSessionSpawnNewRpcHandlers } from '@/rpc/handlers/sessionLifecycle';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { writeDaemonSettingsFixture } from './fakeDaemonLifecycle.testkit';
import type { InstalledProjectAgentDaemonFixture } from './installedProjectAgentDaemonFixture';
import { installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { PendingLocalIdSchema } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { PendingRequestedActionV1Schema } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';
import { seedTestServerProfile } from '@/testkit/serverProfiles';

/** Real public creator and stamping; only Home HTTP and process creation are boundaries. */
export async function spawnPublicInstalledProjectAgentSession(input: Readonly<{
  fixture: InstalledProjectAgentDaemonFixture;
  homeServerIdentityId: string;
  actor: 'owner' | 'member';
  memberRole?: 'use' | 'manage';
  teamCredentialBindings?: SpawnSessionOptions['teamCredentialBindings'];
  modelSelection?: SpawnSessionOptions['modelSelection'];
  agentTarget?: ReturnType<typeof SessionSpawnNewInputV2Schema.parse>['agentTarget'];
  publicIngress?: Readonly<{
    manager: RpcHandlerManager;
    invoke(method: string, params: unknown): Promise<unknown>;
  }>;
  onSpawn?(options: SpawnSessionOptions): void | Promise<void>;
  onPending?(input: Readonly<{ localId: string; message: unknown }>): void | Promise<void>;
}>): Promise<boolean> {
  const h = input.fixture;
  const serverId = h.f.bootstrap.attribution.serverId;
  const custodian = input.actor === 'owner' ? 'requester' : 'company';
  await writeDaemonSettingsFixture(h.f.directory, { activeServerId: serverId,
    servers: { [serverId]: { id: serverId, name: 'Session Home', serverUrl: 'https://session-home.test',
      webappUrl: 'https://session-home.test', createdAt: 0, updatedAt: 0, lastUsedAt: 0 } },
    machineIdByServerId: { [serverId]: 'machine' }, lastTokenSubByServerId: { [serverId]: 'requester' },
  });
  await seedTestServerProfile({ id: serverId, homeId: input.homeServerIdentityId, serverUrl: 'https://session-home.test' });
  reloadConfiguration();
  expect(configuration.activeServerId).toBe(serverId);
  const fetchHome = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: input.homeServerIdentityId } },
    }));
    return await fetchHome(url, init);
  });
  const getHome = vi.mocked(axios.get).getMockImplementation();
  const postHome = vi.mocked(axios.post).getMockImplementation();
  if (!getHome || !postHome) throw new Error('Missing canonical Home HTTP boundaries');
  let launched: SpawnSessionOptions | undefined;
  let pendingInputs = 0;
  vi.mocked(axios.get).mockImplementation(async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/settings') return { status: 200, data: { settings: null, settingsVersion: 0 } };
    if (launched && path === `/v2/sessions/${h.sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: h.sessionId, active: true, encryptionMode: 'plain', dataEncryptionKey: null, share: null,
      metadata: JSON.stringify({ machineId: 'machine', sessionCreationCorrespondenceV1: launched.sessionCreationCorrespondence }),
    }) } };
    return await getHome(url, options);
  });
  vi.mocked(axios.post).mockImplementation(async (url, body: unknown, options) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/lookup-by-tags') return { status: 200, data: { sessions: [] } };
    if (path === `/v2/sessions/${h.sessionId}/pending`) {
      if (!body || typeof body !== 'object' || !('localId' in body) || !('content' in body) || !('requestedAction' in body)) {
        throw new Error('Missing canonical plain Pending input envelope');
      }
      expect(PendingLocalIdSchema.safeParse(body.localId).success).toBe(true);
      expect(PendingRequestedActionV1Schema.safeParse(body.requestedAction).success).toBe(true);
      const content = StrictSessionStoredMessageContentEnvelopeSchema.parse(body.content);
      expect(content.t).toBe('plain');
      const value = content.t === 'plain' ? content.v : null;
      const message = value && typeof value === 'object' && 'content' in value ? value.content : null;
      expect(message !== null && typeof message === 'object' && 'text' in message && message.text === 'UI_CODEX_FIRST_INPUT').toBe(true);
      expect(options?.headers?.Authorization === `Bearer ${h.installedCredentials?.token}`).toBe(true);
      pendingInputs++;
      await input.onPending?.({ localId: String(body.localId), message: value });
      return { status: 200, data: { didWrite: true } };
    }
    return await postHome(url, body, options);
  });
  const handlers = new Map<string, RpcHandler>();
  let admittedInputs = 0;
  onTestFinished(installDaemonMachineAdmissionTransport({ serverId, transport: async request => {
    // The authenticated Machine socket is the network boundary. All Action
    // input normalization, Session targeting and envelope preparation stay real.
    expect(request.sessionId === h.sessionId && request.targetMachineId === 'machine').toBe(true);
    admittedInputs++;
    return { status: 'accepted', localId: request.localId };
  } }));
  const lifecycle = createSpawnNewSessionLifecycleActionHandler({ serverId,
    // Preserve precisely what production process creation hands to tracking.
    spawnSession: async options => {
      launched = options;
      h.tracked.spawnOptions = options;
      h.tracked.requesterWorkAttributionV1 = options.requesterWorkAttributionV1;
      await input.onSpawn?.(options);
      return { type: 'success', sessionId: h.sessionId,
        sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
    } });
  registerSessionSpawnNewRpcHandlers({ rpcHandlerManager: { registerHandler: (method, handler) => {
    handlers.set(method, handler);
    input.publicIngress?.manager.registerHandler(method, handler);
  } },
    sessionSpawnDirectTargetTransport: createMachineSessionDirectTargetTransport({ machineId: 'machine', spawnLifecycleHandler: lifecycle }) });
  const spawn = handlers.get(RPC_METHODS.SESSION_SPAWN_NEW);
  if (!spawn) throw new Error('Missing registered public Session creator');
  const request = SessionSpawnNewInputV2Schema.parse({
    creationKey: `ui-native-${input.actor}`, executionTarget: { serverId, machineId: 'machine' },
    directory: { kind: 'path', path: h.cwd }, organizationPlacement: { folderId: null, tagIds: [] },
    agentTarget: input.agentTarget ?? { kind: 'agent', identity: { pluginId: h.retainedAgent.pluginId, localId: 'codex' } },
    connectedServices: { v: 2, bindingsByServiceId: {} },
    initialInput: { text: 'UI_CODEX_FIRST_INPUT' },
    ...(input.teamCredentialBindings ? { teamCredentialBindings: input.teamCredentialBindings } : {}),
    ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
  });
  const response: unknown = input.publicIngress
    ? await input.publicIngress.invoke(RPC_METHODS.SESSION_SPAWN_NEW, request)
    : await spawn(request, { signal: h.signal, callerAuthority: 'present_user', machineAdmission: {
    actorAccountId: 'requester', custodianAccountId: custodian, machineId: 'machine',
    installationId: h.f.installation.installationId, role: input.actor === 'owner' ? 'manage' : input.memberRole ?? 'use', encryptionMode: 'plain',
  }, verifyMachineAdmissionCurrent: async () => h.f.isHomeCurrent() });
  if (input.actor === 'member') {
    const refused = response !== null && typeof response === 'object'
      && 'ok' in response && response.ok === false && 'errorCode' in response ? response.errorCode : null;
    expect(refused).toBe(input.publicIngress ? RPC_ERROR_CODES.FORBIDDEN : 'target_unavailable');
    expect(launched === undefined).toBe(true);
    expect(admittedInputs).toBe(0);
    expect(pendingInputs).toBe(0);
    expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
    return false;
  }
  const result = SessionSpawnNewResultV1Schema.parse(response);
  expect({ type: result.type, code: result.type === 'error' ? result.code : null }).toEqual({ type: 'success', code: null });
  expect(launched?.requesterWorkAttributionV1?.accountId).toBe('requester');
  expect(h.tracked.requesterSessionRuntimeContext).toBeUndefined();
  expect({ status: result.type === 'success' ? result.initialInput?.status : null,
    code: result.type === 'success' && 'code' in result.initialInput ? result.initialInput.code : null })
    .toEqual({ status: 'accepted', code: null });
  expect(pendingInputs).toBe(1);
  expect(admittedInputs).toBe(0);
  return true;
}
