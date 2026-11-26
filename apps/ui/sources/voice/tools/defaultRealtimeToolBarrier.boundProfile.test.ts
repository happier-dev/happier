import { afterEach, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionAccessFixture, createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { APPROVAL_PROFILE_ARTIFACT_KIND_V1, ApprovalProfileArtifactV1Schema, buildApprovalProfileArtifactHeaderV1 } from '@happier-dev/protocol/actions/approvalProfileArtifactV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { settingsDefaults } from '@/sync/domains/settings/settings';

import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';

vi.mock('socket.io-client', async importOriginal => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// Only the external Socket.IO acknowledgement is replaced; permission policy and RPC routing stay real.
installDisconnectedServerSocketBoundary(socket => {
  configureConnectedServerSocketBoundary(socket);
  vi.spyOn(socket, 'timeout').mockReturnValue(socket);
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, _payload: SocketRpcRequestPayload) => ({
    ok: true, result: event === SOCKET_RPC_EVENTS.CALL ? { ok: true, requestId: 'request' } : undefined,
  }));
});
await loadSyncSingletonForTests();
const { createDefaultRealtimeToolBarrier } = await import('./defaultRealtimeToolBarrier');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { storage } = await import('@/sync/domains/state/storage');
afterEach(async () => { await homes.reset(); });

it.each(['off', 'ask', 'team-off', 'team-waive', 'shared-waive', 'shared-off', 'shared-ask', 'unreadable', 'home'] as const)(
  'realtime client tools enforce the bound profile (%s)', async policy => {
  const serverId = await homes.addHome({ name: 'Realtime policy', serverUrl: 'https://realtime-policy.test', accountId: 'alice', currentAccount: true });
  const actionId = 'memory.remember';
  homes.answer(serverId, 'GET /v1/public-shares', { body: { publicShares: [] } });
  const ref = { kind: 'doc' as const, artifactId: 'memory-doc', serverId };
  const accountAsk = policy === 'home' || policy.endsWith('waive');
  homes.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
    actionsSettingsV1: { v: 1, actions: { [actionId]: accountAsk ? { approvalRequiredSurfaces: ['voice'] } : {} } },
    voice: { ...settingsDefaults.voice, canApproveRequests: false },
  } } } });
  const session = createSessionFixture({ id: 'bound-session', serverId,
    access: createSessionAccessFixture(policy.startsWith('shared-') ? 'edit' : 'owner'),
    metadata: { approvalProfileId: 'profile', approvalProfileTeamOrGroupDerived: policy.startsWith('team-'), work: { memoryEnabled: true, promptStack: [{ id: 'memory', ref, enabled: true, placement: 'system_append' }] } } });
  storage.getState().applySessions([session]);
  homes.answer(serverId, `GET /v2/sessions/${session.id}`, policy === 'unreadable'
    ? { status: 404, body: { error: 'not_found' } } : { body: policy.startsWith('shared-') ? { session: { ...createPlainSessionByIdResponseFixture(session).session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata), ownerMetadata: undefined } } : createPlainSessionByIdResponseFixture(session) });
  const artifacts = homes.artifacts(serverId);
  const profile = ApprovalProfileArtifactV1Schema.parse({ kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: {
    name: 'Bound', actions: { [actionId]: policy.endsWith('waive') ? {} : policy.endsWith('ask')
      ? { approvalRequiredSurfaces: ['voice'] } : { disabledSurfaces: ['voice'] } },
    ...(policy.endsWith('waive') ? { approvalWaivedSurfaces: { [actionId]: ['voice'] } } : {}),
  } });
  expect((await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'profile',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildApprovalProfileArtifactHeaderV1(profile)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(profile) }),
  }) }))?.ok).toBe(true);
  await artifacts.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: ref.artifactId,
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Memory' }),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [], topics: [] })) }),
  }) });
  let created!: () => void;
  const approvalCreated = new Promise<void>(resolve => { created = resolve; });
  artifacts.afterNextCreate(async () => { created(); });
  const barrier = createDefaultRealtimeToolBarrier({ currentServerId: serverId, resolveSessionId: () => policy === 'home' ? null : session.id,
    resolveCurrentSessionAddress: async () => policy === 'home' ? null : { serverId, sessionId: session.id },
    submitResults: async () => {}, continueResponse: async () => {},
  });
  try {
    const running = barrier.run({ responseId: 'response', calls: [{ v: 1, responseId: 'response', callId: 'call', order: 0,
      toolName: 'action_execute', arguments: { actionId, input: { ref, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, text: 'Keep the silver compass.' } } }] });
    if (accountAsk || policy.endsWith('ask')) {
      expect(await Promise.race([running, approvalCreated.then(() => 'approval')])).toBe('approval');
      const approval = artifacts.list().filter(row => row.id !== 'profile' && row.id !== ref.artifactId);
      expect(approval).toHaveLength(1);
      expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: approval[0]!.id, decision: 'reject' },
        { surface: 'ui', serverId, actionCaller: { kind: 'host' } })).toMatchObject({ ok: true });
      await running;
    } else {
      expect((await running).results[0]).toMatchObject({ errorCode: policy === 'unreadable' ? 'approval_context_unavailable' : 'action_disabled' });
      expect(artifacts.list()).toHaveLength(2);
    }
    if (policy === 'home') expect(homes.requestsFor(`/v2/sessions/${session.id}`)).toHaveLength(0);
  } finally { barrier.dispose(); }
});

