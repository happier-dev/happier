import { createProviderAccountUsageStore } from '../connectedServices/accountUsage/store';
import axios from 'axios';
import fastify from 'fastify';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildProviderAccountUsageRecordId, FeaturesResponseSchema, QualifiedConnectedAccountCredentialSnapshotV4Schema,
  QualifiedConnectedAccountListResponseV4Schema, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProviderAccountUsagePersistenceScheduler, flushProviderAccountUsagePersistenceForTrackedSessions } from '../connectedServices/accountUsage/persistence';
import { fetchConnectedServiceProjectionForSession } from '../connectedServices/accountGroups/generation/connectedServiceProjectionSnapshot';
import { registerExecutionRunConnectedServicesTarget } from '../connectedServices/runs/executionRunMaterialization';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { admitRequesterSessionBootstrap, assertRequesterSessionAccountContextCurrent, createRequesterSessionCredentialCustody, createRequesterSessionRuntimeContextResolver, listRequesterSessionCredentialBindings } from './requesterSessionCredentials';
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
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
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
import { buildSessionFollowChangeHintV1 } from '@happier-dev/protocol/sessions/follow/changes';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import { DELIVERY_MUTE_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { retainExecutionRunState } from '../executionRunRegistry';
import { readProcessIdentityByPid } from '../processIdentity';
import { hashProcessCommand } from '../sessionRegistry';
import { pluginReloadController as runPluginRuntimeController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { logger as fileLogger } from '@/utils/logger';
import { readRequesterHomeWithinActionLifetime } from './requesterCurrentness';

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
  const token = accountToken('installed');
  const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
  const tracked: TrackedSession = { pid: process.pid, startedBy: 'daemon', happySessionId: sessionId,
    spawnOptions: { directory } };
  const control: { routes?: Parameters<typeof controlServer.startDaemonControlServer>[0] } = {};
  const listening = vi.spyOn(controlServer, 'startDaemonControlServer').mockImplementation(async routes => {
    control.routes = routes;
    return { port: 43127, stop: async () => {} };
  });
  const reads: string[] = [];
  const writes: string[] = [];
  const policy = { preset: 'everything' as const };
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
    if (path === `/v2/sessions/${sessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
      id: sessionId, ownerAccountId: 'installed', encryptionMode: 'plain', active: true, archivedAt: null,
      origin: { kind: 'none' }, metadata: JSON.stringify({ machineId: 'machine', path: '/repo' }),
      dataEncryptionKey: null, share: null,
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
      trackedSessions: new Map([[tracked.pid, tracked]]), getRequester: () => null,
      getApiMachineForSessions: () => machine.current, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: serverId }) },
      beforeStartup: async () => {
        await writeStoredCredentialsForServerId(serverId, credentials);
        await readOrCreateInstallationIdentity();
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
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
it.each(['usage-owner', 'refresh', 'settings-refresh-failure', 'startup-settings-recovery', 'startup-settings-cancel', 'startup-settings-forbidden', 'startup-settings-unbound', 'untracked-lifetime', 'profile-unavailable', 'action-policy', 'action-home-recovery', 'run-home-recovery', 'run-purpose-home-recovery', 'run-binding-home-recovery', 'authorization-observations', 'warm-account', 'currentness-phase', 'resolution-currentness', 'spawn-currentness', 'background-home-failure', 'startup-home-failure', 'refresh-observations', 'request-auth-observations', 'follow-wake', 'follow-rules', 'follow-source', 'follow-receiver', 'follow-pending', 'follow-idle-source'] as const)('keeps requester %s isolated from active Alice', async (surface) => {
  const actionPolicySurface = surface === 'action-policy' || surface === 'action-home-recovery' || surface === 'authorization-observations';
  const runSurface = surface === 'run-home-recovery' || surface === 'run-purpose-home-recovery' || surface === 'run-binding-home-recovery';
  const runPurposeSurface = surface === 'run-purpose-home-recovery' || surface === 'run-binding-home-recovery';
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
  let runHomeStatus: number | null = null;
  let holdAuthorizationProfile = false;
  const authorizationProfileGate: { release?: () => void } = {};
  const releaseAuthorizationProfile = () => authorizationProfileGate.release?.();
  let connectedCatalogReads = 0;
  let holdSettings = false;
  let failSettings = false;
  const settingsGate: { release?: () => void } = {};
  const releaseSettingsRead = () => settingsGate.release?.();
  let savedSettings: Record<string, unknown> = {};
  let sourceProject = surface === 'follow-pending' ? 'payments' : 'other';
  let freshFollowRule = false;
  let followAccountChanges: ChangeEntry[] = [];
  let followChangesReads = 0;
  let receiverEnabled = surface !== 'follow-idle-source';
  const requesterSessionId = surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' ? 'c123456789012345678901234' : 'bob-session';
  const followDestinationId = surface === 'follow-receiver' ? requesterSessionId : 'c222222222222222222222222';
  const followSourceId = surface === 'follow-receiver' ? 'c333333333333333333333333' : requesterSessionId;
  const requesterToken = accountToken('bob');
  const control: { routes?: Parameters<typeof controlServer.startDaemonControlServer>[0] } = {};
  // The loopback HTTP server is the boundary; retain the real startup Action factory.
  const controlBoundary = actionPolicySurface || runSurface || surface === 'follow-source' ? vi.spyOn(controlServer, 'startDaemonControlServer')
    .mockImplementation(async input => { control.routes = input; return { port: 43127, stop: async () => {} }; }) : null;
  const approvalIds: string[] = [];
  const artifactBoundary = actionPolicySurface ? vi.spyOn(axios, 'post').mockImplementation(async (url, data, config) => {
    const mintPath = bindExternalActionExecutionAuthorizationHttpPathV1('workflow.authoring.draft.discard');
    const verifyPath = bindExternalActionExecutionAuthorizationVerifyHttpPathV1('workflow.authoring.draft.discard');
    if (url === `https://bob-home.test${verifyPath}`) return { status: 200, data: { ok: true } };
    expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
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
    const id = typeof data === 'object' && data !== null && 'id' in data ? data.id : undefined;
    if (typeof id !== 'string') throw new Error('Missing Artifact identity');
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
      return { status: 200, data: { rules: [{ ruleId, version: freshFollowRule ? 0 : 1, receiver,
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
    if (surface === 'follow-receiver' && path === `/v2/sessions/${followSourceId}`) return { status: 200, data: { session: createSessionRecordFixture({
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
      if (runHomeStatus !== null) {
        const status = runHomeStatus;
        runHomeStatus = null;
        return { status, data: { error: 'home_unavailable' } };
      }
      if (failActionHomeRead) {
        failActionHomeRead = false;
        throw new axios.AxiosError('Requester Home read timed out', 'ECONNABORTED');
      }
      // The fixture substitutes admitted Machine access. The initial bound
      // requester proof reads one Profile; the next is preparation's own read.
      if (holdAuthorizationProfile && authorizationProfileReads === 2)
        await new Promise<void>(resolve => { authorizationProfileGate.release = resolve; });
      return { status: 200, data: { id: 'bob' } };
    }
    if (path === `/v2/sessions/${requesterSessionId}`) return { status: 200, data: { session: createSessionRecordFixture({
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
    if (path === '/v1/artifacts') return { status: 200, data: [] };
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
    if (path === '/v4/connect/qualified/accounts') return { status: 200, data: {
      service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accounts: [] } };
    return { status: 200, data: { content: { t: 'plain', v: savedSettings }, version: settingsVersion } };
  });
  let runtime: Awaited<ReturnType<typeof createRequesterSessionRuntimeContext>> = null;
  const followEnqueued: unknown[] = [];
  const followPost = surface === 'follow-source' || surface === 'follow-receiver' ? vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    expect(config?.headers?.Authorization).toBe(`Bearer ${requesterToken}`);
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/follows/occurrence-routes')) {
      if (surface === 'follow-receiver') { expect(body).toHaveProperty('destinationSessionId', requesterSessionId); expect(body).not.toHaveProperty('sourcePublisher'); }
      const original = body && typeof body === 'object' && 'sourceMessage' in body ? body.sourceMessage : null;
      const seq = original && typeof original === 'object' && 'seq' in original ? original.seq : null;
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
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    const trackedSessions = new Map<number, TrackedSession>();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', machineId: 'machine', custodianAccountId: 'alice',
      credentials: aliceCredentials, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions, getRequester: () => runtime, resolveQualifiedConnectedAccountV4Support: () => runPurposeSurface ? 'advertised' : 'indeterminate',
      ...(surface === 'resolution-currentness' ? { resolveRequesterSessionRuntimeContext: createRequesterSessionRuntimeContextResolver({
        trackedSessions, getCreateRuntime: () => null, recoverBootstrap: async () => null,
      }) } : {}),
      ...(actionPolicySurface || surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' ? { startup: { resolveCurrentMachineExecutionOriginContext: async () => {
        authorizationStartReads = sessionReads;
        authorizationProfileReads = 0;
        return { machineId: 'machine', serverIdentityId: 'bob-home' };
      } } } : {}) });
    const admitted = await admitRequesterSessionBootstrap({ bootstrap: { v: 1, disposition: 'ordinary_requester', credentials: { token: requesterToken } },
      ...(actionPolicySurface || runSurface || surface === 'refresh-observations' || surface === 'request-auth-observations' || surface === 'currentness-phase' || surface === 'resolution-currentness' || surface === 'spawn-currentness' || surface === 'follow-wake' || surface === 'follow-source' || surface === 'follow-receiver' || surface === 'follow-pending' || surface === 'follow-idle-source' ? { existingSessionId: requesterSessionId } : {}),
      boundary: { serverId: 'bob-home', serverHttpBaseUrl: 'https://bob-home.test', happyHomeDir: directory },
      context: { signal: new AbortController().signal, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'alice',
        machineId: 'machine', installationId: host.installation?.installationId ?? 'installation', role: 'use', encryptionMode: 'plain' },
      verifyMachineAdmissionCurrent: async () => current } });
    if (!admitted) throw new Error('Missing real requester admission');
    admitted.admitted.bindRuntimeMachineAdmissionCurrentness(async () => current);
    // Admission captures the real settings/cache lifetime after daemon startup.
    expect(admitted.admitted.accountSettingsContext.scopeKey).toBe(resolveAccountSettingsScopeKey(admitted.admitted.credentials));
    const sharedUsageStore = host.runtime.resolveProviderAccountUsageStore(admitted.admitted.attribution);
    const runtimeConstruction = createRequesterSessionRuntimeContext({ bootstrap: admitted.admitted,
      providerAccountUsageStore: sharedUsageStore,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => runPurposeSurface ? 'advertised' : 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          // Environment reads are the boundary after runtime resources start.
          get HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED() {
            if (surface === 'startup-home-failure') runHomeStatus = 503;
            return '0';
          }, HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (surface === 'startup-home-failure') {
      try {
        await expect(runtimeConstruction).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
        expect(await admitted.admitted.isCurrent()).toBe(false);
      } finally { await admitted.cleanupOnFailure(); }
      return;
    }
    runtime = await runtimeConstruction;
    if (!runtime) throw new Error('Missing real requester runtime');
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
    if (surface === 'spawn-currentness') {
      const requester = runtime;
      const spawn = () => executeSpawnSessionRequest({ options: {
        // Stop at real request validation, before any workspace or process effect.
        directory: '', requesterSessionBootstrap: admitted.admitted,
      }, requesterSessionRuntimeContext: requester, credentials: requester.bootstrap.credentials, api: requester.api,
        connectedServicesMaterializationBaseDir: directory,
        connectedServiceRefreshCoordinator: null, connectedServiceQuotasCoordinator: null,
        connectedServiceRuntimeRegistry: registry, pidToTrackedSession: trackedSessions,
        pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
        spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
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
        // One entry observation, one catalog preparation and one fresh
        // publication decision; Settings recovery shares entry's observation.
        expect(sessionReads - before).toBe(3);
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
      expect(await pending).toMatchObject({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE' });
      expect(requester.bootstrap.savedSecretOperationContext.readSnapshot()).toBeNull();
      return;
    }
    if (surface === 'resolution-currentness') {
      trackedSessions.set(process.pid, { pid: process.pid, happySessionId: requesterSessionId, startedBy: 'daemon',
        requesterSessionRuntimeContext: runtime, requesterWorkAttributionV1: runtime.bootstrap.attribution });
      const guard = host.runtime.connectedServicePredictiveSwitchGuard;
      if (!guard) throw new Error('Missing daemon predictive admission');
      const input = { sessionId: requesterSessionId, serviceId: 'openai-codex' as const,
        groupId: 'bob-group', activeProfileId: 'bob-subscription', reason: 'usage_limit' as const };
      const counts = () => ({ session: sessionReads, profile: authorizationProfileReads,
        currentness: get.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness')).length });
      const delta = (before: ReturnType<typeof counts>) => {
        const after = counts();
        return { session: after.session - before.session, profile: after.profile - before.profile,
          currentness: after.currentness - before.currentness };
      };
      // Entry and exit are separate decisions. Each resolution composes the
      // canonical tracked resolver with the daemon's optional-port validation.
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = counts();
        expect(await guard(input)).toEqual({ status: 'allow' });
        expect(delta(before)).toEqual({ session: 2, profile: 2, currentness: 2 });
      }
      const beforeRevocation = counts();
      const homeGet = get.getMockImplementation()!;
      let release: (() => void) | undefined;
      let entered: (() => void) | undefined;
      const requested = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      get.mockImplementation(async (...args) => {
        if (new URL(String(args[0])).pathname === `/v2/sessions/${requesterSessionId}`) {
          entered?.();
          await released;
        }
        return homeGet(...args);
      });
      try {
        const pending = guard(input);
        await requested;
        current = false;
        release?.();
        expect(await pending).toEqual({ status: 'suppress', reason: 'requester_session_not_current' });
        expect(delta(beforeRevocation)).toEqual({ session: 1, profile: 1, currentness: 1 });
        expect(runtime.bootstrap.savedSecretOperationContext.readSnapshot()).toBeNull();
      } finally { release?.(); get.mockImplementation(homeGet); }
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
      const oneQualification = { session: 1, profile: 1, currentness: 1 };
      // The warm Settings guards surrounding requester authority do not start
      // another remote qualification. Later calls still acquire fresh authority.
      for (let phase = 0; phase < 2; phase++) {
        const before = phaseCounts();
        expect(await requester.isCurrent()).toBe(true);
        expect(delta(before)).toEqual(oneQualification);
      }
      const homeGet = get.getMockImplementation()!;
      let release: (() => void) | undefined;
      let entered: (() => void) | undefined;
      let held = false;
      const holdSession = () => {
        held = true;
        const requested = new Promise<void>(resolve => { entered = resolve; });
        const released = new Promise<void>(resolve => { release = resolve; });
        get.mockImplementation(async (...args) => {
          if (held && new URL(String(args[0])).pathname === `/v2/sessions/${requesterSessionId}`) {
            entered?.();
            await released;
          }
          return homeGet(...args);
        });
        return requested;
      };
      try {
        const before = phaseCounts();
        const requested = holdSession();
        const cancelled = new AbortController();
        const first = requester.isCurrent(cancelled.signal);
        const survivor = requester.isCurrent();
        await requested;
        cancelled.abort();
        expect(await first).toBe(false);
        expect(requester.readAccountSettingsSnapshot()).not.toBeNull();
        held = false; release?.();
        expect(await survivor).toBe(true);
        expect(delta(before)).toEqual(oneQualification);

        const beforeEffect = phaseCounts();
        const effectRequested = holdSession();
        const effectAdmission = requester.isCurrent();
        await effectRequested;
        current = false;
        held = false; release?.();
        expect(await effectAdmission).toBe(false);
        expect(delta(beforeEffect)).toEqual(oneQualification);
        expect(admitted.admitted.savedSecretOperationContext.readSnapshot()).toBeNull();
        expect(await requester.isCurrent()).toBe(false);
      } finally { held = false; release?.(); get.mockImplementation(homeGet); }
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
        await channel.hintAccountChange();
        await vi.waitFor(() => expect(followChangesReads).toBeGreaterThan(before));
        // The loopback event is acknowledged and the synchronous HTTP boundary
        // has drained its microtasks before checking for forbidden fresh reads.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(sessionReads).toBe(warmSessionReads);
      }
      expect(reconciled).toEqual([]);
      // A receiver's own progress/turn invalidation recovers configured
      // manager/explicit Follow sources even without a matching private rule.
      followAccountChanges.push({ cursor: 6, kind: 'session', entityId: requesterSessionId, changedAt: 6, hint: null });
      await channel.hintAccountChange();
      await vi.waitFor(() => expect(reconciled).toEqual([null]));
      receiverEnabled = true;
      followAccountChanges.push({ cursor: 7, kind: 'account', entityId: 'bob', changedAt: 7,
        hint: buildSessionFollowChangeHintV1() });
      followAccountChanges.push({ cursor: 8, kind: 'session', entityId: 'new-source', changedAt: 8, hint: null });
      await channel.hintAccountChange();
      await vi.waitFor(() => expect(reconciled).toContain('new-source'));
      expect(sessionReads).toBeGreaterThan(warmSessionReads);
      const admittedReconciliations = reconciled.length;
      current = false;
      followAccountChanges.push({ cursor: 9, kind: 'session', entityId: 'revoked-source', changedAt: 9, hint: null });
      await channel.hintAccountChange();
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
              connectedServiceRuntimeRegistry: registry, pidToTrackedSession: trackedSessions,
              pidToAwaiter: new Map(), pidToSpawnResultResolver: new Map(), pidToSpawnWebhookTimeout: new Map(),
              spawnResourceCleanupByPid: new Map(), sessionAttachCleanupByPid: new Map(),
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
          expect(await settled).toMatchObject({ error: { code: 'project_requester_home_unavailable', retryable: true } });
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
      // Coordinator inventory reads carry cancellation, not an accepted Action
      // lifetime. A Home failure must reach the existing coordinator backoff.
      const signal = new AbortController().signal;
      const beforeRead = authorizationProfileReads;
      const snapshot = runtime.readAccountSettingsSnapshot();
      runHomeStatus = 503;
      await expect(runtime.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, signal,
      })).rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
      expect(authorizationProfileReads - beforeRead).toBe(1);
      expect(snapshot).not.toBeNull();
      expect(runtime.readAccountSettingsSnapshot()).toBe(snapshot);
      runHomeStatus = 503;
      await expect(runtime.bootstrap.isCurrent(signal))
        .rejects.toMatchObject({ response: { status: 503 } });
      // Explicit accepted preparation still uses its incumbent recovery owner.
      runHomeStatus = 503;
      expect(await readRequesterHomeWithinActionLifetime(() => runtime!.isCurrent(signal), signal)).toBe(true);
      expect(await runtime.qualifiedConnectedAccountApi.listAccounts({
        service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, signal,
      })).toMatchObject({ accounts: [] });
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
      trackedSessions.set(process.pid, { pid: process.pid, happySessionId: requesterSessionId, startedBy: 'daemon',
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
          .rejects.toMatchObject({ code: 'project_requester_home_unavailable', retryable: true });
      }
      runHomeStatus = 503;
      await expect(readRequesterHomeWithinActionLifetime(
        () => resolveRequester(requesterSessionId, runtime!.bootstrap.attribution, signal), signal)).resolves.toBe(runtime);
      runHomeStatus = surface === 'run-home-recovery' ? 503 : null;
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
          readTrackedContext: () => trackedSessions.get(process.pid)?.requesterSessionRuntimeContext ?? null,
        }),
      });
      runHomeStatus = 503;
      await expect(register(signal)).resolves.toBeUndefined();
      expect(registry.getRunTargetByRunKey(registration.runKey)?.requesterWorkAttributionV1).toEqual(runtime.bootstrap.attribution);
      expect(registrations).toBe(1);
      releaseRegistrationObservation();
      registry.unregisterRunKey(registration.runKey);
      runHomeStatus = 403;
      const beforeRefusal = authorizationProfileReads;
      expect(await runtime.isCurrent(signal)).toBe(false);
      expect(authorizationProfileReads - beforeRefusal).toBe(1);
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
      expect(followEnqueued).toEqual(['moved-out-original', 'moved-in-original'].map((localId, index) => expect.objectContaining({
        followSources: [expect.objectContaining({ rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } })],
        followDeliveryV1: { v: 1, original: { sourceSessionId: followSourceId,
          sourceMessage: { localId, seq: index + 1 } }, event: { kind: 'failed_or_stopped' }, delivery: 'wake' },
      })));
      expect(followEnqueued[1]).toMatchObject({ followSources: [{ rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } }],
        followRelations: [{ relation: 'follower' }, { relation: 'manager', attachedAt: 10 }],
        followDeliveryV1: { original: { sourceSessionId: followSourceId, sourceMessage: { localId: 'moved-in-original', seq: 2 } }, delivery: 'wake' } });
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
      expect(await runtime.sessionFollowRuleCache.read()).toMatchObject({ status: 'unavailable' });
      return;
    }
    if (surface === 'follow-wake' || surface === 'follow-pending') {
      if (!host) throw new Error('Missing requester control host');
      const requester = runtime;
      const installationId = host.installation?.installationId;
      if (!installationId) throw new Error('Missing real installation');
      const custody = await createRequesterSessionCredentialCustody({ happyHomeDir: directory, sessionId: requesterSessionId,
        attribution: requester.bootstrap.attribution, credentials: requester.bootstrap.credentials });
      const homeGet = get.getMockImplementation()!;
      const requests: string[] = [];
      type MachineClient = NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>;
      let changedSession: Parameters<MachineClient['onSessionChanged']>[0] | undefined;
      let activatePending: Parameters<MachineClient['onPendingSessionActivationHint']>[0] | undefined;
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
        registerLiveStreamRelayRoutes: vi.fn(), connect: vi.fn(),
        updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
        onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => { changedSession = undefined; }; },
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
          expect(sessionId).toBe(requesterSessionId); expect(attribution).toEqual(requester.bootstrap.attribution); return requester;
        }, releaseRequesterSessionRuntimeContext: async context => { expect(context).toBe(requester); },
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
      http.addHook('onRequest', async request => { requests.push(request.url); expect(request.headers.authorization).toBe(`Bearer ${requesterToken}`); });
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
          id: 'bob-follow-source', encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'machine', path: '/repo', projectId: sourceProject }),
          dataEncryptionKey: null, share: null, ownerAccountId: 'bob', origin: { kind: 'none' }, seq: sourceTranscriptSeq,
          agentStateVersion: sourceAgentStateVersion, agentState: JSON.stringify({ requests: sourceRequests, completedRequests: {} }),
          latestTurnId: surface === 'follow-pending' ? null : 'failed-turn', latestTurnStatus: surface === 'follow-pending' ? null : 'failed' }) };
        if (request.url.startsWith('/v1/sessions/bob-follow-source/messages')) return { messages: [{
          id: 'source-message', seq: 1, localId: 'source-failed-original', createdAt: 1, updatedAt: 1, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'failed-turn' } }) },
        }, ...(sourceTranscriptSeq >= 2 ? [{ id: 'source-next-message', seq: 2, localId: 'encountered-rule-original', createdAt: 2,
          updatedAt: 2, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'next-failed-turn' } }) } }] : []),
        ...(sourceTranscriptSeq === 3 ? [{ id: 'fresh-source-message', seq: 3, localId: 'fresh-rule-original', createdAt: 30,
          updatedAt: 30, sidechainId: null, messageRole: 'agent',
          content: { t: 'plain', v: buildAcpAgentMessageEnvelope({ provider: 'claude', body: { type: 'turn_failed', id: 'fresh-failed-turn' } }) } }] : [])]
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
      http.post(`/v2/sessions/${requesterSessionId}/follows/inactive-observations`, async () => SessionFollowObserveInactiveResponseV1Schema.parse({
        ok: true, v: 1, sessionId: requesterSessionId, target: { homeId: 'srv_bob_home', accountId: 'bob', sessionId: requesterSessionId,
          machineId: 'machine', installationId }, currentSourceSessionIds: ['bob-follow-source'], observations: sourceObservations }));
      const acceptedOriginals: unknown[] = [];
      http.post('/v2/sessions/bob-follow-source/follows/occurrence-routes', async request => {
        expect(request.body).toMatchObject({ destinationSessionId: requesterSessionId });
        if (request.body && typeof request.body === 'object' && 'sourceRequests' in request.body) {
          expect(request.body).toMatchObject({ sourceRequests: { agentStateVersion: sourceAgentStateVersion } });
        } else expect(request.body).toMatchObject({ sourceMessage: sourceTranscriptSeq === 3 ? { localId: 'fresh-rule-original', seq: 3 }
          : sourceTranscriptSeq === 2 ? { localId: 'encountered-rule-original', seq: 2 } : { localId: 'source-failed-original', seq: 1 } });
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
      let followPluginRuntime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
      try {
        if (!changedSession) throw new Error('Missing exact Session subscription');
        expect(readInstallationIdentityIfExistsSync()?.installationId).toBe(installationId);
        expect(await requester.isCurrent()).toBe(true);
        expect(await resolveOrigin()).toEqual({ machineId: 'machine', serverIdentityId: 'srv_bob_home' });
        expect(await resolveAmbientOrigin()).toEqual({ machineId: 'machine', serverIdentityId: 'srv_alice_home' });
        const activeAlice = getActiveAccountSettingsSnapshot();
        const originBeforeWake = originReads.length;
        await changedSession({ sessionId: requesterSessionId, cursor: 1 });
        if (surface === 'follow-wake') {
          expect(acceptedOriginals).toHaveLength(1);
          expect(launches).toEqual([]);
          openedRunPluginRuntime = true;
          followPluginRuntime = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
            controller: runPluginRuntimeController, runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
          if (!activatePending || !pendingRequestId) throw new Error('Missing committed Pending activation');
          await activatePending({ sessionId: requesterSessionId, requestId: pendingRequestId, pendingVersion: 1,
            requestedAt: 1, source: 'live', target: activationTarget });
        }
        if (surface === 'follow-pending') {
          expect(acceptedOriginals).toHaveLength(1);
          const inactivePath = `/v2/sessions/${requesterSessionId}/follows/inactive-observations`;
          const inactiveBeforeSource = requests.filter(path => path === inactivePath).length;
          const sourcesBefore = requests.filter(path => path === '/v2/sessions/bob-follow-source').length;
          sourceProject = 'other';
          followAccountChanges = [{ cursor: 1, kind: 'session', entityId: 'bob-follow-source', changedAt: 10 }];
          await channel.hintAccountChange();
          await vi.waitFor(() => expect(requests.filter(path => path === '/v2/sessions/bob-follow-source').length).toBeGreaterThan(sourcesBefore));
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(requests.filter(path => path === inactivePath)).toHaveLength(inactiveBeforeSource);
          // A later predicate match still reaches the same real requester/bootstrap intake.
          sourceProject = 'payments';
          followAccountChanges.push({ cursor: 2, kind: 'session', entityId: 'bob-follow-source', changedAt: 11 });
          await channel.hintAccountChange();
          await vi.waitFor(() => expect(requests.filter(path => path === inactivePath).length).toBeGreaterThan(inactiveBeforeSource));
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(acceptedOriginals[0]).toMatchObject({ followRelations: [{ relation: 'manager', attachedAt: 1 }, { relation: 'follower' }],
            followSources: [{ evaluation: 'receiver', rule: { ruleId: 'bob-private-rule', ruleVersion: 1 } }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source', sourceMessage: { localId: 'source-failed-original', seq: 1 } }, delivery: 'wake' } });
          sourceAgentStateVersion = 4;
          sourceRequests = { approvalA: { tool: 'Bash', arguments: {}, createdAt: 10, turnId: 'current-turn' } };
          for (const observation of sourceObservations) observation.observed.agentStateVersion = sourceAgentStateVersion;
          await changedSession({ sessionId: requesterSessionId, cursor: 2 });
          expect(acceptedOriginals).toHaveLength(2);
          sourceAgentStateVersion = 7;
          sourceRequests = { ...sourceRequests, approvalB: { tool: 'Bash', arguments: {}, createdAt: 20, turnId: 'current-turn' } };
          for (const observation of sourceObservations) observation.observed.agentStateVersion = sourceAgentStateVersion;
          await changedSession({ sessionId: requesterSessionId, cursor: 3 });
          expect(acceptedOriginals).toHaveLength(3);
          expect(acceptedOriginals.slice(1)).toMatchObject([
            { followDeliveryV1: { original: { sourceRequests: { requests: [{ requestId: 'approvalA', createdAt: 10, turnId: 'current-turn' }] } } } },
            { followDeliveryV1: { original: { sourceRequests: { requests: [{ requestId: 'approvalB', createdAt: 20, turnId: 'current-turn' }] } } } },
          ]);
          // An encountered rule's existing private cursor can drive catch-up
          // without an ordinary edge. It is not an initial-history baseline.
          sourceTranscriptSeq = 2;
          sourceObservations.splice(0);
          await changedSession({ sessionId: requesterSessionId, cursor: 4 });
          expect(acceptedOriginals).toHaveLength(4);
          expect(acceptedOriginals[3]).toMatchObject({ followSources: [{ evaluation: 'receiver' }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source',
              sourceMessage: { localId: 'encountered-rule-original', seq: 2 } } } });
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
          await channel.hintAccountChange();
          await vi.waitFor(() => expect(acceptedOriginals).toHaveLength(5));
          expect(acceptedOriginals[4]).toMatchObject({ followSources: [{ evaluation: 'receiver', rule: { ruleId: 'bob-fresh-rule', ruleVersion: 0 } }],
            followDeliveryV1: { original: { sourceSessionId: 'bob-follow-source', sourceMessage: { localId: 'fresh-rule-original', seq: 3 } } } });
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
        await changedSession({ sessionId: requesterSessionId, cursor: 2 });
        expect(launches).toEqual(expectedLaunches);
        homeIdentity = 'srv_bob_home';
        current = false;
        const beforeRetired = requests.length;
        await changedSession({ sessionId: requesterSessionId, cursor: 3 });
        // A fresh authority probe may discover retirement. It must not be
        // followed by private rules, source reads, input admission or wake.
        expect(requests.slice(beforeRetired).filter(path => path !== '/v1/account/encryption/currentness')).toEqual([]);
        expect(launches).toEqual(expectedLaunches);
      } finally {
        await followPluginRuntime?.dispose();
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
      try {
        // The actual requester, assertion and purpose owner run beneath HTTP.
        // An indeterminate service has no admitted binding and returns null
        // before credential reads. Entry and exit each need fresh admission;
        // later requests and the assertion-free adapter repeat those fences.
        for (const callback of [callbacks, callbackWithoutAssertion]) {
          for (let operation = 0; operation < 2; operation++) {
            const before = sessionReads;
            const beforeCatalog = connectedCatalogReads;
            await expect(callback.resolveCurrentBinding({ subject, binding,
              signal: new AbortController().signal })).resolves.toBeNull();
            expect(sessionReads - before).toBe(2);
            expect(connectedCatalogReads).toBe(beforeCatalog);
          }
        }
        current = false;
        for (const callback of [callbacks, callbackWithoutAssertion]) {
          await expect(callback.resolveCurrentBinding({ subject, binding,
            signal: new AbortController().signal })).rejects.toMatchObject({ code: 'request_auth_binding_unavailable',
              diagnostic: { causeCode: 'requester_session_not_current' } });
        }
      } finally { await lease.dispose(); }
      return;
    }
    if (surface === 'refresh-observations') {
      // Exercise the real HTTP client and Home routes; only Home responses
      // and admitted Machine access are substituted. Internal Profile paging,
      // Saved Secret custody and the bound requester verifier remain real.
      const homeGet = get.getMockImplementation()!;
      get.mockRestore();
      const http = fastify();
      http.get('/*', async (request, reply) => {
        const response = await homeGet(new URL(request.url, 'https://bob-home.test').href,
          { headers: { Authorization: request.headers.authorization } });
        if (!response || typeof response !== 'object' || !('status' in response) || typeof response.status !== 'number'
          || !('data' in response)) throw new Error('Invalid Home HTTP fixture response');
        return reply.code(response.status).send(response.data);
      });
      await http.ready();
      const restoreHttp = installAxiosFastifyAdapter({ app: http, origin: 'https://bob-home.test' });
      try {
        // Entry and publication are distinct authority checkpoints. Repeat
        // the operation to rule out retaining a settled observation.
        for (let operation = 0; operation < 2; operation++) {
          const before = sessionReads;
          expect(await runtime.refreshAccountSettings()).toBe(true);
          expect(sessionReads - before).toBe(2);
        }
        let notifications = 0;
        const unsubscribe = runtime.subscribeAccountSettingsSnapshot(() => { notifications++; });
        try {
          holdRows = true;
          const refreshing = runtime.refreshAccountSettings();
          await vi.waitFor(() => expect(releaseRows).toBeDefined());
          current = false;
          holdRows = false;
          releaseRows?.();
          expect(await refreshing).toBe(false);
          expect(notifications).toBe(0);
          expect(await runtime.isCurrent()).toBe(false);
          expect(await runtime.refreshAccountSettings()).toBe(false);
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
        // Separating Settings from admission must retain cancellation while
        // the distinct fresh authority read is outstanding.
        const admission = runtime.isCurrent(reader.signal);
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        reader.abort();
        expect(await Promise.race([admission.then(current => ({ current })),
          new Promise<'network-wait'>(resolve => setImmediate(() => resolve('network-wait')))]))
          .toEqual({ current: false });
        // The distinct authority guard still observes Machine access loss.
        release();
        current = false;
        expect(await admitted.admitted.isCurrent()).toBe(false);
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
        expect(await invoke('agent', lifetime.signal)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(failActionHomeRead).toBe(false);
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
            expect(await invoke('agent')).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(authorizationMintReads[attempt]).toBe(6);
          }
          for (const refusal of ['cancelled', 'revoked'] as const) {
            holdAuthorizationProfile = true;
            authorizationProfileGate.release = undefined;
            const cancellation = new AbortController();
            const preparing = invoke('agent', cancellation.signal);
            await vi.waitFor(() => expect(authorizationProfileGate.release).toBeDefined());
            if (refusal === 'cancelled') cancellation.abort();
            else current = false;
            releaseAuthorizationProfile();
            expect(await preparing).toMatchObject({ ok: false,
              errorCode: refusal === 'cancelled' ? 'cancelled' : 'target_unavailable' });
            expect(authorizationMintReads).toHaveLength(2);
            expect(approvalIds).toHaveLength(2);
          }
        } finally { releaseAuthorizationProfile(); restoreHttp(); await http.close(); }
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
        expect(await invoke(callerSurface)).toMatchObject({ ok: false, errorCode: 'present_user_required' });
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
    current = false;
    releaseRows?.();
    expect(await retiredRead).toBe(false);
    expect(getActiveAccountSettingsSnapshot()).toBe(alice);
  } finally {
    // A failed assertion must not inject its unconsumed Home fault into cleanup.
    runHomeStatus = null;
    releaseRows?.();
    settingsGate.release?.();
    try {
      await runtime?.dispose();
    } finally {
      try {
        await host?.dispose();
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
  const trackedSessions = new Map<number, TrackedSession>();
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
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
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
      expect(get.mock.calls.slice(before).filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(1);
      expect(registry.getRunTargetByRunKey('cold-bob-run')?.requesterWorkAttributionV1).toEqual(exactRuntime.bootstrap.attribution);
      expect(runtime.connectedServiceRuntimeRegistry?.getRunTargetByRunKey('cold-bob-run')?.sessionId).toBe('cold-bob');
      current = false;
      await expect(registerExecutionRunConnectedServicesTarget({ ...input, registration: { ...registration,
        runKey: 'retired-bob-run', materializationKey: 'retired-bob-run' } })).rejects.toThrow('requester_session_not_current');
      expect(registry.getRunTargetByRunKey('retired-bob-run')).toBeNull();
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
      // Two fresh assertion boundaries plus the actual projection read.
      expect(get.mock.calls.slice(before).filter(([url]) => String(url).endsWith('/profile'))).toHaveLength(3);
      expect(projection.snapshot.groups).toEqual([{ serviceId: 'happier.agent.codex/openai-codex', groupId: 'main', activeProfileId: 'work', generation: 2 }]);
      expect(projection.requester).toBe(true);
      const bobProfileUrls = new Set(get.mock.calls.filter(([url, config]) => String(url).endsWith('/profile')
        && config?.headers?.Authorization === `Bearer ${bobToken}`).map(([url]) => url));
      expect([...bobProfileUrls]).toEqual(['https://bob-home.test/v1/account/profile']);
      current = false;
      await expect(fetchConnectedServiceProjectionForSession(input)).rejects.toThrow('requester_session_not_current');
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
      // Flush the retained failure once while transport is still down; the canonical
      // retry owner then parks it until reconnect, rather than an incidental timer.
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


it.each(['retired', 'pending_release'] as const)('keeps requester runtime %s under its canonical authority', async surface => {
  const directory = await mkdtemp(join(tmpdir(), 'requester-runtime-'));
  let holdCurrentness = false;
  let enterCurrentness: (() => void) | undefined;
  let releaseCurrentness: (() => void) | undefined;
  let delayReleaseProbe = false;
  const currentnessEntered = new Promise<void>(resolve => { enterCurrentness = resolve; });
  // HTTP admission/profile/settings is the boundary; all Account owners and runtime composition are real.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (delayReleaseProbe && url.endsWith('/profile')) vi.setSystemTime(2_000);
    if (holdCurrentness && url.endsWith('/profile')) {
      enterCurrentness?.();
      await new Promise<void>(resolve => { releaseCurrentness = resolve; });
    }
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
    const trackedSessions = new Map<number, TrackedSession>();
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
    runtime = await createRequesterSessionRuntimeContext({ providerAccountUsageStore: createProviderAccountUsageStore(), bootstrap: admitted.admitted,
      activeServerDir: directory, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
        logger: { debug: () => {}, info: () => {}, warn: () => {} }, processEnv: {
          HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0', HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' },
        pidToTrackedSession: trackedSessions, connectedServiceRuntimeRegistry: registry,
        connectedServiceAuthGroupPreTurnSwitchCoordinator: host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator } });
    if (!runtime) throw new Error('Missing real requester runtime');
    expect(await runtime.bootstrap.isCurrent()).toBe(true);
    if (surface === 'pending_release') {
      const captured = runtime;
      const emittedAt: number[] = [];
      const ports = createPendingResetStartRecoveryPorts({ credentials: { token: accountToken('alice'), encryption: null }, machineId: 'machine',
        isCurrent: () => true, resolveRequesterSessionRuntimeContext: async () => captured,
        releaseRequesterSessionRuntimeContext: context => context.dispose(),
        // Installed Machine transport is the boundary; the scoped requester adapter remains real.
        release: async () => { emittedAt.push(Date.now()); }, onError: error => { throw error; } });
      vi.useFakeTimers(); vi.setSystemTime(1_000);
      await ports.withSession('bob-session', async session => {
        expect(await session.isCurrent()).toBe(true);
        // The caller's final authority check and readiness decision just settled.
        // A further HTTP probe would postpone the Machine effect beyond the window.
        delayReleaseProbe = true;
        await session.release({ localId: 'pending', reset: {
          source: { ref: { service: { pluginId: 'example', localId: 'service' }, accountId: 'account' }, bindingKind: 'account' },
          recordId: buildProviderAccountUsageRecordId({ providerId: 'test', accountSubjectId: 'account', subjectKind: 'account', quotaScope: 'account' }),
          meterId: 'window', witness: { id: 'history', observedAtMs: 500 },
        } });
      });
      expect(emittedAt).toEqual([1_000]);
      expect(await captured.isCurrent()).toBe(false);
      return;
    }
    holdCurrentness = true;
    const checking = runtime.isCurrent();
    await currentnessEntered;
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    holdCurrentness = false;
    releaseCurrentness?.();
    expect(await checking).toBe(false);
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
    releaseCurrentness?.();
    vi.useRealTimers();
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
