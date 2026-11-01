import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { beforeEach, expect, it, vi } from 'vitest';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import type { HostExternalTranscriptFollowEvent } from './privateContract';

// Each case retires its real registry; subsequent cases need a fresh module graph.
beforeEach(() => { vi.resetModules(); });

function createBufferedNativeTranscript() {
  const remoteSessionId = '33333333-3333-3333-3333-333333333333';
  const model = 'claude-haiku-4-5-20251001';
  const timestamp = new Date().toISOString();
  const common = { sessionId: remoteSessionId, timestamp, isSidechain: false };
  const firstPrompt = 'Return a short confirmation.';
  const longPrompt = 'Return the complete 400-line generated report.';
  const longText = Array.from({ length: 400 }, (_, index) => `Report line ${index + 1}: sanitized native replay.`.padEnd(82, '.')).join('\n') + '.'.repeat(82);
  const serialize = (rows: readonly unknown[]) => rows.map(row => JSON.stringify(row) + '\n').join('');
  const assistant = (uuid: string, parentUuid: string, id: string, content: readonly unknown[], stopReason: 'end_turn' | null) => ({
    ...common, type: 'assistant', uuid, parentUuid,
    message: { id, type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 } },
  });
  return { remoteSessionId, model, firstPrompt, firstText: 'complete', longPrompt, longText,
    prefix: serialize([
      { ...common, type: 'user', uuid: 'native-user', parentUuid: null, message: { role: 'user', content: firstPrompt } },
      assistant('native-answer', 'native-user', 'message-first', [{ type: 'text', text: 'complete' }], 'end_turn'),
    ]),
    user: serialize([{ ...common, type: 'user', uuid: 'native-long-user', parentUuid: 'native-answer',
      message: { role: 'user', content: longPrompt } }]),
    // Claude can buffer both rows until after Stop. The API message identity is
    // shared, but each native observation has its own UUID and content block.
    completion: serialize([
      assistant('native-reasoning', 'native-long-user', 'message-long', [{ type: 'thinking', thinking: 'Preparing the complete report.', signature: 'sanitized' }], 'end_turn'),
      assistant('native-long-answer', 'native-reasoning', 'message-long', [{ type: 'text', text: longText }], 'end_turn'),
      { ...common, type: 'system', subtype: 'turn_duration', uuid: 'native-duration', parentUuid: 'native-long-answer', durationMs: 73_000 },
    ]),
  };
}

