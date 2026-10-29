import fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { createApiSessionClientFixture, createSessionNotificationContextFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiMachineTransportFixture } from '@/testkit/apiMachineTransport';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { withConfiguredDaemonTestHome } from '../testkit/fakeDaemonLifecycle.testkit';
import { createRequesterSessionControlRuntimeFixture } from '../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../connectedServices/runtimeRegistry/registry';
import { createCliRegistryHostV1 } from '@/registries/createCliRegistryHost';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readInstallationIdentityIfExistsSync } from '../identity/store';
import { bootstrapMachineSyncRuntime, retireMachineSyncRuntimeAttempt, type BootstrapMachineSyncRuntimeParams } from './bootstrapMachineSyncRuntime';
import type { ApiMachineClient } from '@/api/apiMachine';
import { createSessionFollowContextReconciler } from '@/agent/runtime/session/follow/sessionFollowContextReconciler';
import { createSessionFollowSourceHydrator } from '@/agent/runtime/session/follow/sessionFollowSourceHydrator';
import { SessionFollowObservePendingResponseV1Schema, type SessionFollowSessionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { deriveSessionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

it('routes a source-only Account change through the installed private rule cache and exact receiver admission without an edge', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'follow-first-source-change-' }, async ({ homeDir }) => {
    const accountId = 'receiver-account';
    const channel = await createRequesterCurrentnessSocketHarness();
    const machineId = 'receiver-machine';
    const sourceSessionId = 'c111111111111111111111111';
    const destinationSessionId = 'c222222222222222222222222';
    const serverId = 'follow-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    const pending: unknown[] = [];
    const observed: string[] = [];
    const httpRequests: string[] = [];
    const runRouteReads: unknown[] = [];
    const runRouteQueries: Record<string, string>[] = [];
    const sourceTargetMachineId = 'source-machine-a';
    let publishTargetHint = true;
    const workflowIds = ['followed-workflow', 'unrelated-workflow'];
    const discussionId = 'followed-discussion';
    const runSource = { kind: 'execution_run', sessionId: sourceSessionId, runId: 'followed-session-run' };
    let followSessionRun = true;
    let runRoutesAvailable = false;
    const metadata = JSON.stringify({ path: homeDir, host: 'host', machineId });
    const source = createSessionRecordFixture({ id: sourceSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: 'foreign-source-owner', origin: { kind: 'none' }, seq: 2, archivedAt: null, active: true });
    const destination = { ...createSessionNotificationContextFixture(destinationSessionId), ...createSessionRecordFixture({ id: destinationSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: accountId, origin: { kind: 'none' }, archivedAt: null, active: true }) };
    const rule = { ruleId: 'new-rule', version: 0, receiver: { kind: 'session', sessionId: destinationSessionId },
      inception: { createdAt: 100, accountChangeCursor: 5 },
      content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }),
        policy: { preset: 'important' } } } };
    let accountRuleCreated = false;
    const app = fastify();
    app.addHook('onRequest', async request => {
      httpRequests.push(`${request.method} ${request.url}`);
      expect(request.headers.authorization).toBe(`Bearer ${credentials.token}`);
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
    app.get('/v2/account/session-follow-rules', async request => ({ rules: [rule,
      ...(accountRuleCreated ? [{ ...rule, ruleId: 'account-only-rule', receiver: { kind: 'account' } }] : [])],
      ...(new URL(request.url, origin).searchParams.has('destinationSessionId') ? { sourceRanges: { status: 'available', sources:
        new URL(request.url, origin).searchParams.has('sourceSessionId')
        && new URL(request.url, origin).searchParams.get('sourceSessionId') !== sourceSessionId ? [] : [{
        sourceSessionId, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: 1 }, throughSeq: 2,
      }] } } : {}) }));
    app.get('/v2/account/session-follow-preferences', async () => ({ assigned: false, direct: false, team: false, group: false }));
    app.get('/v2/sessions', async () => ({ sessions: [], hasNext: false, nextCursor: null }));
    app.get('/v2/account/session-follows', async () => ({ follows: [...workflowIds.map(runId => ({
      source: { kind: 'workflow_run', runId }, following: true, persistent: true, policy: { preset: 'important' },
    })), { source: { kind: 'discussion', discussionId }, following: true, persistent: true, policy: { preset: 'important' } },
    ...(followSessionRun ? [{ source: runSource, following: true, persistent: true, policy: { preset: 'important' } }] : [])] }));
    app.post('/v2/follows/sources/run-occurrence-routes', async (request, reply) => {
      runRouteReads.push(request.body);
      const query = Object.fromEntries(new URL(request.url, origin).searchParams);
      runRouteQueries.push(query);
      // This is a source owner read, not fabricated terminal evidence. The
      // real stored-source/Activity acceptance composition has separate coverage.
      if (runRoutesAvailable && (request.body as { source?: { runId?: string } }).source?.runId === runSource.runId) {
        return { ok: true, v: 1, original: { source: runSource, terminalEventId: 'settled-original' }, event: { kind: 'finished' },
          personal: { policy: { preset: 'important' }, alreadyRepresented: true }, routes: [{ destinationSessionId,
            relation: 'follower', attachedAt: 1, policy: { preset: 'important' }, expectedTerminalEventId: 'settled-original' }] };
      }
      return reply.code(409).send({ ok: false, v: 1, error: 'source_unavailable',
        ...(publishTargetHint && query.includeTargetMachineId === 'true'
          && (request.body as { source?: { kind?: string } }).source?.kind === 'execution_run'
          ? { targetMachineId: sourceTargetMachineId } : {}) });
    });
    app.get(`/v2/sessions/${sourceSessionId}`, async () => ({ session: source }));
    app.get(`/v2/sessions/${destinationSessionId}`, async () => ({ session: destination }));
    app.get(`/v2/sessions/${destinationSessionId}/delivery-mutes`, async () => ({ scopes: [] }));
    app.get(`/v1/sessions/${sourceSessionId}/messages`, async () => ({ messages: [{ id: 'new-original', localId: 'new-original', seq: 2,
      createdAt: 200, updatedAt: 200, sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
        content: { type: 'event', id: 'new-original', data: { type: 'worker-report', summary: 'New original' } } } } }], hasMore: false }));
    app.post('/v2/sessions/:sessionId/follows/inactive-observations', async request => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      observed.push(sessionId);
      return sessionId === destinationSessionId ? { ok: true, v: 1, sessionId, target: { homeId: serverId, accountId,
        sessionId, machineId, installationId: readInstallationIdentityIfExistsSync()!.installationId },
      currentSourceSessionIds: [], observations: [] } : { ok: false, v: 1, error: 'forbidden' };
    });
    app.post(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`, async () => ({ ok: true, v: 1,
      sourceSessionId, originalCreatedAt: 200, routes: [] }));
    app.post(`/v2/sessions/${destinationSessionId}/pending`, async request => { pending.push(request.body); return { didWrite: true }; });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    let changedSession: Parameters<ApiMachineClient['onSessionChanged']>[0] | undefined;
    const changedFollows = new Set<Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]>();
    let connectOptions: Parameters<ApiMachineClient['connect']>[0];
    // This is the Machine socket boundary; startup, the private cache, source
    // reader, destination admission and Pending producer all execute for real.
    const transport = { ...createApiMachineTransportFixture(),
      onSessionChanged: (listener: NonNullable<typeof changedSession>) => { changedSession = listener; return () => { changedSession = undefined; }; },
      onSessionFollowRulesChanged: (listener: Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]) => {
        changedFollows.add(listener); return () => { changedFollows.delete(listener); };
      },
      resolveInstalledAccountObservationRuntime: async () => ({ accountId, credentials, machineId, serverId,
        serverHttpBaseUrl: origin, isCurrent: async () => true }),
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(),
      connect: (options: typeof connectOptions) => { connectOptions = options; },
      registerMachineAccessLossReceiver: () => {}, registerLocalServicesRoutes: () => {}, registerSimulatorPreviewRoutes: () => {},
      updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
      emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
      sendMachineLiveStreamRelayEnvelope: vi.fn(),
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    const apiMachine = transport as unknown as ApiMachineClient;
    const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: homeDir, activeServerDir: homeDir, serverId,
      serverHttpBaseUrl: origin, machineId, custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(homeDir, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => apiMachine,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      beforeStartup: async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      },
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) } });
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    try {
      runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
        machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        requesterServerId: serverId, preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => apiMachine as NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => { throw new Error('A quiet Follow update must not spawn'); },
        spawnSession: async () => { throw new Error('A quiet Follow update must not spawn'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => true,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        dispatchSessionFollowOccurrence: host.runtime.dispatchSessionFollowOccurrence,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      });
      if (!changedSession) throw new Error('Missing Account Session observer');
      const beforeOriginal = httpRequests.length;
      await changedSession({ sessionId: sourceSessionId, cursor: 6 });
      expect(pending, JSON.stringify({ httpRequests, observed })).toHaveLength(1);
      expect(httpRequests.slice(beforeOriginal).filter(request => request.startsWith(`GET /v1/sessions/${sourceSessionId}/messages`))).toHaveLength(1);
      expect(httpRequests.slice(beforeOriginal).filter(request => request === `POST /v2/sessions/${sourceSessionId}/follows/occurrence-routes`)).toHaveLength(1);
      // Known-source discovery consumes its admitted range, not a broad read.
      expect(observed).toEqual([]);
      expect(pending[0]).toMatchObject({ followDeliveryV1: { original: { sourceSessionId, sourceMessage: { localId: 'new-original', seq: 2 } } },
        followSources: [{ evaluation: 'receiver', rule: { ruleId: 'new-rule', ruleVersion: 0 } }] });
      expect(pending[0]).not.toHaveProperty('followRelations');
      expect(runRouteReads).toEqual([{ v: 1, source: runSource }]);
      runRouteReads.length = 0;
      if (!changedFollows.size) throw new Error('Missing Account Follow observer');
      await Promise.all([...changedFollows].map(listener => listener({ full: false, workflowRunIds: [workflowIds[0]!] })));
      expect(runRouteReads).toEqual([{ v: 1, source: { kind: 'workflow_run', runId: workflowIds[0] } }]);
      runRouteReads.length = 0;
      await Promise.all([...changedFollows].map(listener => listener({ full: false, workflowRunIds: [], discussionIds: [discussionId] })));
      expect(runRouteReads).toEqual([{ v: 1, source: { kind: 'discussion', discussionId } }]);
      runRouteReads.length = 0;
      await connectOptions?.onConnect?.();
      expect(runRouteReads).toEqual([...workflowIds.map(runId => ({ v: 1, source: { kind: 'workflow_run', runId } })),
        { v: 1, source: { kind: 'discussion', discussionId } }, { v: 1, source: runSource }]);
      const listReads = () => httpRequests.filter(request => request.startsWith('GET /v2/account/session-follows')).length;
      const reconnectListReads = listReads();
      expect(reconnectListReads).toBe(2);
      runRouteReads.length = 0;
      for (let index = 0; index < 100; index++) await changedSession({ sessionId: `unrelated-${index}`, cursor: 7 + index });
      expect(listReads()).toBe(reconnectListReads);
      expect(runRouteReads).toEqual([]);
      const ruleReads = () => httpRequests.filter(request => request.startsWith('GET /v2/account/session-follow-rules')).length;
      const preferenceReads = () => httpRequests.filter(request => request.startsWith('GET /v2/account/session-follow-preferences')).length;
      const beforeTitlesRules = ruleReads();
      const beforeTitlesPreferences = preferenceReads();
      const beforeTitlesVersion = source.metadataVersion ?? 0;
      const beforeTitlesAllGets = httpRequests.filter(request => request.startsWith('GET ')).length;
      // Construct the canonical title publication at the HTTP/Machine-feed
      // boundary. Unlike the separate loaded QA, this isolates one warm source
      // from unrelated Sessions and accepted-progress publications.
      for (let index = 0; index < 100; index++) {
        source.metadata = JSON.stringify(applyDisplayTitleSessionMetadata({ path: homeDir, host: 'host', machineId },
          { title: `Ordinary title ${index}`, updatedAt: 1000 + index }));
        source.metadataVersion = beforeTitlesVersion + index + 1;
        await changedSession({ sessionId: sourceSessionId, cursor: 107 + index, followSourceChanged: false,
          followReceiverAvailabilityChanged: false });
      }
      expect(source.metadataVersion).toBe(beforeTitlesVersion + 100);
      expect(source.seq).toBe(2);
      expect(ruleReads()).toBe(beforeTitlesRules);
      expect(preferenceReads()).toBe(beforeTitlesPreferences);
      expect(listReads()).toBe(reconnectListReads);
      expect(runRouteReads).toEqual([]);
      expect(httpRequests.filter(request => request.startsWith('GET ')).length - beforeTitlesAllGets,
        'the installed title-arrival phase adds no GETs').toBe(0);
      const receiverChangeStart = httpRequests.length;
      await changedSession({ sessionId: destinationSessionId, cursor: 207, followReceiverAvailabilityChanged: false });
      expect(observed, 'an unrelated receiver Session write is not availability').toEqual([]);
      expect(httpRequests.slice(receiverChangeStart).filter(request => request.includes('/occurrence-routes'))).toEqual([]);
      for (let index = 0; index < 100; index++) await host.runtime.dispatchSessionFollowOccurrence({ sourceSessionIdChanged: sourceSessionId });
      expect(runRouteReads).toEqual([]);
      // Existing user-scoped push, not an ordinary parent Session change:
      // the publisher has produced this exact Run's frontier.
      await vi.waitFor(() => expect(channel.server.sockets.sockets.size).toBe(1));
      channel.server.emit('ephemeral', { type: 'execution-run-updated', sessionId: sourceSessionId, run: {
        runId: runSource.runId, callId: 'call', sidechainId: 'call', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1,
      } });
      await vi.waitFor(() => expect(runRouteReads).toEqual([{ v: 1, source: runSource }]));
      runRouteReads.length = 0;
      const beforeSettingsRules = ruleReads();
      const beforeSettingsPreferences = preferenceReads();
      setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 2,
        loadedAtMs: 2, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
      await host.runtime.dispatchSessionFollowOccurrence({ sourceSessionIdChanged: sourceSessionId });
      expect(ruleReads()).toBe(beforeSettingsRules);
      expect(preferenceReads()).toBe(beforeSettingsPreferences);
      expect(runRouteReads).toEqual([]);
      for (let index = 0; index < 100; index++) await host.runtime.dispatchSessionFollowOccurrence({ sourceSessionIdChanged: sourceSessionId });
      expect(runRouteReads).toEqual([]);
      runRouteReads.length = 0;
      for (let index = 0; index < 100; index++) channel.server.emit('ephemeral', {
        type: 'machine-activity', id: 'source-machine', active: true, activeAt: index,
      });
      await channel.pushProfile(accountId);
      expect(runRouteReads).toEqual([]);
      channel.server.emit('ephemeral', { type: 'machine-activity', id: 'machine-b', active: true, activeAt: 101, reconnected: true });
      await channel.pushProfile(accountId);
      await host.runtime.dispatchSessionFollowOccurrence({ sourceSessionIdChanged: sourceSessionId });
      expect(runRouteReads, 'another Machine cannot release a held Session Run targeted at A').toEqual([]);
      channel.server.emit('ephemeral', { type: 'machine-activity', id: sourceTargetMachineId, active: true, activeAt: 102, reconnected: true });
      await vi.waitFor(() => expect(runRouteReads).toEqual([{ v: 1, source: runSource }]));
      expect(runRouteQueries.at(-1)).toEqual({ includeTargetMachineId: 'true', releaseReason: 'target_machine' });
      runRouteReads.length = 0;
      // A fieldless server refusal remains the supported legacy behavior. The
      // exact Run publication refreshes the held refusal, not its parent title.
      publishTargetHint = false;
      channel.server.emit('ephemeral', { type: 'execution-run-updated', sessionId: sourceSessionId, run: {
        runId: runSource.runId, callId: 'call', sidechainId: 'call', intent: 'review',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, permissionMode: 'read_only',
        retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', status: 'running', startedAtMs: 1,
      } });
      await vi.waitFor(() => expect(runRouteReads).toEqual([{ v: 1, source: runSource }]));
      expect(runRouteQueries.at(-1)).toEqual({ includeTargetMachineId: 'true', releaseReason: 'exact_run' });
      runRouteReads.length = 0;
      channel.server.emit('ephemeral', { type: 'machine-activity', id: 'machine-b', active: true, activeAt: 103, reconnected: true });
      await vi.waitFor(() => expect(runRouteReads).toEqual([{ v: 1, source: runSource }]));
      expect(runRouteQueries.at(-1)).toEqual({ includeTargetMachineId: 'true', releaseReason: 'legacy_broad' });
      runRouteReads.length = 0;
      const priorPending = pending.length;
      runRoutesAvailable = true;
      await channel.disconnect();
      await channel.reconnect();
      await vi.waitFor(() => {
        expect(runRouteReads).toHaveLength(2);
        expect(runRouteReads).toEqual(expect.arrayContaining([
          { v: 1, source: { kind: 'discussion', discussionId } }, { v: 1, source: runSource },
        ]));
      });
      expect(runRouteQueries.slice(-2)).toEqual(expect.arrayContaining([
        {}, { includeTargetMachineId: 'true', releaseReason: 'account_reconnect' },
      ]));
      // A personal-only recovery cannot promote the other returned routes.
      expect(pending).toHaveLength(priorPending);
      runRouteReads.length = 0;
      followSessionRun = false;
      await Promise.all([...changedFollows].map(listener => listener({ full: true, workflowRunIds: [] })));
      expect(listReads()).toBe(reconnectListReads + 1);
      await changedSession({ sessionId: sourceSessionId, cursor: 207 });
      expect(listReads()).toBe(reconnectListReads + 1);
      expect(runRouteReads).toEqual([]);
      // Six already-demanded exact scopes survive an unrelated Account-rule
      // create/delete. The Machine transport is the boundary; startup, private
      // cache, receiver-range dispatch and first-original admission are real.
      const scopes = [sourceSessionId, ...Array.from({ length: 5 }, (_, index) => `c${String(index + 3).repeat(23)}`)];
      const dispatchScopes = async () => {
        for (const sourceId of scopes) await host.runtime.dispatchSessionFollowOccurrence({
          destinationSessionId, sourceSessionId: sourceId, observations: [],
        });
      };
      const beforeColdSources = ruleReads();
      await dispatchScopes();
      expect(ruleReads() - beforeColdSources, 'five new exact source scopes retain first-discovery demand').toBe(5);
      for (const created of [true, false]) {
        const before = ruleReads();
        const beforePreferences = preferenceReads();
        accountRuleCreated = created;
        await Promise.all([...changedFollows].map(listener => listener({ full: true, workflowRunIds: [] })));
        await dispatchScopes();
        expect(ruleReads() - before, `Account rule ${created ? 'create' : 'delete'} must keep unchanged six source scopes`).toBe(1);
        expect(preferenceReads() - beforePreferences).toBe(1);
      }
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await host.dispose(); restoreHttp(); await app.close();
      await channel.close();
      resetActiveAccountSettingsSnapshotForTests();
    }
  });
});

it.each([
  { dispatcherState: 'unavailable', eventType: 'ready', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'unavailable', eventType: 'goal-changed', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'goal-and-finish', policy: { preset: 'everything' }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'important' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'important' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'ready', policy: { preset: 'quiet' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'quiet' }, delivery: 'next_turn' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'custom', events: {
    goal_changed: { delivery: 'interrupt' },
  } }, delivery: 'wake' },
  { dispatcherState: 'available', eventType: 'goal-changed', policy: { preset: 'custom', events: {} }, delivery: null },
  { dispatcherState: 'available', eventType: 'cont28', policy: { preset: 'important' }, delivery: 'next_turn' },
] satisfies ReadonlyArray<{ dispatcherState: 'available' | 'unavailable'; eventType: 'ready' | 'goal-changed' | 'goal-and-finish' | 'cont28';
  policy: FollowPolicyV1; delivery: 'wake' | 'next_turn' | null }>)('defers an original-backed update to original admission ($dispatcherState dispatcher, $eventType, $policy.preset)', async ({ dispatcherState, eventType, policy, delivery }) => {
  await withConfiguredDaemonTestHome({ prefix: 'follow-original-wake-' }, async ({ homeDir }) => {
    const accountId = 'receiver-account';
    const channel = await createRequesterCurrentnessSocketHarness();
    const machineId = 'receiver-machine';
    const sourceSessionId = 'c111111111111111111111111';
    const destinationSessionId = 'c222222222222222222222222';
    const serverId = 'follow-home';
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    const metadata = JSON.stringify({ path: homeDir, host: 'host', machineId, flavor: 'codex',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} }, codexSessionId: 'native-receiver' });
    // Goal mutation alone is not a second completed-Turn occurrence.
    const turnStatus = eventType === 'goal-changed' ? 'in_progress' as const : 'completed' as const;
    const source = createSessionRecordFixture({ id: sourceSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata, ownerAccountId: accountId, origin: { kind: 'none' }, seq: eventType === 'cont28' ? 15 : 1, archivedAt: null, active: true,
      latestTurnId: 'source-turn', latestTurnStatus: turnStatus, pendingReviewRuns: 0 });
    const destination = { ...createSessionNotificationContextFixture(destinationSessionId),
      ...createSessionRecordFixture({ id: destinationSessionId, encryptionMode: 'plain', dataEncryptionKey: null,
        metadata, ownerAccountId: accountId, origin: { kind: 'none' }, archivedAt: null, active: true }) };
    const observation: SessionFollowSessionPendingObservationV1 = { sourceSessionId, destinationSessionId,
      ...(eventType === 'ready' || eventType === 'cont28' || policy.preset !== 'everything'
        ? { relation: 'manager' as const, attachedAt: 1 } : { relation: 'follower' as const }),
      policy, delivered: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: eventType === 'cont28' ? 9 : 0 },
      observed: { ...SESSION_FOLLOW_ZERO_FRONTIER_V1, transcriptSeq: source.seq,
        turn: eventType === 'goal-changed' ? null : { id: 'source-turn', status: 'completed' } } };
    let rulesAvailable = dispatcherState === 'available';
    let routesAvailable = true;
    let losePendingResponse = eventType === 'cont28';
    const pending: unknown[] = [];
    const legacyContexts: unknown[] = [];
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
    app.get('/v2/account/session-follow-rules', async (_request, reply) => rulesAvailable
      ? { rules: [] } : reply.code(503).send({ error: 'unavailable' }));
    app.get('/v2/account/session-follow-preferences', async () => ({ assigned: false, direct: false, team: false, group: false }));
    app.get('/v2/account/session-follows', async () => ({ follows: [] }));
    app.get(`/v2/sessions/${destinationSessionId}/follows/sessions`, async () => ({ sources: [] }));
    app.get(`/v2/sessions/${sourceSessionId}`, async () => ({ session: source }));
    app.get(`/v2/sessions/${destinationSessionId}`, async () => ({ session: destination }));
    app.get(`/v2/sessions/${destinationSessionId}/delivery-mutes`, async () => ({ scopes: [] }));
    app.get(`/v1/sessions/${sourceSessionId}/messages`, async () => ({ messages:
      (eventType === 'cont28' ? [{ seq: 10, type: 'ready' }, { seq: 11, type: 'goal-changed' }, { seq: 15, type: 'ready' }]
        : [{ seq: 1, type: eventType === 'goal-and-finish' ? 'goal-changed' : eventType }]).map(({ seq, type }) => ({ id: `original-${seq}`, localId: `original-${seq}`, seq,
        createdAt: 200 + seq, updatedAt: 200 + seq, sidechainId: null, messageRole: 'agent', content: { t: 'plain', v: { role: 'agent',
          content: { type: 'event', id: `original-${seq}`, data: { type,
            ...(type === 'ready' ? { completedTurnId: eventType === 'cont28' && seq === 10 ? 'old-source-turn' : 'source-turn' } : {}) } } } } })), hasMore: false }));
    app.post('/v2/sessions/:sessionId/follows/inactive-observations', async request => {
      const sessionId = (request.params as { sessionId: string }).sessionId;
      return { ok: true, v: 1, sessionId, target: { homeId: serverId, accountId, sessionId, machineId,
        installationId: readInstallationIdentityIfExistsSync()!.installationId },
        currentSourceSessionIds: [sourceSessionId], observations: [observation] };
    });
    app.post(`/v2/sessions/${sourceSessionId}/follows/occurrence-routes`, async (_request, reply) => routesAvailable
      ? { ok: true, v: 1, sourceSessionId, originalCreatedAt: 200, routes: [observation] }
      : reply.code(503).send({ error: 'unavailable' }));
    app.post(`/v2/sessions/${destinationSessionId}/pending`, async (request, reply) => {
      pending.push(request.body);
      // HTTP boundary only: custody may have committed before its response is lost.
      if (losePendingResponse) { losePendingResponse = false; return reply.code(503).send({ error: 'unavailable' }); }
      return { didWrite: true };
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    const followListeners = new Set<Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]>();
    const sessionListeners = new Set<Parameters<ApiMachineClient['onSessionChanged']>[0]>();
    const receiverChanged = async () => {
      if (!followListeners.size) throw new Error('Missing Account Follow observer');
      await Promise.all([...followListeners].map(listener => listener({ full: false, workflowRunIds: [], receiverSessionIds: [destinationSessionId] })));
    };
    const transport = { ...createApiMachineTransportFixture(),
      onSessionChanged: (listener: Parameters<ApiMachineClient['onSessionChanged']>[0]) => {
        sessionListeners.add(listener); return () => { sessionListeners.delete(listener); };
      },
      onSessionFollowRulesChanged: (listener: Parameters<ApiMachineClient['onSessionFollowRulesChanged']>[0]) => {
        followListeners.add(listener); return () => { followListeners.delete(listener); };
      },
      registerMachineAccessLossReceiver: () => () => {},
      resolveInstalledAccountObservationRuntime: async () => ({ accountId, credentials, machineId, serverId,
        serverHttpBaseUrl: origin, isCurrent: async () => true }),
      setRPCHandlers: () => ({}), registerLiveStreamRelayRoutes: vi.fn(),
      connect: () => {}, registerLocalServicesRoutes: () => {}, registerSimulatorPreviewRoutes: () => {},
      updateDaemonState: async () => 'published' as const, updateMachineMetadata: async () => 'published' as const,
      emitExternalSessionTranscriptUpdate: vi.fn(), sendMachineTransferEnvelope: vi.fn(), sendTransferRelayV2Envelope: vi.fn(),
      sendMachineLiveStreamRelayEnvelope: vi.fn(),
      getPeerMediationMachineRpcHandlerManager: () => ({ invokeLocal: async () => ({ ok: true }) }),
    };
    const apiMachine = transport as unknown as ApiMachineClient;
    const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: homeDir, activeServerDir: homeDir, serverId,
      serverHttpBaseUrl: origin, machineId, custodianAccountId: accountId, credentials,
      connectedServicesMaterializationBaseDir: join(homeDir, 'materialized'), registry: new ConnectedServiceRuntimeRegistry(),
      trackedSessions: new Map(), getRequester: () => null, getApiMachineForSessions: () => apiMachine,
      resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
      startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }) } });
    // Substitute only the publisher socket. The resumed host's selection and
    // source hydration stay real, so a process launch cannot stand in for delivery.
    const session = Object.assign(createApiSessionClientFixture(), { sessionId: destinationSessionId,
      runSessionFollowSourceRequest: <T>({ request }: { request: () => T }): T => request(),
      observePendingSessionFollow: async () => SessionFollowObservePendingResponseV1Schema.parse({ ok: true, v: 1,
        sessionId: destinationSessionId, publisherGeneration: '1', currentSourceSessionIds: [sourceSessionId], observations: [observation] }),
    });
    const reconcile = createSessionFollowContextReconciler({ session,
      hydrateObservation: createSessionFollowSourceHydrator({ session, credentials }), maxFollowContextUtf8Bytes: 8192 });
    let runtime: Awaited<ReturnType<typeof bootstrapMachineSyncRuntime>> | undefined;
    try {
      runtime = await bootstrapMachineSyncRuntime({ cliVersion: 'test', machineId, credentials,
        machine: { id: machineId, encryptionMode: 'plain', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 },
        requesterServerId: serverId, preferredHost: 'host', happyHomeDir: homeDir, happyLibDir: homeDir,
        filesystemAccessPolicy: { kind: 'osUser' }, takeoverRequested: false, isShuttingDown: () => false,
        createConnectedApiMachine: () => apiMachine as NonNullable<Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>>,
        attachTransferRuntimeStatePublisher: async () => {}, startAutomationWorkerForMachine: () => null,
        startMemoryWorkerForMachine: async () => null, startVoiceInferenceWorkerForMachine: async () => null,
        spawnSessionForInternalResume: async () => {
          legacyContexts.push(await reconcile({ signal: new AbortController().signal, deliveryIntent: 'wake' }));
          return { type: 'success', sessionId: destinationSessionId };
        },
        spawnSession: async () => { throw new Error('Follow must use internal resume'); },
        stopSession: async () => ({ status: 'stopped' }), isSessionAlreadyRunning: async () => false,
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId }),
        dispatchSessionFollowOccurrence: host.runtime.dispatchSessionFollowOccurrence,
        loadLocalSessionMetadataForHandoff: async () => null, beforeShutdown: async () => {}, requestShutdown: () => {},
        directPeerServerLifecycle: null, directTransferRegistryHost: createCliRegistryHostV1(),
        connectedServiceRefreshLoopHandle: null, connectedServiceQuotasLoopHandle: null, daemonServerWorkScheduler: {} as never,
      });
      await receiverChanged();
      const beforeRetry = [...legacyContexts];
      rulesAvailable = true;
      if (eventType === 'cont28') {
        expect(pending).toHaveLength(1);
        // Transcript publications precede the normalized terminal Turn originals.
        // A lost response must still stop the remaining selected suffix.
        expect(pending[0]).toMatchObject({ followDeliveryV1: { delivery: 'next_turn', event: { kind: 'goal_changed' },
          original: { sourceMessage: { localId: 'original-11', seq: 11 } } } });
        routesAvailable = false;
        await receiverChanged();
        expect(pending).toHaveLength(1);
        expect(legacyContexts).toEqual([]);
        routesAvailable = true;
      }
      if (eventType === 'cont28') {
        await receiverChanged();
        expect(pending, 'progress alone cannot retry an unknown admission').toHaveLength(1);
        for (const listener of sessionListeners) await listener({ sessionId: destinationSessionId,
          cursor: 20, followSourceChanged: false, followReceiverAvailabilityChanged: true });
      } else await receiverChanged();
      expect(pending).toHaveLength(eventType === 'cont28' ? 4 : eventType === 'goal-and-finish' ? 2
        : delivery === null ? 0 : 1);
      for (const request of pending) expect(request).toMatchObject({ followDeliveryV1: { delivery } });
      if (eventType === 'cont28') {
        expect(pending).toMatchObject([
          ...[11, 11].map(seq => ({ followDeliveryV1: { event: { kind: 'goal_changed' },
            original: { sourceSessionId, sourceMessage: { localId: `original-${seq}`, seq } } } })),
          ...['old-source-turn', 'source-turn'].map(id => ({ followDeliveryV1: { event: { kind: 'finished' },
            original: { sourceSessionId, sourceTurn: { id, status: 'completed' } } } })),
        ]);
        const retryLocalId = deriveSessionFollowInputLocalIdV1({ destinationSessionId,
          original: { sourceSessionId, sourceMessage: { localId: 'original-11', seq: 11 } } });
        for (const attempt of pending.slice(0, 2)) expect(attempt).toMatchObject({ localId: retryLocalId });
      } else if (eventType === 'goal-and-finish') {
        const originals = [
          { sourceSessionId, sourceMessage: { localId: 'original-1', seq: 1 } },
          { sourceSessionId, sourceTurn: { id: 'source-turn', status: 'completed' as const } },
        ];
        expect(pending).toMatchObject(originals.map((original, index) => ({
          localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId, original }),
          followDeliveryV1: { original, event: { kind: index % 2 === 0 ? 'goal_changed' : 'finished' } },
        })));
      } else if (delivery !== null) {
        for (const request of pending) expect(request).toMatchObject({ followDeliveryV1: {
          event: { kind: eventType === 'ready' ? 'finished' : 'goal_changed' },
          original: { sourceSessionId, ...(eventType === 'ready'
            ? { sourceTurn: { id: 'source-turn', status: 'completed' } }
            : { sourceMessage: { localId: 'original-1', seq: 1 } }) },
        } });
      }
      expect(beforeRetry).toEqual([]);
      expect(legacyContexts).toEqual([]);
    } finally {
      if (runtime) await retireMachineSyncRuntimeAttempt(runtime);
      await host.dispose(); restoreHttp(); await app.close();
      await channel.close();
    }
  });
});
