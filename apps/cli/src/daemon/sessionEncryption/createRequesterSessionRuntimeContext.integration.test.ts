import axios from 'axios';
import fastify from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, FeaturesResponseSchema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountListResponseV4Schema, TranscriptRawAgentEventV1Schema, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProviderAccountUsagePersistenceScheduler, flushProviderAccountUsagePersistenceForTrackedSessions } from '../connectedServices/accountUsage/persistence';
import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import { fetchConnectedServiceProjectionForSession } from '../connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { registerExecutionRunConnectedServicesTarget } from '../connectedServices/runs/executionRunMaterialization';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, assertRequesterSessionAccountContextCurrent, bindRequesterSessionRuntimeMachineAdmissionCurrentness,
  createRequesterSessionCredentialCustody, createRequesterSessionRuntimeContextResolver, listRequesterSessionCredentialBindings,
  releaseUnretainedRequesterSessionRuntimeContext, resolveRequesterSessionBootstrapFromCustody } from './requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from './createRequesterSessionRuntimeContext';
import { executeSpawnSessionRequest } from '../startup/executeSpawnSessionRequest';
import { createHostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';
import { ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createSessionStartupProjectSpawn } from '@/session/actions/lifecycle/sessionStartupProjectOperation';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { ProfileRecordV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import type { TrackedSession } from '../types';
import { createPendingResetStartRecoveryPorts } from '../connectedServices/usageLimitRecovery/createPendingResetStartRecoveryPorts';
import { createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import * as controlServer from '../controlServer';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import { projectRunnerDaemonPluginServicesFailure } from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import { projectAgentRuntimeDaemonServiceTurnWitnessV1 } from '@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
  bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createDaemonQualifiedRequestAuthCallbacks } from '../connectedServices/requestAuth/createDaemonQualifiedRequestAuthCallbacks';
import { scopeConnectedAccountPurposeBindingLease } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from '../machine/bootstrapMachineSyncRuntime';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SessionFollowObserveInactiveResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { readInstallationIdentityIfExistsSync, readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { ApiMachineClient } from '@/api/apiMachine';
import { configuration } from '@/configuration';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { sealSessionFollowRuleContentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleContentCodecV1';
import { buildAcpAgentMessageEnvelope } from '@/api/session/acpMessageEnvelope';
import { buildSessionFollowChangeHintV1, buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { DELIVERY_MUTE_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { retainExecutionRunState } from '../executionRunRegistry';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand } from '../sessionRegistry';
import { pluginReloadController as runPluginRuntimeController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { logger as fileLogger } from '@/utils/logger';
import { readRequesterHomeWithinActionLifetime } from './requesterCurrentness';
import { startDaemonConnectedServiceRuntime } from '../startup/startDaemonRuntimeBootstrap';
import { ConnectedServiceRefreshCoordinator } from '../connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import { ConnectedServiceQuotasCoordinator } from '../connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import { createRequesterConnectedAccountPurposeBindingRuntime } from '../connectedServices/purposeBindings/createRequesterConnectedAccountPurposeBindingRuntime';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4QueryCodec';
import { QualifiedConnectedAccountServiceRefSchema, QualifiedConnectedAccountServiceListV4Schema,
  QualifiedConnectedAccountMultiServiceListResponseV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol';
import { notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogReadResponseV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol';
import { MachineInstallationProofV1Schema, RequesterSessionCurrentnessPurposeV1Schema,
  verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// HTTP substitutes authentication; the real Account owners still inspect the subject.
function accountToken(accountId: string) {
  return `e30.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
}

it('returns installed Account personal ready policy through startup and refuses retired or foreign custody', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'installed-personal-follow-'));
  const home = 'https://installed-personal.test';
  const serverId = 'installed-personal-home';
  const sessionId = 'c555555555555555555555555';
  const hostTurnId = 'installed-completed-host-turn';
  const token = accountToken('installed');
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    spawnOptions: { directory } };
  const control: { routes?: Parameters<typeof controlServer.startDaemonControlServer>[0] } = {};
  const listening = vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async routes => {
    control.routes = routes;
    return { port: 43127, stop: async () => {} };
  });
  const reads: string[] = [];
  const writes: string[] = [];
  const policy = { preset: 'everything' as const };
  const settings = accountSettingsParse({});
  const receiver = { kind: 'account' as const };
  const definition = { v: 1 as const, enabled: true,
    filter: normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible' }), policy };
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    reads.push(path);
    expect(new URL(String(url)).origin).toBe(home);
    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    if (path.endsWith('/profile')) return { status: 200, data: { id: 'installed', connectedServices: [] } };
    if (path.endsWith('/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === '/v2/account/session-follow-rules') return { status: 200, data: { rules: [{
      ruleId: 'installed-private-rule', version: 1, receiver,
      content: sealSessionFollowRuleContentV1({ ruleId: 'installed-private-rule', receiver, definition, mode: 'plain', material: null }),
    }] } };
    if (path === '/v2/account/session-follow-preferences') return { status: 200, data: { assigned: true, direct: false, team: false, group: false } };
    if (path === DELIVERY_MUTE_HTTP_PATHS_V1.account || path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (path === `/v1/sessions/${sessionId}/messages`) {
      const afterSeq = Number(new URL(String(url)).searchParams.get('afterSeq') ?? 0);
      return { status: 200, data: SessionMessagesPageV1Schema.parse({ messages: afterSeq < 3 ? [{
        id: 'installed-ready-row', localId: 'installed-ready-original', seq: 3, createdAt: 3, updatedAt: 3,
        sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: {
          type: 'event', id: 'installed-ready-original',
          data: TranscriptRawAgentEventV1Schema.parse({ type: 'ready', completedTurnId: hostTurnId }),
        } } },
      }] : [], hasMore: false, nextBeforeSeq: null, nextAfterSeq: null }) };
    }
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      ...createSessionNotificationContextFixture(sessionId),
      id: sessionId, ownerAccountId: 'installed', encryptionMode: 'plain', active: true, archivedAt: null,
      origin: { kind: 'none' }, metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null, seq: 3, latestReadyEventSeq: 3,
      latestTurnId: hostTurnId, latestTurnStatus: 'completed',
    }) } };
    throw new Error(`Unexpected installed Follow read ${path}`);
  });
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, _body, config) => {
    const path = new URL(String(url)).pathname;
    writes.push(path);
    expect(new URL(String(url)).origin).toBe(home);
    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
    if (path.endsWith('/follows/occurrence-routes')) return { status: 200, data: { ok: true, v: 1, sourceSessionId: sessionId, routes: [] } };
    if (path.endsWith('/session-follow-rules/personal-progress')) return { status: 200, data: { accepted: true, alreadyRepresented: false } };
    throw new Error(`Unexpected installed Follow write ${path}`);
  });
  const machine: { current: ApiMachineClient | null } = { current: null };
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  let app: ReturnType<typeof controlServer.createDaemonControlApp> | null = null;
  let snapshot: ReturnType<typeof getActiveAccountSettingsSnapshot> = null;
  try {
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId, serverHttpBaseUrl: home, machineId: 'machine', custodianAccountId: 'installed', credentials,
      connectedServicesMaterializationBaseDir: join(directory, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map([[tracked.trackingKey, tracked]]), getRequester: () => null,
      getApiMachineForSessions: () => machine.current, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: serverId }) },
      beforeStartup: async () => {
        await writeStoredCredentialsForServerId(serverId, credentials);
        await readOrCreateInstallationIdentity();
        setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1,
          notificationChannelCatalog: notificationCatalogFixture(settings).notificationChannelCatalog,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
        snapshot = getActiveAccountSettingsSnapshot();
        machine.current = runWithServerHttpBaseUrl(home, () => new ApiMachineClient(token, { id: 'machine', encryptionMode: 'plain',
          metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 }));
      },
    });
    if (!control.routes?.onSessionActivityChanged) throw new Error('Missing actual installed source callback');
    const installed = await machine.current!.resolveInstalledAccountObservationRuntime(new AbortController().signal);
    expect(installed, JSON.stringify(reads)).toMatchObject({ accountId: 'installed', serverId, machineId: 'machine' });
    expect(installed?.credentials).toEqual(credentials);
    expect(await installed?.isCurrent?.()).toBe(true);
    expect(configuration.activeServerId).toBe(serverId);
    expect(getActiveAccountSettingsSnapshot()).toBe(snapshot);
    const routes = control.routes;
    app = controlServer.createDaemonControlApp(routes);
    const occurrence = { sourceSessionId: sessionId,
      sourcePublisher: { machineId: 'machine', committedFenceMs: 1, publisherGeneration: '1' },
      sourceMessage: { localId: 'installed-ready-original', seq: 3 }, evidence: { v: 1 as const, ownerAccountId: 'installed',
        event: { kind: 'finished' as const }, facts: { serverId, kind: 'session' as const } } };
    const notify = () => app!.inject({ method: 'POST', url: '/session-activity-changed',
      headers: { 'x-happier-daemon-token': routes.controlToken! }, payload: { sessionId, followOccurrence: occurrence } });
    const current = await notify();
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toEqual({ ok: true, personalFollow: { sourceSessionId: sessionId, accepted: true,
      sourceMessage: { localId: 'installed-ready-original', seq: 3, policies: [policy] } } });
    expect(getActiveAccountSettingsSnapshot()).toBe(snapshot);
    const personalProgressWrites = () => writes.filter(path => path === '/v2/account/session-follow-rules/personal-progress').length;
    const admittedPersonalWrites = personalProgressWrites();
    expect(admittedPersonalWrites).toBeGreaterThan(0);
    resetActiveAccountSettingsSnapshotForTests();
    expect((await notify()).json()).toEqual({ ok: true });
    expect(personalProgressWrites()).toBe(admittedPersonalWrites);
    const sourceReads = reads.length;
    const sourceWrites = writes.length;
    if (!snapshot) throw new Error('Missing installed Account snapshot');
    setActiveAccountSettingsSnapshot(snapshot);
    tracked.requesterWorkAttributionV1 = { accountId: 'foreign', serverId, machineId: 'machine', installationId: 'foreign-installation' };
    const foreign = await notify();
    expect(foreign.statusCode).toBe(500);
    expect(foreign.json()).not.toHaveProperty('personalFollow');
    expect(reads).toHaveLength(sourceReads);
    expect(writes).toHaveLength(sourceWrites);
    delete tracked.requesterWorkAttributionV1;
    await writeStoredCredentialsForServerId(serverId, { token: 'retired-installed-credential', encryption: null });
    expect((await notify()).json()).toEqual({ ok: true });
    expect(writes).toHaveLength(sourceWrites);
  } finally {
    await app?.close();
    await host?.dispose();
    await machine.current?.shutdown();
    get.mockRestore(); post.mockRestore(); listening.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
    await rm(directory, { recursive: true, force: true });
  }
});

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
let openedRunPluginRuntime = false;
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); });
afterAll(async () => { if (openedRunPluginRuntime) await runPluginRuntimeController.shutdown(); });
it.each(['managed-provider-authority', 'settings-key-subscriptions', 'usage-owner', 'refresh', 'settings-refresh-failure', 'startup-settings-recovery', 'startup-settings-cancel', 'startup-settings-forbidden', 'startup-settings-unbound', 'untracked-lifetime', 'profile-unavailable', 'action-policy', 'action-home-recovery', 'run-home-recovery', 'run-purpose-home-recovery', 'run-binding-home-recovery', 'authorization-observations', 'warm-account', 'currentness-phase', 'resolution-currentness', 'spawn-currentness', 'background-home-failure', 'background-refresh-owned-by-quota', 'startup-home-failure', 'refresh-observations', 'request-auth-observations', 'follow-wake', 'follow-rules', 'follow-source', 'follow-receiver', 'follow-pending', 'follow-idle-source'] as const)('keeps requester %s isolated from active Alice', async (surface) => {
  const actionPolicySurface = surface === 'action-policy' || surface === 'action-home-recovery' || surface === 'authorization-observations';
  const runSurface = surface === 'run-home-recovery' || surface === 'run-purpose-home-recovery' || surface === 'run-binding-home-recovery';
  const runPurposeSurface = surface === 'managed-provider-authority' || surface === 'run-purpose-home-recovery' || surface === 'run-binding-home-recovery';
  const runService = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const runCredentialRevision = 'csr_aaaaaaaaaaaaaaaaaaaaaa';
  const directory = await mkdtemp(join(tmpdir(), 'requester-profiles-'));
  let current = true;
  let revision = 2;
  let holdRows = false;
  let releaseRows: (() => void) | undefined;
  let settingsVersion = 1;
  let settingsReads = 0;
  let sessionReads = 0;
  let authorizationStartReads = 0;
  const authorizationMintReads: number[] = [];
  let authorizationProfileReads = 0;
  let failActionHomeRead = false;
  let failedActionHomeReads = 0;
  let runHomeStatus: number | null = null;
  let runHomeFailurePath = '/v1/account/profile';
  let connectedCatalogReads = 0;
  let holdSettings = false;
  let failSettings = false;
  const settingsGate: { release?: () => void } = {};
  const releaseSettingsRead = () => settingsGate.release?.();
  let savedSettings: Record<string, unknown> = {};
  let coordinatorProfiles: readonly QualifiedConnectedAccountProfileV4[] = [];
  let sourceProject = surface === 'follow-pending' ? 'payments' : 'other';
  let freshFollowRule = false;
  let followAccountChanges: ChangeEntry[] = [];
  let followChangesReads = 0;
  let receiverEnabled = surface !== 'follow-idle-source';
  let followRuleVersion = 1;
  const requesterSessionId = surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' ? 'c123456789012345678901234' : 'bob-session';
  const followDestinationId = surface === 'follow-receiver' ? requesterSessionId : 'c222222222222222222222222';
  const followSourceId = surface === 'follow-receiver' ? 'c333333333333333333333333' : requesterSessionId;
  const requesterToken = accountToken('bob');
  const control: { routes?: Parameters<typeof controlServer.startDaemonControlServer>[0] } = {};
  // The loopback HTTP server is the boundary; retain the real startup Action factory.
  const controlBoundary = actionPolicySurface || runSurface || surface === 'follow-source' ? vi.spyOn(controlServer, 'startDaemonControlServer')
    .mockImplementation(async input => { control.routes = input; return { port: 43127, stop: async () => {} }; }) : null;
  const approvalIds: string[] = [];
  const approvalArtifacts = new Map<string, ReturnType<typeof ArtifactHttpReadV1Schema.parse>>();
  const artifactBoundary = actionPolicySurface ? vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1('workflow.authoring.draft.discard');
    const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('workflow.authoring.draft.discard');
    if (url === `https://bob-home.test${verifyPath}`) return { status: 200, data: { ok: true } };
    expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
    if (url === 'https://bob-home.test/v1/artifacts/read' && failActionHomeRead) {
      failActionHomeRead = false;
      failedActionHomeReads++;
      return { status: 503, data: { error: 'home_unavailable' } };
    }
    if (url === 'https://bob-home.test/v1/artifacts/read') return artifactReadResponse(data, id => approvalArtifacts.get(id) ?? null);
    if (url === `https://bob-home.test${mintPath}`) {
      authorizationMintReads.push(sessionReads - authorizationStartReads);
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(data);
      return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-home-proof', binding: {
        accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        serverIdentityId: 'bob-home', machineId: 'machine', custodianAccountId: 'alice',
        installationId: request.sessionActionSource?.installationId, actionId: 'workflow.authoring.draft.discard',
        requestId: request.envelope.requestId, target: request.envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
        sessionActionOrigin: request.sessionActionOrigin, sessionActionSource: request.sessionActionSource,
      } }) };
    }
    expect(url).toBe('https://bob-home.test/v1/artifacts');
    const { idScope: _idScope, approvalState: _approvalState, approvalSessionId: _approvalSessionId,
      ...created } = ArtifactJsonCreateHttpInputV1Schema.parse(data);
    const { id } = created;
    // Home persists the real writer's encoded content; approval creation reopens
    // that authoritative owned row before acknowledging its receipt.
    approvalArtifacts.set(id, ArtifactHttpReadV1Schema.parse({ ...created,
      ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }));
    approvalIds.push(id);
    return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
  }) : null;
  const profileReads: string[] = [];
  const followReads: string[] = [];
  const record = ProfileRecordV1Schema.parse({ v: 1, id: 'bob-profile', enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'legacy', profile: { id: 'bob-profile', name: 'Bob native', createdAt: 1, updatedAt: 2 } } });
  const aliceCredentials = { token: accountToken('alice'), encryption: null };
  await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(aliceCredentials) });
  });
  const alice = getActiveAccountSettingsSnapshot();
  // HTTP and admitted Machine access are the boundaries. Both Account custody
  // owners, the full Profile pager and requester runtime stay real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/artifacts/') && failActionHomeRead) {
      failActionHomeRead = false;
      failedActionHomeReads++;
      return { status: 503, data: { error: 'home_unavailable' } };
    }
    if (runHomeStatus !== null && path === runHomeFailurePath) {
      const status = runHomeStatus;
      runHomeStatus = null;
      return { status, data: { error: 'home_unavailable' } };
    }
    if ((surface === 'follow-source' || surface === 'follow-receiver')
      && path === `/v1/sessions/${followSourceId}/messages`) {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      const afterSeq = Number(config?.params?.afterSeq ?? new URL(url).searchParams.get('afterSeq') ?? 0);
      const messages = ['moved-out-original', 'moved-in-original', 'completed-original'].map((localId, index) => ({
        id: localId, localId, seq: index + 1, createdAt: index + 1, updatedAt: index + 1,
        sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: buildAcpAgentMessageEnvelope({
          provider: 'claude', body: index === 2
            ? { type: 'task_complete', id: localId }
            : { type: 'turn_failed', id: localId },
          meta: { runtimeTurnId: `${localId}-host-turn` },
        }) },
      })).filter(row => row.seq > afterSeq);
      return { status: 200, data: { messages, hasMore: false, nextBeforeSeq: null, nextAfterSeq: null } };
    }
    if (path === '/v2/changes') {
      followChangesReads++;
      const after = Number(config?.params?.after ?? new URL(url).searchParams.get('after') ?? 0);
      return { status: 200, data: { changes: followAccountChanges.filter(change => change.cursor > after),
        nextCursor: followAccountChanges.at(-1)?.cursor ?? after } };
    }
    if (path === '/v2/account/session-follow-rules' || path === '/v2/account/session-follow-preferences') {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      expect(new URL(url).origin).toBe('https://bob-home.test');
      followReads.push(path);
      if (path.endsWith('/session-follow-preferences')) return { status: 200, data: { assigned: true, direct: false, team: false, group: false } };
      const receiver = { kind: 'session' as const, sessionId: surface === 'follow-source' || surface === 'follow-receiver' ? followDestinationId : requesterSessionId };
      const definition = { v: 1 as const, enabled: receiverEnabled, filter: normalizeSessionListFilterV1({ homeServerIds: ['bob-home'],
        scope: 'all_accessible', ...(surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' ? { projects: { include: [{ serverId: 'bob-home', projectKey: 'payments' }], exclude: [] } } : {}) }), policy: { preset: 'important' as const } };
      const ruleId = freshFollowRule ? 'bob-fresh-rule' : 'bob-private-rule';
      return { status: 200, data: { rules: [{ ruleId, version: freshFollowRule ? 0 : followRuleVersion, receiver,
        ...(freshFollowRule ? { inception: { createdAt: 20, accountChangeCursor: 0 } } : surface === 'follow-pending' ? { sources: [{ sourceSessionId: 'bob-follow-source',
          delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 } }] } : {}),
        content: sealSessionFollowRuleContentV1({ ruleId, receiver, definition, mode: 'plain', material: null }) },
        ...(surface === 'follow-source' ? [{ ruleId: 'bob-personal-rule', version: 1, receiver: { kind: 'account' as const },
          content: sealSessionFollowRuleContentV1({ ruleId: 'bob-personal-rule', receiver: { kind: 'account' },
            definition: { ...definition, policy: { preset: 'custom', events: { finished: { delivery: 'quiet' } } } },
            mode: 'plain', material: null }) }] : []),
        ...(surface === 'follow-idle-source' ? [{ ruleId: 'other-receiver-rule', version: 1,
          receiver: { kind: 'session' as const, sessionId: 'other-receiver' },
          content: sealSessionFollowRuleContentV1({ ruleId: 'other-receiver-rule',
            receiver: { kind: 'session', sessionId: 'other-receiver' }, definition: { ...definition, enabled: true },
            mode: 'plain', material: null }) }] : []),
      ], ...(freshFollowRule && new URL(url).searchParams.has('destinationSessionId') ? { sourceRanges: { status: 'available', sources: [{
        sourceSessionId: 'bob-follow-source', delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 2 }, throughSeq: 3,
      }] } } : {}) } };
    }
    if (path === DELIVERY_MUTE_HTTP_PATHS_V1.account || path.endsWith('/delivery-mutes')) return { status: 200, data: { scopes: [] } };
    if (surface === 'follow-source' && path === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 200,
      data: NotificationChannelCatalogReadResponseV1Schema.parse({ status: 'deleted', revision: 1 }) };
    if (surface === 'follow-receiver' && path === `/v2/sessions/${followSourceId}`) return { status: 200, data: { session: createSessionRecordFixture({
      ...createSessionNotificationContextFixture(followSourceId), projectKey: sourceProject,
      id: followSourceId, active: false, archivedAt: null, encryptionMode: 'plain', share: null,
      ownerAccountId: 'bob', origin: { kind: 'none' }, metadata: JSON.stringify({ machineId: 'offline-source-machine', projectId: sourceProject }),
    }) } };
    if (surface === 'follow-source' && path === `/v2/sessions/${followDestinationId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: followDestinationId, active: true, archivedAt: null, encryptionMode: 'plain', share: null,
      ownerAccountId: 'bob', origin: { kind: 'none' }, metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
    }) } };
    if (path === `/v2/sessions/${requesterSessionId}`) sessionReads++;
    if (path.startsWith('/v4/connect/')) connectedCatalogReads++;
    if (path === '/v2/account/settings') {
      settingsReads++;
      if (failSettings) throw new axios.AxiosError('Settings transport unavailable', 'ECONNRESET');
      if (holdSettings) await new Promise<void>(resolve => { settingsGate.release = resolve; });
    }
    const profilePath = path.startsWith('/v1/account/entity-rows/profiles');
    if (profilePath) {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      expect(new URL(url).origin).toBe('https://bob-home.test');
      profileReads.push(path);
      if (surface === 'profile-unavailable') return { status: 404, data: { error: 'not_found' } };
    }
    if (path.endsWith('/profile')) {
      authorizationProfileReads++;
      return { status: 200, data: { id: 'bob' } };
    }
    if (surface === 'follow-wake' && path === '/v1/machines/machine') {
      const installation = readInstallationIdentityIfExistsSync();
      if (!installation) throw new Error('Missing requester fixture installation');
      return { status: 200, data: { machine: { id: 'machine', installationId: installation.installationId,
        metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use',
          resourceMode: 'plain', accessState: 'ready' } } } };
    }
    if (path === `/v2/sessions/${requesterSessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      ...(surface === 'follow-source' ? { ...createSessionNotificationContextFixture(requesterSessionId), projectKey: sourceProject } : {}),
      id: requesterSessionId, encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
      metadata: JSON.stringify({ machineId: 'machine', path: '/repo', ...(surface === 'follow-source' ? { projectId: sourceProject } : {}),
        ...(surface === 'follow-wake' || surface === 'follow-pending' ? { flavor: 'claude', claudeSessionId: 'bob-native',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} } } : {}) }),
      dataEncryptionKey: null, share: null,
    }) } };
    if (path.endsWith('/currentness')) return { status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path.endsWith('/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path.endsWith('/profiles/reference-guard')) return { status: 200, data: { status: 'ready', revision } };
    if (path.endsWith('/profiles/transfer')) return { status: 200, data: { status: 'absent' } };
    if (path.endsWith('/entity-rows/profiles')) {
      if (holdRows) await new Promise<void>(resolve => { releaseRows = resolve; });
      return { status: 200, data: { status: 'listed',
        rows: [{ id: record.id, revision, content: { t: 'plain', v: record } }], nextCursor: null, complete: true,
        diagnostics: [], referenceGuardRevision: revision, transferControl: { status: 'absent' } } };
    }
    if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, []) };
    if (path.startsWith('/v1/artifacts/')) {
      const artifact = approvalArtifacts.get(decodeURIComponent(path.slice('/v1/artifacts/'.length)));
      return artifact ? { status: 200, data: artifact } : { status: 404, data: { error: 'artifact_not_found' } };
    }
    if (runPurposeSurface && path.startsWith('/v4/connect/')) {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      expect(new URL(url).origin).toBe('https://bob-home.test');
      if (path === '/v4/connect/qualified/configuration') return { status: 404, data: null };
      if (path === '/v4/connect/qualified/accounts') return { status: 200, data: QualifiedConnectedAccountListResponseV4Schema.parse({
        service: runService, accounts: [{ ref: { service: runService, accountId: 'work' }, status: 'connected', authenticationModeId: 'oauth',
          revisionSemantics: 'revisioned', credentialRevision: runCredentialRevision, configurationReady: true, configurationRevision: null, scopes: [] }],
      }) };
      if (path === '/v4/connect/qualified/credential') return { status: 200, data: QualifiedConnectedAccountCredentialSnapshotV4Schema.parse({
        ref: { service: runService, accountId: 'work' }, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
        credentialRevision: runCredentialRevision, configurationRevision: null, metadata: { scopes: [] },
        content: { t: 'plain', v: { v: 1, values: { accessToken: 'fixture-bob-subscription', refreshToken: 'fixture-bob-refresh',
          idToken: 'fixture-bob-id', providerAccountId: 'fixture-bob-billing' } } },
      }) };
    }
    if (surface === 'background-refresh-owned-by-quota' && path === '/v4/connect/qualified/accounts') {
      expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
      expect(new URL(url).origin).toBe('https://bob-home.test');
      const query = new URL(url).searchParams;
      const services = query.has('services')
        ? parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceListV4Schema, query.get('services'))
        : [parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountServiceRefSchema, query.get('service'))];
      const accounts = coordinatorProfiles.filter(profile => services.some(service => (
        service.pluginId === profile.ref.service.pluginId && service.localId === profile.ref.service.localId
      )));
      return { status: 200, data: query.has('services')
        ? QualifiedConnectedAccountMultiServiceListResponseV4Schema.parse({ services, accounts })
        : QualifiedConnectedAccountListResponseV4Schema.parse({ service: services[0], accounts }) };
    }
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accounts: [] } };
    if (surface === 'background-refresh-owned-by-quota' && path === '/v4/connect/qualified/groups') return { status: 200, data: { groups: [] } };
    return { status: 200, data: { content: { t: 'plain', v: savedSettings }, version: settingsVersion } };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  const followDestination = { runtime: null as Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> };
  let cleanupFollowDestination: (() => Promise<void>) | undefined;
  let cleanupOwnedFollow: (() => Promise<void>) | undefined;
  const followEnqueued: unknown[] = [];
  const followPost = surface === 'follow-source' || surface === 'follow-receiver' ? vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/occurrence-routes')) {
      if (surface === 'follow-receiver') { expect(body).toHaveProperty('destinationSessionId', requesterSessionId); expect(body).not.toHaveProperty('sourcePublisher'); }
      const original = body && typeof body === 'object' && 'sourceTurn' in body ? body.sourceTurn : null;
      const turnId = original && typeof original === 'object' && 'id' in original ? original.id : null;
      const seq = ['moved-out-original', 'moved-in-original', 'completed-original']
        .findIndex(localId => `${localId}-host-turn` === turnId) + 1;
      expect(seq).toBeGreaterThan(0);
      return { status: 200, data: { ok: true, v: 1, sourceSessionId: followSourceId,
        routes: seq === 1 ? [] : ['follower', 'manager'].map(relation => ({ sourceSessionId: followSourceId,
          destinationSessionId: followDestinationId, relation, ...(relation === 'manager' ? { attachedAt: 10 } : {}),
          policy: { preset: 'important' }, delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
          observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: seq } })) } };
    }
    if (path === `/v2/sessions/${followDestinationId}/pending`) { followEnqueued.push(body); return { status: 200, data: { didWrite: true } }; }
    if (path.endsWith('/session-follow-rules/personal-progress')) return { status: 200, data: { accepted: true, alreadyRepresented: false } };
    throw new Error(`Unexpected write: ${path}`);
  }) : null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  const pluginRuntimeController = runSurface ? runPluginRuntimeController : null;
  let followPluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
  let followRuntimeInput: Parameters<typeof createRequesterSessionRuntimeContext>[0] | undefined;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    const followMachineBoundary = { machineId: 'machine', daemonToken: aliceCredentials.token,
      readInstallation: readInstallationIdentityIfExistsSync,
      isHomeCurrent: () => configuration.activeServerId === 'bob-home',
      getObservedServerIdentityId: () => 'srv_bob_home' };
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: aliceCredentials, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => runPurposeSurface ? 'advertised' : 'indeterminate',
      ...(surface === 'follow-source' ? { resolveRequesterSessionRuntimeContext: async (sessionId: string) =>
        [runtime, followDestination.runtime].find(candidate => candidate?.bootstrap.getBoundSessionId() === sessionId) ?? null } : {}),
      ...(surface === 'follow-wake' ? {
        // Untracked acquisitions own temporary runtimes. The host's immediate
        // resume attempt must not retire the enclosing fixture's requester.
        resolveRequesterSessionRuntimeContext: createRequesterSessionRuntimeContextResolver({ trackedSessions,
          getCreateRuntime: () => async bootstrap => {
            if (!followRuntimeInput) throw new Error('Missing requester runtime construction');
            bindRequesterSessionRuntimeMachineAdmissionCurrentness({ bootstrap, boundary: followMachineBoundary });
            return await createRequesterSessionRuntimeContext({ ...followRuntimeInput, bootstrap });
          },
          recoverBootstrap: input => resolveRequesterSessionBootstrapFromCustody({ happyHomeDir: directory,
            serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', sessionId: input.sessionId,
            expectedAttribution: input.attribution, signal: input.signal, onRecoveryRefused: input.onRecoveryRefused,
            machineAdmissionBoundary: followMachineBoundary }),
        }),
        releaseRequesterSessionRuntimeContext: async context => await releaseUnretainedRequesterSessionRuntimeContext(context,
          [...trackedSessions.values()].map(tracked => tracked.requesterSessionRuntimeContext)),
      } : {}),
      ...(surface === 'resolution-currentness' ? { resolveRequesterSessionRuntimeContext: createRequesterSessionRuntimeContextResolver({
        trackedSessions, getCreateRuntime: () => null, recoverBootstrap: async () => null,
      }) } : {}),
      ...(actionPolicySurface || surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' ? { startup: { resolveCurrentMachineExecutionOriginContext: async () => {
        authorizationProfileReads = 0;
        return { machineId: 'machine', serverIdentityId: 'bob-home' };
      } } } : {}) });
    if (surface === 'follow-wake') {
      openedRunPluginRuntime = true;
      // Establish the daemon's real Agent catalog before requester admission,
      // as startup does; publishing a new fixture runtime is not a Follow event.
      followPluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
        controller: runPluginRuntimeController, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
    }
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
      ...(actionPolicySurface || runSurface || surface === 'background-refresh-owned-by-quota' || surface === 'refresh-observations' || surface === 'request-auth-observations' || surface === 'currentness-phase' || surface === 'resolution-currentness' || surface === 'spawn-currentness' || surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' || surface === 'follow-idle-source' ? { existingSessionId: requesterSessionId } : {}),
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory,
        ...(surface === 'follow-wake' || surface === 'follow-pending'
          ? { getObservedServerIdentityId: async () => 'srv_bob_home' } : {}) },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: host.installation?.installationId ?? 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    // Admission captures the real settings/cache lifetime after daemon startup.
    expect(admitted.admitted.accountSettingsContext.scopeKey).toBe(resolveAccountSettingsScopeKey(admitted.admitted.credentials));
    const sharedUsageStore = host.runtime.resolveProviderAccountUsageStore(admitted.admitted.attribution);
    const runtimeInput = { bootstrap: admitted.admitted,
      ...{ providerAccountUsageStore: sharedUsageStore },
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => runPurposeSurface ? 'advertised' : 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          // Environment reads are the boundary after runtime resources start.
          get HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED() {
            if (surface === 'startup-home-failure') runHomeStatus = 503;
            return '0';
          }, HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator }
    } satisfies Parameters<typeof createRequesterSessionRuntimeContext>[0];
    followRuntimeInput = runtimeInput;
    const runtimeConstruction = createRequesterSessionRuntimeContext(runtimeInput);
    if (surface === 'startup-home-failure') {
      try {
        // Startup consumes the admitted requester; an unused future Profile
        // refusal must not create a second permission probe during construction.
        runtime = await runtimeConstruction;
        expect(runtime).not.toBeNull();
        expect(runHomeStatus).toBe(503);
        expect(await runtime!.isCurrent()).toBe(true);
        await runtime!.dispose();
        expect(await admitted.admitted.isCurrent()).toBe(false);
      } finally { await admitted.cleanupOnFailure(); }
      return;
    }
    runtime = await runtimeConstruction;
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'managed-provider-authority') {
      const { createManagedProviderOperationAuthority } = await import('../connectedServices/purposeBindings/managedProviderOperationAuthority');
      const { createConnectedAccountPurposeBindingOwner } = await import('../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner');
      const { createConnectedAccountRequestAuthSubjectRegistry } = await import('../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry');
      const { readFile } = await import('node:fs/promises');
      const unavailable = async (): Promise<never> => { throw new Error('Requester used the daemon Account owner'); };
      const daemonOwner = createConnectedAccountPurposeBindingOwner({ credentialOwnerAccountId: 'alice',
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable,
        resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: 'Alice work account' } : null,
        resolveCredentialRevision: async () => runCredentialRevision,
        materializeAccount: async request => {
          request.credentialRevisionBasis?.captureCredentialRevision(runCredentialRevision);
          return { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture-alice-subscription' } };
        },
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: async () => {} });
      const requestAuthRegistry = createConnectedAccountRequestAuthSubjectRegistry();
      const original = createManagedProviderOperationAuthority({ materializationBaseDir: join(directory, 'managed-provider'),
        purposeBindingOwner: daemonOwner, requestAuthRegistry, resolveRequestAuthHttpPort: () => 43123,
        createRedactionLease: () => ({ add() {}, close() {} }) });
      const authority = runtime.createManagedProviderAccountAuthority(original);
      expect(await authority.readCredentials()).toBe(runtime.bootstrap.credentials);
      expect(authority.connectedAccountsOwner).toBe(runtime.connectedAccountsOwner);
      const pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
        controller: runPluginRuntimeController, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
      const binding = { purpose, target: { kind: 'account' as const, account: { service: runService, accountId: 'work' } } };
      const materialization = { kind: 'httpHeaders' as const, origin: 'https://chatgpt.com', headerNames: ['authorization'] };
      let activation: Awaited<ReturnType<typeof original.activate>> | undefined;
      try {
        activation = await authority.operationAuthority.activate({ identity: purpose.consumer, operationId: 'requester-managed',
          purposes: [purpose], purposeBindings: { v: 1, bindings: [binding] }, requestAuthUses: [{ purpose, materialization }], isCurrent: () => true });
        if (!activation.requestAuth) throw new Error('Missing requester managed capability');
        const document: unknown = JSON.parse(await readFile(activation.requestAuth.capabilityPath, 'utf8'));
        if (!document || typeof document !== 'object' || !('capability' in document)) throw new Error('Invalid capability fixture');
        const subject = requestAuthRegistry.authenticate(document.capability);
        if (!subject?.bindingAuthority) throw new Error('Missing requester binding authority');
        const signal = new AbortController().signal;
        const resolved = await runWithServerHttpBaseUrl('https://bob-home.test', () => subject.bindingAuthority!.resolveCurrentBinding({ binding, signal }));
        expect(resolved?.account).toEqual(binding.target.account);
        if (!resolved) throw new Error('Missing requester account');
        const headers = await runWithServerHttpBaseUrl('https://bob-home.test', () => subject.bindingAuthority!.materializeHeaders({ binding, resolved, materialization, signal }));
        expect(headers.headers.authorization).toBe('Bearer fixture-bob-subscription');
      } finally { await activation?.cleanup(); await pluginRuntime.dispose(); }
      return;
    }
    if (surface === 'usage-owner') {
      const recordKey = { providerId: 'openai-codex', accountSubjectId: 'provider-bob', subjectKind: 'account' as const, quotaScope: 'account' as const };
      const source = { serviceId: 'happier.agent.codex/openai-codex', profileId: 'primary', bindingKind: 'group_member' as const, groupId: 'pool', groupGeneration: 7 };
      sharedUsageStore.recordSnapshot({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'openai-codex', accountSubject: { kind: 'providerSubject', id: 'provider-bob' },
        observedAtMs: 900, fetchedAtMs: 900, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'weekly', label: 'Weekly', used: 100, limit: 100, unit: 'unknown', remainingPct: 0,
          utilizationPct: 100, resetsAt: 100_000, status: 'ok', details: {} }] }, { sources: [source] });
      expect(runtime.providerAccountUsageStore.resolveBySource(source)?.meters[0]?.remainingPct).toBe(0);
      expect(host.runtime.providerAccountUsageStore.resolveBySource(source)).toBeNull();
      await runtime.dispose();
      runtime = null;
      expect(host.runtime.resolveProviderAccountUsageStore(admitted.admitted.attribution).resolveBySource(source)?.meters[0]?.remainingPct).toBe(0);
      return;
    }
    if (surface === 'background-refresh-owned-by-quota') {
      const requester = runtime;
      // Keep the real bootstrap, coordinators, requester proof and Axios/Home
      // transport composition. Only Home responses and the provider boundary
      // are substituted; these spies pass through the actual scheduler work.
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      let authorityReads = 0;
      let credentialReads = 0;
      let inventoryReads = 0;
      const inventoryRequests: { url: string; authorization: string | undefined; purpose: string | string[] | undefined }[] = [];
      http.get('/*', async (request, reply) => {
        const path = new URL(request.url, 'https://bob-home.test').pathname;
        if (path.endsWith('/currentness') || path.endsWith('/profile') || path === `/v2/sessions/${requesterSessionId}`) authorityReads++;
        if (path.includes('/credential')) credentialReads++;
        if (path === '/v4/connect/qualified/accounts') {
          inventoryReads++;
          inventoryRequests.push({ url: request.url, authorization: request.headers.authorization,
            purpose: request.headers['x-happier-request-purpose'] });
        }
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid requester Home response');
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
        features: { connectedServices: { enabled: true, quotas: { enabled: true } } }, capabilities: {},
      })), { status: 200, headers: { 'content-type': 'application/json' } }));
      resetServerFeaturesClientForTests();
      const refreshTicks = vi.spyOn(ConnectedServiceRefreshCoordinator.prototype, 'tickOnce');
      const quotaTicks = vi.spyOn(ConnectedServiceQuotasCoordinator.prototype, 'tickOnce');
      const loopRegistry = new ConnectedServiceRuntimeRegistry();
      let providerReads = 0;
      let selectedProofs = 0;
      let background: Awaited<ReturnType<typeof startDaemonConnectedServiceRuntime>> | undefined;
      let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      const settleTicks = async () => {
        let count: number;
        do {
          await vi.advanceTimersByTimeAsync(0);
          const calls = [...refreshTicks.mock.results, ...quotaTicks.mock.results];
          count = calls.length;
          await Promise.all(calls.filter(result => result.type === 'return').map(result => result.value));
          await vi.advanceTimersByTimeAsync(0);
        } while (refreshTicks.mock.results.length + quotaTicks.mock.results.length !== count);
      };
      try {
        pluginRuntime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.claude'] } });
        const purposeRuntime = createRequesterConnectedAccountPurposeBindingRuntime({
          serverId: requester.bootstrap.attribution.serverId, operationContext: requester.bootstrap.savedSecretOperationContext, accountId: 'bob', machineId: 'machine',
          reloadController: pluginRuntime.controller, getAccountEncryptionMode: options => requester.api.getAccountEncryptionMode(options),
          isCurrent: requester.isCurrent, allowNativeAccountCredentials: false, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        });
        coordinatorProfiles = [
          { service: runService, accountId: 'bob-codex', status: 'connected' },
          { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, accountId: 'bob-claude', status: 'needs_reauth' },
        ].map(({ service, accountId, status }) => QualifiedConnectedAccountProfileV4Schema.parse({
          ref: { service, accountId }, status, authenticationModeId: 'oauth', revisionSemantics: 'revisioned',
          credentialRevision: runCredentialRevision, configurationReady: true, configurationRevision: null,
          kind: 'oauth', expiresAt: null, scopes: ['profile'], providerIdentity: { accountId }, displayName: accountId,
        }));
        const accounts = await purposeRuntime.purposes.listCoordinatorAccounts();
        expect(inventoryReads).toBe(1);
        expect(inventoryRequests).toEqual([{ url: expect.any(String), authorization: `Bearer ${requesterToken}`,
          purpose: 'connected-accounts:requester-coordinator' }]);
        const inventoryQuery = new URL(inventoryRequests[0]!.url, 'https://bob-home.test').searchParams;
        expect(inventoryQuery.has('service')).toBe(false);
        const inventoryServices = parseQualifiedConnectedAccountV4StructuredQueryValue(
          QualifiedConnectedAccountServiceListV4Schema, inventoryQuery.get('services'));
        expect(inventoryServices).toEqual(expect.arrayContaining(coordinatorProfiles.map(profile => profile.ref.service)));
        expect(accounts).toHaveLength(coordinatorProfiles.length);
        for (const profile of coordinatorProfiles) {
          expect(accounts.filter(account => account.ref.service.pluginId === profile.ref.service.pluginId
            && account.ref.service.localId === profile.ref.service.localId)).toEqual([profile]);
        }
        expect(credentialReads).toBe(0);
        coordinatorProfiles = [];
        purposeRuntime.purposes.invalidate();
        vi.useFakeTimers();
        background = await runWithServerHttpBaseUrl('https://bob-home.test', () => startDaemonConnectedServiceRuntime({
          api: requester.api, credentials: requester.bootstrap.credentials, machineId: 'machine', machineIdProvider: () => 'machine',
          runtimeId: 'idle-loop', happyHomeDir: directory, activeServerDir: directory,
          logger: { debug: () => {}, info: () => {}, warn: () => {} },
          processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1', HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
            HAPPIER_CONNECTED_SERVICES_QUOTAS_DISCOVERY_ENABLED: '0' },
          trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: loopRegistry,
          connectedServiceRuntimeQuotaSnapshots: requester.connectedServiceRuntimeQuotaSnapshots,
          providerAccountUsageStore: requester.providerAccountUsageStore,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: host!.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator,
          accountSettingsSnapshot: () => requester.bootstrap.savedSecretOperationContext.readSnapshot(),
          subscribeAccountSettingsSnapshot: requester.subscribeAccountSettingsSnapshot,
          isAccountRuntimeCurrent: async () => { selectedProofs++; return await requester.isCurrent(); },
          runAccountOperation: operation => runWithServerHttpBaseUrl('https://bob-home.test', operation),
          qualifiedConnectedAccountEstablishedRuntimeOwner: purposeRuntime.established,
          resolveQualifiedConnectedAccountPeerClass: () => 'advertised_v4',
          listScheduledQualifiedConnectedAccounts: service => purposeRuntime.purposes.listCoordinatorAccounts(undefined, service),
          connectedAccountsOwner: purposeRuntime.purposes.owner,
          connectedServiceQuotaFetcherDescriptors: [{ id: 'fixture-provider', createFetcher: () => ({ serviceId: 'openai-codex',
            loadQuota: async () => { providerReads++; throw new Error('Retired requester reached provider'); } }) }],
        }));
        await settleTicks();
        expect(background.connectedServiceRefreshLoopHandle).not.toBeNull();
        expect(background.connectedServiceQuotasLoopHandle).not.toBeNull();
        const settledRefreshTicks = refreshTicks.mock.calls.length;
        const settledQuotaTicks = quotaTicks.mock.calls.length;
        expect(settledRefreshTicks).toBeGreaterThan(0);
        expect(settledQuotaTicks).toBeGreaterThan(0);
        const writeSettings = async (patch: Record<string, unknown>) => {
          const previous = requester.readAccountSettingsSnapshot();
          const rawSettings = { ...previous.rawSettings, ...patch };
          expect(await requester.bootstrap.savedSecretOperationContext.replaceAccountSettings({ ...previous, rawSettings,
            settings: accountSettingsParse(rawSettings), settingsVersion: previous.settingsVersion + 1 })).toBe(true);
          await settleTicks();
        };
        for (let index = 0; index < 25; index++) await writeSettings({ analyticsOptOut: index % 2 === 0 });
        expect(refreshTicks).toHaveBeenCalledTimes(settledRefreshTicks);
        expect(quotaTicks).toHaveBeenCalledTimes(settledQuotaTicks);
        await writeSettings({ connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' } } });
        expect(refreshTicks).toHaveBeenCalledTimes(settledRefreshTicks + 1);
        expect(quotaTicks).toHaveBeenCalledTimes(settledQuotaTicks);
        await writeSettings({ usageQuotaNotificationsV1: { ...requester.readAccountSettingsSnapshot().settings.usageQuotaNotificationsV1, pace: true } });
        expect(refreshTicks).toHaveBeenCalledTimes(settledRefreshTicks + 1);
        expect(quotaTicks).toHaveBeenCalledTimes(settledQuotaTicks + 1);
        const initialRefreshTicks = refreshTicks.mock.calls.length;
        const initialQuotaTicks = quotaTicks.mock.calls.length;
        // Quota owns qualified discovery in the production composition. Isolate
        // explicit refresh wakes; do not call required quota discovery "idle".
        background.connectedServiceQuotasLoopHandle?.pause();
        authorityReads = 0;
        selectedProofs = 0;
        for (let wake = 0; wake < 20; wake++) {
          background.connectedServiceRefreshLoopHandle?.wake();
          await settleTicks();
        }
        expect(refreshTicks).toHaveBeenCalledTimes(initialRefreshTicks + 20);
        expect(quotaTicks).toHaveBeenCalledTimes(initialQuotaTicks);
        expect(authorityReads).toBe(0);
        expect(selectedProofs).toBe(0);

        inventoryReads = 0;
        background.connectedServiceQuotasLoopHandle?.resume();
        await settleTicks();
        expect(selectedProofs).toBeGreaterThan(0);
        expect(authorityReads).toBe(0);
        expect(inventoryReads).toBeGreaterThan(0);
        background.connectedServiceQuotasLoopHandle?.pause();

        // Retiring the local custody stops later provider acquisition. A
        // changed admission verifier alone is not an in-flight revocation.
        const retiring = requester.dispose();
        refreshTicks.mockClear();
        selectedProofs = 0;
        background.connectedServiceQuotasLoopHandle?.resume();
        await settleTicks();
        expect(selectedProofs).toBeGreaterThan(0);
        expect(credentialReads).toBe(0);
        expect(providerReads).toBe(0);
        expect(requester.bootstrap.savedSecretOperationContext.readSnapshot()).toBeNull();
        expect(getActiveAccountSettingsSnapshot()).toBe(alice);
        vi.useRealTimers();
        await retiring;
      } finally {
        await background?.connectedServiceRefreshLoopHandle?.stop();
        await background?.connectedServiceQuotasLoopHandle?.stop();
        background?.connectedServiceQuotasCoordinator?.disposeInBandQuotaPersistence();
        vi.useRealTimers();
        await pluginRuntime?.dispose();
        refreshTicks.mockRestore(); quotaTicks.mockRestore(); features.mockRestore();
        resetServerFeaturesClientForTests(); restoreHttp(); await http.close();
      }
      return;
    }
    if (surface === 'spawn-currentness') {
      const requester = runtime;
      const spawn = () => executeSpawnSessionRequest({ options: {
        // Stop at real request validation, before any workspace or process effect.
        directory: '', requesterSessionBootstrap: admitted.admitted,
      }, requesterSessionRuntimeContext: requester, credentials: requester.bootstrap.credentials, api: requester.api,
        connectedServicesMaterializationBaseDir: directory,
        connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
        connectedServiceRuntimeRegistry: registry, trackedSessionsByKey: trackedSessions,
        spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
        spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
        resolveCanonicalTrackedSessionId: () => { throw new Error('Unexpected runner'); },
        onChildExited: () => { throw new Error('Unexpected runner'); },
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        // Malformed Settings withdraws publication. Its next reader recovers
        // through the real Settings owner before continuing spawn preparation.
        await channel.pushInvalidSettings('bob');
        settingsVersion++;
        const before = sessionReads;
        expect(await spawn()).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
        // Admission and publication consume the live requester observation;
        // recovering Settings must not re-fetch unchanged Session authority.
        expect(sessionReads - before).toBe(0);
        expect(requester.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion);
      }
      await channel.pushInvalidSettings('bob');
      settingsVersion++;
      holdSettings = true;
      const pending = spawn();
      await vi.waitFor(() => expect(settingsGate.release).toBeDefined());
      current = false;
      holdSettings = false;
      releaseSettingsRead();
      // Revoking future Machine admission does not discard admitted preparation.
      expect(await pending).toMatchObject({ type: 'error', errorCode: 'INVALID_REQUEST' });
      expect(requester.bootstrap.savedSecretOperationContext.readSnapshot()).not.toBeNull();
      expect(await admitRequesterSessionBootstrap({
        bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
        boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
        context: { signal: new AbortController().signal,
          machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
            installationId: runtime.bootstrap.attribution.installationId, role: 'use', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => current },
      })).toBeNull();
      return;
    }
    if (surface === 'resolution-currentness') {
      trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: requesterSessionId, startedBy: 'daemon',
        requesterSessionRuntimeContext: runtime, requesterWorkAttributionV1: runtime.bootstrap.attribution });
      const resolveRequester = createRequesterSessionRuntimeContextResolver({ trackedSessions,
        getCreateRuntime: () => null, recoverBootstrap: async () => null });
      const resolve = (signal?: AbortSignal) => resolveRequester(requesterSessionId, runtime!.bootstrap.attribution, signal);
      const counts = () => ({ session: sessionReads, profile: authorizationProfileReads,
        currentness: get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness')).length });
      const delta = (before: ReturnType<typeof counts>) => {
        const after = counts();
        return { session: after.session - before.session, profile: after.profile - before.profile,
          currentness: after.currentness - before.currentness };
      };
      // The resolver and optional port consume the admitted requester locally;
      // neither repeats the original Session/Machine admission over HTTP.
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = counts();
        expect(await resolve()).toBe(runtime);
        expect(delta(before)).toEqual({ session: 0, profile: 0, currentness: 0 });
      }
      const beforeRevocation = counts();
      current = false;
      expect(await resolve()).toBe(runtime);
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await resolve(cancelled.signal)).toBeNull();
      expect(await resolve()).toBe(runtime);
      await runtime.dispose();
      expect(await resolve()).toBeNull();
      expect(delta(beforeRevocation)).toEqual({ session: 0, profile: 0, currentness: 0 });
      expect(runtime.bootstrap.savedSecretOperationContext.readSnapshot()).toBeNull();
      return;
    }
    if (surface === 'currentness-phase') {
      const requester = runtime;
      const phaseCounts = () => ({
        session: sessionReads,
        profile: get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/profile')).length,
        currentness: get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness')).length,
      });
      const delta = (before: ReturnType<typeof phaseCounts>) => {
        const after = phaseCounts();
        return { session: after.session - before.session, profile: after.profile - before.profile,
          currentness: after.currentness - before.currentness };
      };
      const localObservation = { session: 0, profile: 0, currentness: 0 };
      // Both warm and later guards consume the captured live observation.
      for (let phase = 0; phase < 2; phase++) {
        const before = phaseCounts();
        expect(await requester.isCurrent()).toBe(true);
        expect(delta(before)).toEqual(localObservation);
      }
      const before = phaseCounts();
      const homeGet = get.getMockImplementation()!;
      let enterCurrentness: (() => void) | undefined;
      let releaseCurrentness: (() => void) | undefined;
      let sharedSignal: AbortSignal | undefined;
      const requested = new Promise<void>(resolve => { enterCurrentness = resolve; });
      const released = new Promise<void>(resolve => { releaseCurrentness = resolve; });
      get.mockImplementation(async (...args) => {
        if (new URL(String(args[0])).pathname === '/v1/account/encryption/currentness') {
          sharedSignal = args[1]?.signal instanceof AbortSignal ? args[1].signal : undefined;
          enterCurrentness?.();
          await released;
        }
        return homeGet(...args);
      });
      try {
        // Withdraw only the live observation through its real socket ingress.
        // Both borrowers then await one shared currentness HTTP replacement.
        await channel.pushInvalidCurrentness('bob');
        const cancelled = new AbortController();
        const first = requester.isCurrent(cancelled.signal);
        let survivorSettled = false;
        const survivor = requester.isCurrent().then(value => { survivorSettled = true; return value; });
        await requested;
        cancelled.abort();
        expect(await first).toBe(false);
        expect(survivorSettled).toBe(false);
        expect(sharedSignal).toBeInstanceOf(AbortSignal);
        expect(sharedSignal?.aborted).toBe(false);
        expect(requester.readAccountSettingsSnapshot()).not.toBeNull();
        releaseCurrentness?.();
        expect(await survivor).toBe(true);
        expect(delta(before)).toEqual({ session: 0, profile: 0, currentness: 1 });
      } finally { releaseCurrentness?.(); get.mockImplementation(homeGet); }
      const beforeRetirement = phaseCounts();
      current = false;
      expect(await requester.isCurrent()).toBe(true);
      await requester.dispose();
      expect(await requester.isCurrent()).toBe(false);
      expect(admitted.admitted.savedSecretOperationContext.readSnapshot()).toBeNull();
      expect(delta(beforeRetirement)).toEqual(localObservation);
      return;
    }
    if (surface === 'follow-idle-source') {
      const reconciled: (string | null)[] = [];
      runtime.bindSessionFollowSourceReconciliation(async source => { reconciled.push(source); }, new AbortController().signal);
      expect(await runtime.sessionFollowRuleCache.read()).toMatchObject({ status: 'available', rules: [
        { receiver: { sessionId: requesterSessionId }, definition: { enabled: false } },
        { receiver: { sessionId: 'other-receiver' }, definition: { enabled: true } },
      ] });
      const warmSessionReads = sessionReads;
      for (let cursor = 1; cursor <= 5; cursor++) {
        followAccountChanges.push({ cursor, kind: 'session', entityId: 'unrelated-session', changedAt: cursor, hint: null });
        const before = followChangesReads;
        await channel.hintAccountChange(cursor);
        await vi.waitFor(() => expect(followChangesReads).toBeGreaterThan(before));
        // The loopback event is acknowledged and the synchronous HTTP boundary
        // has drained its microtasks before checking for forbidden fresh reads.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sessionReads).toBe(warmSessionReads);
      }
      expect(reconciled).toEqual([]);
      // A generic receiver row cannot demand Follow recovery.
      followAccountChanges.push({ cursor: 6, kind: 'session', entityId: requesterSessionId, changedAt: 6, hint: null });
      await channel.hintAccountChange(6);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reconciled).toEqual([]);
      // Follow's exact receiver wake recovers ordinary/manager sources even
      // without a matching private rule.
      followAccountChanges.push({ cursor: 7, kind: 'account', entityId: buildSessionFollowReceiverChangeEntityIdV1(requesterSessionId), changedAt: 7, hint: null });
      await channel.hintAccountChange(7);
      await vi.waitFor(() => expect(reconciled).toEqual([null]));
      receiverEnabled = true;
      followRuleVersion++;
      followAccountChanges.push({ cursor: 8, kind: 'account', entityId: 'bob', changedAt: 8,
        hint: buildSessionFollowChangeHintV1() });
      followAccountChanges.push({ cursor: 9, kind: 'session', entityId: 'new-source', changedAt: 9, hint: null });
      await channel.hintAccountChange(9);
      await vi.waitFor(() => expect(reconciled).toContain('new-source'));
      expect(sessionReads).toBe(warmSessionReads);
      const admittedReconciliations = reconciled.length;
      await runtime.dispose();
      // Disposal closes Bob's physical channel. Let the loopback server apply
      // that disconnect before its delivery helper waits for a retired ACK.
      await vi.waitFor(() => expect([...channel.server.sockets.sockets.values()]
        .filter(socket => socket.handshake.auth.token === requesterToken)).toHaveLength(0));
      followAccountChanges.push({ cursor: 10, kind: 'session', entityId: 'revoked-source', changedAt: 10, hint: null });
      await channel.hintAccountChange(10);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(reconciled).toHaveLength(admittedReconciliations);
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    if (surface === 'settings-refresh-failure' || surface.startsWith('startup-settings-')) {
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      let unavailable = true;
      let failedReads = 0;
      http.get('/*', async (request, reply) => {
        if (request.url === '/v2/account/settings' && unavailable) {
          failedReads++;
          return reply.code(surface === 'startup-settings-forbidden' ? 403 : 503).send({ error: 'home_unavailable' });
        }
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid Home HTTP fixture response');
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      const snapshot = runtime.readAccountSettingsSnapshot();
      const operations = createHostActionOperationRuntime({ serverId: 'bob-home', machineId: 'machine',
        resolveAccountId: async () => 'bob', supportsCoreCancellation: () => true });
      let operationId = '';
      let pending: Promise<unknown> | undefined;
      try {
        if (surface === 'settings-refresh-failure') {
          await expect(runtime.bootstrap.refreshAccountSettings(2)).rejects.toMatchObject({ response: { status: 503 } });
          expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
          // A previously failed socket hint enters refresh through its first
          // readiness read, rather than the explicit minimum's final read.
          await channel.hintSettings(2);
          await expect(runtime.bootstrap.refreshAccountSettings(2)).rejects.toMatchObject({ response: { status: 503 } });
          expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
          unavailable = false;
          settingsVersion = 2;
          expect(await runtime.bootstrap.refreshAccountSettings(2)).toBe(true);
          expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(2);
          return;
        }
        const input = { creationKey: `fix138-${surface}`, directory, machineId: 'machine' };
        pending = operations.observeExecution({ actionId: 'session.spawn_new', input,
          actionRequestId: input.creationKey, onOperation: operation => { operationId = operation.operationId; },
          execute: async operation => {
            const spawn = createSessionStartupProjectSpawn({ context: { signal: operation.signal,
              ...(surface === 'startup-settings-unbound' ? {} : { localActionContext: operation }) },
              awaitAgentSessionOpen: async () => { throw new Error('Unexpected runner'); },
              stopSession: async () => { throw new Error('Unexpected runner retirement'); },
              spawnSession: options => executeSpawnSessionRequest({ options,
              requesterSessionRuntimeContext: runtime!, credentials: runtime!.bootstrap.credentials, api: runtime!.api,
              connectedServicesMaterializationBaseDir: directory,
              connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
              connectedServiceRuntimeRegistry: registry, trackedSessionsByKey: trackedSessions,
              spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
              spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
              resolveCanonicalTrackedSessionId: () => { throw new Error('Unexpected runner'); },
              onChildExited: () => { throw new Error('Unexpected runner'); },
              }),
            });
            // Invalid directory is the no-effect neighbor after Settings:
            // recovery must reach request validation, never launch a runner.
            const result = await spawn({ directory: '', accountSettingsVersionHint: 2,
              requesterSessionBootstrap: admitted.admitted }).catch(error => {
              // Match the installed Workflow startup callback's operation
              // cancellation projection; native launch remains unreachable.
              if (operation.signal.aborted) return { type: 'error' as const, errorCode: 'cancelled', errorMessage: 'cancelled' };
              throw error;
            });
            return result.type === 'error' ? { ok: false, errorCode: result.errorCode, error: result.errorMessage }
              : { ok: true, result };
          } });
        // Consume rejection immediately; an unbound transient must remain
        // retryable rather than becoming an unhandled exception in the harness.
        const settled = pending.then(result => ({ result }), error => ({ error: error as unknown }));
        if (surface === 'startup-settings-unbound') {
          expect(await settled).toMatchObject({ error: { status: 503, response: { status: 503 } } });
          expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
          return;
        }
        if (surface === 'startup-settings-forbidden') {
          expect(await settled).toMatchObject({ error: { response: { status: 403 } } });
          expect(failedReads).toBe(1);
          expect(ActionOperationGetV1ResponseSchema.parse(await operations.handlers.get({ operationId })))
            .toMatchObject({ kind: 'found', operation: { state: 'failed' } });
          expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
          return;
        }
        await vi.waitFor(() => expect(failedReads).toBeGreaterThan(0));
        const readOperation = () => operations.handlers.get({ operationId });
        expect(ActionOperationGetV1ResponseSchema.parse(await readOperation())).toMatchObject({ kind: 'found', operation: { state: 'running' } });
        expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
        if (surface === 'startup-settings-cancel') {
          expect(await operations.handlers.cancel({ operationId })).toMatchObject({ kind: 'requested' });
          await settled;
          expect(ActionOperationGetV1ResponseSchema.parse(await readOperation())).toMatchObject({ kind: 'found', operation: { state: 'cancelled' } });
          expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(1);
        } else {
          unavailable = false;
          settingsVersion = 2;
          expect(await settled).toMatchObject({ result: { ok: false, errorCode: 'INVALID_REQUEST' } });
          expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(2);
          expect(ActionOperationGetV1ResponseSchema.parse(await readOperation())).toMatchObject({ kind: 'found', operation: {
            state: 'failed', error: { errorCode: 'INVALID_REQUEST' },
          } });
        }
        expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      } finally {
        unavailable = false;
        if (operationId) await operations.handlers.cancel({ operationId });
        await pending?.catch(() => undefined);
        restoreHttp(); await http.close();
      }
      return;
    }
    if (surface === 'background-home-failure') {
      // Fail the requested inventory itself, rather than an obsolete Profile
      // permission probe. Local custody survives that ordinary HTTP failure.
      const signal = new AbortController().signal;
      const beforeRead = authorizationProfileReads;
      const snapshot = runtime.readAccountSettingsSnapshot();
      const homeGet = get.getMockImplementation()!;
      let unavailable = true;
      get.mockImplementation(async (...args) => {
        if (unavailable && new URL(String(args[0])).pathname === '/v4/connect/qualified/accounts') {
          throw Object.assign(new axios.AxiosError('Home unavailable', 'ERR_BAD_RESPONSE'),
            { status: 503, response: { status: 503 } });
        }
        return await homeGet(...args);
      });
      await expect(runtime.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, signal,
      })).rejects.toMatchObject({ status: 503 });
      expect(authorizationProfileReads - beforeRead).toBe(0);
      expect(snapshot).not.toBeNull();
      expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
      expect(await runtime.bootstrap.isCurrent(signal)).toBe(true);
      expect(await readRequesterHomeWithinActionLifetime(() => runtime!.isCurrent(signal), signal)).toBe(true);
      unavailable = false;
      expect(await runtime.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, signal,
      })).toMatchObject({ accounts: [] });
      get.mockImplementation(homeGet);
      return;
    }
    if (runSurface) {
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      http.get('/*', async (request, reply) => {
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid Home response');
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
      try {
      openedRunPluginRuntime = true;
      pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory, controller: pluginRuntimeController!,
        runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
      const runner = await readProcessIdentityByPid(process.pid);
      if (!runner?.processStartTimeMs || !runner.command) throw new Error('Missing live test runner identity');
      trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, happySessionId: requesterSessionId, startedBy: 'daemon',
        requesterSessionRuntimeContext: runtime, requesterWorkAttributionV1: runtime.bootstrap.attribution,
        runnerProcessIdentity: { pid: process.pid, processStartTimeMs: runner.processStartTimeMs,
          processCommandHash: hashProcessCommand(runner.command) } });
      const runId = randomUUID();
      await retainExecutionRunState({ runId, callId: 'call', sidechainId: 'side', sessionId: requesterSessionId,
        depth: 0, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
        instructions: 'Read only', permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status: 'running', startedAtMs: 1 });
      const materialize = control.routes?.materializeConnectedServicesForExecutionRun;
      if (!materialize) throw new Error('Missing production Run materializer');
      const signal = new AbortController().signal;
      const resolveRequester = createRequesterSessionRuntimeContextResolver({ trackedSessions,
        getCreateRuntime: () => null, recoverBootstrap: async () => null });
      if (surface === 'run-home-recovery') {
        runHomeStatus = 503;
        await expect(resolveRequester(requesterSessionId, runtime.bootstrap.attribution))
          .resolves.toBe(runtime);
        expect(runHomeStatus).toBe(503);
      }
      runHomeStatus = 503;
      await expect(readRequesterHomeWithinActionLifetime(
        () => resolveRequester(requesterSessionId, runtime!.bootstrap.attribution, signal), signal)).resolves.toBe(runtime);
      expect(runHomeStatus).toBe(503);
      runHomeStatus = null;
      let phaseFaultInjected = false;
      const infoFile = fileLogger.infoFile.bind(fileLogger);
      // File logging is an OS boundary. Inject Home failure when the real
      // production phase starts; every owner beneath it remains composed.
      const phases = vi.spyOn(fileLogger, 'infoFile').mockImplementation((...args) => {
        infoFile(...args);
        const phase = args[1];
        if (runPurposeSurface && !phaseFaultInjected && phase && typeof phase === 'object'
          && 'phase' in phase && phase.phase === (surface === 'run-purpose-home-recovery' ? 'purpose_activation' : 'binding_read')
          && 'status' in phase && phase.status === 'started') {
          phaseFaultInjected = true;
          runHomeFailurePath = surface === 'run-purpose-home-recovery'
            ? '/v4/connect/qualified/accounts' : '/v4/connect/qualified/credential';
          runHomeStatus = 503;
        }
      });
      let response: Awaited<ReturnType<typeof materialize>>;
      try {
        response = await materialize({ activationId: randomUUID(), runId,
          runnerPid: process.pid, agentId: 'codex', cwd: directory, connectedServices: { v: 2, bindingsByServiceId: runPurposeSurface
            ? { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } : {} } }, signal);
      } finally { phases.mockRestore(); }
      // The empty preflight probe has no credential effect; declared-purpose
      // probes exercise their complete isolated Run materialization and release.
      if (runPurposeSurface) {
        expect(phaseFaultInjected).toBe(true);
        if (surface === 'run-binding-home-recovery') {
          // A failed credential acquisition settles this attempt. Recovery is
          // a fresh materialization, not an in-operation permission retry.
          expect(response).toMatchObject({ ok: false });
          expect(runHomeStatus).toBeNull();
          expect(await runtime.isCurrent()).toBe(true);
          response = await materialize({ activationId: randomUUID(), runId,
            runnerPid: process.pid, agentId: 'codex', cwd: directory, connectedServices: { v: 2,
              bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' } } } }, signal);
        }
        expect(response, !response.ok ? response.errorMessage : undefined).toMatchObject({ ok: true });
        if (response.ok) await control.routes!.releaseConnectedServicesForExecutionRun!({ runId, runnerPid: process.pid, activationId: response.activationId });
      } else expect(response).toMatchObject({ ok: false, errorMessage: 'Connected services selection resolved no materialized auth' });
      expect(runHomeStatus).toBeNull();
      expect(await runtime.isCurrent()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot()).toBeDefined();
      const exactRuntime = runtime;
      const registration = { runKey: 'requester-signaled-registration', runnerPid: process.pid, agentId: 'codex' as const,
        materializationKey: 'requester-signaled-registration', connectedServicesBindingsRaw: {}, connectedServiceSelectionsEnv: {}, sessionId: requesterSessionId };
      let registrations = 0;
      const releaseRegistrationObservation = registry.subscribeTargetRegistrations(target => {
        if (target.materializationKey === registration.materializationKey) registrations++;
      });
      const register = (registrationSignal: AbortSignal) => registerExecutionRunConnectedServicesTarget({ registry, registration,
        signal: registrationSignal,
        withSessionAccountContext: async <T>(sessionId: string | null, operation: (context: typeof exactRuntime | null) => Promise<T>,
          attribution?: typeof exactRuntime.bootstrap.attribution, readerSignal?: AbortSignal) => {
          const context = sessionId ? await resolveRequester(sessionId, attribution, readerSignal) : null;
          return await operation(context);
        },
        assertSessionAccountCurrent: async (_sessionId, expected, _attribution, readerSignal) => await assertRequesterSessionAccountContextCurrent({
          expected, signal: readerSignal, resolveCurrent: async () => exactRuntime,
          readTrackedContext: () => trackedSessions.get(legacyPidSessionTrackingKey(process.pid))?.requesterSessionRuntimeContext ?? null,
        }),
      });
      runHomeStatus = 503;
      runHomeFailurePath = '/v1/account/profile';
      const beforeRegistration = authorizationProfileReads;
      await expect(register(signal)).resolves.toBeUndefined();
      expect(authorizationProfileReads).toBe(beforeRegistration);
      expect(runHomeStatus).toBe(503);
      expect(registry.getRunTargetByRunKey(registration.runKey)?.requesterWorkAttributionV1).toEqual(runtime.bootstrap.attribution);
      expect(registrations).toBe(1);
      releaseRegistrationObservation();
      registry.unregisterRunKey(registration.runKey);
      runHomeStatus = 403;
      const beforeRefusal = authorizationProfileReads;
      expect(await runtime.isCurrent(signal)).toBe(true);
      expect(authorizationProfileReads - beforeRefusal).toBe(0);
      await runtime.dispose();
      expect(await runtime.isCurrent(signal)).toBe(false);
      const cancelled = new AbortController();
      cancelled.abort();
      const beforeCancellation = authorizationProfileReads;
      expect(await runtime.isCurrent(cancelled.signal)).toBe(false);
      await expect(register(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(registry.getRunTargetByRunKey(registration.runKey)).toBeNull();
      expect(authorizationProfileReads).toBe(beforeCancellation);
      return;
      } finally {
        try { await pluginRuntime?.dispose(); }
        finally { restoreHttp(); await http.close(); }
      }
    }
    if (surface === 'follow-source' || surface === 'follow-receiver') {
      if (surface === 'follow-source') {
        // Source publication re-enters the daemon under the receiver's own
        // admitted Session custody, just like receiver catch-up does.
        const destination = await admitRequesterSessionBootstrap({
          bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
          existingSessionId: followDestinationId,
          boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
          context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
            machineId: 'machine', installationId: host.installation!.installationId, role: 'use', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => current },
        });
        if (!destination) throw new Error('Missing real Follow destination admission');
        cleanupFollowDestination = destination.cleanupOnFailure;
        destination.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
        followDestination.runtime = await createRequesterSessionRuntimeContext({ ...runtimeInput, bootstrap: destination.admitted });
        if (!followDestination.runtime) throw new Error('Missing real Follow destination runtime');
        expect(followDestination.runtime.bootstrap.getBoundSessionId()).toBe(followDestinationId);
      }
      const notify = control.routes?.onSessionActivityChanged;
      if (surface === 'follow-source' && !notify) throw new Error('Missing real source IPC receiver');
      const occurrence = { sourceSessionId: followSourceId,
        sourcePublisher: { machineId: 'machine', committedFenceMs: 1, publisherGeneration: '1' },
        sourceMessage: { localId: 'moved-out-original', seq: 1 }, evidence: { v: 1 as const, ownerAccountId: 'bob',
          event: { kind: 'failed_or_stopped' as const }, facts: { serverId: 'bob-home', kind: 'session' as const, startedBy: 'you' as const } } };
      const deliver = async (original: typeof occurrence) => {
        if (surface === 'follow-source') await notify!(requesterSessionId, original);
        else { const { sourcePublisher: _publisher, ...receiverOriginal } = original;
          await host!.runtime.dispatchSessionFollowOccurrence({ destinationSessionId: requesterSessionId, occurrence: receiverOriginal }); }
      };
      await deliver(occurrence);
      expect(followEnqueued).toEqual([]);
      sourceProject = 'payments';
      await deliver({ ...occurrence, sourceMessage: { localId: 'moved-in-original', seq: 2 } });
      // A notification traverses every still-undelivered original with current
      // facts; the earlier nonmatch did not advance the server's zero frontier.
      expect(followEnqueued).toEqual(['moved-out-original', 'moved-in-original'].map(localId => expect.objectContaining({
        followSources: [expect.objectContaining({ rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } })],
        followDeliveryV1: { v: 1, original: { sourceSessionId: followSourceId,
          sourceTurn: { id: `${localId}-host-turn`, status: 'failed' } }, event: { kind: 'failed_or_stopped' }, delivery: 'wake' },
      })));
      expect(followEnqueued[1]).toMatchObject({ followSources: [{ rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } }],
        followRelations: [{ relation: 'follower' }, { relation: 'manager', attachedAt: 10 }],
        followDeliveryV1: { original: { sourceSessionId: followSourceId, sourceTurn: { id: 'moved-in-original-host-turn', status: 'failed' } }, delivery: 'wake' } });
      if (surface === 'follow-receiver') {
        expect(followEnqueued[0]).toMatchObject({ followSources: [{ evaluation: 'receiver' }] });
        expect(JSON.stringify(followEnqueued)).not.toContain('expectedSourcePublisherGeneration');
      }
      if (surface === 'follow-source') {
        const result = await notify!(requesterSessionId, { ...occurrence,
          sourceMessage: { localId: 'completed-original', seq: 3 },
          evidence: { ...occurrence.evidence, event: { kind: 'finished' } } });
        expect(result).toMatchObject({ personalFollow: { sourceSessionId: followSourceId,
          sourceMessage: { localId: 'completed-original', seq: 3,
            policies: [{ preset: 'custom', events: { finished: { delivery: 'quiet' } } }] } } });
      }
      expect(followReads).toContain('/v2/account/session-follow-rules');
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    if (surface === 'follow-rules') {
      expect(await runtime.sessionFollowRuleCache.read()).toMatchObject({ status: 'available', rules: [{ ruleId: 'bob-private-rule' }] });
      expect(followReads).toContain('/v2/account/session-follow-rules');
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      current = false;
      expect(await runtime.sessionFollowRuleCache.read()).toMatchObject({ status: 'available' });
      const readHome = get.getMockImplementation()!;
      get.mockImplementation(async (...args) => String(args[0]).includes('/session-follow-')
        ? { status: 403, data: { error: 'forbidden' } } : await readHome(...args));
      expect(await runtime.sessionFollowRuleCache.read({ refresh: true })).toMatchObject({ status: 'unavailable' });
      return;
    }
    if (surface === 'follow-wake' || surface === 'follow-pending') {
      if (!host) throw new Error('Missing requester control host');
      const requester = runtime;
      const installationId = host.installation?.installationId;
      if (!installationId) throw new Error('Missing real installation');
      const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: requesterSessionId,
        attribution: requester.bootstrap.attribution, credentials: requester.bootstrap.credentials,
        homeServerIdentityId: requester.bootstrap.homeServerIdentityId });
      const homeGet = get.getMockImplementation()!;
      const ownedRetainedSessionId = 'c234567890123456789012345';
      // The custody writer also retains ordinary Sessions admitted by their own
      // Machine custodian. Reconnect must not read that Account's work set twice.
      get.mockImplementation(async (url: string, config) => {
        if (new URL(url).origin !== 'https://alice-home.test') return await homeGet(url, config);
        const path = new URL(url).pathname;
        if (path.endsWith('/profile')) return { status: 200, data: { id: 'alice' } };
        if (path === `/v2/sessions/${ownedRetainedSessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
          id: ownedRetainedSessionId, encryptionMode: 'plain', ownerAccountId: 'alice', origin: { kind: 'none' },
          metadata: JSON.stringify({ machineId: 'machine', path: directory }), dataEncryptionKey: null, share: null,
        }) } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
        return await homeGet(url, config);
      });
      const ownedAdmission = await admitRequesterSessionBootstrap({
        bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: aliceCredentials.token } },
        existingSessionId: ownedRetainedSessionId,
        boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://alice-home.test', happyHomeDir: directory,
          getObservedServerIdentityId: async () => 'srv_alice_home' },
        context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'alice', custodianAccountId: 'alice',
          machineId: 'machine', installationId, role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true },
      });
      if (!ownedAdmission) throw new Error('Missing real custodian requester admission');
      const ownedResources: { runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>>;
        custody: Awaited<ReturnType<typeof createRequesterSessionCredentialCustody>> | null }
        = { runtime: null, custody: null };
      cleanupOwnedFollow = async () => {
        try { await ownedResources.runtime?.dispose(); }
        finally { try { await ownedResources.custody?.cleanup(); } finally { await ownedAdmission.cleanupOnFailure(); } }
      };
      ownedAdmission.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
      const ownedRequester = await createRequesterSessionRuntimeContext({ ...runtimeInput, bootstrap: ownedAdmission.admitted,
        providerAccountUsageStore: host.runtime.resolveProviderAccountUsageStore(ownedAdmission.admitted.attribution) });
      ownedResources.runtime = ownedRequester;
      if (!ownedRequester) throw new Error('Missing real custodian requester runtime');
      ownedResources.custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: ownedRetainedSessionId,
        attribution: ownedRequester.bootstrap.attribution, credentials: ownedRequester.bootstrap.credentials,
        homeServerIdentityId: ownedRequester.bootstrap.homeServerIdentityId });
      const requests: string[] = [];
      type MachineClient = NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>;
      let changedSession: Parameters<MachineClient['onSessionChanged']>[0] | undefined;
      let followChanged: Parameters<MachineClient['onSessionFollowRulesChanged']>[0] | undefined;
      let activatePending: Parameters<MachineClient['onPendingSessionActivationHint']>[0] | undefined;
      let machineConnected: Parameters<MachineClient['connect']>[0]['onConnect'] | undefined;
      let running = false;
      let homeIdentity = 'srv_bob_home';
      const launches: string[] = [];
      const originReads: string[] = [];
      const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
        originReads.push(String(input));
        expect(['https://alice-home.test/v1/features', 'https://bob-home.test/v1/features']).toContain(String(input));
        return new Response(JSON.stringify(FeaturesResponseSchema.parse({ features: {},
          capabilities: { serverIdentity: { serverIdentityId: String(input).startsWith('https://alice-home.test/')
            ? 'srv_alice_home' : homeIdentity } } })), { status: 200,
            headers: { 'Content-Type': 'application/json' } });
      });
      const resolveOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://bob-home.test',
        resolveCurrentMachineId: () => 'machine' });
      const resolveAmbientOrigin = createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://alice-home.test',
        resolveCurrentMachineId: () => 'machine' });
      const transport = { ...createApiMachineTransportFixture(),
        setRPCHandlers: (..._args: Parameters<MachineClient['setRPCHandlers']>) => ({} as ReturnType<MachineClient['setRPCHandlers']>),
        registerLiveStreamRelayRoutes: vi.fn(), connect: vi.fn((options: Parameters<MachineClient['connect']>[0]) => {
          machineConnected = options.onConnect;
        }),
        updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
        onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => { changedSession = undefined; }; },
        onSessionFollowRulesChanged: (listener: NonNullable<typeof followChanged>) => {
          if (!followChanged) followChanged = listener;
          return () => { if (followChanged === listener) followChanged = undefined; };
        },
        onPendingSessionActivationHint: (listener: NonNullable<typeof activatePending>) => { activatePending = listener; return () => { activatePending = undefined; }; },
        emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
        sendMachineLiveStreamRelayEnvelope: vi.fn(),
        getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
      };
      const machine = await runWithServerHttpBaseUrl('https://alice-home.test', () => bootstrapMachineSyncRuntime({
        cliVersion: 'test', machineId: 'machine', credentials: aliceCredentials,
        machine: { id: 'machine', encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        preferredHost: 'host', happyHomeDir: directory, happyLibDir: directory, filesystemAccessPolicy: { kind: 'osUser' },
        takeoverRequested: false, isShuttingDown: () => false, createConnectedApiMachine: () => transport as unknown as MachineClient,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async options => {
          expect(options.requesterSessionBootstrap).toBe(requester.bootstrap);
          expect(options.requesterSessionRuntimeContext).toBe(requester);
          expect(options.executionAuthorization).toMatchObject({ provenance: 'user_request', requestId: pendingRequestId });
          launches.push(options.existingSessionId!); running = true;
          return { type: 'success', sessionId: requesterSessionId };
        },
        spawnSession: async () => { throw new Error('Requester Pending must not use person Resume'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => running,
        requesterServerId: 'bob-home', resolveCurrentMachineExecutionOriginContext: resolveOrigin,
        readRequesterSessionCredentialBindings: () => listRequesterSessionCredentialBindings({ happyHomeDir: directory,
          serverId: 'bob-home', machineId: 'machine', installationId }),
        resolveRequesterSessionRuntimeContext: async (sessionId, attribution) => {
          if (sessionId === ownedRetainedSessionId) { expect(attribution).toEqual(ownedRequester.bootstrap.attribution); return ownedRequester; }
          expect(sessionId).toBe(requesterSessionId); expect(attribution).toEqual(requester.bootstrap.attribution); return requester;
        }, releaseRequesterSessionRuntimeContext: async context => { expect([requester, ownedRequester]).toContain(context); },
        dispatchSessionFollowOccurrence: host!.runtime.dispatchSessionFollowOccurrence,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      }));
      get.mockRestore();
      const http = fastify();
      let sourceAgentStateVersion = 0;
      let sourceTranscriptSeq = 1;
      let sourceRequests: Record<string, { tool: string; arguments: object; createdAt: number; turnId: string }> = {};
      let pendingRequestId: string | undefined;
      const activationTarget = { homeId: 'srv_bob_home', accountId: 'bob', sessionId: requesterSessionId, machineId: 'machine', installationId };
      http.addHook('onRequest', async request => {
        requests.push(request.url);
        expect(request.headers.authorization).toBe(`Bearer ${request.url === '/v1/machines/machine/admission/verify'
          ? aliceCredentials.token : requesterToken}`);
      });
      http.get('/*', async (request, reply) => {
        if (request.url === `/v2/sessions/${requesterSessionId}/pending`) return { pending: pendingRequestId
          ? [{ localId: pendingRequestId, messageRole: 'user', deliveryStatus: { status: 'queued' } }] : [] };
        if (request.url === `/v2/sessions/${requesterSessionId}` && pendingRequestId) return { session: createSessionRecordFixture({
          id: requesterSessionId, encryptionMode: 'plain', ownerAccountId: 'bob', origin: { kind: 'none' },
          metadata: JSON.stringify({ machineId: 'machine', path: directory, flavor: 'codex', codexSessionId: 'bob-native',
            runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } }), dataEncryptionKey: null, share: null,
          pendingCount: 1, pendingVersion: 1, pendingActivationAuthorization: { status: 'waiting', requestId: pendingRequestId,
            requestedAt: 1, admittedTarget: activationTarget },
        }) };
        if (request.url === '/v2/sessions/bob-follow-source') return { session: createSessionRecordFixture({
          ...createSessionNotificationContextFixture('bob-follow-source'),
          id: 'bob-follow-source', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo', projectId: sourceProject }),
          dataEncryptionKey: null, share: null, ownerAccountId: 'bob', origin: { kind: 'none' }, seq: sourceTranscriptSeq,
          projectKey: sourceProject,
          agentStateVersion: sourceAgentStateVersion, agentState: JSON.stringify({ requests: sourceRequests, completedRequests: {} }),
          latestTurnId: surface === 'follow-pending' ? null : 'failed-turn', latestTurnStatus: surface === 'follow-pending' ? null : 'failed' }) };
        if (request.url.startsWith('/v1/sessions/bob-follow-source/messages')) return { messages: [{
          id: 'source-message', seq: 1, localId: 'source-failed-original', createdAt: 1, updatedAt: 1, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'native-failed-turn' },
            meta: { runtimeTurnId: 'failed-turn' } }) },
        }, ...(sourceTranscriptSeq >= 2 ? [{ id: 'source-next-message', seq: 2, localId: 'encountered-rule-original', createdAt: 2,
          updatedAt: 2, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'native-next-failed-turn' },
            meta: { runtimeTurnId: 'next-failed-turn' } }) } }] : []),
        ...(sourceTranscriptSeq === 3 ? [{ id: 'fresh-source-message', seq: 3, localId: 'fresh-rule-original', createdAt: 30,
          updatedAt: 30, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'native-fresh-failed-turn' },
            meta: { runtimeTurnId: 'fresh-failed-turn' } }) } }] : [])]
          .filter(row => row.seq > Number(new URL(request.url, 'https://bob-home.test').searchParams.get('afterSeq') ?? 0)), hasMore: false,
          nextBeforeSeq: null, nextAfterSeq: null };
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid Home response');
        return reply.code(response.status).send(response.data);
      });
      const sourceObservations = ['manager', ...(surface === 'follow-pending' ? ['follower'] : [])].map(relation => ({
        sourceSessionId: 'bob-follow-source', destinationSessionId: requesterSessionId, relation,
        ...(relation === 'manager' ? { attachedAt: 1 } : {}), policy: { preset: 'important' },
        delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1, observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1,
          transcriptSeq: 1 },
      }));
      const unboundReceiverId = 'c987654321098765432109876';
      http.post('/v2/follows/pending-receivers', async request => {
        expect(request.body).toEqual({ v: 1, machineId: 'machine', installationId });
        return { ok: true, v: 1, sessionIds: [requesterSessionId, unboundReceiverId] };
      });
      http.post(`/v2/sessions/${requesterSessionId}/follows/inactive-observations`, async () => SessionFollowObserveInactiveResponseV1Schema.parse({
        ok: true, v: 1, sessionId: requesterSessionId, target: { homeId: 'srv_bob_home', accountId: 'bob', sessionId: requesterSessionId,
          machineId: 'machine', installationId }, currentSourceSessionIds: ['bob-follow-source'], observations: sourceObservations }));
      const acceptedOriginals: unknown[] = [];
      http.post('/v1/machines/machine/admission/verify', async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object' || !('context' in body) || !('proof' in body) || !('purpose' in body)) {
          throw new Error('Missing requester Machine admission proof');
        }
        const context = SocketRpcMachineAdmissionContextV1Schema.parse(body.context);
        const proof = MachineInstallationProofV1Schema.parse(body.proof);
        const purpose = RequesterSessionCurrentnessPurposeV1Schema.parse(body.purpose);
        const installation = readInstallationIdentityIfExistsSync();
        if (!installation) throw new Error('Missing requester fixture installation');
        const valid = context.actorAccountId === 'bob' && context.custodianAccountId === 'alice'
          && purpose.sessionId === requesterSessionId && verifyMachineInstallationProof({ publicKey: installation.publicKey,
            proof, payload: { version: 1, accountId: 'alice', machineId: 'machine', installationId,
              rpcAdmission: { context, purpose } } });
        return valid && current ? { v: 1, ok: true } : reply.code(403).send({ error: 'access_denied' });
      });
      http.post('/v2/sessions/bob-follow-source/follows/occurrence-routes', async request => {
        expect(request.body).toMatchObject({ destinationSessionId: requesterSessionId });
        if (request.body && typeof request.body === 'object' && 'sourceRequests' in request.body) {
          expect(request.body).toMatchObject({ sourceRequests: { agentStateVersion: sourceAgentStateVersion } });
        } else expect(request.body).toMatchObject({ sourceTurn: { id: sourceTranscriptSeq === 3 ? 'fresh-failed-turn'
          : sourceTranscriptSeq === 2 ? 'next-failed-turn' : 'failed-turn', status: 'failed' } });
        expect(request.body).not.toHaveProperty('sourcePublisher');
        return { ok: true, v: 1, sourceSessionId: 'bob-follow-source', originalCreatedAt: sourceTranscriptSeq === 3 ? 30 : sourceTranscriptSeq,
          routes: sourceObservations };
      });
      const pendingIds = new Set<string>();
      http.post(`/v2/sessions/${requesterSessionId}/pending`, async request => {
        const body = request.body as { localId: string };
        const didWrite = !pendingIds.has(body.localId);
        if (didWrite) { pendingIds.add(body.localId); acceptedOriginals.push(request.body); pendingRequestId = body.localId; }
        return { didWrite };
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      const requesterAdapter = axios.defaults.adapter;
      if (typeof requesterAdapter !== 'function') throw new Error('Missing requester HTTP adapter');
      const ambientRequests: string[] = [];
      // Reconnect also visits Alice's installed Account. Keep that separate HTTP
      // boundary empty while Bob's real requester path goes through Fastify.
      axios.defaults.adapter = async config => {
        const url = new URL(axios.getUri(config));
        if (url.origin === 'https://bob-home.test') return requesterAdapter(config);
        expect(url.origin).toBe('https://alice-home.test');
        expect(config.headers.get('Authorization')).toBe(`Bearer ${aliceCredentials.token}`);
        ambientRequests.push(url.pathname);
        const data = url.pathname === '/v2/sessions' ? { sessions: [], hasNext: false, nextCursor: null }
          : url.pathname === '/v2/follows/pending-receivers' ? { ok: true, v: 1, sessionIds: [] } : { error: 'home_unavailable' };
        return { config, status: url.pathname === '/v2/sessions' || url.pathname === '/v2/follows/pending-receivers' ? 200 : 503,
          statusText: '', headers: {}, data };
      };
      try {
        if (!changedSession) throw new Error('Missing exact Session subscription');
        if (!followChanged) throw new Error('Missing exact Follow receiver subscription');
        const pushReceiverChange = () => followChanged!({ full: false, workflowRunIds: [], receiverSessionIds: [requesterSessionId] });
        expect(readInstallationIdentityIfExistsSync()?.installationId).toBe(installationId);
        expect(await requester.isCurrent()).toBe(true);
        expect(await resolveOrigin()).toEqual({ machineId: 'machine', serverIdentityId: 'srv_bob_home' });
        expect(await resolveAmbientOrigin()).toEqual({ machineId: 'machine', serverIdentityId: 'srv_alice_home' });
        const activeAlice = getActiveAccountSettingsSnapshot();
        const originBeforeWake = originReads.length;
        await changedSession({ sessionId: requesterSessionId, cursor: 1 });
        expect(acceptedOriginals, 'generic Session projection is not a Follow wake').toHaveLength(0);
        if (!machineConnected) throw new Error('Missing real Machine reconnect callback');
        await machineConnected();
        expect(requests.filter(path => path === '/v2/follows/pending-receivers')).toHaveLength(1);
        expect(ambientRequests.filter(path => path === '/v2/follows/pending-receivers')).toHaveLength(1);
        expect(requests.filter(path => path.includes('/follows/inactive-observations')))
          .toEqual([`/v2/sessions/${requesterSessionId}/follows/inactive-observations`]);
        expect(ambientRequests.some(path => path.includes(unboundReceiverId))).toBe(false);
        if (surface === 'follow-wake') {
          expect(acceptedOriginals).toHaveLength(1);
          expect(launches).toEqual([]);
          if (!activatePending || !pendingRequestId) throw new Error('Missing committed Pending activation');
          await activatePending({ sessionId: requesterSessionId, requestId: pendingRequestId, pendingVersion: 1,
            requestedAt: 1, source: 'live', target: activationTarget });
        }
        if (surface === 'follow-pending') {
          expect(acceptedOriginals).toHaveLength(1);
          const inactivePath = `/v2/sessions/${requesterSessionId}/follows/inactive-observations`;
          const inactiveBeforeSource = requests.filter(path => path === inactivePath).length;
          const sourcesBefore = requests.filter(path => path === '/v2/sessions/bob-follow-source').length;
          const sourceRoutesPath = '/v2/sessions/bob-follow-source/follows/occurrence-routes';
          const routesBeforeSource = requests.filter(path => path === sourceRoutesPath).length;
          sourceProject = 'other';
          followAccountChanges = [{ cursor: 1, kind: 'session', entityId: 'bob-follow-source', changedAt: 10 }];
          await channel.hintAccountChange(1);
          await vi.waitFor(() => expect(requests.filter(path => path === '/v2/sessions/bob-follow-source').length).toBeGreaterThan(sourcesBefore));
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(requests.filter(path => path === inactivePath)).toHaveLength(inactiveBeforeSource);
          // A later predicate match still reaches the same real requester/bootstrap intake.
          sourceProject = 'payments';
          sourceAgentStateVersion = 4;
          sourceRequests = { approvalA: { tool: 'Bash', arguments: {}, createdAt: 10, turnId: 'current-turn' } };
          for (const observation of sourceObservations) observation.observed.agentStateVersion = sourceAgentStateVersion;
          followAccountChanges.push({ cursor: 2, kind: 'session', entityId: 'bob-follow-source', changedAt: 11 });
          await channel.hintAccountChange(2);
          await vi.waitFor(() => expect(requests.filter(path => path === sourceRoutesPath).length).toBeGreaterThan(routesBeforeSource));
          await vi.waitFor(() => expect(acceptedOriginals).toHaveLength(2));
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(requests.filter(path => path === inactivePath), 'matching source discovery uses fresh route admission, not broad observation')
            .toHaveLength(inactiveBeforeSource);
          expect(acceptedOriginals[0]).toMatchObject({ followRelations: [{ relation: 'manager', attachedAt: 1 }, { relation: 'follower' }],
            followSources: [{ evaluation: 'receiver', rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source', sourceTurn: { id: 'failed-turn', status: 'failed' } }, delivery: 'wake' } });
          // Re-observing the same admitted request does not create a third original.
          await pushReceiverChange();
          expect(acceptedOriginals).toHaveLength(2);
          sourceAgentStateVersion = 7;
          sourceRequests = { ...sourceRequests, approvalB: { tool: 'Bash', arguments: {}, createdAt: 20, turnId: 'current-turn' } };
          for (const observation of sourceObservations) observation.observed.agentStateVersion = sourceAgentStateVersion;
          await pushReceiverChange();
          expect(acceptedOriginals).toHaveLength(3);
          expect(acceptedOriginals.slice(1)).toMatchObject([
            { followDeliveryV1: { original: { sourceRequests: { requests: [{ requestId: 'approvalA', createdAt: 10, turnId: 'current-turn' }] } } } },
            { followDeliveryV1: { original: { sourceRequests: { requests: [{ requestId: 'approvalB', createdAt: 20, turnId: 'current-turn' }] } } } },
          ]);
          // An encountered rule's existing private cursor can drive catch-up
          // without an ordinary edge. It is not an initial-history baseline.
          sourceTranscriptSeq = 2;
          sourceObservations.splice(0);
          await pushReceiverChange();
          expect(acceptedOriginals).toHaveLength(4);
          expect(acceptedOriginals[3]).toMatchObject({ followSources: [{ evaluation: 'receiver' }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source',
              sourceTurn: { id: 'next-failed-turn', status: 'failed' } } } });
          expect(acceptedOriginals[3]).not.toHaveProperty('followRelations');
          expect(requests.some(path => {
            const url = new URL(path, 'https://bob-home.test');
            return url.pathname === '/v1/sessions/bob-follow-source/messages' && url.searchParams.get('afterSeq') === '1';
          })).toBe(true);
          // The retained requester Home source feed discovers a brand-new
          // rule with no edge/progress; Alice's installed Account is never used.
          freshFollowRule = true;
          sourceTranscriptSeq = 3;
          followAccountChanges = [{ cursor: 3, kind: 'account', entityId: 'session-follows', changedAt: 30,
            hint: buildSessionFollowChangeHintV1() }, { cursor: 4, kind: 'session', entityId: 'bob-follow-source', changedAt: 30 }];
          await channel.hintAccountChange(4);
          await vi.waitFor(() => expect(acceptedOriginals).toHaveLength(5));
          expect(acceptedOriginals[4]).toMatchObject({ followSources: [{ evaluation: 'receiver', rule: { ruleId: 'bob-fresh-rule', ruleVersion: 0 } }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source', sourceTurn: { id: 'fresh-failed-turn', status: 'failed' } } } });
        }
        const expectedLaunches = surface === 'follow-pending' ? [] : [requesterSessionId];
        // The migrated producer commits the input first; only the incumbent
        // Pending activation/acceptance owner may launch it. It must not also
        // take the removed direct observation→hydrate→wake path.
        expect(launches, JSON.stringify({ requests, originReads })).toEqual(expectedLaunches);
        expect(originReads.slice(originBeforeWake)).toEqual(expect.arrayContaining(['https://bob-home.test/v1/features']));
        expect(originReads.slice(originBeforeWake)).not.toContain('https://alice-home.test/v1/features');
        expect(requests).toContain('/v2/sessions/bob-follow-source');
        expect(originReads.length).toBeGreaterThan(0);
        // Alice's own asynchronous catalog read may settle during the wake.
        // Bob must preserve her Account identity and preferences independently.
        expect(getActiveAccountSettingsSnapshot()).toMatchObject({ scopeKey: activeAlice?.scopeKey,
          settings: activeAlice?.settings, rawSettings: activeAlice?.rawSettings, settingsVersion: activeAlice?.settingsVersion });
        running = false;
        homeIdentity = 'srv_replaced_home';
        await pushReceiverChange();
        expect(launches).toEqual(expectedLaunches);
        homeIdentity = 'srv_bob_home';
        await requester.dispose();
        const beforeRetired = requests.length;
        await pushReceiverChange();
        // Local runtime retirement prevents another private read or wake.
        expect(requests.slice(beforeRetired).filter(path => path !== '/v1/account/encryption/currentness')).toEqual([]);
        expect(launches).toEqual(expectedLaunches);
      } finally {
        await retireMachineSyncRuntimeAttempt(machine); restoreHttp(); await http.close(); fetchBoundary.mockRestore(); await custody.cleanup();
      }
      return;
    }
    if (surface === 'request-auth-observations') {
      const requester = runtime;
      if (!requester.activatePurposeBindings) throw new Error('Missing requester purpose bindings owner');
      const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
      const binding = { purpose, target: { kind: 'account' as const,
        account: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' } } };
      const lease = requester.activatePurposeBindings({ subject: { kind: 'execution_run', runId: 'requester-read',
        runnerPid: process.pid, agentId: 'codex', isCurrent: () => true }, purposes: [purpose], bindings: [binding] });
      const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId,
        parentSessionId: 'bob-session', uses: [{ purpose, materialization: { kind: 'httpHeaders',
          origin: 'https://chatgpt.com', headerNames: ['authorization'] } }], registerRedaction: () => {} });
      const callbacks = createDaemonQualifiedRequestAuthCallbacks<typeof requester>({
        withSessionAccountContext: async (_sessionId, operation) => await operation(requester),
        assertSessionAccountCurrent: async (_sessionId, expected) => await assertRequesterSessionAccountContextCurrent({
          expected, resolveCurrent: async () => requester, readTrackedContext: () => requester,
        }),
      });
      const callbackWithoutAssertion = createDaemonQualifiedRequestAuthCallbacks({
        withSessionAccountContext: async (_sessionId, operation) => await operation(requester),
      });
      let pluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
      try {
        // The daemon publishes a registry before resolving purpose bindings.
        // An empty admitted registry is unavailable service data, not missing
        // runtime custody; keep the real resolver beneath that boundary.
        pluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
          controller: runPluginRuntimeController, runtimeOptions: { pluginIds: [] } });
        // The actual requester, assertion and purpose owner run beneath HTTP.
        // The unavailable service has no admitted binding and returns null
        // before credential reads. Both adapters consume pushed authority;
        // the later revoked request must still refuse below.
        for (const callback of [callbacks, callbackWithoutAssertion]) {
          for (let operation = 0; operation < 2; operation++) {
            const before = sessionReads;
            await expect(callback.resolveCurrentBinding({ subject, binding,
              signal: new AbortController().signal })).resolves.toBeNull();
            expect(sessionReads - before).toBe(0);
          }
        }
        current = false;
        for (const callback of [callbacks, callbackWithoutAssertion]) {
          // New Home reads enforce their own admission; the old bootstrap
          // Machine verifier is not an in-flight permission veto.
          get.mockRejectedValueOnce(Object.assign(new axios.AxiosError('Forbidden', 'ERR_BAD_REQUEST'),
            { response: { status: 403 } }));
          await expect(callback.resolveCurrentBinding({ subject, binding,
            signal: new AbortController().signal })).rejects.toMatchObject({ code: 'request_auth_binding_unavailable',
              diagnostic: { causeCode: 'binding_http_refused', httpStatus: 403 } });
        }
      } finally {
        try { await lease.dispose(); } finally { await pluginRuntime?.dispose(); }
      }
      return;
    }
    if (surface === 'settings-key-subscriptions') {
      const wakes = { refresh: 0, quota: 0, authorize: 0 };
      const observed: unknown[] = [];
      const releases = [
        runtime.subscribeAccountSettingsSnapshot(() => {
          wakes.refresh++;
          observed.push(runtime!.readAccountSettingsSnapshot().settings.connectedServicesProviderStateSharingSettingsV1.defaults.stateMode);
        }, { settings: ['connectedServicesProviderStateSharingSettingsV1'] }),
        runtime.subscribeAccountSettingsSnapshot(() => {
          wakes.quota++;
          observed.push(runtime!.readAccountSettingsSnapshot().settings.usageQuotaNotificationsV1.pace);
        }, { settings: ['usageQuotaNotificationsV1'] }),
        runtime.subscribeAccountSettingsSnapshot(() => {
          wakes.authorize++;
          observed.push(runtime!.readAccountSettingsSnapshot().providerConnectionsCatalog?.status);
        }, { settings: ['providerDefaultModelSelectionsByAgentTargetKeyV1'], facets: ['providerConnectionsCatalog'] }),
      ];
      try {
        const operation = admitted.admitted.savedSecretOperationContext;
        const write = async (patch: Record<string, unknown>) => {
          const previous = runtime!.readAccountSettingsSnapshot();
          const rawSettings = { ...previous.rawSettings, ...patch };
          expect(await operation.replaceAccountSettings({ ...previous, rawSettings,
            settings: accountSettingsParse(rawSettings), settingsVersion: previous.settingsVersion + 1 })).toBe(true);
        };
        for (let index = 0; index < 25; index++) await write({ analyticsOptOut: index % 2 === 0 });
        expect(wakes).toEqual({ refresh: 0, quota: 0, authorize: 0 });
        await write({ usageQuotaNotificationsV1: { ...runtime.readAccountSettingsSnapshot().settings.usageQuotaNotificationsV1, pace: true } });
        expect(wakes).toEqual({ refresh: 0, quota: 1, authorize: 0 });
        await write({ connectedServicesProviderStateSharingSettingsV1: { v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' } } });
        expect(wakes).toEqual({ refresh: 1, quota: 1, authorize: 0 });
        expect(await operation.commitProviderConnectionsCatalog({ expectedSettingsVersion: runtime.readAccountSettingsSnapshot().settingsVersion,
          catalog: { status: 'unavailable', reason: 'scope-retired' } })).toBe(true);
        expect(wakes).toEqual({ refresh: 1, quota: 1, authorize: 1 });
        expect(observed).toEqual([true, 'isolated', 'unavailable']);
        releases.forEach(release => release());
        await write({ usageQuotaNotificationsV1: { ...runtime.readAccountSettingsSnapshot().settings.usageQuotaNotificationsV1, pace: false } });
        expect(wakes).toEqual({ refresh: 1, quota: 1, authorize: 1 });
      } finally { releases.forEach(release => release()); }
      return;
    }
    if (surface === 'refresh-observations') {
      // Exercise the real HTTP client and Home routes; only Home responses
      // and admitted Machine access are substituted. Internal Profile paging,
      // Saved Secret custody and the bound requester verifier remain real.
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      let refuseNewRequest = false;
      let permissionReads = 0;
      http.get('/*', async (request, reply) => {
        if (refuseNewRequest) return reply.code(403).send({ error: 'forbidden' });
        const path = new URL(request.url, 'https://bob-home.test').pathname;
        if (path === '/v1/account/profile' || path === `/v2/sessions/${requesterSessionId}`) permissionReads++;
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid Home HTTP fixture response');
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      try {
        // The runtime was admitted above. Finite Follow/Profile reads consume
        // its custody; Home still authorizes their actual content requests.
        for (let operation = 0; operation < 2; operation++) {
          const before = sessionReads;
          expect(await runtime.sessionFollowRuleCache.read({ refresh: true }))
            .toMatchObject({ status: 'available', rules: [{ ruleId: 'bob-private-rule' }] });
          expect(await runtime.refreshAccountSettings()).toBe(true);
          expect(sessionReads - before).toBe(0);
          expect(permissionReads).toBe(0);
        }
        let notifications = 0;
        const unsubscribe = runtime.subscribeAccountSettingsSnapshot(() => { notifications++; }, { facets: ['profileCatalog'] });
        try {
          // Observe a real Profile change through the declared catalog interest.
          record.enabled = false;
          revision++;
          holdRows = true;
          const refreshing = runtime.refreshAccountSettings();
          await vi.waitFor(() => expect(releaseRows).toBeDefined());
          current = false;
          holdRows = false;
          releaseRows?.();
          expect(await refreshing).toBe(true);
          expect(notifications).toBe(1);
          refuseNewRequest = true;
          await expect(runtime.qualifiedConnectedAccountApi.listAccounts({
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
          })).rejects.toBeDefined();
        } finally { holdRows = false; releaseRows?.(); unsubscribe(); }
      } finally { restoreHttp(); await http.close(); }
      return;
    }
    if (surface === 'warm-account') {
      // A warm Settings fence must settle from its admitted publication. Park
      // only Home HTTP to distinguish it from a fresh requester admission.
      const homeGet = get.getMockImplementation()!;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let reads = 0;
      get.mockImplementation(async (...args) => { reads++; await held; return homeGet(...args); });
      const reader = new AbortController();
      try {
        const checking = admitted.admitted.ensureAccountSettingsCurrent(reader.signal);
        const result = await Promise.race([checking.then(current => ({ current })),
          new Promise<'network-wait'>(resolve => setImmediate(() => resolve('network-wait')))]);
        expect(result).toEqual({ current: true });
        expect(reads).toBe(0);
        expect(await runtime.isCurrent(reader.signal)).toBe(true);
        expect(reads).toBe(0);
        reader.abort();
        expect(await runtime.isCurrent(reader.signal)).toBe(false);
        expect(await runtime.isCurrent()).toBe(true);
        // Future Machine admission does not withdraw captured custody. Local
        // disposal still closes that custody and every subsequent reader.
        release();
        current = false;
        expect(await admitted.admitted.isCurrent()).toBe(true);
        await runtime.dispose();
        expect(await admitted.admitted.isCurrent()).toBe(false);
        expect(reads).toBe(0);
      } finally { reader.abort(); release(); }
      return;
    }
    if (actionPolicySurface) {
      await channel.pushSettings('bob', savedSettings, ++settingsVersion);
      await vi.waitFor(() => expect(runtime!.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion));
      const service = control.routes?.agentRuntimeDaemonServices;
      if (!service) throw new Error('Missing real requester Action dispatcher');
      const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'plugin.runner', pluginVersion: '1.0.0',
        agentId: 'claude', localAgentId: 'claude', sourceCustody: { kind: 'managed', immutableGenerationId: 'fixture-generation',
          installSource: 'localPath' }, locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        normalizedModulePath: '/immutable/runtime.mjs', loadMode: 'immutable-js' });
      const witness = projectAgentRuntimeDaemonServiceTurnWitnessV1({ turnId: 'turn', inputId: 'input', userMessageSeq: 1,
        userMessageSeqs: [1], agentStartCaller: { kind: 'session', sessionId: 'bob-session', starterDepth: 0, turnDepth: 0 } });
      let invocation = 0;
      const invoke = async (callerSurface: 'agent' | 'mcp', signal?: AbortSignal) => {
        const result = await service.dispatch(AgentRuntimeDaemonServiceRequestV1Schema.parse({ v: 1,
          context: { token: 'a'.repeat(43), sessionId: 'bob-session' }, operation: { kind: 'action.execute',
            requestId: `policy-${settingsVersion}-${callerSurface}-${++invocation}`, surface: callerSurface, witness,
            actionId: 'workflow.authoring.draft.discard', input: { scope: { serverId: 'bob-home', accountId: 'bob' }, draftId: 'absent' } },
        }), { sessionId: 'bob-session', retainedAgent, runner: { pid: process.pid, processStartTimeMs: 1,
          processCommandHash: 'a'.repeat(64), snapshotIdentity: 'fixture-runner' },
          invocationContext: { cwd: directory, environment: {}, providerBindingActive: false },
          ...(signal ? { signal } : {}), isCurrent: async () => surface === 'authorization-observations'
            ? await runtime!.isCurrent(signal) : current });
        if (!result.ok) return result;
        if (result.result.kind !== 'action.execution') throw new Error('Missing Action outcome');
        return result.result.outcome;
      };
      if (surface === 'action-home-recovery') {
        failActionHomeRead = true;
        const lifetime = new AbortController();
        // The requested private Artifact read fails at Home. That failed
        // preparation creates no approval; a fresh invocation can recover.
        expect(await invoke('agent', lifetime.signal)).toMatchObject({ ok: false,
          errorCode: 'action_failed', error: 'artifact_read_unavailable' });
        expect(failedActionHomeReads).toBe(1);
        expect(approvalIds).toHaveLength(0);
        expect(failActionHomeRead).toBe(false);
        expect(await invoke('agent', lifetime.signal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(failedActionHomeReads).toBe(1);
        expect(approvalIds).toHaveLength(1);
        expect(getActiveAccountSettingsSnapshot()).toMatchObject({ scopeKey: alice?.scopeKey });
        return;
      }
      if (surface === 'authorization-observations') {
        const homeGet = get.getMockImplementation()!;
        const homePost = artifactBoundary!.getMockImplementation()!;
        get.mockRestore();
        artifactBoundary!.mockRestore();
        const http = fastify();
        http.route({ method: ['GET', 'POST'], url: '/*', handler: async (request, reply) => {
          const url = new URL(request.url, 'https://bob-home.test').href;
          const config = { headers: { Authorization: request.headers.authorization } };
          const response = request.method === 'GET' ? await homeGet(url, config) : await homePost(url, request.body, config);
          if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
            || !('data' in response)) throw new Error('Invalid Home HTTP fixture response');
          return reply.code(response.status).send(response.data);
        } });
        await http.ready();
        const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            // The host captures its origin once before requester bootstrap.
            // Measure this Action, not the earlier Session admission reads.
            authorizationStartReads = sessionReads;
            expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            // The Action owner admits the caller once; preparation must not
            // repeat that owner-role qualification through currentness hooks.
            expect(authorizationMintReads[attempt]).toBe(1);
          }
          const cancellation = new AbortController();
          cancellation.abort();
          expect(await invoke('agent', cancellation.signal)).toMatchObject({ ok: false, errorCode: 'cancelled' });
          await runtime.dispose();
          expect(await invoke('agent')).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
          expect(authorizationMintReads).toHaveLength(2);
          expect(approvalIds).toHaveLength(2);
        } finally { restoreHttp(); await http.close(); }
        return;
      }
      for (const callerSurface of ['agent', 'mcp'] as const) {
        const admittedReads = settingsReads;
        const admittedProfileReads = profileReads.length;
        const admittedConnectedReads = connectedCatalogReads;
        const outcome = await invoke(callerSurface);
        expect(settingsReads).toBe(admittedReads);
        expect(profileReads).toHaveLength(admittedProfileReads);
        expect(connectedCatalogReads).toBe(admittedConnectedReads);
        expect(outcome).toEqual({ ok: true, result: expect.objectContaining({ kind: 'approval_request_created' }) });
      }
      expect(approvalIds).toHaveLength(2);
      savedSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
        'workflow.authoring.draft.discard': ['agent', 'mcp'],
      } } };
      settingsVersion++;
      const readsBeforeEnvelope = settingsReads;
      await channel.pushSettings('bob', savedSettings, settingsVersion);
      for (const callerSurface of ['agent', 'mcp'] as const) {
        // User-waived Ask reaches the draft's Machine owner. This Account-only
        // fixture deliberately has no live Machine transport, not a hard floor.
        expect(await invoke(callerSurface)).toMatchObject({ ok: false, errorCode: 'machine_transport_unavailable' });
      }
      expect(approvalIds).toHaveLength(2);
      expect(settingsReads).toBe(readsBeforeEnvelope);
      expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion);
      savedSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
        'workflow.authoring.draft.discard': ['agent', 'mcp'],
      }, actions: {
        'workflow.authoring.draft.discard': { approvalRequiredSurfaces: ['agent', 'mcp'] },
      } } };
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(approvalIds).toHaveLength(3);
      // An unrelated demanded Profile read must not hold policy admission.
      holdRows = true;
      const catalogRefresh = runtime.refreshAccountSettings();
      await vi.waitFor(() => expect(releaseRows).toBeDefined());
      expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      holdRows = false;
      releaseRows?.();
      expect(await catalogRefresh).toBe(true);
      expect(approvalIds).toHaveLength(4);
      // An explicit demand can recover a failed hint without a socket restart.
      failSettings = true;
      await channel.hintSettings(++settingsVersion);
      await expect(runtime.isCurrent()).rejects.toMatchObject({ code: 'project_requester_home_unavailable' });
      failSettings = false;
      expect(await runtime.refreshAccountSettings()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot().settingsVersion).toBe(settingsVersion);
      // Cancelling one Action waiting for hinted policy does not cancel its Account publisher.
      holdSettings = true;
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      const cancellation = new AbortController();
      const cancelledAction = invoke('agent', cancellation.signal);
      await vi.waitFor(() => expect(settingsGate.release).toBeDefined());
      cancellation.abort();
      expect(await cancelledAction).toMatchObject({ ok: false, errorCode: 'cancelled' });
      expect(approvalIds).toHaveLength(4);
      holdSettings = false;
      releaseSettingsRead();
      settingsGate.release = undefined;
      expect(await invoke('mcp')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
      expect(approvalIds).toHaveLength(5);
      // Retirement during a hinted settings refresh cannot republish private policy.
      holdSettings = true;
      settingsVersion++;
      await channel.hintSettings(settingsVersion);
      const pending = invoke('agent');
      await vi.waitFor(() => expect(settingsGate.release).toBeDefined());
      await runtime.dispose();
      holdSettings = false;
      releaseSettingsRead();
      expect(await pending).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
      expect(approvalIds).toHaveLength(5);
      expect(() => runtime!.readAccountSettingsSnapshot()).toThrow('requester_account_context_unavailable');
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    if (surface === 'untracked-lifetime') {
      // This actual invocation-local Account runtime must be released on denial.
      const untracked = runtime;
      await expect(assertRequesterSessionAccountContextCurrent({ expected: null,
        resolveCurrent: async () => untracked, readTrackedContext: () => null }))
        .rejects.toThrow('requester_session_not_current');
      await expect(untracked.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
      })).rejects.toThrow('requester_account_context_unavailable');
      return;
    }
    if (surface === 'profile-unavailable') {
      // The same requester freshness port admits launches without a Profile.
      // An unavailable Profile domain must remain typed and runtime-closed,
      // without changing successful Account Settings freshness into failure.
      expect(await runtime.refreshAccountSettings()).toBe(true);
      expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
        profileCatalog: { status: 'unavailable', reason: 'unsupported' } });
      await expect(runtime.readAccountLaunchProfiles()).rejects.toMatchObject({ code: 'authoring_memory_unavailable' });
      expect(getActiveAccountSettingsSnapshot()).toBe(alice);
      return;
    }
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', source: 'destination', records: [{ record, revision: 2 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    revision = 3;
    expect(await runtime.refreshAccountSettings()).toBe(true);
    expect(runtime.readAccountSettingsSnapshot()).toMatchObject({ settingsVersion: 1,
      profileCatalog: { status: 'ready', records: [{ revision: 3 }] } });
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
    expect(profileReads).toContain('/v1/account/entity-rows/profiles');
    holdRows = true;
    const retiredRead = runtime.refreshAccountSettings();
    await vi.waitFor(() => expect(releaseRows).toBeDefined());
    await runtime.dispose();
    releaseRows?.();
    expect(await retiredRead).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  } finally {
    // A failed assertion must not inject its unconsumed Home fault into cleanup.
    runHomeStatus = null;
    releaseRows?.();
    settingsGate.release?.();
    try {
      try { await cleanupOwnedFollow?.(); }
      finally {
        try { await followDestination.runtime?.dispose(); }
        finally {
          try { await cleanupFollowDestination?.(); }
          finally { await runtime?.dispose(); }
        }
      }
    } finally {
      try {
        try { await followPluginRuntime?.dispose(); }
        finally { await host?.dispose(); }
      } finally {
        get.mockRestore(); controlBoundary?.mockRestore(); artifactBoundary?.mockRestore(); followPost?.mockRestore(); resetActiveAccountSettingsSnapshotForTests();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

it.each(['generation', 'usage', 'reconnect', 'run_custody'] as const)('keeps requester %s effects under Bob Home and credentials without consuming Alice authority', async (surface) => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-usage-'));
  const aliceToken = accountToken('alice');
  const bobToken = accountToken('bob');
  let current = true;
  // Account admission, encryption mode and durable usage writes are genuine HTTP boundaries.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => ({ status: 200,
    data: url.endsWith('/profile') ? { id: config?.headers?.Authorization === `Bearer ${aliceToken}` ? 'alice' : 'bob',
      connectedServicesV2: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'work', status: 'connected' }],
        groups: [{ groupId: 'main', activeProfileId: 'work', generation: config?.headers?.Authorization === `Bearer ${aliceToken}` ? 1 : 2,
          memberProfileIds: ['work'] }] }],
      connectedServiceCredentialRevisionsV1: [{ serviceId: 'openai-codex', profileId: 'work', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS' }] }
      : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : url.endsWith('/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
  }));
  const writes: Array<{ url: string; token: unknown; data: unknown }> = [];
  let bobUnavailable = surface === 'reconnect';
  const post = vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    if (bobUnavailable && config?.headers?.Authorization === `Bearer ${bobToken}`) return { status: 503, data: null };
    writes.push({ url, token: config?.headers?.Authorization, data });
    return { status: 200, data: { success: true, source: { status: 'linked' } } };
  });
  const alice = createProviderAccountUsagePersistenceScheduler({ credentials: { token: aliceToken, encryption: null },
    api: { getAccountEncryptionMode: async () => 'plain' }, now: () => Date.now() });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  let admitted: Awaited<ReturnType<typeof admitRequesterSessionBootstrap>> = null;
  const registry = new ConnectedServiceRuntimeRegistry();
  const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
  try {
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: aliceToken, encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: bobToken } },
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    runtime = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    if (surface === 'run_custody') {
      const exactRuntime = runtime;
      const registration = { runKey: 'cold-bob-run', runnerPid: process.pid, agentId: 'codex' as const,
        materializationKey: 'cold-bob-run', connectedServicesBindingsRaw: {}, connectedServiceSelectionsEnv: {}, sessionId: 'cold-bob' };
      const input = { registry, registration,
        withSessionAccountContext: async <T>(_sessionId: string | null, operation: (context: typeof exactRuntime | null) => Promise<T>) => await operation(exactRuntime),
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      const before = get.mock.calls.length;
      await registerExecutionRunConnectedServicesTarget(input);
      expect(get.mock.calls.slice(before).filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(0);
      expect(registry.getRunTargetByRunKey('cold-bob-run')?.requesterWorkAttributionV1).toEqual(exactRuntime.bootstrap.attribution);
      expect(runtime.connectedServiceRuntimeRegistry?.getRunTargetByRunKey('cold-bob-run')?.sessionId).toBe('cold-bob');
      current = false;
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'admitted-bob-run', materializationKey: 'admitted-bob-run' } })).resolves.toBeUndefined();
      expect(registry.getRunTargetByRunKey('admitted-bob-run')?.requesterWorkAttributionV1).toEqual(exactRuntime.bootstrap.attribution);
      expect(await admitRequesterSessionBootstrap({
        bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: bobToken } },
        boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
        context: { signal: new AbortController().signal,
          machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice', machineId: 'machine',
            installationId: runtime.bootstrap.attribution.installationId, role: 'use', encryptionMode: 'plain' },
          verifyMachineAdmissionCurrent: async () => current },
      })).toBeNull();
      expect(registry.unregisterRunKey('admitted-bob-run')?.materializationKey).toBe('admitted-bob-run');
      expect(registry.unregisterRunKey('cold-bob-run')?.materializationKey).toBe('cold-bob-run');
      expect(registry.getRunTargetByRunKey('cold-bob-run')).toBeNull();
      await runtime.dispose();
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'disposed-bob-run', materializationKey: 'disposed-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('disposed-bob-run')).toBeNull();
      return;
    }
    if (surface === 'generation') {
      const exactRuntime = runtime;
      const input = { token: aliceToken, sessionId: 'bob-session',
        withSessionAccountContext: async <T>(_sessionId: string | null, operation: (context: typeof exactRuntime | null) => Promise<T>) => await operation(exactRuntime),
        assertSessionAccountCurrent: async () => { if (!await exactRuntime.isCurrent()) throw new Error('requester_session_not_current'); } };
      const before = get.mock.calls.length;
      const projection = await fetchConnectedServiceProjectionForSession(input);
      // Only the requested projection reads Home; the authority assertions
      // consume the existing live observation instead of fetching it again.
      expect(get.mock.calls.slice(before).filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(1);
      expect(projection.snapshot.groups).toEqual([{ serviceId: 'happier.agent.codex/openai-codex', groupId: 'main', activeProfileId: 'work', generation: 2 }]);
      expect(projection.requester).toBe(true);
      const bobProfileUrls = new Set(get.mock.calls.filter(([url, config]) => String(url).endsWith('/profile')
        && config?.headers?.Authorization === `Bearer ${bobToken}`).map(([url]) => url));
      expect([...bobProfileUrls]).toEqual(['https://bob-home.test/v1/account/profile']);
      current = false;
      get.mockRejectedValueOnce(new axios.AxiosError('Requester Home refused', 'ERR_BAD_REQUEST'));
      await expect(fetchConnectedServiceProjectionForSession(input)).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
      const owned = await runWithServerHttpBaseUrl('https://alice-home.test', () => fetchConnectedServiceProjectionForSession({ token: aliceToken }));
      expect(owned.snapshot.groups[0]?.generation).toBe(1);
      expect(owned.requester).toBe(false);
      return;
    }
    const recordKey = { providerId: 'codex', accountSubjectId: 'provider-bob', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot: ProviderAccountUsageSnapshotV1 = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: 'provider-bob' }, observedAtMs: 1_000,
      fetchedAtMs: 1_000, staleAfterMs: 300_000, source: 'runtimeSignal', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    const targets = [{ source: { ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' },
      bindingKind: 'account' as const }, expectedCredentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', expectedConfigurationRevision: 'cfg-current' }];
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot(snapshot, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    if (surface === 'reconnect') {
      // Keep failed work in canonical backoff while transport is down; reconnect
      // explicitly flushes the same retained payload without waiting for its timer.
      await runtime.providerAccountUsagePersistence.flush(1_000);
      expect(writes).toEqual([]);
      bobUnavailable = false;
      const exactRuntime = runtime;
      const reconnect = () => flushProviderAccountUsagePersistenceForTrackedSessions({ ownedScheduler: alice,
        trackedSessions: [{ happySessionId: 'bob-session' }, { happySessionId: 'bob-session' }],
        withSessionAccountContext: async (_sessionId, operation) => await operation(exactRuntime), timeoutMs: 1_000 });
      await runWithServerHttpBaseUrl('https://alice-home.test', reconnect);
      expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: `Bearer ${bobToken}`,
        data: expect.objectContaining({ snapshot }) }]);
      current = false;
      await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
      await runtime.providerAccountUsagePersistence.flush(1_000);
      await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
        await alice.recordInBandSnapshot(snapshot, { targets });
        await reconnect();
      });
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: `Bearer ${aliceToken}`,
        data: expect.objectContaining({ snapshot }) });
      return;
    }
    expect(writes).toEqual([{ url: 'https://bob-home.test/v4/connect/qualified/provider-account-usage', token: `Bearer ${bobToken}`,
      data: expect.objectContaining({ source: targets[0].source, snapshot, payloadMode: 'plain_json_v1' }) }]);
    current = false;
    await runtime.providerAccountUsagePersistence.recordInBandSnapshot({ ...snapshot, fetchedAtMs: 2_000 }, { targets });
    await runtime.providerAccountUsagePersistence.flush(1_000);
    expect(writes).toHaveLength(1);
    await runWithServerHttpBaseUrl('https://alice-home.test', async () => {
      await alice.recordInBandSnapshot(snapshot, { targets });
      await alice.flush(1_000);
    });
    expect(writes[1]).toEqual({ url: 'https://alice-home.test/v4/connect/qualified/provider-account-usage', token: `Bearer ${aliceToken}`,
      data: expect.objectContaining({ snapshot }) });
  } finally {
    try {
      try { await runtime?.dispose(); } finally { await admitted?.cleanupOnFailure(); }
    } finally {
      try {
        await host?.dispose();
      } finally {
        alice.dispose(); get.mockRestore(); post.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});


it.each(['retired', 'pending_release', 'concurrent_resume'] as const)('keeps requester runtime %s under its canonical authority', async surface => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-runtime-'));
  let onProjectionRead: (() => void) | undefined;
  // HTTP admission/profile/settings is the boundary; all Account owners and runtime composition are real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/profile')) onProjectionRead?.();
    return { status: 200,
    data: url.endsWith('/v2/sessions/bob-session') ? { session: createSessionRecordFixture({
      id: 'bob-session', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
    }) } : url.endsWith('/profile') ? { id: 'bob' } : url.endsWith('/currentness')
      ? { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
    };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | null = null;
  let admitted: Awaited<ReturnType<typeof admitRequesterSessionBootstrap>> = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<SessionTrackingKey, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: { token: accountToken('alice'), encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: accountToken('bob') } },
      existingSessionId: 'bob-session',
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => true } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => true);
    const runtimeInput: Parameters<typeof createRequesterSessionRuntimeContext>[0] = { providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        trackedSessionsByKey: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } };
    runtime = await createRequesterSessionRuntimeContext(runtimeInput);
    if (!runtime) throw new Error('Missing real requester runtime');
    expect(await runtime.bootstrap.isCurrent()).toBe(true);
    if (surface === 'concurrent_resume') {
      const resumed = runtime;
      const captured = await createRequesterSessionRuntimeContext({ ...runtimeInput, bootstrapOwnership: 'borrowed' });
      if (!captured) throw new Error('Missing cold requester context');
      expect(captured).not.toBe(resumed);
      onProjectionRead = () => trackedSessions.set(legacyPidSessionTrackingKey(process.pid), { trackingKey: legacyPidSessionTrackingKey(process.pid), pid: process.pid, startedBy: 'daemon', happySessionId: 'bob-session',
        requesterSessionRuntimeContext: resumed, requesterWorkAttributionV1: resumed.bootstrap.attribution });
      try {
        // The native resume publishes its runner while the cold operation's
        // already-admitted profile read is in flight. Both retain Bob custody.
        const before = get.mock.calls.length;
        await expect(fetchConnectedServiceProjectionForSession({ token: accountToken('alice'), sessionId: 'bob-session',
          withSessionAccountContext: async (_sessionId, operation) => await operation(captured),
          assertSessionAccountCurrent: async () => await assertRequesterSessionAccountContextCurrent({ expected: captured,
            resolveCurrent: async () => resumed,
            readTrackedContext: () => trackedSessions.get(legacyPidSessionTrackingKey(process.pid))?.requesterSessionRuntimeContext ?? null }),
        })).resolves.toMatchObject({ requester: true });
        const reads = get.mock.calls.slice(before).filter(([url]) => String(url).endsWith('/profile'));
        expect(reads).toHaveLength(1);
        expect(reads[0]).toMatchObject(['https://bob-home.test/v1/account/profile', {
          headers: { Authorization: `Bearer ${accountToken('bob')}` },
        }]);
        expect(await resumed.isCurrent()).toBe(true);
      } finally {
        onProjectionRead = undefined;
        await releaseUnretainedRequesterSessionRuntimeContext(captured, [resumed]);
      }
      expect(await captured.isCurrent()).toBe(false);
      await expect(assertRequesterSessionAccountContextCurrent({ expected: captured,
        resolveCurrent: async () => resumed, readTrackedContext: () => resumed })).rejects.toThrow('requester_session_not_current');
      expect(await resumed.isCurrent()).toBe(true);
      return;
    }
    if (surface === 'pending_release') {
      const captured = runtime;
      const emitted: string[] = [];
      const ports = createPendingResetStartRecoveryPorts({ credentials: { token: accountToken('alice'), encryption: null }, machineId: 'machine',
        isCurrent: () => true, resolveRequesterSessionRuntimeContext: async () => captured,
        releaseRequesterSessionRuntimeContext: context => context.dispose(),
        // Installed Machine transport is the boundary; the scoped requester adapter remains real.
        release: async demand => { emitted.push(demand.localId); }, onError: error => { throw error; } });
      await ports.withSession('bob-session', async session => {
        // The finite wake is admitted. Its Machine effect must not reacquire
        // Home authority; the release owner still checks the exact Pending CAS.
        const profileReads = get.mock.calls.filter(([url]) => String(url).endsWith('/profile')).length;
        await session.release({ localId: 'pending', reset: {
          source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' },
          recordId: buildProviderAccountUsageRecordId({ providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' }),
          meterId: 'window', witness: { id: 'history', observedAtMs: 500 },
        } });
        expect(get.mock.calls.filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(profileReads);
      });
      expect(emitted).toEqual(['pending']);
      expect(await captured.isCurrent()).toBe(false);
      return;
    }
    const profileReads = get.mock.calls.filter(([url]) => String(url).endsWith('/profile')).length;
    expect(await runtime.isCurrent()).toBe(true);
    expect(get.mock.calls.filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(profileReads);
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    expect(await runtime.isCurrent()).toBe(false);
    expect(await admitted.admitted.isCurrent()).toBe(false);
    expect(channel.clients.every(client => !client.connected)).toBe(true);
    const before = get.mock.calls.length;
    await expect(assertRequesterSessionAccountContextCurrent({ expected: runtime,
      resolveCurrent: async () => runtime, readTrackedContext: () => runtime })).rejects.toThrow('requester_session_not_current');
    await expect(runtime.qualifiedConnectedAccountApi.listAccounts({ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }))
      .rejects.toMatchObject({ code: 'requester_account_context_unavailable' });
    expect(await runtime.refreshAccountSettings()).toBe(false);
    let refusal: unknown;
    try { runtime.readAccountSettingsSnapshot(); } catch (error) { refusal = error; }
    expect(AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: false,
      error: projectRunnerDaemonPluginServicesFailure(refusal) })).toMatchObject({ ok: false, error: {
        code: 'requester_account_context_unavailable',
        cause: { code: 'requester_account_context_unavailable', stage: 'dispatch' },
      } });
    expect(get.mock.calls.length).toBe(before);
  } finally {
    try {
      try { await runtime?.dispose(); } finally { await admitted?.cleanupOnFailure(); }
    } finally {
      try {
        await host?.dispose();
      } finally {
        get.mockRestore(); await rm(directory, { recursive: true, force: true });
      }
    }
  }
});