it.each(['runner_http_fresh_terminal_inventory_refresh', 'runner_http_fresh_terminal_interrupt_recovery', 'runner_http_fresh_terminal_pending_followup', 'runner_http_fresh_terminal_catalog_refresh', 'runner_transport', 'runner_transport_retired_acquisition', 'runner_http', 'runner_http_fresh', 'runner_http_fresh_publisher', 'runner_http_fresh_terminal_service', 'runner_http_fresh_terminal_e2ee', 'runner_http_fresh_terminal_concurrent_commit', 'runner_http_cancelled_acquisition', 'runner_http_retired_acquisition', 'thinking_text', 'cold_history', 'oversized_native_row', 'observer_retired', 'runner_retired', 'listener_failure'] as const)('admits a runner-carried Claude codec through real observation and scoped follow (%s)', async kind => {
  const interruptRecovery = kind === 'runner_http_fresh_terminal_interrupt_recovery';
  const pendingFollowup = kind === 'runner_http_fresh_terminal_pending_followup';
  const liveAppend = interruptRecovery || pendingFollowup || kind === 'runner_http_fresh_terminal_catalog_refresh' || kind === 'runner_http_fresh_terminal_inventory_refresh';
  const replayStages = { rawLines: 0, target: 0, identityAck: 0, bind: 0, readAfter: 0, cursor: 0,
    sourceItems: 0, displayItems: 0, durableAck: 0, durableLongAck: 0, durableRecoveryAck: 0 };
  const replay = liveAppend ? createBufferedNativeTranscript() : null;
  const firstText = replay?.firstText ?? 'complete';
  const concurrentCommit = kind === 'runner_http_fresh_terminal_concurrent_commit';
  const usesTerminalService = liveAppend || kind === 'runner_http_fresh_terminal_service' || kind === 'runner_http_fresh_terminal_e2ee' || concurrentCommit;
  const usesPublisher = kind === 'runner_http_fresh_publisher' || usesTerminalService;
  const encrypted = kind === 'runner_http_fresh_terminal_e2ee' || concurrentCommit;
  const retiresAcquisition = kind === 'runner_transport_retired_acquisition' || kind === 'runner_http_retired_acquisition';
  const persistence = await import('@/persistence');
  const { runWithServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
  const { createAdmittedPluginRuntimeFixture } = await import('@/plugins/testkit/admittedRuntime');
  const { pluginReloadController } = await import('@/plugins/runtime/reload/singleton');
  const { resolveExternalSessionSourceSurface } = await import('@/session/actions/externalSessions/providerOpsResolution');
  const { createExternalSessionFollowLeaseManager } = await import('@/api/session/external/leases/createExternalSessionFollowLeaseManager');
  const { createExternalSessionObservationDaemonProjection } = await import('@/api/session/external/leases/createExternalSessionObservationDaemonProjection');
  const { resolveExternalSessionObservationLinkInput } = await import('@/api/session/external/leases/resolveExternalSessionObservationLinkInput');
  const { loadLinkedExternalSession } = await import('@/api/session/external/takeover/loadLinkedExternalSession');
  const { createExternalSessionFollowHostOperation } = await import('./followHostOperation');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-runner-claude-follow-')));
  const configDir = join(root, 'claude');
  const projectId = '-project';
  const remoteSessionId = replay?.remoteSessionId ?? '33333333-3333-3333-3333-333333333333';
  const nativePath = join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`);
  // The Pending scenario publishes Activity/turn custody that the transcript-only
  // Home fixtures do not own. Do not replay it into their distinct Sessions.
  const sessionId = pendingFollowup ? 'hosted-claude-pending' : 'hosted-claude';
  const home = 'https://runner-claude-follow.example';
  const { encrypt, encodeBase64, getRandomBytes, libsodiumPublicKeyFromSecretKey } = await import('@/api/encryption');
  const { deriveAccountMachineKeyFromRecoverySecret, sealEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol');
  const encryptionKey = new Uint8Array(32).fill(17);
  const accountSecret = new Uint8Array(32).fill(19);
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'follow-account' })).toString('base64url')}.signature`,
    encryption: encrypted ? { type: 'legacy' as const, secret: accountSecret } : null };
  const dataEncryptionKey = encrypted ? encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: encryptionKey,
    recipientPublicKey: libsodiumPublicKeyFromSecretKey(deriveAccountMachineKeyFromRecoverySecret(accountSecret)),
    randomBytes: getRandomBytes })) : null;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  await mkdir(join(configDir, 'projects', projectId), { recursive: true });
  const hasHistory = kind === 'cold_history' || kind === 'oversized_native_row';
  const historical = !hasHistory ? [] : [
    { type: 'assistant', uuid: 'old-launch', parentUuid: null, sessionId: remoteSessionId,
      message: { content: [{ type: 'tool_use', id: 'old-agent-tool', name: 'Agent', input: { description: 'existing worker' } }] },
      ...(kind === 'oversized_native_row' ? { pad: '🙂'.repeat(2_100_000) } : {}) },
    { type: 'user', uuid: 'old-alias', parentUuid: 'old-launch', sessionId: remoteSessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-agent-tool', content: 'launched' }] },
      toolUseResult: { status: 'async_launched', agentId: 'existing-native-child' } },
    ...(kind === 'cold_history' ? Array.from({ length: 1_100 }, (_, index) => ({
      type: 'assistant', uuid: `display-${index}`, parentUuid: index === 0 ? 'old-alias' : `display-${index - 1}`,
      message: { content: [{ type: 'text', text: 'x'.repeat(4_096) }] },
    })) : []),
  ];
  await writeFile(join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`), historical.map(row => JSON.stringify(row) + '\n').join('') + (usesPublisher ? '' : JSON.stringify({
    type: 'user', uuid: 'native-user', sessionId: remoteSessionId, timestamp: new Date().toISOString(),
    parentUuid: !hasHistory ? null : kind === 'cold_history' ? 'display-1099' : 'old-alias',
    message: { content: 'work' },
  }) + '\n') + JSON.stringify({ type: 'assistant', uuid: 'native-answer', parentUuid: 'native-user',
    timestamp: new Date().toISOString(), message: { content: [{ type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'complete' }], stop_reason: 'end_turn' },
  }) + '\n');
  if (replay) await writeFile(nativePath, '');
  const sessionMetadata = { machineId: 'machine', path: root, flavor: 'claude', claudeSessionId: remoteSessionId };
  const rawSession = { ...createSessionNotificationContextFixture(sessionId), currentStorageState: 'hosted' as const,
    ...(pendingFollowup ? { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 } : {}),
    encryptionMode: encrypted ? 'e2ee' as const : 'plain' as const,
    dataEncryptionKey,
    metadata: encrypted ? encodeBase64(encrypt(encryptionKey, 'dataKey', sessionMetadata)) : JSON.stringify(sessionMetadata) };
  // Credential-file and Home HTTP are genuine system boundaries. Registry,
  // codecs, link admission, observation reduction and follow custody are real.
  const credentialsRead = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  let metadataReads = 0;
  let committedBaselineLocalId: string | undefined;
  let commitDuringBaselineRead: (() => Promise<void>) | undefined;
  let acquisitionEntered!: () => void;
  const acquisitionPending = new Promise<void>(resolve => { acquisitionEntered = resolve; });
  let releaseAcquisition!: () => void;
  const acquisitionReleased = new Promise<void>(resolve => { releaseAcquisition = resolve; });
  const http = vi.spyOn(axios, 'get').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.origin).toBe(home);
    if (url.pathname === `/v2/sessions/${sessionId}`) {
      metadataReads++;
      // Hold a real Home read inside the original manager acquisition, after
      // the caller already crossed target resolution and source validation.
      if ((kind === 'runner_http_cancelled_acquisition' || retiresAcquisition) && metadataReads === 3) {
        acquisitionEntered();
        await acquisitionReleased;
      }
      return { status: 200, data: { session: rawSession } };
    }
    if (url.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
      mode: encrypted ? 'e2ee' : 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (pendingFollowup && url.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    if (pendingFollowup && url.pathname === `/v2/sessions/${sessionId}/pending`) return { status: 200, data: {
      pending: [{ localId: 'followup', status: 'queued', deliveryState: 'delivering' }],
    } };
    if (usesPublisher && url.pathname === '/v1/auth/ping') return { status: 200, data: {} };
    if (usesTerminalService && url.pathname === `/v1/sessions/${sessionId}/messages`) {
      const { SessionMessagesPageV1Schema } = await import('@happier-dev/protocol/sessions/messages/sessionMessagesPageV1');
      const data = SessionMessagesPageV1Schema.parse({
        messages: committedBaselineLocalId ? [{ id: 'home-native-answer', seq: 1, localId: committedBaselineLocalId,
          createdAt: 1, content: encrypted ? { t: 'encrypted', c: encodeBase64(encrypt(encryptionKey, 'dataKey', {
            role: 'agent', content: { type: 'text', text: 'complete' },
          })) } : { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'complete' } } } }] : [],
        hasMore: false, nextBeforeSeq: null, nextAfterSeq: null,
      });
      // Home can take the baseline snapshot before a concurrent SDK commit,
      // then return that snapshot after the real commit has completed.
      const commit = commitDuringBaselineRead;
      commitDuringBaselineRead = undefined;
      await commit?.();
      return { status: 200, data };
    }
    throw new Error(`Unexpected follow HTTP boundary: ${url.pathname}`);
  });
  const metadataHttp = liveAppend ? vi.spyOn(axios, 'patch').mockImplementation(async (input, body) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(home);
    expect(url.pathname).toBe(`/v2/sessions/${sessionId}`);
    const { SessionMetadataTuplePatchV1Schema } = await import('@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1');
    const patch = SessionMetadataTuplePatchV1Schema.parse(body);
    if (patch.mode === 'shared_editor') throw new Error('Replay requires owner metadata');
    const target = patch.mode === 'owner_migration' ? patch.target : patch;
    Object.assign(rawSession, { metadataLayoutVersion: 1, metadata: target.sharedMetadata.ciphertext,
      ownerMetadata: target.ownerMetadata, share: null, agentState: target.agentState.ciphertext,
      metadataVersion: rawSession.metadataVersion + 1, agentStateVersion: rawSession.agentStateVersion + 1 });
    return { status: 200, data: { success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: rawSession.metadataVersion }, agentState: { version: rawSession.agentStateVersion } } };
  }) : undefined;
  const projectHttp = pendingFollowup ? vi.spyOn(axios, 'post').mockImplementation(async input => {
    const { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } = await import('@happier-dev/protocol/projects/projectAccountRowsV1');
    if (new URL(String(input)).pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return { status: 200,
      data: ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [] }) };
    throw new Error(`Unexpected follow POST boundary: ${new URL(String(input)).pathname}`);
  }) : undefined;
  const fixture = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.claude'] } });
  // These two publishers cross Home persistence; no internal owner is mocked.
  const manager = createExternalSessionFollowLeaseManager({ writeFollowStatus: async () => {} });
  const projection = createExternalSessionObservationDaemonProjection({ publishField: async () => {},
    requestTranscriptRefresh: input => manager.requestTranscriptRefresh(input),
    isTranscriptRefreshDemanded: input => manager.hasTranscriptDemand(input) });
  const operation = createExternalSessionFollowHostOperation({ machineId: 'machine', followLeaseManager: manager,
    observationProjection: projection });
  let subscription: Readonly<{ dispose(): void | Promise<void> }> | undefined;
  let disposeTransport: (() => Promise<void>) | undefined;
  let closePublisher: (() => Promise<void>) | undefined;
  let restorePublisherFetch: (() => void) | undefined;
  try {
    await runWithServerHttpBaseUrl(home, async () => {
      const source = { kind: 'claudeConfig', configDir, projectId };
      const surface = await resolveExternalSessionSourceSurface('claude', source);
      if (!surface.ok || !surface.providerOps.pageTranscript || !surface.providerOps.readAfterTranscript) throw new Error('Claude source unavailable');
      const loaded = await loadLinkedExternalSession({ credentials, sessionId, machineId: 'machine',
        expectedIdentity: { agentId: 'claude', machineId: 'machine', remoteSessionId, source: surface.source } });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error('Hosted Session unavailable');
      const observation = await resolveExternalSessionObservationLinkInput({ sessionId, linked: loaded.session });
      expect(observation).not.toBeNull();
      expect(observation?.resource.occurrenceId).not.toBe('runner-service-binding');
      const events: HostExternalTranscriptFollowEvent[] = [];
      const runnerRetirement = new AbortController();
      let listener: (event: HostExternalTranscriptFollowEvent) => void | Promise<void> = (event) => { events.push(event); };
      let publisherBaseline: Parameters<typeof import('@/agent/runtime/session/terminal/transcriptFollow').createHostTerminalTranscriptFollowService>[0]['loadCommittedLocalIdBaseline'];
      let terminalPublish: Parameters<typeof import('@/agent/runtime/session/terminal/transcriptFollow').createHostTerminalTranscriptFollowService>[0]['publish'] | undefined;
      let nativePublisher: import('@/api/session/sessionClient').ApiSessionClient | undefined;
      let replayNativeHook: ((payload: Readonly<Record<string, unknown>>) => Promise<void>) | undefined;
      let interruptAndRecover: (() => Promise<void>) | undefined;
      let enqueueFollowup: (() => Promise<void>) | undefined;
      let publishPending: (() => void) | undefined;
      let pendingAvailable = false;
      let firstNativePrompt = replay?.firstPrompt ?? '';
      let followupNativePrompt = replay?.longPrompt ?? '';
      let followupReopenedNative = false;
      if (kind === 'listener_failure') listener = async () => {
        // The consumer delivery boundary refuses this real native baseline.
        throw new Error('secret delivery failure', { cause: Object.assign(new Error('secret filesystem failure'), { code: 'ENOENT' }) });
      };
      if (usesPublisher) {
        const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
        const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { session: {
          runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 }, publisherAuthority: { protocolVersion: 1 },
        } } });
        const nativeFetch = globalThis.fetch;
        const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
          if (url.origin === home && url.pathname === '/v1/features') return Response.json(features);
          return await nativeFetch(input, init);
        });
        restorePublisherFetch = () => fetchBoundary.mockRestore();
        const { ApiSessionClient } = await import('@/api/session/sessionClient');
        const { createTestApiSessionClient } = await import('@/testkit/backends/createTestApiSessionClient');
        const { createPlainSessionFixture } = await import('@/testkit/backends/sessionFixtures');
        const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
        const { createApiSessionSocketStub, createSessionTranscriptHomeStub, createSessionRuntimeActivityHomeStub, createSessionTurnMutationAppliedSocketAck } = await import('@/testkit/backends/apiSessionSocketHarness');
        const { SessionTurnMutationV1Schema } = await import('@happier-dev/protocol/sessions/turns/sessionTurnMutationV1');
        const { createExternalSessionTerminalFollowProjector } = await import('./terminalFollowProjection');
        const { projectRuntimeTranscriptEvent } = await import('@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent');
        const { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SessionTranscriptObservationInputSchema,
          SessionTranscriptObservationAckV1Schema } = await import('@happier-dev/protocol/sessions/messages/transcriptObservationV1');
        const transcriptHome = createSessionTranscriptHomeStub();
        const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'machine' });
        const retainedObservations = new Map<string, { createdAt: number; updatedAt: number }>();
        const socket = createApiSessionSocketStub({ connected: true,
          emit: (event, args) => {
            if (event === 'ping' && typeof args[0] === 'function') args[0]();
          },
          emitWithAck: (event, payload) => {
            if (pendingFollowup && event === 'pending-materialize-next') {
              if (!pendingAvailable) return { ok: true, didMaterialize: false, pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 };
              pendingAvailable = false;
              return { ok: true, didMaterialize: true, didWrite: false, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2,
                message: { id: 'followup', seq: null, localId: 'followup', createdAt: Date.now(),
                  content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: replay!.longPrompt } } },
                  providerAction: 'send', deliveryState: { mode: 'provider', unresolved: true } } };
            }
            if (event === 'session-turn-mutation') return createSessionTurnMutationAppliedSocketAck(SessionTurnMutationV1Schema.parse(payload));
            if (usesTerminalService && event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
              const observation = SessionTranscriptObservationInputSchema.parse(payload);
              const existing = retainedObservations.get(observation.localId);
              // Real Home rejects a same-local-ID observation with a different
              // creation time or regressing update time, even under E2EE.
              if (existing && (existing.createdAt !== observation.createdAt || existing.updatedAt > observation.updatedAt)) {
                return SessionTranscriptObservationAckV1Schema.parse({ ok: false, error: 'invalid_observation' });
              }
              retainedObservations.set(observation.localId, { createdAt: observation.createdAt, updatedAt: observation.updatedAt });
            }
            const transcriptAck = transcriptHome.answer(event, payload);
            if (liveAppend && transcriptAck && event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
              expect(SessionTranscriptObservationAckV1Schema.parse(transcriptAck)).toMatchObject({ ok: true });
              replayStages.durableAck++;
              if (replay && JSON.stringify(payload).includes(JSON.stringify(replay.longText))) replayStages.durableLongAck++;
              if (JSON.stringify(payload).includes('Recovery complete.')) replayStages.durableRecoveryAck++;
            }
            // Metadata is a genuine Home boundary too. Preserve the socket's
            // versioned update contract while the real native host publishes.
            if (event === 'update-metadata') {
              const request = payload as { metadata: string; expectedVersion: number };
              rawSession.metadata = request.metadata;
              return { result: 'success', version: request.expectedVersion + 1, metadata: request.metadata };
            }
            return transcriptAck ?? activityHome.answer(event, payload) ?? { ok: true };
          } });
        publishPending = () => {
          pendingAvailable = true;
          Object.assign(rawSession, { pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 });
          socket.trigger('update', { id: 'followup-pending', seq: 5, createdAt: Date.now(),
            body: { t: 'pending-changed', sid: sessionId, pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2 } });
        };
        type Transport = import('@/api/session/client/transport/sessionClientTransport').SessionClientTransport;
        // Socket.IO is the genuine Home boundary; the Session client, durable
        // outbox, projector and transcript admission all remain real.
        const homeSocket = socket as unknown as ReturnType<Transport['createSessionSocketTransport']>['socket'];
        const plainPublisherSession = createPlainSessionFixture({ id: sessionId,
          ...(pendingFollowup ? { pendingCount: 0, pendingBlockedCount: 0, pendingVersion: 1 } : {}),
          ...(liveAppend ? { metadata: createTestMetadata(sessionMetadata) } : {}) });
        const publisher = createTestApiSessionClient(ApiSessionClient, credentials.token,
          encrypted ? { ...plainPublisherSession, encryptionMode: 'e2ee', encryptionKey, encryptionVariant: 'dataKey' } : plainPublisherSession,
          { localMachineId: 'machine', metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials }, transport: {
            serverId: 'follow-publisher', serverUrl: home,
            createSessionSocketTransport: () => ({ socket: homeSocket, transport: {
              connect: async () => { socket.connect(); }, disconnect: async () => { socket.disconnect(); }, destroy: async () => {},
              isConnected: () => socket.connected, onConnected: callback => { socket.on('connect', callback); return () => socket.off('connect', callback); },
              onDisconnected: callback => { socket.on('disconnect', callback); return () => socket.off('disconnect', callback); },
              onError: callback => { socket.on('error', callback); return () => socket.off('error', callback); },
            } }), resolveToken: async () => credentials.token,
          } });
        closePublisher = () => publisher.close();
        nativePublisher = publisher;
        publisherBaseline = input => publisher.fetchCommittedTranscriptLocalIdBaseline(input);
        // The SDK already committed this native identity at receipt time. Its
        // JSONL source timestamp is earlier; fresh admission must use the
        // committed baseline rather than rewrite that retained observation.
        // The SDK's committed baseline predates native SessionStart; prepare
        // its identity, then return to an empty source before live file-follow.
        if (replay) await writeFile(nativePath, replay.prefix);
        const page = await surface.providerOps.pageTranscript({ source: surface.source, remoteSessionId,
          direction: 'newer', projection: 'terminal', maxItems: 200, maxBytes: 512 * 1024 });
        if (replay) await writeFile(nativePath, '');
        const { mapPluginExternalTerminalSourceItem } = await import('./pluginExternalSessionsAdapter');
        const display = page.items.map(mapPluginExternalTerminalSourceItem).find(item => item.kind === 'agent');
        if (!display) throw new Error('Expected native assistant display fixture');
        if (typeof display.timestampMs !== 'number') throw new Error('Expected native source timestamp');
        const sdkObservedAt = display.timestampMs + 2;
        const commitSdkDisplay = async () => {
          const committed = await publisher.enqueueAgentMessageCommitted('claude', { type: 'message', message: firstText }, {
            localId: display.localId ?? display.id, provenance: { kind: 'non_dependent', source: 'external' },
            createdAt: sdkObservedAt, updatedAt: sdkObservedAt,
            admission: { signal: new AbortController().signal, requireDelivery: true },
          });
          expect(committed).toMatchObject({ persisted: true, delivered: true });
          committedBaselineLocalId = display.localId ?? display.id;
        };
        if (concurrentCommit) commitDuringBaselineRead = commitSdkDisplay;
        else await commitSdkDisplay();
        const project = createExternalSessionTerminalFollowProjector({ sessionId, agentId: 'claude',
          observeSourceTranscript: async () => {},
          projectRuntimeEvent: (event, admission) => projectRuntimeTranscriptEvent({ session: publisher,
            provider: 'claude', event, ...(admission ? { admission } : {}) }) });
        listener = async event => { events.push(event); await project(event, { signal: new AbortController().signal, requireDelivery: true }); };
        terminalPublish = async (event, admission) => { events.push(event); await project(event, admission); };
      }
      const execute = async (consume = listener) => operation.execute({ pluginId: 'happier.agent.claude', contributionId: 'claude',
        occurrenceId: 'runner-service-binding', sessionId, machineId: 'machine',
        retirementSignal: runnerRetirement.signal,
        ref: { agentId: 'claude', sourceId: surface.sourceKeyOwner.sourceKey, remoteSessionId }, source: surface.source,
        providerOps: { pageTranscript: surface.providerOps.pageTranscript, readAfterTranscript: surface.providerOps.readAfterTranscript },
        options: { projection: 'terminal', initialReplay: true }, isCurrent: () => true,
        listener: consume });
      const result = !kind.startsWith('runner_') || kind === 'runner_retired' ? await execute() : await (async () => {
        const { createRunnerAgentDaemonFacets } = await import('@/agent/runtime/session/process/runnerAgentDaemonFacets');
        const { createRunnerAgentDaemonFacetService } = await import('@/daemon/agentRuntime/runnerAgentDaemonFacetService');
        const { AGENT_RUNTIME_DAEMON_SERVICES_PATH, AgentRuntimeDaemonServiceRequestV1Schema, AgentRuntimeDaemonServiceResponseV1Schema } = await import('@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol');
        const { RunnerAgentDaemonFacetOperationV1Schema } = await import('@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol');
        const { createAgentSessionRunnerFactoryBinding } = await import('@/plugins/runtime/runner/agentSessionRunnerFactoryBinding');
        const { createExternalSessionHostOperationOwner } = await import('./hostOperationOwner');
        const { createExternalSessionFollowTargetHostOperation } = await import('./followTargetHostOperation');
        const settings = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
        const { accountSettingsParse, ingestPluginManifestV2 } = await import('@happier-dev/protocol');
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-claude/manifest');
        settings.setActiveAccountSettingsSnapshot({ source: liveAppend ? 'cache' : 'network', settings: accountSettingsParse({}), settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'runner-follow' });
        const manifest = ingestPluginManifestV2(PLUGIN_MANIFEST);
        if (!manifest.ok) throw new Error('Claude manifest unavailable');
        const definition = manifest.manifest.contributes.agents?.find(agent => agent.id === 'claude');
        if (!definition) throw new Error('Claude Agent unavailable');
        const retainedAgent = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: PLUGIN_MANIFEST.id,
          pluginVersion: PLUGIN_MANIFEST.version, agentId: 'claude', localAgentId: 'claude',
          sourceCustody: { kind: 'managed', immutableGenerationId: 'runner-generation', installSource: 'localPath' },
          locator: { module: './agent/factory.js', export: 'createAgentRuntime', runtimeApiVersion: 1 },
          normalizedModulePath: 'agent/factory.js', loadMode: 'immutable-js' });
        const owner = createExternalSessionHostOperationOwner();
        const operations = { followOperation: operation, followTargetOperation: createExternalSessionFollowTargetHostOperation({ machineId: 'machine' }) };
        await owner.install(operations);
        const runner = { pid: 42, processStartTimeMs: 1, processCommandHash: 'a'.repeat(64), snapshotIdentity: 'runner' };
        const tracked: import('@/daemon/types').TrackedSession = { startedBy: 'daemon', pid: runner.pid, sessionRunnerPid: runner.pid,
          happySessionId: sessionId, processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash,
          runnerAgentSourceCustodyV1: retainedAgent.sourceCustody };
        const { authorizeTrackedRunnerAgentDaemonServiceOperation } = await import('@/daemon/agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation');
        let runnerWitness: import('@/agent/runtime/session/process/agentRuntimeDaemonServiceTurnWitness').AgentRuntimeDaemonServiceTurnWitnessInputV1 | null = null;
        let holdNext = false;
        let nextEntered!: () => void;
        const nextPending = new Promise<void>(resolve => { nextEntered = resolve; });
        let releaseNext!: () => void;
        const nextReleased = new Promise<void>(resolve => { releaseNext = resolve; });
        const daemon = createRunnerAgentDaemonFacetService({ machineId: 'machine', externalSessionHostOperationOwner: owner,
          authorizeCurrent: async input => authorizeTrackedRunnerAgentDaemonServiceOperation({ ...input, tracked, witness: undefined, allowIdleCurrentGeneration: true }),
          authorizeActiveTurn: async input => authorizeTrackedRunnerAgentDaemonServiceOperation({ ...input, tracked, allowIdleCurrentGeneration: false }),
          resolveRetainedExternalSessionAgentContribution: async () => ({ id: 'claude',
            identity: { pluginId: PLUGIN_MANIFEST.id, localId: 'claude' }, richDefinition: { provenance: 'first_party', definition } }),
          snapshotVoiceAuthority: async () => ({ agentSourceCustody: retainedAgent.sourceCustody, providers: [] }),
          waitVoiceAuthorityRetired: async () => {} });
        const { validateSource, resolveLinkIdentity, pageTranscript, readAfterTranscript: nativeReadAfter } = surface.providerOps;
        if (!validateSource || !resolveLinkIdentity || !pageTranscript || !nativeReadAfter) throw new Error('Claude surface unavailable');
        const readAfterTranscript: typeof nativeReadAfter = async request => {
          if (liveAppend) replayStages.readAfter++;
          return await nativeReadAfter(request);
        };
        let closeHttp = async () => {};
        let disposeConfigured = async () => {};
        let sendHttp: ((request: Parameters<typeof AgentRuntimeDaemonServiceRequestV1Schema.parse>[0], signal?: AbortSignal) => Promise<ReturnType<typeof AgentRuntimeDaemonServiceResponseV1Schema.parse>>) | undefined;
        if (kind.startsWith('runner_http')) {
          const { createDaemonControlApp } = await import('@/daemon/controlServer');
          const { configuration } = await import('@/configuration');
          const { createAgentRuntimeDaemonServiceAuthorityPath, publishAgentRuntimeDaemonServiceAuthority,
            removeAgentRuntimeDaemonServiceAuthorityIfOwned } = await import('@/daemon/agentRuntime/sessionBridgeAuthorization');
          const { buildDaemonControlHttpHeaders, readDaemonControlHttpResponse } = await import('@/daemon/controlHttp');
          const authorityPath = await createAgentRuntimeDaemonServiceAuthorityPath({ happyHomeDir: configuration.happyHomeDir,
            publicReleaseRing: configuration.publicReleaseRing });
          let capabilityDigest = '';
          Object.assign(tracked, { agentRuntimeDaemonServiceAuthorityFilePath: authorityPath, agentRuntimeDaemonServiceCapabilityHash: '',
            runnerAgentInvocationContext: { cwd: root, environment: {}, providerBindingActive: true } });
          const app = createDaemonControlApp({ machineId: 'machine',
            getChildren: () => [tracked],
            stopSession: async () => ({ status: 'not_found' as const }),
            spawnSession: async () => ({ type: 'success' as const, sessionId: 'unused' }),
            requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'control-token',
            agentRuntimeDaemonServices: { dispatch: async (request, context) => ({ ok: true,
              result: await daemon.dispatch({ sessionId, runner, retainedAgent,
                operation: RunnerAgentDaemonFacetOperationV1Schema.parse(request.operation), signal: context.signal }) }) } });
          closeHttp = async () => {
            await app.close();
            if (capabilityDigest) await removeAgentRuntimeDaemonServiceAuthorityIfOwned({ happyHomeDir: configuration.happyHomeDir,
              publicReleaseRing: configuration.publicReleaseRing, path: authorityPath, capabilityDigest });
          };
          disposeTransport = async () => { await closeHttp(); await daemon.dispose(); await owner.retire(); settings.resetActiveAccountSettingsSnapshotForTests(); };
          await app.listen({ host: '127.0.0.1', port: 0 });
          const address = app.server.address();
          if (!address || typeof address === 'string') throw new Error('Expected the real control HTTP listener');
          const { capabilityDigest: publishedDigest } = await publishAgentRuntimeDaemonServiceAuthority({
            happyHomeDir: configuration.happyHomeDir, publicReleaseRing: configuration.publicReleaseRing,
            path: authorityPath, sessionId, runner, retainedAgent, httpPort: address.port, capability: 'A'.repeat(43),
            readPluginHardRevocationRevision: async () => 0 });
          capabilityDigest = publishedDigest;
          tracked.agentRuntimeDaemonServiceCapabilityHash = publishedDigest;
          sendHttp = async (request, signal) => {
            const wire = AgentRuntimeDaemonServiceRequestV1Schema.parse(request);
            if (holdNext && wire.operation.kind === 'external_session.follow.next') {
              holdNext = false;
              nextEntered();
              await nextReleased;
            }
            const response = await readDaemonControlHttpResponse({ httpPort: address.port,
              path: AGENT_RUNTIME_DAEMON_SERVICES_PATH, headers: buildDaemonControlHttpHeaders('A'.repeat(43)), body: request,
              ...(signal ? { signal } : {}) });
            expect(response.status).toBe(200);
            return AgentRuntimeDaemonServiceResponseV1Schema.parse(JSON.parse(response.body));
          };
        }
        const facets = await createRunnerAgentDaemonFacets({ authority: { happyHomeDir: root, publicReleaseRing: 'stable',
          path: join(root, 'authority.json'), sessionId, runner, retainedAgent },
          readActiveTurnAdmissionWitness: () => runnerWitness,
          resolveRetainedExternalSessionProviderOps: async () => ({ validateSource, resolveLinkIdentity, pageTranscript, readAfterTranscript }),
          dispatch: async input => {
            const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(JSON.parse(JSON.stringify(input.createRequest('A'.repeat(43)))));
            if (sendHttp) return await sendHttp(request, input.signal);
            return AgentRuntimeDaemonServiceResponseV1Schema.parse({ ok: true,
              result: await daemon.dispatch({ sessionId, runner, retainedAgent,
                operation: RunnerAgentDaemonFacetOperationV1Schema.parse(request.operation), signal: input.signal }) });
          } });
        disposeTransport = async () => { await disposeConfigured(); await facets.dispose(); await closeHttp(); await daemon.dispose(); await owner.retire(); settings.resetActiveAccountSettingsSnapshotForTests(); };
        const port = facets.externalSessionHostOperations.bindSession(sessionId);
        if (liveAppend) {
          if (!nativePublisher) throw new Error('Expected native publisher');
          const publisher = nativePublisher;
          const { createNativeAgentRuntimeSessionPlanFixture, createExternalContributionFixtures, createSessionHostServiceOwners } = await import('@/agent/runtime/registry/engineRegistry/nativeAgentSession.testkit');
          const { buildPluginSessionBindingInput } = await import('@/plugins/runtime/runtimeCore/plugin/sessionLaunch');
          const { subscribeSessionRuntimePublicationToMetadata } = await import('@/agent/runtime/identity/metadata/subscription');
          const { createCliRuntimeSessionStateBridge } = await import('@/agent/runtime/state/bridge');
          const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
          const { ProviderEnforcedPermissionHandler } = await import('@/agent/permissions/providerEnforced/handler');
          const { MessageQueue2 } = await import('@/agent/runtime/modeMessageQueue');
          const { MessageBuffer } = await import('@/ui/ink/messageBuffer');
          const { createPluginTranscriptFileFollowService } = await import('@/plugins/runtime/context/transcripts/fileFollow');
          const { createTranscriptFileFollowPathGrantRegistry } = await import('@/plugins/runtime/context/transcripts/fileFollowGrants');
          const { createSessionHooksService } = await import('@/plugins/runtime/hooks/session/service');
          const { resolveBackendExecutionSurfacesFromNativeAgentRuntime } = await import('@/agent/runtime/registry/backendEngineSurfaceBindings');
          const { createStablePluginSettingsHost, createAccountSettingsBackedSettingsRecordStore } = await import('@/plugins/runtime/invocation/services/settings');
          const { createStablePluginEventsBroker } = await import('@/plugins/runtime/invocation/services/events');
          const { PluginSettingsContributionV2Schema } = await import('@happier-dev/protocol');
          const runtimePath = '../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime.ts';
          const nativeSessionPath = '../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession.ts';
          const testkitPath = '../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit.ts';
          const { createClaudeNativeRuntime }: typeof import('../../../../../packages/plugins/claude/src/agent/runtime/nativeRuntime') = await import(runtimePath);
          const { openClaudeNativeUnifiedTerminalSession }: typeof import('../../../../../packages/plugins/claude/src/agent/runtime/terminal/unified/nativeSession') = await import(nativeSessionPath);
          const { createTerminalHostFixture }: typeof import('../../../../../packages/plugins/claude/src/agent/runtime/engine.testkit') = await import(testkitPath);
          const terminal = createTerminalHostFixture();
          const grants = createTranscriptFileFollowPathGrantRegistry();
          const fileFollow = createPluginTranscriptFileFollowService({ pluginId: PLUGIN_MANIFEST.id,
            runtimeId: sessionId, readSessionId: () => sessionId, fileFollowPathGrants: grants });
          const hooks = createSessionHooksService({ happyHomeDir: root, hasCapability: capability => capability === 'sessionHooks',
            grantTranscriptFileFollowPath: async request => {
              await grants.grant({ pluginId: PLUGIN_MANIFEST.id, runtimeId: sessionId,
                scope: { kind: 'session', sessionId }, path: request.transcriptPath, reason: 'providerTranscriptSource',
                evidence: { kind: 'sessionStartTranscriptPath', providerSessionId: request.providerSessionId } });
            },
          });
          let hookServer: Awaited<ReturnType<typeof hooks.startServer>> | undefined;
          const hostOwners = { ...createSessionHostServiceOwners(), terminalHost: terminal.service,
            sessionHooks: { ...hooks, startServer: async (request: Parameters<typeof hooks.startServer>[0]) => {
              hookServer = await hooks.startServer(request);
              return hookServer;
            } }, transcripts: { fileFollow: { follow: async (input: Parameters<typeof fileFollow.follow>[0]) => {
              return await fileFollow.follow({ ...input, onLine: async row => {
                replayStages.rawLines++;
                await input.onLine(row);
              } });
            } } } };
          const runtime: import('@happier-dev/plugin-sdk/agents/runtime').AgentRuntime = createClaudeNativeRuntime({
            openSession: openClaudeNativeUnifiedTerminalSession,
            resolveSupportsEffort: async () => false,
            resolveSupportsSystemPromptSnapshotOff: async () => false,
          });
          const base = createExternalContributionFixtures('claude');
          const backend = { ...base.backend, pluginId: PLUGIN_MANIFEST.id, provenance: 'first_party' as const, source: { kind: 'bundled' as const } };
          const agent = fixture.registry.contributes.agentDefinitionsById.get('claude');
          const nativeLease = fixture.registry.agentRuntimesByAgentId.get('claude');
          if (!agent || !nativeLease) throw new Error('Expected admitted Claude Agent');
          const settingsHost = createStablePluginSettingsHost({
            declarations: (manifest.manifest.contributes.settings ?? []).map(contribution => ({ pluginId: PLUGIN_MANIFEST.id,
              contribution: PluginSettingsContributionV2Schema.parse(contribution) })),
            broker: createStablePluginEventsBroker(),
            recordStore: createAccountSettingsBackedSettingsRecordStore({ async bindOperation() { return {
              async readRecord() { return { status: 'present' as const, revision: 1, values: {} }; },
              async writeRecord() { throw new Error('Replay must not write Account settings'); },
            }; } }),
          });
          const nativeSettings = settingsHost.bind({ plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: 'claude', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/claude` }, occurrenceId: nativeLease.occurrenceId,
            correlationId: sessionId, surface: 'agent', signal: nativeLease.retirementSignal, isOccurrenceCurrent: nativeLease.isCurrent });
          if (!nativeSettings) throw new Error('Expected Claude settings');
          let identitySubscription: ReturnType<typeof subscribeSessionRuntimePublicationToMetadata> | undefined;
          let metadata = createTestMetadata({ ...sessionMetadata, claudeSessionId: undefined });
          const bridge = createCliRuntimeSessionStateBridge({ session: publisher, credentials,
            ...(pendingFollowup ? {} : { metadataPort: { update: async (_id: string, update: (current: import('@/api/types').Metadata) => import('@/api/types').Metadata) => {
              // Home metadata persistence is the genuine system boundary;
              // the identity state engine and publication subscriber are real.
              metadata = createTestMetadata(update(metadata));
              if (metadata.claudeSessionId === remoteSessionId) replayStages.identityAck++;
              return { ok: true, version: replayStages.identityAck + 1 };
            } } }),
          });
          const nativePlan = await createNativeAgentRuntimeSessionPlanFixture({ runtime,
            lease: nativeLease,
            backend, agent,
            sessionInput: buildPluginSessionBindingInput({ credentials, directory: root, startingMode: 'terminal',
              backendTarget: { kind: 'backend', backendId: 'claude' }, environmentVariables: { CLAUDE_CONFIG_DIR: configDir },
              modelSelection: { v: 1, updatedAt: 1, ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null,
                modelId: replay?.model ?? 'default' } } }),
            executionSurfaces: {
              ...resolveBackendExecutionSurfacesFromNativeAgentRuntime({ backend, runtime, agentId: 'claude',
                isCurrent: nativeLease.isCurrent, declaredAgentSurfaceFamilies: new Set(['terminalRuntime']), diagnostics: [] }),
              externalSession: surface.providerOps,
            },
            externalSessionHostOperations: { bindSession: () => {
              const nativePort = facets.externalSessionHostOperations.bindSession(sessionId);
              return { ...nativePort,
              executeFollow: async request => {
                replayStages.target++;
                const result = await nativePort.executeFollow({ ...request, listener: async event => {
                  events.push(event);
                  if (event.kind === 'data') {
                    replayStages.sourceItems += event.items.filter(item => item.kind === 'source_observation').length;
                    replayStages.displayItems += event.items.filter(item => item.kind === 'agent').length;
                    if (event.nextCursor) replayStages.cursor++;
                  }
                  await request.listener(event);
                } });
                if (result.status === 'following') replayStages.bind++;
                return result;
              },
            }; } }, createSessionHostServiceOwners: () => hostOwners,
            createInvocationServices: async () => {
              const invocation = await nativeLease.createAgentRuntimeSurfaceInvocationContext({ cwd: root, happierSessionId: sessionId });
              return { ...invocation.services, settings: nativeSettings };
            },
            reportSessionMetadataToDaemon: async () => {},
          });
          let promptPlan: import('@/agent/prompting/coding/sessionPromptPlan').SessionPromptPlanResolver | undefined;
          if (pendingFollowup) {
            const { emptyPromptLibraryRecordV1 } = await import('@happier-dev/protocol/prompts/library/promptLibraryCatalogV1');
            const { PromptLibraryCatalogKeyV1Schema } = await import('@happier-dev/protocol/prompts/library/promptLibraryRowsV1');
            const account = settings.getActiveAccountSettingsSnapshot()!;
            settings.setActiveAccountSettingsSnapshot({ ...account, promptLibraryCatalog: { status: 'ready',
              rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1, record: emptyPromptLibraryRecordV1(key) })),
              tombstones: [], diagnostics: [] } });
            const { createSessionPromptPlanResolver } = await import('@/agent/prompting/coding/sessionPromptPlan');
            promptPlan = createSessionPromptPlanResolver({ opts: { credentials }, session: publisher, agentId: 'claude', machineId: 'machine',
              directory: root, memoryRecallGuidanceEnabled: false, readNativeSessionId: () => null });
          }
          const created = await nativePlan.config.createSessionRuntime!({ directory: root, metadata, machineId: 'machine',
            agentTargetKey: 'agent:happier.agent.claude/claude',
            session: publisher, transcriptSession: publisher, messageBuffer: new MessageBuffer(),
            messageQueue: new MessageQueue2<import('@/agent/runtime/permissions/queuedPrompt').PermissionModeQueuedPromptMode,
              import('@/agent/runtime/permissions/queuedPrompt').PermissionModeQueuedPrompt>(mode => mode.permissionMode),
            mcpServers: {}, permissionHandler: new ProviderEnforcedPermissionHandler(publisher, { logPrefix: '[c14-replay]' }),
            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
            runnerProcessIdentity: null, startupModelSelection: null,
            resolveFreshSessionSystemPrompt: promptPlan,
            runWithTerminalModelSelection: async effect => ({ status: 'completed',
              value: await effect(null, async localEffect => ({ status: 'completed', value: await localEffect() })),
            }),
            waitForProviderSessionIdPublication: async (id, signal) => {
              if (!identitySubscription) throw new Error('Native identity subscriber unavailable');
              await identitySubscription.waitForProviderSessionIdPublication(id, signal);
            },
          });
          identitySubscription = subscribeSessionRuntimePublicationToMetadata({ session: publisher, sessionState: bridge.engine,
            runtime: created.operations, providerSessionMetadataKey: 'claudeSessionId' });
          // The host runtime feeds this observer from its canonical event watch (publishHostRuntimeEvent).
          const unsubscribeIdentityEvents = created.operations.subscribeRuntimeEvents(event => {
            if ('kind' in event) identitySubscription?.observeRuntimeEvent(event);
          });
          disposeConfigured = async () => { unsubscribeIdentityEvents(); identitySubscription?.(); await created.operations.resetOrDisposeRuntime(); await hookServer?.dispose(); };
          if (pendingFollowup) {
            const { createHostRuntimeActivityProjection } = await import('@/agent/runtime/session/activity/createHostRuntimeActivityProjection');
            const activity = createHostRuntimeActivityProjection({ sessionId, agentRuntimeApplicability: 'supported',
              enqueueRegisteredSessionStateFieldMutation: mutation => publisher.enqueueRegisteredSessionStateFieldMutation(mutation) });
            const binding = activity.bindAgentRuntime({ applicability: 'supported' });
            const unsubscribe = created.operations.subscribeRuntimeEvents(event => { void binding.observeEvent(event); });
            const disposeNative = disposeConfigured;
            disposeConfigured = async () => { await disposeNative(); unsubscribe(); activity.dispose(); };
          }
          const startup = await created.prepareStartupPresentation!();
          // Native terminal execution is the external boundary. Its genuine
          // SessionStart hook discovers and proves the native JSONL source.
          if (!hookServer?.sessionHookSecretFile) throw new Error('Expected native hook server');
          replayNativeHook = async payload => {
            // Prompt-plan preparation can replace the native incarnation. Its
            // newly spawned forwarder reads that incarnation's current secret.
            const secret = (await readFile(hookServer!.sessionHookSecretFile!, 'utf8')).trim();
            const hook = await fetch(`http://127.0.0.1:${hookServer!.port}/hook/session-start`, { method: 'POST',
              headers: { 'content-type': 'application/json', 'x-happier-hook-secret': secret },
              body: JSON.stringify({ session_id: remoteSessionId, transcript_path: nativePath, ...payload }) });
            expect(hook.status).toBe(200);
          };
          if (interruptRecovery) interruptAndRecover = async () => {
            // The network can carry a poll admitted in the previous turn across
            // cancellation. Keep the real daemon authorizer and settlement owner.
            const witness = { turnId: 'long-interrupted', inputId: 'long-input', userMessageSeq: 20, userMessageSeqs: [20] };
            runnerWitness = witness;
            Object.assign(tracked, { activeTurnId: witness.turnId, agentRuntimeDaemonServiceAdmittedTurnId: witness.turnId,
              agentRuntimeDaemonServiceAdmittedInputId: witness.inputId, agentRuntimeDaemonServiceAdmittedUserMessageSeq: witness.userMessageSeq,
              agentRuntimeDaemonServiceAdmittedUserMessageSeqs: witness.userMessageSeqs });
            holdNext = true;
            await replayNativeHook!({ hook_event_name: 'UserPromptSubmit', prompt: 'Continue the long report.' });
            const common = { sessionId: remoteSessionId, timestamp: new Date().toISOString(), isSidechain: false };
            const row = (value: unknown) => JSON.stringify(value) + '\n';
            await appendFile(nativePath, row({ ...common, type: 'user', uuid: 'interrupt-user', parentUuid: 'native-long-answer',
              message: { role: 'user', content: 'Continue the long report.' } }));
            await nextPending;
            try {
              await created.operations.cancelTurn();
              const { clearTrackedRunnerAgentDaemonServiceAdmission } = await import('@/daemon/agentRuntime/clearTrackedRunnerAgentDaemonServiceAdmission');
              clearTrackedRunnerAgentDaemonServiceAdmission(tracked);
              delete tracked.activeTurnId;
              runnerWitness = null;
              expect(vi.mocked(terminal.service.interruptTurn)).toHaveBeenCalled();
            } finally { releaseNext(); }
            await appendFile(nativePath, row({ ...common, type: 'assistant', uuid: 'partial-answer', parentUuid: 'interrupt-user',
              message: { role: 'assistant', content: [{ type: 'text', text: 'Partial long reply.' }], stop_reason: null } })
              + row({ ...common, type: 'user', uuid: 'native-interruption', parentUuid: 'partial-answer',
                message: { role: 'user', content: '[Request interrupted by user]' } }));
            await replayNativeHook!({ hook_event_name: 'UserPromptSubmit', prompt: 'Recover with a short reply.' });
            await appendFile(nativePath, row({ ...common, type: 'user', uuid: 'recovery-user', parentUuid: 'native-interruption',
              message: { role: 'user', content: 'Recover with a short reply.' } })
              + row({ ...common, type: 'assistant', uuid: 'recovery-answer', parentUuid: 'recovery-user',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Recovery complete.' }], stop_reason: 'end_turn' } }));
            await replayNativeHook!({ hook_event_name: 'Stop', stop_hook_active: false });
            await vi.waitFor(() => expect(replayStages.durableRecoveryAck).toBe(1), { timeout: 10000 });
            expect(manager.countActiveLeases(sessionId)).toBe(1);
          };
          await replayNativeHook({ hook_event_name: 'SessionStart', source: 'startup' });
          if (!replay) throw new Error('Expected buffered native transcript');
          if (pendingFollowup) {
            const { createPermissionModeQueueState } = await import('@/agent/runtime/createPermissionModeQueueState');
            const { runSessionLoopLifecycle } = await import('@/agent/runtime/session/loop/lifecycle');
            const { runPermissionModePromptLoop } = await import('@/agent/runtime/runPermissionModePromptLoop');
            const { registerRunnerTerminationHandlers } = await import('@/agent/runtime/lifecycle/runnerTerminationHandlers');
            const { createSessionProviderInputConsumer } = await import('@/agent/runtime/session/input/sessionProviderInputConsumer');
            const { createSessionProviderInputConsumerSessionAdapter } = await import('@/agent/runtime/waitForNextPermissionModeMessage');
            const queueState = createPermissionModeQueueState({ session: publisher,
              agentTargetKey: 'agent:happier.agent.claude/claude', initialPermissionMode: 'default' });
            const inputConsumer = createSessionProviderInputConsumer({ messageQueue: queueState.messageQueue,
              session: createSessionProviderInputConsumerSessionAdapter(publisher), reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false });
            let ready = 0;
            let loopFailure: string | null = null;
            let stopLoop: (() => Promise<void>) | undefined;
            queueState.messageQueue.pushIsolate({ text: replay.firstPrompt, localId: 'first', localIds: ['first'] }, { permissionMode: 'default' });
            const loop = runSessionLoopLifecycle({ opts: { credentials, permissionMode: 'default' },
              config: { ...nativePlan.config, shouldRenderTerminalDisplay: () => false, processLifecycleOwnership: 'caller',
                createSendReady: () => () => { ready++; }, onRuntimeStopReady: stop => { stopLoop = stop; } },
              api: { push: () => ({ sendToAllDevices: async () => {}, sendToAllDevicesAsync: async () => true }) },
              session: publisher, runtime: created.operations, hookRuntime: created.operations,
              messageBuffer: new MessageBuffer(), permissionHandler: new ProviderEnforcedPermissionHandler(publisher, { logPrefix: '[pending-followup]' }),
              permissionModeState: queueState, registerProviderAcceptedEffect: () => {},
              sessionSwapStrategy: { requestSessionSwap: async () => {} }, runtimeDirectory: root, runtimeMetadata: metadata,
              machineId: 'machine', memoryRecallGuidanceEnabled: false, policyAgentId: 'claude',
              setActiveAgentCompositionToolSelection: () => {}, happyMcpServerStop: () => {}, reconnectionHandle: null,
              startupCoordinator: null, runtimeState: { thinking: false }, setAbortRequestedCallback: () => {},
              transitionModelSelection: async selection => ({ ok: true, status: 'already_active', activeSelection: selection }),
              resolveFreshSessionSystemPrompt: promptPlan,
              deps: { registerRunnerTerminationHandlersFn: input => registerRunnerTerminationHandlers({ ...input, exit: () => {} }),
                runPermissionModePromptLoopFn: input => runPermissionModePromptLoop({ ...input, inputConsumer }) },
              initialResumeId: '' });
            void loop.catch(error => { loopFailure = error instanceof Error ? error.message : 'unknown'; });
            const disposeNative = disposeConfigured;
            disposeConfigured = async () => { await stopLoop?.(); await disposeNative(); await loop.catch(error => {
              if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
            }); };
            await vi.waitFor(() => expect(vi.mocked(terminal.service.injectUserPrompt).mock.calls
              .some(([, input]) => input.text.includes(replay.firstPrompt)), loopFailure ?? 'first prompt not injected').toBe(true), { timeout: 15000 });
            firstNativePrompt = vi.mocked(terminal.service.injectUserPrompt).mock.calls.find(([, input]) => input.text.includes(replay.firstPrompt))![1].text;
            await replayNativeHook({ hook_event_name: 'SessionStart', source: 'startup' });
            enqueueFollowup = async () => {
              await vi.waitFor(() => expect(ready).toBe(1), { timeout: 15000 });
              const hostCount = vi.mocked(terminal.service.createOrAttachHost).mock.calls.length;
              publishPending!();
              expect(publisher.getPendingQueueState()).toMatchObject({ known: true, pendingCount: 1, pendingVersion: 2 });
              // A changed plan can resume the native process; an unchanged
              // plan can deliver directly. Drive a real hook only on reopen.
              await vi.waitFor(() => expect(vi.mocked(terminal.service.createOrAttachHost).mock.calls.length > hostCount
                || vi.mocked(terminal.service.injectUserPrompt).mock.calls.some(([, input]) => input.text.includes(replay.longPrompt)),
              loopFailure ?? 'Pending follow-up was not dispatched').toBe(true), { timeout: 15000 });
              followupReopenedNative = vi.mocked(terminal.service.createOrAttachHost).mock.calls.length > hostCount;
              if (followupReopenedNative) await replayNativeHook!({ hook_event_name: 'SessionStart', source: 'resume' });
              await vi.waitFor(() => expect(vi.mocked(terminal.service.injectUserPrompt).mock.calls
                .some(([, input]) => input.text.includes(replay.longPrompt))).toBe(true), { timeout: 15000 });
              followupNativePrompt = vi.mocked(terminal.service.injectUserPrompt).mock.calls.find(([, input]) => input.text.includes(replay.longPrompt))![1].text;
            };
          }
          await replayNativeHook({ hook_event_name: 'UserPromptSubmit', prompt: firstNativePrompt });
          const echoPrompt = (rows: string, text: string) => rows.split('\n').filter(Boolean).map(line => {
            const row = JSON.parse(line);
            if (row.type === 'user') row.message.content = text;
            return JSON.stringify(row) + '\n';
          }).join('');
          await appendFile(nativePath, pendingFollowup ? echoPrompt(replay.prefix, firstNativePrompt) : replay.prefix);
          await vi.waitFor(() => expect(replayStages.bind).toBe(1), { timeout: 15000 });
          if (pendingFollowup) await replayNativeHook({ hook_event_name: 'Stop', stop_hook_active: false });
          if (!pendingFollowup) expect(replayStages.identityAck).toBeGreaterThan(0);
          expect(startup).toBeDefined();
          return { status: 'following' as const, startingCursor: 'native-host-admitted', subscription: { dispose: async () => {} } };
        }
        if (usesPublisher) {
          const { createLiveConfiguredPluginExternalSessionsAdapter } = await import('./configuredSourceMaterializer');
          const lifecycle = await createLiveConfiguredPluginExternalSessionsAdapter({
            resolveCatalogEntry: async () => null,
            agents: [{ id: 'claude', identity: { pluginId: PLUGIN_MANIFEST.id, localId: 'claude' },
              richDefinition: { provenance: 'first_party', definition } }],
            activeServerDir: root,
            // The Account HTTP boundary returns no connected profile fixture;
            // configured native-source materialization and selection stay real.
            readAccount: async () => ({ connectedServicesV2: [] }),
            readAccountRevision: () => settings.resolveActiveAccountConfiguredExternalSessionSourceRevision(settings.getActiveAccountSettingsSnapshot()),
            subscribeAccountRevision: listener => settings.subscribeActiveAccountSettingsSnapshot((_previous, next) =>
              listener(settings.resolveActiveAccountConfiguredExternalSessionSourceRevision(next))),
            isCurrent: () => observation!.resource.retirementSignal?.aborted !== true,
            resolveAgentOccurrence: () => ({ occurrenceId: observation!.resource.occurrenceId,
              isCurrent: () => observation!.resource.retirementSignal?.aborted !== true }),
            resolveAgentSourceCustody: () => retainedAgent.sourceCustody,
            resolveProviderOps: async () => surface.providerOps,
            attach: async () => ({ sessionId }),
            followTranscript: request => port.executeFollow(request),
          });
          disposeConfigured = () => lifecycle.dispose();
          const signal = new AbortController().signal;
          const target = await lifecycle.compositionPort.resolveFollowTarget({ agentId: 'claude', remoteSessionId, signal });
          expect(target.status).toBe('resolved');
          if (target.status !== 'resolved') throw new Error('Expected the configured native source');
          if (usesTerminalService) {
            const { createHostTerminalTranscriptFollowService } = await import('@/agent/runtime/session/terminal/transcriptFollow');
            if (!terminalPublish) throw new Error('Expected the real terminal publisher');
            const service = createHostTerminalTranscriptFollowService({ signal, loadCommittedLocalIdBaseline: publisherBaseline,
              followProviderSession: (request, consume) => lifecycle.compositionPort.followTranscript(target, {
                projection: 'terminal', initialReplay: request.initialReplay, replay: request.replay,
                signal: request.signal, admissionDeadlineAtMs: request.admissionDeadlineAtMs,
              }, consume),
              publish: terminalPublish,
            });
            disposeConfigured = async () => { await service.releaseActiveBindings(); await lifecycle.dispose(); };
            const bind = () => service.bindProviderSession({ agentId: 'claude', providerSessionId: remoteSessionId, replay: 'fresh', signal });
            if (concurrentCommit) {
              await expect(bind()).resolves.toMatchObject({ status: 'unavailable', code: 'plugin_external_follow_acquisition_failed' });
              events.length = 0;
            }
            const binding = await bind();
            if (binding.status !== 'following') return binding;
            return { status: 'following' as const, startingCursor: binding.startingCursor,
              subscription: { dispose: () => binding.binding.dispose() } };
          }
          return await lifecycle.compositionPort.followTranscript(target, { projection: 'terminal', replay: 'fresh',
            initialReplay: true, signal }, listener);
        }
        if (kind === 'runner_http_cancelled_acquisition' || retiresAcquisition) {
          const cancelled = new AbortController();
          const first = port.executeProviderSessionFollow({ agentId: 'claude', providerSessionId: remoteSessionId,
            options: { projection: 'terminal', initialReplay: true, signal: cancelled.signal }, listener })
            .then(value => ({ value }), error => ({ error }));
          await acquisitionPending;
          if (kind === 'runner_http_cancelled_acquisition') {
            cancelled.abort();
            const cancelledResult = await first;
            expect('error' in cancelledResult || cancelledResult.value.status === 'unavailable').toBe(true);
          } else {
            await owner.install(operations);
          }
          const replacement = port.executeProviderSessionFollow({ agentId: 'claude', providerSessionId: remoteSessionId,
            options: { projection: 'terminal', initialReplay: true }, listener });
          releaseAcquisition();
          await first;
          return await replacement;
        }
        return port.executeProviderSessionFollow({ agentId: 'claude', providerSessionId: remoteSessionId,
          options: { projection: 'terminal', initialReplay: true, ...(kind === 'runner_http_fresh' || kind === 'runner_http_fresh_publisher' ? { replay: 'fresh' as const } : {}) }, listener });
      })();
      if (kind === 'listener_failure') {
        expect(result).toEqual({ status: 'unavailable', code: 'plugin_external_follow_acquisition_failed' });
        expect(manager.countActiveLeases(sessionId)).toBe(0);
        return;
      }
      if (kind === 'oversized_native_row') {
        // A record beyond the read allowance fails explicitly (JSONL_RECORD_TOO_LARGE) instead of looping a no-progress resync.
        expect(result).toMatchObject({ status: 'unavailable', code: 'plugin_external_follow_acquisition_failed' });
        expect(events.filter(event => event.kind === 'data')).toEqual([]);
        expect(manager.countActiveLeases(sessionId)).toBe(0);
        return;
      }
      if (retiresAcquisition) {
        expect(result.status === 'unavailable' ? result.code : result.status).toBe('following');
      }
      expect(result).toMatchObject({ status: 'following', startingCursor: expect.any(String) });
      if (result.status === 'following') subscription = result.subscription;
      if (replay) {
        const { acquireCanonicalExternalSessionFollowLease } = await import('@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease');
        const { EXTERNAL_SESSIONS_INVOCATION_POLICY } = await import('./agentExternalSessionsInvocation');
        if (!observation) throw new Error('Expected real observation resource');
        const viewerResource = { linkGeneration: loaded.session.linkGeneration, occurrenceId: observation.resource.occurrenceId,
          retirementSignal: observation.resource.retirementSignal };
        const viewer = await manager.attach({ sessionId, ttlMs: 30_000, resource: viewerResource,
          acquireFollowLease: initialCursor => acquireCanonicalExternalSessionFollowLease({ sessionId, machineId: 'machine',
            linked: loaded.session, resource: viewerResource, observation, providerOps: surface.providerOps,
            initialCursor, maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
            maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
            observationProjection: projection, credentials,
          }) });
        await manager.detach({ sessionId, leaseId: viewer.leaseId });
        expect(manager.countActiveLeases(sessionId)).toBe(1);
        const settings = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
        const cached = settings.getActiveAccountSettingsSnapshot();
        if (!cached) throw new Error('Expected active cached Account settings');
        expect(settings.commitActiveProfileCatalog({ scopeKey: cached.scopeKey!,
          lifetimeToken: settings.getActiveAccountSettingsSnapshotLifetimeToken(),
          catalog: { status: 'ready', authority: 'inactive', control: null, controlRevision: 'absent',
            records: [], diagnostics: [], referenceGuardRevision: 7 } })).toBe(true);
        // A delivery preference is not a native transcript source change. The
        // existing follow must carry the later durable reply without rebinding.
        if (!pendingFollowup) {
          settings.setActiveAccountSettingsSnapshot({ ...settings.getActiveAccountSettingsSnapshot()!,
            settingsVersion: cached.settingsVersion + 1,
            settings: { ...cached.settings, sessionPendingQueueDeliveryTiming: cached.settings.sessionPendingQueueDeliveryTiming === 'after_runtime_idle'
              ? 'after_foreground_ready' : 'after_runtime_idle' } });
        }
        expect(replay.longText.split('\n')).toHaveLength(400);
        expect(replay.longText).toHaveLength(33281);
        await vi.waitFor(() => expect(replayStages.durableAck).toBeGreaterThan(0), { timeout: 10000 });
        const firstCursor = events.filter(event => event.kind === 'data').at(-1)?.nextCursor;
        expect(firstCursor).toEqual(expect.any(String));
        if (kind === 'runner_http_fresh_terminal_inventory_refresh') {
          // Passive observation invokes this manager operation on Connected
          // Account inventory pushes, including unrelated service changes.
          await manager.releaseSessionsForCredentialInvalidation();
        }
        await enqueueFollowup?.();
        await replayNativeHook!({ hook_event_name: 'UserPromptSubmit', prompt: followupNativePrompt });
        const userEcho = pendingFollowup ? JSON.stringify({ ...JSON.parse(replay.user),
          message: { role: 'user', content: followupNativePrompt } }) + '\n' : replay.user;
        await appendFile(nativePath, userEcho);
        if (kind === 'runner_http_fresh_terminal_inventory_refresh') {
          await vi.waitFor(() => expect(events.filter(event => event.kind === 'data').at(-1)?.nextCursor)
            .not.toBe(firstCursor), { timeout: 10000 });
        }
        await vi.waitFor(() => expect(replayStages.rawLines).toBeGreaterThanOrEqual(3), { timeout: 10000 });
        await replayNativeHook!({ hook_event_name: 'Stop', stop_hook_active: false });
        await appendFile(nativePath, replay.completion);
        await vi.waitFor(() => expect(replayStages.rawLines).toBe(followupReopenedNative ? 8 : 6), { timeout: 10000 });
        await vi.waitFor(() => expect(events.flatMap(event => event.kind === 'data' ? event.items : [])
          .some(item => item.kind === 'agent' && JSON.stringify(item.data).includes(JSON.stringify(replay.longText)))).toBe(true), { timeout: 10000 });
        await vi.waitFor(() => expect(replayStages.durableLongAck).toBeGreaterThan(0), { timeout: 10000 });
        expect(replayStages).toMatchObject(followupReopenedNative
          ? { target: 2, bind: 2, rawLines: 8, durableLongAck: 1 }
          : { target: 1, bind: 1, rawLines: 6, durableLongAck: 1 });
        if (!pendingFollowup) expect(replayStages.identityAck).toBeGreaterThan(0);
        expect(replayStages.readAfter).toBeGreaterThan(0);
        expect(replayStages.cursor).toBeGreaterThan(1);
        expect(events.filter(event => event.kind === 'data').at(-1)?.nextCursor).not.toBe(firstCursor);
        expect(replayStages.sourceItems).toBeGreaterThan(2);
        expect(manager.countActiveLeases(sessionId)).toBe(1);
        await interruptAndRecover?.();
        if (kind === 'runner_http_fresh_terminal_catalog_refresh') {
          settings.clearActiveAccountSettingsSnapshot();
          await vi.waitFor(() => expect(manager.countActiveLeases(sessionId)).toBe(0), { timeout: 10000 });
        }
      }
      expect(events.some(event => event.kind === 'data' && event.providerSessionId === remoteSessionId)).toBe(true);
      if (usesTerminalService) {
        const items = events.flatMap(event => event.kind === 'data' ? event.items : []);
        expect(items.some(item => item.kind === 'source_observation')).toBe(true);
        // The native host observes the daemon transport before the
        // terminal service's committed-ID filter. Home still rejects a rewrite.
        if (!liveAppend) expect(items.some(item => item.kind === 'agent' && (item.localId ?? item.id) === committedBaselineLocalId)).toBe(false);
      }
      if (hasHistory) {
        const nativeRows = events.flatMap(event => event.kind === 'data' ? event.items : [])
          .filter(item => item.kind === 'source_observation').map(item => item.data);
        expect(nativeRows).toEqual(expect.arrayContaining([
          expect.objectContaining({ uuid: 'old-launch' }),
          expect.objectContaining({ uuid: 'old-alias', toolUseResult: expect.objectContaining({ agentId: 'existing-native-child' }) }),
        ]));
      }
      if (kind === 'observer_retired' || kind === 'runner_retired') {
        expect(manager.countActiveLeases(sessionId)).toBe(1);
        if (kind === 'observer_retired') {
          await fixture.lease.release();
          await fixture.controller.shutdown();
          expect(runnerRetirement.signal.aborted).toBe(false);
          expect(observation?.resource.retirementSignal?.aborted).toBe(true);
        } else {
          runnerRetirement.abort();
          expect(observation?.resource.retirementSignal?.aborted).toBe(false);
        }
        await vi.waitFor(() => {
          expect(events.filter(event => event.kind === 'terminated')).toEqual([
            expect.objectContaining({ kind: 'terminated', reason: 'retired', code: 'plugin_generation_retired' }),
          ]);
          expect(manager.countActiveLeases(sessionId)).toBe(0);
          expect(manager.hasTranscriptDemand({ sessionId, resource: {
            linkGeneration: loaded.session.linkGeneration, occurrenceId: observation!.resource.occurrenceId,
          } })).toBe(false);
        });
      }
    });
  } finally {
    releaseAcquisition();
    await subscription?.dispose();
    await disposeTransport?.();
    await closePublisher?.();
    restorePublisherFetch?.();
    await projection.dispose();
    await fixture.dispose();
    credentialsRead.mockRestore(); http.mockRestore();
    metadataHttp?.mockRestore();
    projectHttp?.mockRestore();
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  }
}, 150000);
