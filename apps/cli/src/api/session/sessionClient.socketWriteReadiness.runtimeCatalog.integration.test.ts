import axios from 'axios';
import { mkdir, readFile, rmdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  SessionMetadataTuplePatchV1Schema,
  SessionMetadataTuplePatchSuccessV1Schema,
  TranscriptRawRecordV1Schema,
  buildDeterministicSessionWorkStateItemId,
} from '@happier-dev/protocol';
import { SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1, SessionTranscriptObservationInputSchema } from '@happier-dev/protocol/sessions/messages/transcriptObservationV1';
import { readSessionWorkStateV1FromMetadata, writeSessionWorkStateV1ToMetadata } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub, type ApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createNativeAgentSessionWorkStateService } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionWorkState';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import type { Session } from '@/api/types';
import { ApiSessionClient, type ApiSessionClientOptions } from './sessionClient';
import { createSessionScopedSocketConnection } from './sockets';
import { SessionFollowRuleSourceOccurrenceV1Schema, evaluateSessionFollowRuleOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';
import { createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';
import { notificationSettingsFixture, notificationCatalogFixture } from '@/notifications/activity/activityNotification.testkit';
import { setActiveAccountSettingsSnapshot, clearActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification';
import { PushNotificationClient } from '@/api/pushNotifications';
import { createCodexAgentRuntime } from '../../../../../packages/plugins/codex/src/agent/runtime/engine';
import { createCodexNativeSessionControls } from '../../../../../packages/plugins/codex/src/agent/runtime/controls';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import type { AgentSessionGoalControlContext, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentSessionRuntime, AgentSessionRuntimeEvent } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventV1Schema, SessionTurnMutationV1Schema } from '@happier-dev/protocol';
import { createSessionTurnMutationAppliedSocketAck } from '@/testkit/backends/apiSessionSocketHarness';
import { runSessionLoopLifecycle } from '@/agent/runtime/session/loop/lifecycle';
import { createLifecycleParams } from '@/agent/runtime/session/loop/lifecycle.testkit';
import { runPermissionModePromptLoop } from '@/agent/runtime/runPermissionModePromptLoop';
import { registerRunnerTerminationHandlers } from '@/agent/runtime/lifecycle/runnerTerminationHandlers';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '@/agent/runtime/permissions/queuedPrompt';
import { createSessionRuntimeModelsPublisher } from '@/agent/runtime/controls/sessionRuntimeModelsPublisher';
import { applyActiveModelFacts } from '@/providers/sessions/applyActiveModelFacts';
import type { AuthorizedSessionModelTransitionTarget } from '@/providers/sessions/sessionModelTransitionCoordinator';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resolveRunnerMcpServers } from '@/mcp/runtime/resolveRunnerMcpServers';
import { publishRunnerSkillNotice, publishSkillLaunchNotice } from '@/prompts/skills/runtime/publishRunnerSkillNotice';
import { createSessionPromptPlanResolver } from '@/agent/prompting/coding/sessionPromptPlan';
import { installEmptyProjectAccountRowsHttpBoundary } from '@/testkit/http/projectAccountRows';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { loadSessionClientDurableMutationOutbox, resolveSessionClientDurableMutationOutboxPath } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { SessionMutationJournalAdmissionBlockedError } from './client/transport/mutations/createSessionClientDurableMutationOutbox';
import { ApiClient } from '@/api/api';
import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { SESSION_PREPARATION_FAILURE_PREVIEWS } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

// Substitute only HTTP and Socket.IO. Negotiation, the outbox, tuple codecs,
// Account-currentness admission and connection supersession remain real.
vi.mock('axios');
const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));
// Daemon IPC is the notification boundary; semantic capture and publication stay real.
const { daemonPost } = vi.hoisted(() => ({ daemonPost: vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({ ok: true })) }));
vi.mock('@/daemon/controlHttp', () => ({ daemonPost }));
// Expo is the external push transport; notification admission/channel policy stay real.
const { expoSend } = vi.hoisted(() => ({ expoSend: vi.fn(async (_messages: unknown[]) => [{ status: 'ok', id: 'push-ticket' }]) }));
vi.mock('expo-server-sdk', () => ({ Expo: class {
  static isExpoPushToken() { return true; }
  chunkPushNotifications(messages: unknown[]) { return [messages]; }
  sendPushNotificationsAsync = expoSend;
} }));
// Keep the native startup file lock real, isolated from live agents at the OS boundary.
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), homedir: process.env.TMPDIR || actual.userInfo().homedir }) };
});

const ownerCredentials = { token: 'tok', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(4) } };
const serverUrl = 'https://socket-readiness.example.test';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

const currentFeatures = FeaturesResponseSchema.parse({
  features: { sharing: { pendingQueueV2: { enabled: true } } },
  capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } },
});