it('native spoken permission answers respect the bound Session Off profile', async () => {
  const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
  const { createNativeVoicePermissionInput } = await import('@/voice/local/nativeVoicePermissionInput');
  const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
  const serverId = await homes.addHome({ name: 'Permission policy', serverUrl: 'https://permission-policy.test', accountId: 'alice', currentAccount: true });
  homes.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
    voice: { ...settingsDefaults.voice, canApproveRequests: true, privacy: { ...settingsDefaults.voice.privacy, sharePermissionRequests: true } },
  } } } });
  storage.getState().applySettingsLocal({ voice: { ...storage.getState().settings.voice, canApproveRequests: true, privacy: { ...settingsDefaults.voice.privacy, sharePermissionRequests: true } } });
  const session = createSessionFixture({ id: 'permission-target', serverId, active: true, metadataLayoutVersion: 1,
    ownerMetadataView: { approvalProfileId: 'permission-profile' }, metadata: {},
    agentState: { requests: { request: { kind: 'permission', tool: 'WriteFile', arguments: { filePath: '/project/a' }, createdAt: 1 } } } });
  storage.getState().applySessions([session]);
  homes.answer(serverId, `GET /v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const profile = ApprovalProfileArtifactV1Schema.parse({ kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: {
    name: 'Permission Off', actions: { 'session.permission.respond': { disabledSurfaces: ['voice'] } },
  } });
  await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'permission-profile',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildApprovalProfileArtifactHeaderV1(profile)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(profile) }),
  }) });
  const controller = new AbortController();
  const account = await captureLazyActionAccountContext(serverId);
  const binding = { adapterId: 'local_conversation', controlSessionId: 'permission-call', conversationSessionId: 'carrier',
    conversationSessionAddress: { serverId, sessionId: 'carrier' }, targetSessionAddress: { serverId, sessionId: session.id },
    transcriptMode: 'native_session' as const, updatedAt: 1 };
  storage.getState().applySessions([createSessionFixture({ id: 'carrier', serverId }), session]);
  voiceSessionBindingStore.getState().bind(binding);
  const { setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
  setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId, status: 'connected', mode: 'listening', canStop: true });
  let settled: unknown;
  const input = createNativeVoicePermissionInput({ controlSessionId: binding.controlSessionId, signal: controller.signal,
    readVoiceAgentHandle: () => ({ accountLifetime: account.accountLifetime, client: new DaemonVoiceAgentClient(account.accountLifetime.scope, controller.signal),
      voiceAgentId: 'run_permission', rpcSessionId: 'carrier', transcriptEpoch: 0, metadataSessionId: null, backend: 'daemon', agentBackendId: 'codex',
      actionInvocation: { caller: { kind: 'host' }, surface: 'voice', authority: 'present_user' } }),
    isConversationTurnPending: () => false, readOut: async (_text, _listen, _current, ready) => { ready(); },
    commitTranscript: async () => {}, onResponding: () => {}, onResponseSettled: async result => { settled = result; },
  });
  try {
    await waitForHomeGovernance(() => expect(input.canAccept()).toBe(true));
    const respond = input.captureResponse();
    expect(respond).not.toBeNull();
    await respond!('yes');
    expect(settled).toMatchObject({ ok: false, error: { code: 'action_disabled' } });
  } finally { input.dispose(); controller.abort(); voiceSessionBindingStore.getState().unbind('carrier'); account.dispose(); }
});

it('live Voice target policy wins over the stale turn address', async () => {
  const { createVoiceToolHandlers } = await import('./handlers');
  const serverId = await homes.addHome({ name: 'Retarget policy', serverUrl: 'https://retarget-policy.test', accountId: 'alice', currentAccount: true });
  const stale = createSessionFixture({ id: 'stale-target', serverId });
  const live = createSessionFixture({ id: 'live-target', serverId, metadata: { approvalProfileId: 'live-profile' } });
  for (const session of [stale, live]) homes.answer(serverId, `GET /v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
  const profile = ApprovalProfileArtifactV1Schema.parse({ kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: {
    name: 'Live Off', actions: { 'artifact.get': { disabledSurfaces: ['voice'] } },
  } });
  await homes.artifacts(serverId).handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({ id: 'live-profile',
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(buildApprovalProfileArtifactHeaderV1(profile)),
    body: encodePlainArtifactStoredContent({ body: JSON.stringify(profile) }),
  }) });
  const handlers = createVoiceToolHandlers({ currentServerId: serverId, resolveSessionId: () => live.id,
    currentSessionAddress: { serverId, sessionId: stale.id }, resolveCurrentSessionAddress: async () => ({ serverId, sessionId: live.id }) });
  expect(JSON.parse(await handlers.action_execute!({ actionId: 'artifact.get', input: { artifactId: 'live-profile' } }, { serverId })))
    .toMatchObject({ ok: false, errorCode: 'action_disabled' });
});