describe('ApiSessionClient socket write readiness', () => {
  const clients: ApiSessionClient[] = [];
  const connectGates: ReturnType<typeof createDeferred>[] = [];

  it.each(['current', 'replacement'] as const)('settles required daemon readiness failure before host construction for the %s runner', async runner => {
    const metadata = createTestMetadata({ hostPid: process.pid, hostProcessStartTimeMs: 10,
      startedBy: 'daemon', lifecycleState: 'running', lifecycleStateSince: 1, flavor: 'codex' });
    const session = createPlainSessionFixture({ id: `s-daemon-readiness-failure-${runner}`, metadata });
    const row = createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(metadata), metadataVersion: session.metadataVersion, share: null });
    serveSession(row);
    const turns: ReturnType<typeof SessionTurnMutationV1Schema.parse>[] = [];
    vi.mocked(axios.post).mockImplementation(async (url, payload) => {
      if (!String(url).endsWith('/turns/mutations')) throw new Error('Unexpected fixture POST');
      const mutation = SessionTurnMutationV1Schema.parse(payload);
      turns.push(mutation);
      return { status: 200, data: { success: true, applied: true,
        receipt: createSessionTurnMutationAppliedSocketAck(mutation).receipt } };
    });
    const socket = createSocket({ emitWithAck: async (event, payload) => {
      if (event === 'session-turn-mutation') {
        const mutation = SessionTurnMutationV1Schema.parse(payload);
        turns.push(mutation);
        return createSessionTurnMutationAppliedSocketAck(mutation);
      }
      return { result: 'success' };
    } });
    mockIo.mockImplementation(() => socket);
    // This is the daemon HTTP boundary. Initialization, report retries, issue
    // classification, turn publication, metadata CAS and cleanup remain real.
    const credentials = { token: 'tok', encryption: null };
    daemonPost.mockImplementation(async () => {
      if (runner === 'replacement') {
        const tuple = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
          metadata: { ...metadata, hostPid: process.pid + 1, hostProcessStartTimeMs: 20 }, agentState: {} });
        row.metadataLayoutVersion = 1;
        row.metadata = tuple.sharedMetadata.ciphertext;
        row.ownerMetadata = tuple.ownerMetadata;
        row.metadataVersion += 1;
      }
      return { error: 'Request failed: /session-started, HTTP 503' };
    });
    const api = await ApiClient.create(credentials);
    let acquired: ApiSessionClient | undefined;
    await expect(initializeBackendRunSession({ api, existingSessionId: session.id, metadata, state: {},
      sessionTag: session.id, uiLogPrefix: '[readiness-test]', requireDaemonAckOnAttach: true,
      sessionAttachSecret: { encryptionMode: 'plain', snapshot: { metadata, metadataVersion: session.metadataVersion,
        agentState: {}, agentStateVersion: 0 } },
      sessionClientOptions: { initialRegisteredSessionStateFieldMutations: [], metadataAuthority: { kind: 'owner', credentials } },
      configureSessionClient: client => { acquired = client; clients.push(client); },
      startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
    }, { reportSessionToDaemonIfRunningFn: input => reportSessionToDaemonIfRunning(input, { retryTimeoutMs: 0 }) }))
      .rejects.toMatchObject({ code: 'native_agent_privileged_effect_outcome_unknown' });
    if (runner === 'replacement') {
      expect(turns).toEqual([]);
      expect(acquired?.getMetadataSnapshot()).toMatchObject({ hostPid: process.pid + 1,
        hostProcessStartTimeMs: 20, lifecycleState: 'running' });
      return;
    }
    expect(turns).toContainEqual(expect.objectContaining({ action: 'fail', issue: expect.objectContaining({
      scope: 'primary_session', code: 'native_agent_privileged_effect_outcome_unknown', status: 'failed',
      sanitizedPreview: SESSION_PREPARATION_FAILURE_PREVIEWS.native_agent_privileged_effect_outcome_unknown,
    }) }));
    expect(acquired?.getMetadataSnapshot()).not.toHaveProperty('hostPid');
    expect(acquired?.getMetadataSnapshot()).not.toHaveProperty('hostProcessStartTimeMs');
    expect(acquired?.getMetadataSnapshot()).not.toHaveProperty('lifecycleState');
  });

  it.each(['preparation', 'native-refusal'] as const)('admits an optional Skill notice before its Home ACK (%s)', async kind => {
    const started = createDeferred();
    const release = createDeferred();
    const transcript = createSessionTranscriptHomeStub();
    const localIds: string[] = [];
    let completedAcks = 0;
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        localIds.push(SessionTranscriptObservationInputSchema.parse(payload).localId);
        started.resolve();
        await release.promise;
        completedAcks += 1;
      }
      return transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(createPlainSessionFixture({ id: `skill-notice-${kind}` }), [socket], {
      initialRegisteredSessionStateFieldMutations: [],
    });
    let admitted = false;
    const pending = (kind === 'preparation'
      ? publishRunnerSkillNotice(client, {
          plan: { plan: 'session_dir', items: [], nativeDisables: [], diagnostics: [] },
          indexItems: [], unavailable: true, unavailableReason: 'skill_rules_unavailable',
        })
      : publishSkillLaunchNotice(client, {
          pluginRoot: '/session', skillsRoot: '/session/skills',
          items: [], nativeDisables: [{ name: 'review', path: '/native/review/SKILL.md' }],
        })).then(() => { admitted = true; });
    try {
      await started.promise;
      await vi.waitFor(() => expect(admitted).toBe(true));
      await pending;
      expect(completedAcks).toBe(0);
      expect(localIds).toHaveLength(1);
      expect(await loadSessionClientDurableMutationOutbox(client.sessionId)).toMatchObject([
        { kind: 'transcript_message_append', payload: { localId: localIds[0] } },
      ]);
      expect(localIds[0]).toMatch(/^capability-notice:/u);
      release.resolve();
      await client.flushDurableMutationDelivery();
      expect(completedAcks).toBe(1);
      expect(localIds).toHaveLength(1);
      expect(await loadSessionClientDurableMutationOutbox(client.sessionId)).toEqual([]);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it('admits a diagnostic event durably without awaiting its one Home round trip', async () => {
    const started = createDeferred();
    const release = createDeferred();
    const transcript = createSessionTranscriptHomeStub();
    let requests = 0;
    const observedLocalIds: string[] = [];
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        requests += 1;
        observedLocalIds.push(SessionTranscriptObservationInputSchema.parse(payload).localId);
        started.resolve();
        await release.promise;
      }
      return transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(createPlainSessionFixture({ id: 'diagnostic-admission-client' }), [socket], {
      initialRegisteredSessionStateFieldMutations: [],
    });
    let admitted = false;
    const pending = client.enqueueSessionEventCommitted({ type: 'message', message: 'Optional capability unavailable' },
      'diagnostic-notice', { awaitDelivery: false }).then(result => { admitted = true; return result; });
    try {
      await started.promise;
      await vi.waitFor(() => expect(admitted).toBe(true));
      expect(await pending).toMatchObject({ persisted: true, delivered: false, localId: observedLocalIds[0] });
      expect(observedLocalIds[0]).toEqual(expect.any(String));
      expect(requests).toBe(1);
      release.resolve();
      await client.flushDurableMutationDelivery();
      expect(requests).toBe(1);
    } finally {
      release.resolve();
      await pending;
    }
  });

  it('prepares optional prompt-library context after durable notice admission without waiting for its Home ACK', async () => {
    const previousGet = Object.getOwnPropertyDescriptor(axios, 'get');
    const previousPost = Object.getOwnPropertyDescriptor(axios, 'post');
    if (!previousGet || !previousPost) throw new Error('Missing suite Axios boundary');
    const restoreProjectBoundary = installEmptyProjectAccountRowsHttpBoundary();
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
      return { status: 503, data: { error: 'unavailable' } };
    });
    const started = createDeferred();
    const release = createDeferred();
    const transcript = createSessionTranscriptHomeStub();
    const observations: ReturnType<typeof SessionTranscriptObservationInputSchema.parse>[] = [];
    let completedAcks = 0;
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        observations.push(SessionTranscriptObservationInputSchema.parse(payload));
        started.resolve();
        await release.promise;
        const ack = transcript.answer(event, payload);
        completedAcks += 1;
        return ack;
      }
      return transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(createPlainSessionFixture({ id: 'prompt-library-notice-admission', metadata: createTestMetadata({
      work: { memoryEnabled: true, promptStack: [{ id: 'optional-entry',
        ref: { kind: 'doc', artifactId: 'optional-document' }, enabled: true, required: false, placement: 'system_append' }] },
    }) }), [socket], { initialRegisteredSessionStateFieldMutations: [] });
    const resolver = createSessionPromptPlanResolver({
      opts: { credentials: { token: 'tok', encryption: null } }, session: client,
      agentId: 'codex', machineId: 'machine-1', directory: '/tmp/project', memoryRecallGuidanceEnabled: false,
      readNativeSessionId: () => 'native',
      // Daemon turn-contribution IPC is external to this process. The real
      // prompt/Artifact admission, resolver, Session client and journal stay beneath it.
      daemonBridge: {
        resolvePrompt: async () => ({ kind: 'prompt', promptAssetBlocks: [], toolPromptContributions: [] }),
        resolveAgentComposition: async () => { throw new Error('Unexpected composition request'); },
        resolveComposerReference: async () => { throw new Error('Unexpected reference request'); },
        resolveComposerAttachment: async () => { throw new Error('Unexpected attachment request'); },
        afterComposerAttachmentMessageAccepted: async () => { throw new Error('Unexpected attachment acceptance'); },
        transformAgentContext: async () => { throw new Error('Unexpected context transform'); },
        transformSessionInput: async () => { throw new Error('Unexpected input transform'); },
        transformAgentRequest: async () => { throw new Error('Unexpected request transform'); },
      },
    });
    let prepared = false;
    const pending = runWithServerHttpBaseUrl(serverUrl, () => resolver({
      baseOverride: 'Retained base instructions', includeAdmittedInventory: true,
    })).then(result => { prepared = true; return result; });
    try {
      await started.promise;
      await vi.waitFor(() => expect(prepared).toBe(true));
      expect(await pending).toMatchObject({ text: expect.stringContaining('Retained base instructions'),
        admittedEntries: [{ outcome: 'unavailable', reason: 'unavailable' }] });
      expect(resolver.readStartupInstructions?.()).not.toBeNull();
      expect(observations).toHaveLength(1);
      expect(completedAcks).toBe(0);
      const original = observations[0];
      expect(original.localId).toMatch(/^capability-notice:/u);
      expect(original.content).toMatchObject({ t: 'plain', v: { content: { data: {
        capabilityNoticeV1: { v: 1, items: [{ kind: 'prompt_library', code: 'prompt_library_unavailable' }] },
      } } } });
      expect(await loadSessionClientDurableMutationOutbox(client.sessionId)).toEqual([expect.objectContaining({
        payload: expect.objectContaining({ localId: original.localId, content: original.content }),
      })]);
      release.resolve();
      await client.flushDurableMutationDelivery();
      expect(observations).toHaveLength(1);
      expect(completedAcks).toBe(1);
      expect(await loadSessionClientDurableMutationOutbox(client.sessionId)).toEqual([]);
    } finally {
      release.resolve();
      try { await pending; } finally {
        try { restoreProjectBoundary(); } finally {
          // The fixture's spies must not replace this suite's module mocks.
          Object.defineProperties(axios, { get: previousGet, post: previousPost });
        }
      }
    }
  });

  it('refuses MCP startup when its optional capability notice cannot enter the real journal', async () => {
    let transcriptRequests = 0;
    const transcript = createSessionTranscriptHomeStub();
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) transcriptRequests += 1;
      return transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(createPlainSessionFixture({ id: 'mcp-notice-journal-refusal' }), [socket], {
      initialRegisteredSessionStateFieldMutations: [],
    });
    await client.flushDurableMutationDelivery();
    const queuePath = resolveSessionClientDurableMutationOutboxPath(client.sessionId);
    // A directory at the exact journal destination forces the real atomic
    // rename to fail on every platform, without mocking journal admission.
    await expect(readFile(queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(queuePath, { recursive: true });
    const accountCredentials = { token: 'tok', encryption: null };
    const accountSettings = accountSettingsParse({ mcpServersStrictMode: false });
    try {
      await expect(resolveRunnerMcpServers({ session: client, credentials: accountCredentials,
        accountSettings, accountSettingsSnapshot: {
          source: 'network', scopeKey: runWithServerHttpBaseUrl(serverUrl, () => resolveAccountSettingsScopeKey(accountCredentials)),
          settings: accountSettings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
          mcpServerCatalog: { status: 'ready', authority: 'active', revision: 1, diagnostics: [],
            catalog: { v: 1, servers: [{ id: 'missing-value', name: 'Missing value', transport: 'stdio',
              stdio: { command: 'echo', args: [] }, env: { REQUIRED: { t: 'literal', v: '${B15_MISSING_MCP_VALUE}' } },
              createdAt: 1, updatedAt: 1 }], bindings: [] } },
        }, machineId: 'machine-1', directory: '/tmp', env: {}, agentId: 'codex', agentAcceptsUserMcp: true,
        sessionMetadata: { mcpSelectionV1: { v: 1, managedServersEnabled: true,
          forceIncludeServerIds: ['missing-value'], forceExcludeServerIds: [] } },
        includeHappierMcpServer: false,
      })).rejects.toBeInstanceOf(SessionMutationJournalAdmissionBlockedError);
      expect(transcriptRequests).toBe(0);
      await expect(readFile(queuePath, 'utf8')).rejects.toBeDefined();
    } finally {
      await rmdir(queuePath);
      await client.close();
    }
  });

  function createSocket(options: Parameters<typeof createApiSessionSocketStub>[0] = {}) {
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1', committedFenceMs: 1_000 });
    const transcript = createSessionTranscriptHomeStub();
    return createApiSessionSocketStub({ ...options, emitWithAck: (event, payload, socket) =>
      activity.answer(event, payload) ?? transcript.answer(event, payload)
      ?? options.emitWithAck?.(event, payload, socket) ?? { result: 'success' } });
  }

  function createClient(session: Session, sockets: readonly ApiSessionSocketStub[], options: Partial<ApiSessionClientOptions> = {}, gate?: ReturnType<typeof createDeferred>, token = 'tok') {
    let nextSocket = 0;
    mockIo.mockImplementation(() => sockets[Math.min(nextSocket++, sockets.length - 1)]);
    const client = new ApiSessionClient(token, session, {
      localMachineId: 'machine-1',
      metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
        sessionId: session.id, agentRuntimeApplicability: 'supported',
      })],
      transport: { serverId: 'socket-readiness-home', serverUrl,
        createSessionSocketTransport: ({ sessionId, machineId }) => {
          const { socket, transport } = createSessionScopedSocketConnection({ token, serverUrl, sessionId, machineId });
          return { socket, transport: gate ? { ...transport,
            connect: async () => { await gate.promise; await transport.connect(); },
          } : transport };
        },
      },
      ...options,
    });
    clients.push(client);
    if (gate) connectGates.push(gate);
    return client;
  }

  function serveSession(row: ReturnType<typeof createSessionRecordFixture>, currentness = createAccountEncryptionCurrentnessFixture()) {
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
      if (path === `/v2/sessions/${row.id}`) return { status: 200, data: { session: row } };
      return { status: 404, data: {} };
    });
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' && patch.mode !== 'owner_migration') throw new Error('Expected owner tuple patch');
      const target = patch.mode === 'owner_migration' ? patch.target : patch;
      row.metadataLayoutVersion = 1;
      row.metadata = target.sharedMetadata.ciphertext;
      row.ownerMetadata = target.ownerMetadata;
      row.metadataVersion += 1;
      if (target.agentState) {
        row.agentState = target.agentState.ciphertext;
        row.agentStateVersion = (row.agentStateVersion ?? 0) + 1;
      }
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({
        success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion },
        agentState: { version: row.agentStateVersion },
      }) };
    });
  }

  function createEncryptedOwnerSession(id: string, accountEncryptionMode: 'plain' | 'e2ee' = 'e2ee') {
    const legacy = createPlainSessionFixture({ id });
    const tuple = buildSessionMetadataEnvelopeFields({ credentials: ownerCredentials, accountEncryptionMode: 'e2ee',
      metadata: legacy.metadata, agentState: legacy.agentState, storedContentMode: 'e2ee',
      encryptionKey: ownerCredentials.encryption.secret, encryptionVariant: 'legacy' });
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: ownerCredentials.encryption });
    const currentness = createAccountEncryptionCurrentnessFixture({ mode: accountEncryptionMode, version: 1,
      contentKeyFingerprint: accountEncryptionMode === 'e2ee'
        ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null });
    serveSession(createSessionRecordFixture({ id, encryptionMode: 'e2ee', metadataLayoutVersion: 1,
      metadata: tuple.sharedMetadata.ciphertext, metadataVersion: 1, ownerMetadata: tuple.ownerMetadata,
      agentState: tuple.agentState, agentStateVersion: 2, share: null }), currentness);
    return { ...legacy, encryptionMode: 'e2ee' as const, encryptionKey: ownerCredentials.encryption.secret,
      encryptionVariant: 'legacy' as const, metadataLayoutVersion: 1 as const, metadataVersion: 1,
      ownerMetadata: tuple.ownerMetadataValue, ownerMetadataEnvelope: tuple.ownerMetadata, agentStateVersion: 2 };
  }

  beforeEach(() => {
    clearActiveAccountSettingsSnapshot();
    expoSend.mockClear();
    daemonPost.mockReset().mockResolvedValue({ ok: true });
    vi.mocked(axios.get).mockReset().mockImplementation(async url => ({
      status: new URL(String(url)).pathname === '/v1/auth/ping' ? 200 : 404, data: {},
    }));
    vi.mocked(axios.patch).mockReset();
    vi.mocked(axios.post).mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(currentFeatures), { status: 200,
      headers: { 'content-type': 'application/json' } })));
  });

  afterEach(async () => {
    for (const gate of connectGates.splice(0)) gate.resolve();
    await Promise.all(clients.splice(0).map(client => client.close()));
    vi.unstubAllGlobals();
    clearActiveAccountSettingsSnapshot();
  });

  it.each(['foreground', 'sidechain', 'ordinary', 'explicit-local-custody'] as const)(
    'retains native foreground transcript custody until Home acknowledges the final sequence (%s)', async scope => {
    const session = createPlainSessionFixture({ id: 's-native-final-anchor' });
    serveSession(createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null }));
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const transcript = createSessionTranscriptHomeStub();
    const appendGate = createDeferred();
    const attempted = createDeferred();
    let firstAppend = true;
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        SessionTranscriptObservationInputSchema.parse(payload);
        if (firstAppend) {
          firstAppend = false;
          throw new Error('Home append receipt temporarily unavailable');
        }
        attempted.resolve();
        await appendGate.promise;
      }
      return activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(session, [socket]);
    client.getTurnAssistantTextSnapshotStore().beginTurn({ turnToken: 'native-turn', startSeqExclusive: null, startedAtMs: 1 });
    let settled = false;
    const commit = client.enqueueAgentMessageCommitted('codex', { type: 'message', message: 'Exact native answer',
      ...(scope === 'sidechain' ? { sidechainId: 'native-child' } : {}) }, {
      localId: 'native-final', ...(scope === 'ordinary' ? {} : { meta: { runtimeTurnId: 'native-turn' } }),
      provenance: { kind: 'non_dependent', source: 'background' },
      ...(scope === 'explicit-local-custody' ? { admission: { signal: new AbortController().signal, requireDelivery: false } } : {}),
    }).then(result => { settled = true; return result; });
    try {
      await vi.waitFor(() => expect(socket.emitWithAck.mock.calls.map(([event]) => event)).toContain(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1));
      await attempted.promise;
      expect(settled).toBe(scope !== 'foreground');
      appendGate.resolve();
      const result = await commit;
      if (scope === 'foreground') {
        expect(result).toMatchObject({ persisted: true, delivered: true, committedSequence: expect.any(Number) });
        expect(client.getTurnAssistantTextSnapshotStore().getCurrentTurnSnapshot()).toMatchObject({
          normalizedText: 'Exact native answer', seq: result.committedSequence, source: 'committed',
        });
      } else expect(result).toMatchObject({ persisted: true, delivered: false });
    } finally {
      appendGate.resolve();
      await commit;
    }
  });

  it.each(['offline', 'connected', 'disconnect-during-drain'] as const)(
    'retires an offline native transcript ACK before runner cleanup drains the Session (%s)', async closeState => {
    // Each mode owns a different retained journal. The offline case deliberately
    // leaves custody behind, so reusing its Session would replay that earlier turn.
    const session = createPlainSessionFixture({ id: `s-native-offline-close-${closeState}` });
    serveSession(createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null }));
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const transcript = createSessionTranscriptHomeStub();
    const appendGate = createDeferred();
    const attempted = createDeferred();
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === 'session-turn-mutation') {
        return createSessionTurnMutationAppliedSocketAck(SessionTurnMutationV1Schema.parse(payload));
      }
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        attempted.resolve();
        await appendGate.promise;
      }
      return activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(session, [socket]);
    let listener: ((event: AgentSessionRuntimeEvent) => void) | undefined;
    let disposed = false;
    const provider: AgentSessionRuntime = {
      async send() { throw new Error('Provider-owned turn has no host prompt'); },
      watch(next) { listener = next; return { dispose() { listener = undefined; } }; },
      dispose() { disposed = true; },
    };
    const runtime = createNativeAgentSessionOperations(provider, session.id, undefined, undefined, undefined, undefined, undefined, {
      context: {} as AgentSessionRuntimeContext, cwd: '/tmp/native-offline-close', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false }, cancellation: { declared: false },
      configuration: { declared: false }, compaction: { capability: null },
    });
    const base = createLifecycleParams({ runPermissionModePromptLoopFn: runPermissionModePromptLoop });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
      mode => mode.permissionMode, { batcher: combinePermissionModeQueuedPrompts });
    let finished = false;
    const run = runSessionLoopLifecycle({ ...base, session: client, runtime, hookRuntime: runtime,
      permissionModeState: { ...base.permissionModeState, messageQueue: queue }, deps: { ...base.deps,
        registerRunnerTerminationHandlersFn: options => registerRunnerTerminationHandlers({ ...options,
          processLifecycleOwnership: 'caller', sessionExitReport: null, exit() {} }),
      } }).then(() => { finished = true; });
    void run.catch(() => undefined);
    let sequence = 0;
    const emit = (event: Readonly<Record<string, unknown>>) => listener?.(AgentSessionRuntimeEventV1Schema.parse({
      ...event, sessionId: session.id, emittedAtMs: ++sequence, sequence,
    }));
    try {
      await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
      emit({ kind: 'turn-start', turnId: 'offline-native-turn', startedBy: 'provider' });
      emit({ kind: 'transcript-message-committed', turnId: 'offline-native-turn', role: 'assistant',
        messageId: 'offline-final', text: 'Retained while offline' });
      await vi.waitFor(() => expect(socket.emitWithAck.mock.calls.map(([event]) => event)).toContain(SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1));
      await attempted.promise;
      emit({ kind: 'turn-complete', turnId: 'offline-native-turn' });
      if (closeState === 'offline') {
        socket.connected = false;
        socket.trigger('disconnect', 'transport close');
      }
      emit({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      await vi.waitFor(() => expect(disposed).toBe(true));
      if (closeState !== 'offline') {
        expect(finished).toBe(false);
        if (closeState === 'connected') appendGate.resolve();
        else {
          socket.connected = false;
          socket.trigger('disconnect', 'transport close');
        }
      }
      await vi.waitFor(() => expect(finished).toBe(true));
      await run;
      if (closeState === 'connected') {
        const turns = socket.emitWithAck.mock.calls.filter(([event]) => event === 'session-turn-mutation')
          .map(([, payload]) => SessionTurnMutationV1Schema.parse(payload));
        expect(turns).toContainEqual(expect.objectContaining({ action: 'complete', turnId: 'offline-native-turn' }));
        expect(turns).not.toContainEqual(expect.objectContaining({ action: 'fail', turnId: 'offline-native-turn' }));
      }
    } finally {
      appendGate.resolve();
      emit({ kind: 'turn-complete', turnId: 'offline-native-turn' });
      emit({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      await client.close();
      await run.catch(() => undefined);
    }
  });

  it.each(['unavailable', 'accepted', 'accepted_no_channels', 'failure_unavailable', 'failure_accepted', 'person_wrote_unavailable', 'person_wrote_owner', 'person_wrote_collaborator', 'unaccepted', 'unaccepted_rule_only', 'other_original', 'retired_account', 'missing_settings', 'wrong_account', 'other_home', 'retired_publisher'] as const)(
    'keeps the original nonfinished personal notification with source-daemon %s', async disposition => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'semantic-owner' })).toString('base64url')}.signature`;
    const session = createPlainSessionFixture({ id: 's-personal-semantic' });
    const personalPolicy = disposition.startsWith('person_wrote') ? { preset: 'everything' as const } : { preset: 'custom' as const, events: {
      message: { delivery: 'interrupt' as const }, failed_or_stopped: { delivery: 'interrupt' as const },
    } };
    const context = createSessionNotificationContextFixture(session.id);
    const row = { ...context, viewer: { ...context.viewer!, follow: { ...context.viewer!.follow,
      follows: disposition !== 'unaccepted_rule_only',
      ...(disposition === 'unaccepted_rule_only' ? {} : { policy: personalPolicy }) } } };
    serveSession(row);
    const readSession = vi.mocked(axios.get).getMockImplementation()!;
    vi.mocked(axios.get).mockImplementation(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (path.includes('delivery-mute')) return { status: 200, data: { scopes: [] } };
      if (path === '/v1/push-tokens') return { status: 200, data: { tokens: [{ id: 'push-device', token: 'ExponentPushToken[device]', createdAt: 1, updatedAt: 1 }] } };
      if (path === '/v1/account/activity/badge-snapshot') return { status: 200, data: { badgeCount: 1 } };
      return await readSession(url, options);
    });
    const settings = notificationSettingsFixture({ notificationChannelsV1: [{ id: 'push', kind: 'expo_push', enabled: true,
      topics: { ready: true, permissionRequest: true, userActionRequest: true } }] });
    setActiveAccountSettingsSnapshot({ source: 'network', settings, ...notificationCatalogFixture(settings), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: runWithServerHttpBaseUrl(serverUrl, () => resolveAccountSettingsScopeKey({ token, encryption: null })) });
    if (disposition === 'missing_settings') clearActiveAccountSettingsSnapshot();
    if (disposition === 'wrong_account') setActiveAccountSettingsSnapshot({ source: 'network', settings,
      ...notificationCatalogFixture(settings), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKey({ token: 'unrelated-account', encryption: null }) });
    let publisherCurrent = true;
    daemonPost.mockImplementation(async (_path, body) => {
      if (!body || typeof body !== 'object' || !('followOccurrence' in body)) return { ok: true };
      const occurrence = SessionFollowRuleSourceOccurrenceV1Schema.parse(body.followOccurrence);
      if (!('sourceMessage' in occurrence)) throw new Error('Expected committed transcript original');
      if (disposition === 'unavailable' || disposition === 'failure_unavailable' || disposition.startsWith('person_wrote')) throw new Error('daemon unavailable');
      if (disposition === 'retired_account') clearActiveAccountSettingsSnapshot();
      if (disposition === 'retired_publisher') publisherCurrent = false;
      if (disposition === 'accepted' || disposition === 'failure_accepted') {
        // Keep the IPC peer's channel dispatch real. This boundary fixture
        // supplies the private accepted response; daemon composition separately
        // proves that only source-backed Inbox acceptance produces that marker.
        const push = new PushNotificationClient(token, serverUrl, configuration.activeServerId);
        await dispatchActivityNotificationAsync({ settings,
          expoPushSender: push, fetchSessionNotificationContext: push.fetchSessionNotificationContext.bind(push),
          readAccountSessionDeliveryMutedScopes: push.readAccountSessionDeliveryMutedScopes.bind(push), pluginNotifications: null,
          admittedRulePolicies: [personalPolicy], event: { topic: 'follow_update', sessionId: session.id,
            follow: { event: occurrence.evidence.event, sourceMessage: occurrence.sourceMessage } } });
      }
      return { ok: true, personalFollow: { sourceSessionId: session.id,
        ...(disposition === 'accepted' || disposition === 'accepted_no_channels' || disposition === 'failure_accepted' || disposition === 'other_original' ? { accepted: true as const } : {}),
        sourceMessage: { ...occurrence.sourceMessage,
          ...(disposition === 'other_original' ? { localId: 'different-original' } : {}), policies: [personalPolicy] } } };
    });
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const transcript = createSessionTranscriptHomeStub();
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) =>
      event === 'session-publisher-authority-check' && !publisherCurrent
        ? { status: 'superseded', sessionId: session.id }
        : activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' } });
    const client = createClient(session, [socket], { transport: { serverId: disposition === 'other_home' ? 'another-home' : configuration.activeServerId, serverUrl,
      createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({ token, serverUrl, sessionId, machineId }) } }, undefined, token);
    if (disposition.startsWith('person_wrote')) {
      // Exercise the same public notification method reached by the protected
      // human-input observer. Its original-proof contract has its own composed
      // tests; an agent row must never be relabelled as human evidence here.
      const evidence = client.captureSessionFollowRuleEvidence({ kind: 'person_wrote' });
      if (!evidence) throw new Error('Current owner source evidence unavailable');
      const original = { localId: 'semantic-original', seq: 7, evidence,
        ...(disposition === 'person_wrote_owner' ? { authorAccountId: 'semantic-owner' }
          : disposition === 'person_wrote_collaborator' ? { authorAccountId: 'collaborator' } : {}) };
      await client.notifySessionFollowRuleMessageCommitted(original);
    } else {
      await expect(client.enqueueAgentMessageCommitted('codex', disposition.startsWith('failure_')
        ? { type: 'turn_failed', id: 'failed-turn' } : { type: 'message', message: 'Original message' }, {
        localId: 'semantic-original', provenance: { kind: 'non_dependent', source: 'background' },
      })).resolves.toMatchObject({ persisted: true, delivered: true });
    }
    await vi.waitFor(() => expect(daemonPost.mock.calls.some(call => call[0] === '/session-activity-changed')).toBe(true));
    // The outbox deliberately detaches notification observation from append
    // settlement. All transport boundaries above settle in microtasks.
    await new Promise<void>(resolve => setImmediate(resolve));
    const expectsPush = !['accepted_no_channels', 'person_wrote_owner', 'retired_account', 'missing_settings', 'wrong_account', 'other_home', 'retired_publisher', 'unaccepted_rule_only'].includes(disposition);
    if (!expectsPush) {
      expect(expoSend).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => expect(expoSend).toHaveBeenCalledTimes(1));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(expoSend).toHaveBeenCalledTimes(1);
    expect(expoSend.mock.calls[0]?.[0]).toMatchObject([{ data: { sessionId: session.id, serverUrl, activityEventLocalId: 'semantic-original' } }]);
  });

  it('appends only committed effective Goal changes across racing sources and retries the original notice', async () => {
    const session = createPlainSessionFixture({ id: 's-committed-goal', origin: { kind: 'none' } });
    const row = createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null, origin: session.origin });
    serveSession(row);
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const transcript = createSessionTranscriptHomeStub();
    const originals: unknown[] = [];
    const attempts: string[] = [];
    const committedAtAppend: unknown[] = [];
    let failAppend = true;
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        const request = SessionTranscriptObservationInputSchema.parse(payload);
        attempts.push(request.localId);
        committedAtAppend.push(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot()));
        if (failAppend) { failAppend = false; throw new Error('One transient transcript append failure'); }
        originals.push(request);
      }
      return activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'goal-owner' })).toString('base64url')}.signature`;
    const client = createClient(session, [socket], {}, undefined, token);
    const service = createNativeAgentSessionWorkStateService({ session: client, pluginId: 'test-goal',
      contributionId: 'runtime', agentId: 'custom-acp', occurrenceId: 'goal-occurrence', isCurrent: () => true,
      declarations: [{ id: 'goals', itemKinds: ['goal'] }, { id: 'other-goals', itemKinds: ['goal'] },
        { id: 'tasks', itemKinds: ['task'] }] });
    const goals = service.publisher('goals');
    const otherGoals = service.publisher('other-goals');
    const tasks = service.publisher('tasks');
    const goal = { sourceSequence: 1, observedAtMs: 1, items: [{ localId: 'objective', kind: 'goal' as const,
      origin: 'vendor' as const, status: 'active' as const, title: 'Private objective', updatedAtMs: 1 }] };
    const task = { sourceSequence: 1, observedAtMs: 1, items: [{ localId: 'task', kind: 'task' as const,
      origin: 'vendor' as const, status: 'active' as const, title: 'Task published concurrently', updatedAtMs: 1 }] };
    await expect(Promise.all([goals.publish(goal), otherGoals.publish(goal), tasks.publish(task)]))
      .resolves.toMatchObject([{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }]);
    await vi.waitFor(() => expect(originals).toHaveLength(2), { timeout: 10_000 });
    expect(attempts.length).toBeGreaterThan(2);
    expect(new Set(attempts).size).toBe(2);
    for (const original of originals) {
      const request = SessionTranscriptObservationInputSchema.parse(original);
      if (typeof request.content === 'string') throw new Error('Expected a keyless plain Goal notice');
      expect(request.content.t).toBe('plain');
      if (request.content.t !== 'plain') throw new Error('Expected a keyless plain Goal notice');
      expect(TranscriptRawRecordV1Schema.parse(request.content.v)).toMatchObject({ role: 'agent',
        content: { type: 'event', data: { type: 'goal-changed' } } });
      expect(request.messageRole).toBe('event');
    }
    // The work-state tuple has settled before its original reaches the transport.
    for (const state of committedAtAppend) expect(state).toHaveProperty('items');
    expect(JSON.stringify(originals)).not.toContain('Private objective');
    expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())?.items).toHaveLength(3);
    const goalOccurrences = () => daemonPost.mock.calls.flatMap(call => {
      const body: unknown = call[1];
      if (!body || typeof body !== 'object' || !('followOccurrence' in body)) return [];
      const occurrence = SessionFollowRuleSourceOccurrenceV1Schema.parse(body.followOccurrence);
      return 'evidence' in occurrence && occurrence.evidence.event.kind === 'goal_changed' ? [occurrence] : [];
    });
    await vi.waitFor(() => expect(goalOccurrences()).toHaveLength(2));
    expect(goalOccurrences()).toEqual(expect.arrayContaining(originals.map(original => {
      const request = SessionTranscriptObservationInputSchema.parse(original);
      return expect.objectContaining({ sourceSessionId: session.id,
        sourceMessage: { localId: request.localId, seq: expect.any(Number) },
        evidence: expect.objectContaining({ event: { kind: 'goal_changed' } }) });
    })));
    for (const occurrence of goalOccurrences()) {
      if (!('evidence' in occurrence)) throw new Error('Goal original evidence unavailable');
      expect(evaluateSessionFollowRuleOccurrenceV1({ accountId: 'goal-owner', evaluator: 'source', production: 'source',
        sourceSessionId: occurrence.sourceSessionId, evidence: occurrence.evidence, currentFacts: {
          serverId: client.getServerBinding().serverId, kind: 'session', startedBy: 'you', metadata: client.getMetadataSnapshot(),
        },
        rules: [{ ruleId: 'goals', version: 1, receiver: { kind: 'session', sessionId: 'goal-receiver' },
          definition: { v: 1, enabled: true,
            filter: normalizeSessionListFilterV1({ homeServerIds: ['socket-readiness-home'], scope: 'all_accessible' }),
            policy: { preset: 'custom', events: { goal_changed: { delivery: 'interrupt' } } } } }] }))
        .toMatchObject({ status: 'evaluated', routes: [{ delivery: { selected: true, session: { wake: true } } }] });
    }
    await expect(goals.publish(goal)).resolves.toMatchObject({ status: 'unchanged' });
    // A newer source snapshot with only usage/timestamp/progress changes is also quiet.
    await expect(goals.publish({ ...goal, sourceSequence: 2, observedAtMs: 2,
      items: [{ ...goal.items[0]!, updatedAtMs: 2, tokensUsed: 10, progress: 0.5 }] }))
      .resolves.toMatchObject({ status: 'applied' });
    await expect(goals.publish({ ...goal, sourceSequence: 2, items: [] })).resolves.toMatchObject({ status: 'conflict' });
    await client.updateMetadata(metadata => metadata);
    expect(originals).toHaveLength(2);
    expect(goalOccurrences()).toHaveLength(2);
    await goals.publish({ sourceSequence: 3, observedAtMs: 3, items: [] });
    await vi.waitFor(() => expect(originals).toHaveLength(3));
    await otherGoals.publish({ sourceSequence: 2, observedAtMs: 3, items: [] });
    await vi.waitFor(() => expect(originals).toHaveLength(4));
    expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())?.items).toMatchObject([{ kind: 'task' }]);
  });

  it.skipIf(process.platform === 'win32')('retains paused Codex Goal B through native reopen, then publishes only C and genuine Clear', async () => {
    const session = createPlainSessionFixture({ id: 's-codex-goal-source-reopen' });
    const row = createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null });
    serveSession(row);
    const socket = createSocket();
    const client = createClient(session, [socket]);
    const workState = (occurrenceId: string) => createNativeAgentSessionWorkStateService({
      session: client, pluginId: 'happier.agent.codex', contributionId: 'codex', agentId: 'codex', occurrenceId,
      isCurrent: () => true, declarations: [{ id: 'goals', itemKinds: ['goal'] }],
    });
    const originals = () => socket.emitWithAck.mock.calls.flatMap(([event, payload]) =>
      event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1 ? [SessionTranscriptObservationInputSchema.parse(payload)] : []);
    let initialClearSent = false;
    await withCodexNativeAttachFixture(async ({ openConfiguredSession, exec, directory, requests, emitNotification }) => {
      const initial = await openConfiguredSession();
      await initial.dispose();
      const initialControls = createCodexNativeSessionControls();
      const base = { signal: new AbortController().signal,
        plugin: { id: 'happier.agent.codex', version: '1.0.0' },
        contribution: { id: 'codex', qualifiedId: 'happier.agent.codex/codex' },
        surface: 'background' as const, invokedAtMs: 1, agent: { id: 'codex' },
        protocols: { acp: {
          open: async () => { throw new Error('Native Goal control must not open ACP'); },
          openExecutionRunV1: async () => { throw new Error('Native Goal control must not open ACP'); },
        } },
        services: { ...createUnavailablePluginServices(), exec }, session: {
        id: session.id, cwd: directory, activity: 'inactive' as const, providerSessionId: 'fresh-thread', connectedAccounts: [],
      } };
      await expect(initialControls.goals.set({ objective: 'Retained B', status: 'paused' }, {
        ...base, goalSource: workState('inactive-before-reopen').publisher('goals'),
      } satisfies AgentSessionGoalControlContext)).resolves.toMatchObject({ status: 'applied' });
      await client.flush();
      expect(originals()).toHaveLength(1);
      const retained = readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot());
      expect(retained?.items).toMatchObject([{ title: 'Retained B', status: 'paused' }]);
      const runtime = await createCodexAgentRuntime({ plugin: { id: 'happier.agent.codex', version: '1.0.0' },
        agent: { id: 'codex' }, signal: base.signal });
      if (!runtime.sessions) throw new Error('Expected the native Session factory');
      const reopenedState = workState('reopened-native');
      const nativeContext = { signal: base.signal, workState: reopenedState, services: { exec, sessions: {}, logger: {
        debug() {}, info() {}, warn() {}, error() {},
      } }, agent: { id: 'codex' }, session: { id: session.id, services: {} }, ui: { title: { set: async () => undefined } },
      } as unknown as AgentSessionRuntimeContext;
      const opened = await runtime.sessions.open({ kind: 'resume', providerSessionId: 'fresh-thread', sessionId: session.id,
        cwd: directory, launchEnvironment: { values: { CODEX_HOME: directory }, unset: [] },
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: 'fixture-model', updatedAtMs: 1 },
          permissionIntent: { value: 'read-only', updatedAtMs: 1 }, options: {} },
      }, nativeContext);
      const operations = createNativeAgentSessionOperations(opened, session.id, undefined, 'fresh-thread',
        undefined, undefined, undefined, { context: nativeContext, cwd: directory, connectedAccounts: [],
          capabilities: { open: ['resume'], delivery: ['newTurn'], cancel: false,
            goals: { source: 'goals', active: { get: true, clear: true,
              set: { fields: ['objective', 'status', 'tokenBudget'], writableStatuses: ['active', 'paused', 'complete'] } } } },
          goals: runtime.sessions.goals, cancellation: { declared: false }, configuration: { declared: false },
          compaction: { capability: null } });
      try {
        expect(requests.some(request => request.method === 'thread/goal/get')).toBe(true);
        expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())).toEqual(retained);
        expect(originals()).toHaveLength(1);
        // A person can Get immediately after Resume, before a transcript
        // subscriber or prompt demands the native identity event stream.
        const controls = operations as typeof operations & { refreshGoal(): Promise<unknown> };
        await expect(controls.refreshGoal()).resolves.toMatchObject({ status: 'applied' });
        expect(operations.readSessionIdentity()).toEqual({ sessionId: 'fresh-thread' });
        const runtimeEvents: unknown[] = [];
        const unsubscribe = operations.subscribeRuntimeEvents(event => { runtimeEvents.push(event); });
        expect(runtimeEvents).toContainEqual(expect.objectContaining({ kind: 'provider-session-id', providerSessionId: 'fresh-thread' }));
        unsubscribe();
        const goalContext = { ...base, session: { ...base.session, activity: 'active' as const },
          goalSource: reopenedState.publisher('goals') } satisfies AgentSessionGoalControlContext;
        if (!runtime.sessions.goals) throw new Error('Expected native Goal controls');
        await expect(runtime.sessions.goals.get(goalContext)).resolves.toMatchObject({ status: 'applied' });
        await client.flush();
        expect(initialClearSent).toBe(true);
        expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())).toEqual(retained);
        expect(originals()).toHaveLength(1);
        await expect(runtime.sessions.goals.set({ objective: 'Changed C', status: 'paused' }, goalContext))
          .resolves.toMatchObject({ status: 'applied' });
        await client.flush();
        expect(originals()).toHaveLength(2);
        emitNotification('thread/goal/cleared', { threadId: 'fresh-thread' });
        await vi.waitFor(() => expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())?.items).toEqual([]));
        await client.flush();
        expect(originals()).toHaveLength(3);
        await expect(runtime.sessions.goals.clear(goalContext)).resolves.toMatchObject({ status: 'applied' });
        await client.flush();
        expect(originals()).toHaveLength(3);
        for (const original of originals()) {
          const content = SessionStoredMessageContentSchema.parse(original.content);
          if (content.t !== 'plain') throw new Error('Expected keyless plain original');
          expect(TranscriptRawRecordV1Schema.parse(content.v)).toMatchObject({ role: 'agent',
            content: { type: 'event', data: { type: 'goal-changed' } } });
        }
        expect(JSON.stringify(originals())).not.toContain('Retained B');
        expect(JSON.stringify(originals())).not.toContain('Changed C');
      } finally { await operations.resetOrDisposeRuntime('runtime_recovery'); }
    }, { beforeThreadResumeResponse: ({ socket: nativeSocket, params }) => {
      initialClearSent = true;
      // CONT5: initial source absence precedes native Goal hydration. The
      // resumed thread's explicit Goal read still returns retained paused B.
      nativeSocket.send(JSON.stringify({ method: 'thread/goal/cleared', params: { threadId: params.threadId } }));
    } });
  });

  it.each([
    { layout: 0, refreshBeforeAck: false },
    { layout: 1, refreshBeforeAck: false },
    { layout: 1, refreshBeforeAck: true },
  ] as const)('does not announce an unchanged native Goal readback on reopen (layout $layout, concurrent refresh $refreshBeforeAck)', async ({ layout, refreshBeforeAck }) => {
    const session = createPlainSessionFixture({ id: `s-goal-reopen-${layout}-${refreshBeforeAck}` });
    const itemId = buildDeterministicSessionWorkStateItemId({ kind: 'goal',
      sourceFamily: 'plugin-agent/test-goal/runtime/goals', stableParts: ['objective'] });
    const retained = writeSessionWorkStateV1ToMetadata(session.metadata, {
      v: 1, backendId: 'custom-acp', agentId: 'custom-acp', updatedAt: 1, sourceTruncations: {},
      items: [{ id: itemId, kind: 'goal', origin: 'vendor', status: 'paused',
        title: 'Retained objective', agentId: 'custom-acp', tokenBudget: null, updatedAt: 1 }],
      primaryItemId: itemId,
    });
    const tuple = buildSessionMetadataEnvelopeFields({ credentials: { token: 'tok', encryption: null },
      accountEncryptionMode: 'plain', metadata: retained, agentState: session.agentState, storedContentMode: 'plain' });
    const row = createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: layout,
      metadata: layout === 0 ? JSON.stringify(retained) : tuple.sharedMetadata.ciphertext,
      metadataVersion: session.metadataVersion,
      ...(layout === 1 ? { ownerMetadata: tuple.ownerMetadata, agentState: tuple.agentState } : {}), share: null });
    serveSession(row);
    const socket = createSocket();
    // Reopening starts from launch metadata; the mutation owner reads the retained
    // Goal from Home. A readback must not compare it with the stale launch cache.
    const client = createClient({ ...session, metadataLayoutVersion: layout,
      ...(layout === 1 ? { ownerMetadata: tuple.ownerMetadataValue, ownerMetadataEnvelope: tuple.ownerMetadata } : {}) }, [socket]);
    if (refreshBeforeAck) {
      const commit = vi.mocked(axios.patch).getMockImplementation();
      if (!commit) throw new Error('Expected the Home tuple transport');
      vi.mocked(axios.patch).mockImplementationOnce(async (url, body, config) => {
        const acknowledged = await commit(url, body, config);
        const work = readSessionWorkStateV1FromMetadata(retained);
        if (!work) throw new Error('Expected the retained Goal');
        // Another writer advances Home while this unchanged-Goal timestamp write
        // awaits its ACK. The normal snapshot reader admits that newer tuple.
        const advanced = buildSessionMetadataEnvelopeFields({ credentials: { token: 'tok', encryption: null },
          accountEncryptionMode: 'plain', agentState: session.agentState, storedContentMode: 'plain',
          metadata: writeSessionWorkStateV1ToMetadata(retained, { ...work, updatedAt: 3,
            items: work.items.map(item => ({ ...item, title: 'Concurrent objective', updatedAt: 3 })) }) });
        row.metadata = advanced.sharedMetadata.ciphertext;
        row.ownerMetadata = advanced.ownerMetadata;
        row.metadataVersion += 1;
        await client.readOpenedSessionStateSnapshot({ agentStateVersion: 0, sharedMetadataVersion: 0 });
        expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())?.items[0]?.title).toBe('Concurrent objective');
        return acknowledged;
      });
    }
    const goals = createNativeAgentSessionWorkStateService({ session: client, pluginId: 'test-goal',
      contributionId: 'runtime', agentId: 'custom-acp', occurrenceId: 'reopened-native-runtime', isCurrent: () => true,
      declarations: [{ id: 'goals', itemKinds: ['goal'] }] }).publisher('goals');
    const readbackAt = refreshBeforeAck ? 2 : 1;
    await expect(goals.publish({ sourceSequence: 1, observedAtMs: readbackAt,
      items: [{ localId: 'objective', kind: 'goal', origin: 'vendor', status: 'paused',
        title: 'Retained objective', tokenBudget: null, updatedAtMs: readbackAt }], primaryLocalId: 'objective' }))
      .resolves.toMatchObject({ status: 'applied' });
    await client.flush();
    expect(socket.emitWithAck.mock.calls.filter(([event]) => event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1)).toEqual([]);
    expect(axios.patch).toHaveBeenCalledTimes(refreshBeforeAck ? 1 : 0);
  });

  it('does not announce a CAS attempt that becomes equal on retry or a refused Goal write', async () => {
    const session = createPlainSessionFixture({ id: 's-goal-cas' });
    const row = createSessionRecordFixture({ id: session.id, encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null });
    serveSession(row);
    vi.mocked(axios.patch).mockImplementationOnce(async (_url, body) => {
      const patch = SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner_migration') throw new Error('Expected initial owner migration');
      // A concurrent writer committed this exact Goal before our CAS. The real
      // tuple owner refreshes and runs the source merge again against that state.
      row.metadataLayoutVersion = 1;
      row.metadata = patch.target.sharedMetadata.ciphertext;
      row.ownerMetadata = patch.target.ownerMetadata;
      row.agentState = patch.target.agentState.ciphertext;
      row.metadataVersion += 1;
      row.agentStateVersion = (row.agentStateVersion ?? 0) + 1;
      return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
        sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
    });
    const socket = createSocket();
    const client = createClient(session, [socket]);
    const goals = createNativeAgentSessionWorkStateService({ session: client, pluginId: 'test-goal',
      contributionId: 'runtime', agentId: 'custom-acp', occurrenceId: 'goal-cas', isCurrent: () => true,
      declarations: [{ id: 'goals', itemKinds: ['goal'] }] }).publisher('goals');
    const goal = { sourceSequence: 1, observedAtMs: 1, items: [{ localId: 'objective', kind: 'goal' as const,
      origin: 'vendor' as const, status: 'active' as const, title: 'Already committed', updatedAtMs: 1 }] };
    await expect(goals.publish(goal)).resolves.toMatchObject({ status: 'applied' });
    expect(readSessionWorkStateV1FromMetadata(client.getMetadataSnapshot())?.items).toMatchObject([{ title: 'Already committed' }]);
    expect(socket.emitWithAck.mock.calls.filter(([event]) => event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1)).toEqual([]);
    vi.mocked(axios.patch).mockResolvedValueOnce({ status: 409, data: { code: 'session_publisher_authority_lost' } });
    await expect(goals.publish({ ...goal, sourceSequence: 2,
      items: [{ ...goal.items[0]!, title: 'Refused change' }] })).resolves.toMatchObject({ status: 'unavailable' });
    expect(socket.emitWithAck.mock.calls.filter(([event]) => event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1)).toEqual([]);
  });

  it.each(['plain', 'e2ee'] as const)('notifies the original semantic agent message after an append retry (%s)', async mode => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'message-owner' })).toString('base64url')}.signature`;
    const initialSession = mode === 'plain' ? createPlainSessionFixture({ id: 's-message-retry' })
      : createEncryptedOwnerSession('s-message-retry');
    const session = { ...initialSession, metadata: { ...initialSession.metadata,
      projectId: 'private-original-project', workspaceId: 'private-workspace' } };
    if (mode === 'plain') serveSession(createSessionRecordFixture({ id: session.id, encryptionMode: 'plain',
      metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, share: null }));
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const transcript = createSessionTranscriptHomeStub();
    const attempts: string[] = [];
    const committed: string[] = [];
    const originals: unknown[] = [];
    let failAppend = true;
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (event === SESSION_TRANSCRIPT_OBSERVATION_EVENT_V1) {
        const request = SessionTranscriptObservationInputSchema.parse(payload);
        attempts.push(request.localId);
        if (failAppend) { failAppend = false; throw new Error('One transient transcript append failure'); }
        committed.push(request.localId);
        originals.push(openSessionStoredContent({ content: SessionStoredMessageContentSchema.parse(request.content),
          ...(session.encryptionMode === 'plain' ? { mode: 'plain', ctx: null } : { mode: 'e2ee', ctx: {
            encryptionKey: session.encryptionKey, encryptionVariant: session.encryptionVariant,
          } }) }));
      }
      return activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(session, [socket], mode === 'e2ee'
      ? { metadataAuthority: { kind: 'owner', credentials: { ...ownerCredentials, token } } } : {}, undefined, token);
    await client.enqueueAgentMessageCommitted('codex', { type: 'message', message: 'Original agent answer' }, {
      localId: 'agent-original', provenance: { kind: 'non_dependent', source: 'background' },
      meta: { happierFollowRuleEvidenceV1: { v: 1, ownerAccountId: 'message-owner', event: { kind: 'goal_changed' },
        facts: { serverId: 'socket-readiness-home', kind: 'session' } } },
    });
    await vi.waitFor(() => expect(committed).toEqual(['agent-original']), { timeout: 10_000 });
    const occurrences = () => daemonPost.mock.calls.flatMap(call => {
      const body: unknown = call[1];
      if (!body || typeof body !== 'object' || !('followOccurrence' in body)) return [];
      return [SessionFollowRuleSourceOccurrenceV1Schema.parse(body.followOccurrence)];
    });
    await vi.waitFor(() => expect(occurrences()).toEqual([expect.objectContaining({
      sourceSessionId: session.id, sourceMessage: { localId: 'agent-original', seq: expect.any(Number) },
      evidence: expect.objectContaining({ ownerAccountId: 'message-owner', event: { kind: 'message' } }),
    })]));
    expect(attempts.length).toBeGreaterThan(1);
    expect(new Set(attempts)).toEqual(new Set(['agent-original']));
    expect(JSON.stringify(occurrences())).not.toContain('Original agent answer');
    for (const original of originals) {
      expect(JSON.stringify(original)).not.toContain('private-original-project');
      expect(JSON.stringify(original)).not.toContain('private-workspace');
      expect(original).toMatchObject({ meta: { happierFollowRuleEvidenceV1: { event: { kind: 'message' } } } });
    }
    daemonPost.mockImplementation(async (path, body) => {
      if (path === '/session-activity-changed' && body && typeof body === 'object' && 'followOccurrence' in body) {
        throw new Error('Source notification IPC unavailable');
      }
      return { ok: true };
    });
    await expect(client.enqueueAgentMessageCommitted('codex', { type: 'message', message: 'Another original' }, {
      localId: 'agent-ipc-failure', provenance: { kind: 'non_dependent', source: 'background' },
    })).resolves.toMatchObject({ persisted: true, delivered: true });
    expect(committed).toEqual(['agent-original', 'agent-ipc-failure']);
  });

  it.each(['metadata', 'AgentState'] as const)('upgrades ordinary layout-0 %s through the atomic HTTP owner tuple', async field => {
    const socket = createSocket();
    const session = createPlainSessionFixture({ id: `s-ready-${field}` });
    serveSession(createSessionRecordFixture({ id: session.id, metadataLayoutVersion: 0,
      metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
      agentState: null, agentStateVersion: session.agentStateVersion, encryptionMode: 'plain', share: null }));
    const client = createClient(session, [socket]);
    if (field === 'metadata') await client.updateMetadata(metadata => ({ ...metadata, summary: { text: 'startup ready', updatedAt: 1 } }));
    else await client.updateAgentState(state => ({ ...state, startupReady: true }));
    expect(axios.patch).toHaveBeenCalledWith(`${serverUrl}/v2/sessions/${session.id}`, expect.objectContaining({
      mode: 'owner_migration', expectedAccountEncryptionMode: 'plain', expectedAccountContentPublicKeyFingerprint: null,
      source: expect.objectContaining({ metadataLayoutVersion: 0, metadata: { version: 0, ciphertext: JSON.stringify(session.metadata) },
        agentState: { version: 0, ciphertext: null } }),
      target: expect.objectContaining({ metadataLayoutVersion: 1,
        ...(field === 'metadata' ? { sharedMetadata: { ciphertext: expect.stringContaining('startup ready') } }
          : { agentState: { ciphertext: expect.stringContaining('startupReady') } }),
      }),
    }), expect.anything());
    expect(socket.emitWithAck.mock.calls.map(([event]) => event)).not.toContain('update-metadata');
    expect(socket.emitWithAck.mock.calls.map(([event]) => event)).not.toContain('update-state');
  });


  it.each([false, true])('counts initial model authority, snapshot and commit round trips (combined: %s)', async combined => {
    const session = createEncryptedOwnerSession(`s-initial-model-publication-${combined}`);
    const socket = createSocket();
    const client = createClient(session, [socket], { durableMutationDeliveryInitiallyActive: false,
      metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await client.claimCurrentSessionPublisherAuthorityForStartup();
    await client.refreshSessionSnapshotFromServerRequired({ reason: 'startup-drain' });
    await client.activateDurableMutationDelivery();
    const authorityCount = () => socket.emitWithAck.mock.calls.filter(([event]) => event === 'session-publisher-authority-check').length;
    const httpCount = (path: string) => vi.mocked(axios.get).mock.calls.filter(([url]) => new URL(String(url)).pathname === path).length;
    const before = { authority: authorityCount(), snapshot: httpCount(`/v2/sessions/${session.id}`),
      currentness: httpCount('/v1/account/encryption/currentness'), commits: vi.mocked(axios.patch).mock.calls.length };
    const target = { selection: { agentTargetKey: 'agent:happier.agent.qwen/qwen', providerConnectionId: null, modelId: 'chosen' },
      policy: 'live', providerBinding: null, sessionBindingMetadata: null, runtimeBindingBasis: null,
      revalidateBeforeEffect: async () => true,
    } satisfies AuthorizedSessionModelTransitionTarget;
    if (!combined) {
      await client.updateMetadataAsCurrentPublisher(metadata => applyActiveModelFacts(metadata, target, 'qwen'));
    }
    const snapshot = { observedAt: 1, currentModelId: 'chosen', models: [{ id: 'chosen', name: 'Chosen model' }] };
    const publisher = createSessionRuntimeModelsPublisher({ agentId: 'qwen', agentTargetKey: target.selection.agentTargetKey,
      runnerProcessIdentity: { pid: 123, processStartTimeMs: 1_000 }, session: client,
      ...(combined ? { initialActiveTarget: target } : {}),
      // Native Agent observations are the external execution boundary; the real
      // Session writer, codecs, currentness and tuple transport remain beneath it.
      source: { read: () => snapshot, subscribe: listener => { listener(snapshot); return { dispose() {} }; } },
    });
    try {
      await publisher.flush();
      const expected = combined ? 1 : 2;
      expect({ authority: authorityCount() - before.authority,
        snapshot: httpCount(`/v2/sessions/${session.id}`) - before.snapshot,
        currentness: httpCount('/v1/account/encryption/currentness') - before.currentness,
        commits: vi.mocked(axios.patch).mock.calls.length - before.commits,
      }).toEqual({ authority: expected, snapshot: expected, currentness: expected, commits: expected });
      expect(client.getMetadataSnapshot()?.sessionModelsV1).toMatchObject({ currentModelId: 'chosen',
        availableModels: [{ id: 'chosen', name: 'Chosen model' }],
        activeSelectionV1: { source: 'runtime_readback', selection: target.selection },
      });
      expect(axios.patch).toHaveBeenLastCalledWith(`${serverUrl}/v2/sessions/${session.id}`, expect.objectContaining({
        publisherPrecondition: { machineId: 'machine-1', committedFenceMs: 1_000, publisherGeneration: '1' },
      }), expect.anything());
    } finally { publisher.dispose(); }
  });

  it.each([false, true])('drains a fenced publisher metadata write while connected (close prepared: %s)', async closing => {
    const session = createEncryptedOwnerSession(`s-publisher-close-${closing}`);
    const socket = createSocket();
    const client = createClient(session, [socket], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'claimed' });
    if (closing) client.prepareForClose();
    await expect(client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata,
      lifecycleState: 'stopped', lifecycleStateSince: 1 }))).resolves.toBeUndefined();
    expect(client.getMetadataSnapshot()).toMatchObject({ lifecycleState: 'stopped' });
    expect(axios.patch).toHaveBeenCalledWith(`${serverUrl}/v2/sessions/${session.id}`, expect.objectContaining({
      publisherPrecondition: { machineId: 'machine-1', committedFenceMs: 1_000, publisherGeneration: '1' },
    }), expect.anything());
    if (closing) {
      // Only metadata drains through close: startup/effect admission is retired.
      await expect(client.readCurrentPublisherPreconditionForStartup()).rejects.toMatchObject({ name: 'SocketAckAbortError' });
      await expect(client.checkCurrentPublisherAuthority()).rejects.toMatchObject({ name: 'SocketAckAbortError' });
    }
  });

  it('refuses a superseded publisher metadata write during connected close', async () => {
    const session = createEncryptedOwnerSession('s-publisher-close-superseded');
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1', committedFenceMs: 1_000 });
    let superseded = false;
    const socket = createApiSessionSocketStub({ emitWithAck: (event, payload) =>
      event === 'session-publisher-authority-check' && superseded
        ? { status: 'superseded', sessionId: session.id }
        : activity.answer(event, payload) ?? { result: 'success' } });
    const client = createClient(session, [socket], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await client.claimCurrentSessionPublisherAuthorityForStartup();
    superseded = true;
    client.prepareForClose();
    await expect(client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, lifecycleState: 'stopped' })))
      .rejects.toMatchObject({ code: 'session_publisher_authority_lost', retryable: false });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('cancels a close-time publisher metadata check when its socket disconnects', async () => {
    const session = createEncryptedOwnerSession('s-publisher-close-disconnect');
    const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1', committedFenceMs: 1_000 });
    const attempted = createDeferred();
    const reply = createDeferred();
    let closing = false;
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (closing && event === 'session-publisher-authority-check') {
        attempted.resolve();
        await reply.promise;
      }
      return activity.answer(event, payload) ?? { result: 'success' };
    } });
    const client = createClient(session, [socket], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await client.claimCurrentSessionPublisherAuthorityForStartup();
    closing = true;
    client.prepareForClose();
    const write = client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, lifecycleState: 'stopped' }));
    const cancelled = expect(write).rejects.toMatchObject({ name: 'SocketAckAbortError' });
    try {
      await attempted.promise;
      socket.connected = false;
      socket.trigger('disconnect', 'transport close');
      await cancelled;
      expect(axios.patch).not.toHaveBeenCalled();
    } finally {
      reply.resolve();
    }
  });

  it('checks exact publisher authority through the authenticated session socket', async () => {
    const socket = createSocket();
    const client = createClient(createPlainSessionFixture({ id: 's-publisher-check' }), [socket]);
    await expect(client.checkCurrentPublisherAuthority()).resolves.toBe(true);
    expect(socket.emitWithAck).toHaveBeenCalledWith('session-publisher-authority-check', { sessionId: 's-publisher-check' });
  });

  it('fails closed without emitting the authority-check event to the moving Remote v2 predecessor', async () => {
    const features = FeaturesResponseSchema.parse({ features: { sharing: { pendingQueueV2: { enabled: true } } },
      capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 } } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const socket = createSocket();
    const client = createClient(createPlainSessionFixture({ id: 's-remote-v2-publisher-check' }), [socket]);
    await expect(client.checkCurrentPublisherAuthority()).resolves.toBe(false);
    expect(socket.emitWithAck).not.toHaveBeenCalledWith('session-publisher-authority-check', expect.anything());
  });

  it('writes layout-1 metadata and AgentState through HTTP without waiting for or using the socket', async () => {
    const gate = createDeferred();
    const socket = createSocket();
    const session = createEncryptedOwnerSession('s-layout-one');
    const client = createClient(session, [socket], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } }, gate);
    await client.updateMetadata(metadata => ({ ...metadata, summary: { text: 'HTTP tuple', updatedAt: 2 } }));
    await client.updateAgentState(state => ({ ...state, startupReady: true }));
    expect(axios.patch).toHaveBeenCalledTimes(2);
    expect(axios.patch).toHaveBeenCalledWith(`${serverUrl}/v2/sessions/s-layout-one`, expect.objectContaining({ mode: 'owner', metadataLayoutVersion: 1 }), expect.anything());
    expect(client.getMetadataSnapshot()?.summary?.text).toBe('HTTP tuple');
    expect(socket.emitWithAck).not.toHaveBeenCalled();
  });

  it('binds a focused layout-1 owner patch to the exact current publisher fence', async () => {
    const socket = createSocket();
    const client = createClient(createEncryptedOwnerSession('s-layout-one-publisher'), [socket], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, summary: { text: 'publisher fenced', updatedAt: 2 } }));
    expect(axios.patch).toHaveBeenCalledWith(`${serverUrl}/v2/sessions/s-layout-one-publisher`, expect.objectContaining({ mode: 'owner',
      publisherPrecondition: { machineId: 'machine-1', committedFenceMs: 1_000, publisherGeneration: '1' } }), expect.anything());
  });

  it('rejects an encrypted owner tuple when currentness says the Account is plain', async () => {
    const session = createEncryptedOwnerSession('s-mismatched-account-mode', 'plain');
    const client = createClient(session, [createSocket()], { metadataAuthority: { kind: 'owner', credentials: ownerCredentials } });
    await expect(client.updateMetadata(metadata => ({ ...metadata, summary: { text: 'must not write', updatedAt: 2 } })))
      .rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required' });
    expect(axios.patch).not.toHaveBeenCalled();
  });

  it('delays runtime activity projection writes until the managed session socket is online', async () => {
    const gate = createDeferred();
    const socket = createSocket();
    const client = createClient(createPlainSessionFixture({ id: 's-ready-runtime-activity' }), [socket], {}, gate);
    const update = client.updateRuntimeActivityProjection({ runtimeActivityState: 'active', runtimeActivityActiveCount: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.emitWithAck).not.toHaveBeenCalled();
    gate.resolve();
    await update;
    expect(socket.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
      sessionId: 's-ready-runtime-activity', mutationId: 'runtime-activity-snapshot:s-ready-runtime-activity', snapshot: { state: 'active', activeCount: 1 },
    });
    expect(socket.emitWithAck.mock.calls.map(([event]) => event)).not.toContain('update-state');
    expect(socket.emitWithAck.mock.calls.map(([event]) => event)).not.toContain('update-metadata');
    expect(socket.emit).not.toHaveBeenCalledWith('session-alive', expect.objectContaining({ thinking: true }));
  });

  it('claims current publisher authority through the acknowledged Runtime Activity presence owner', async () => {
    const acknowledge = createDeferred();
    const home = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const socket = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === 'session-runtime-activity-snapshot') await acknowledge.promise;
      return home.answer(event, payload) ?? { result: 'success' };
    } });
    const session = createPlainSessionFixture({ id: 's-startup-publisher-claim' });
    const client = createClient(session, [socket], { durableMutationDeliveryInitiallyActive: false,
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId: session.id, agentRuntimeApplicability: 'supported' })] });
    let settled = false;
    const claim = client.claimCurrentSessionPublisherAuthorityForStartup().then(result => { settled = true; return result; });
    await vi.waitFor(() => expect(socket.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', expect.anything()));
    expect(settled).toBe(false);
    acknowledge.resolve();
    await expect(claim).resolves.toEqual({ status: 'claimed' });
    expect(socket.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
      sessionId: session.id, mutationId: `runtime-activity-snapshot:${session.id}`, snapshot: { state: 'unknown', activeCount: 0 },
    });
  });

  it.each(['released_server_v0_2_1', 'session_sync_v2_pending_input_v1'] as const)('keeps ordinary %s startup off the unsupported publisher-claim transport', async mode => {
    const features = FeaturesResponseSchema.parse({ features: { sharing: { pendingQueueV2: { enabled: true } } },
      capabilities: mode === 'released_server_v0_2_1' ? {} : { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 } } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200 })));
    const socket = createSocket();
    const client = createClient(createPlainSessionFixture({ id: 's-released-startup' }), [socket], { durableMutationDeliveryInitiallyActive: false });
    await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'unsupported', reason: 'publisher_authority_check_unsupported' });
    expect(socket.emitWithAck).not.toHaveBeenCalledWith('session-runtime-activity-snapshot', expect.anything());
  });

  it('retries the startup publisher claim on the exact newly negotiated socket when its first ACK is superseded', async () => {
    const firstAcknowledge = createDeferred();
    const home = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
    const socketA = createApiSessionSocketStub({ emitWithAck: async (event, payload) => {
      if (event === 'session-runtime-activity-snapshot') await firstAcknowledge.promise;
      return home.answer(event, payload) ?? { result: 'success' };
    } });
    const socketB = createSocket({ id: 'replacement-socket' });
    const session = createPlainSessionFixture({ id: 's-superseded-startup-publisher-claim' });
    const client = createClient(session, [socketA, socketB], { durableMutationDeliveryInitiallyActive: false,
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId: session.id, agentRuntimeApplicability: 'supported' })] });
    const claim = client.claimCurrentSessionPublisherAuthorityForStartup();
    await vi.waitFor(() => expect(socketA.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', expect.anything()));
    socketA.connected = false;
    socketA.trigger('disconnect', 'transport close');
    await vi.waitFor(() => expect(socketB.connected).toBe(true));
    firstAcknowledge.resolve();
    await expect(claim).resolves.toEqual({ status: 'claimed' });
    expect(socketB.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', {
      sessionId: session.id, mutationId: `runtime-activity-snapshot:${session.id}`, snapshot: { state: 'unknown', activeCount: 0 },
    });
  });
});
