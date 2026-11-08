import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
const qaAddress = (sessionId: string): SessionAddress => ({ serverId: getActiveServerSnapshot().serverId, sessionId });
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { VOICE_TOOL_RESULTS_JSON_PREFIX } from '@happier-dev/protocol/voice/toolResultsChannel';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ExecutionRunTurnStreamStartV2RequestSchema, ExecutionRunTurnStreamStartResponseSchema,
  ExecutionRunTurnStreamReadRequestSchema, ExecutionRunTurnStreamReadResponseSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { ExecutionRunTurnStreamCancelRequestSchema } from '@happier-dev/protocol/execution/runs/streaming';
import { attachVoiceAgentActionEffectId } from '@/voice/agent/types';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { createDeferred, createSessionFixture, waitForTestEvent } from '@/dev/testkit';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';
import { writeVoiceConversationScopeMetadata } from '@/voice/persistence/voiceConversationScopeMetadata';
import {
  registerLocalVoiceEngineHarnessHooks,
  warmLocalVoiceEngineHarnessGraph,
  localVoiceAgentRpc,
  sessionRpcWithServerScope,
  localVoiceHomeId,
  loadLocalVoiceEngineWithCompatState,
  getStorage,
  nativeMicRequestPermissionsAsync,
  setNextRecorderPrepareError,
  replaceLocalVoiceSessionHttpSeed,
  setLocalVoiceHttpResponder,
  readLocalVoiceHttpRequests,
  publishLocalVoiceAssistantMessage,
} from '@/voice/local/localVoiceEngine.testHarness';

import { resetVoiceQaStoreForTests, useVoiceQaStore } from './voiceQaStore';
const { sync } = await import('@/sync/syncEngine');
const { storage } = await import('@/sync/domains/state/storage');
const { createVoiceQaController } = await import('./voiceQaController');
const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
const { resolveSessionLiveConsumption } = await import('@/sync/runtime/sessionLiveConsumption');
afterAll(() => restoreModuleLoader());
const fixtureStorage = await getStorage();
const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
const { getVoiceSessionLifecycleController, setVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
const { voiceSessionManager } = await import('@/voice/session/voiceSession');
const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
const { readDaemonSpeechStreamQaRouteRequirement } = await import('@/voice/runtime/daemonInference/daemonSpeechStreamQaRouteRequirement');
const { createSessionMetadataHttpBoundary } = await import('@/dev/testkit/harness/sessionMetadataHttpBoundary');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { voiceAgentSessions } = await import('@/voice/agent/voiceAgentSessions');

function prepareLocalQaSession(options: Readonly<{ welcome?: boolean }> = {}) {
  const voice = storage.getState().settings.voice;
  const config = readLocalConversationVoiceSettings(voice);
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
    ...writeVoiceProviderSettingsConfig(voice, 'local_conversation', {
      ...config, conversationMode: 'agent',
      agent: { ...config.agent, agentSource: 'session', prewarmOnConnect: false },
    }),
    welcome: { ...voice.welcome, enabled: options.welcome === true, mode: 'immediate' },
  } }, storage.getState().settings));
  storage.getState().applySessions([createSessionFixture({ id: 'voice-hidden-s1', serverId: localVoiceHomeId,
    active: true, activeAt: Date.now(), pendingVersion: 0, pendingCount: 0, metadata: writeVoiceConversationScopeMetadata({
      path: '/project', host: 'test', machineId: 'machine-1', flavor: 'claude',
      ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
      permissionMode: config.agent.permissionIntent,
    }, { kind: 'session_root', sessionRootId: 's1' }),
  })]);
  replaceLocalVoiceSessionHttpSeed('voice-hidden-s1');
  return createVoiceQaController();
}

function selectLocalVoiceAgentFixture() {
  const settings = storage.getState().settings;
  const config = readLocalConversationVoiceSettings(settings.voice);
  const voice = writeVoiceProviderSettingsConfig({ ...settings.voice, providerId: 'local_conversation' },
    'local_conversation', { ...config, conversationMode: 'agent' });
  storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice }, settings));
}

function createAcceptedPendingPort() {
  return {
    enqueuePendingMessage: vi.fn(async ({ localId }: Readonly<{ localId: string }>) => ({
      localId,
      accepted: true,
      externalHandoffClaimed: true,
    } as const)),
    blockPendingDelivery: vi.fn(async () => {}),
    markPendingDeliveryHandled: vi.fn(async () => {}),
  };
}

describe('voiceQaController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetVoiceQaStoreForTests();
    fixtureStorage.__setState({
      settings: {
        ...(storage.getState() as any).settings,
        backendEnabledById: {
          claude: true,
          codex: true,
          opencode: true,
        },
      },
    } as any);
  });
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(async () => { await loadLocalVoiceEngineWithCompatState(); });

  it('rejects ambiguous explicit targets before changing QA state', async () => {
    fixtureStorage.__setState({ sessionListIndexByServerId: {
      a: [{ type: 'session', sessionId: 'collision', serverId: 'a', serverName: 'A' }],
      b: [{ type: 'session', sessionId: 'collision', serverId: 'b', serverName: 'B' }],
    } });
    const before = useVoiceQaStore.getState();
    await expect(createVoiceQaController().start({ sessionId: 'collision' }))
      .rejects.toThrow('voice_qa_target_session_unresolved');
    expect(useVoiceQaStore.getState()).toBe(before);
  });

  it('starts a real local voice-agent QA run through the bound hidden voice conversation when the binding is native-session backed', async () => {
    const controller = prepareLocalQaSession({ welcome: true });

    await controller.start({ sessionAddress: qaAddress('s1') });

    expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running',
      runtimeSessionId: 'voice-hidden-s1', targetSessionAddress: qaAddress('s1') });
    expect(localVoiceAgentRpc.readRetainedRun()).toMatchObject({ intent: 'voice_agent', status: 'running' });
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'assistant' && entry.text === 'Welcome!')).toBe(true);
    await controller.stop();
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
  });

  it('keeps the actual admitted native QA target and pending carrier after global focus drifts', async () => {
    const controller = prepareLocalQaSession({ welcome: true });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(qaAddress('s1'));
    await controller.start();
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(qaAddress('voice-hidden-s1'));
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(qaAddress('voice-hidden-s1'));
    await controller.sendPrompt({ prompt: 'Keep this admitted target' });
    expect(useVoiceQaStore.getState()).toMatchObject({
      targetSessionAddress: qaAddress('s1'), runtimeSessionId: 'voice-hidden-s1', status: 'running',
    });
    const promptPending = readLocalVoiceHttpRequests().filter(request => request.method === 'POST'
      && request.path.endsWith('/pending') && String(JSON.stringify(request.body)).includes('Keep this admitted target'));
    expect(promptPending).toHaveLength(1);
    expect(promptPending[0]?.path).toBe('/v2/sessions/voice-hidden-s1/pending');
    expect(localVoiceAgentRpc.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2
      && ExecutionRunTurnStreamStartV2RequestSchema.parse(request.input).userTranscript?.mode === 'suppress')).toBe(true);
    await controller.stop();
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
  });

  it('retains one actual pending user turn and suppresses tool follow-up transcript custody through the real QA owner', async () => {
    const controller = prepareLocalQaSession();
    const voice = storage.getState().settings.voice;
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
      ...voice, privacy: { ...voice.privacy, shareDeviceInventory: true },
    } }, storage.getState().settings));
    const dispatch = sessionRpcWithServerScope.getMockImplementation();
    if (!dispatch) throw new Error('Expected the genuine daemon transport responder');
    const streams = new Map<string, ReturnType<typeof ExecutionRunTurnStreamStartV2RequestSchema.parse>>();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        const input = ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload);
        const streamId = `qa-tool-stream-${streams.size + 1}`;
        streams.set(streamId, input);
        return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId });
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        const input = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
        const start = streams.get(input.streamId);
        if (!start) return await dispatch(request);
        const followUp = start.message.startsWith(VOICE_TOOL_RESULTS_JSON_PREFIX);
        const failedAction = start.message.includes('Answer the absent request') || start.message.includes('"answerUserActionRequest"');
        return ExecutionRunTurnStreamReadResponseSchema.parse({ streamId: input.streamId, nextCursor: 1, done: true,
          events: [{ t: 'done', assistantText: followUp
            ? (failedAction ? 'No pending question was available.' : 'Available backends: claude, codex, opencode.')
            : 'I checked the tools.',
            actions: followUp ? [] : failedAction ? [{ t: 'answerUserActionRequest', args: {
              answers: [{ question: 'What do you want me to work on in this repo?', values: ['Implement a feature'] }],
            } }] : [{ t: 'listAgentBackends', args: {} }] }],
        });
      }
      return await dispatch(request);
    });
    const { refreshAcpCatalog } = await import('@/sync/engine/settings/acpCatalogEngine');
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected the admitted Account settings scope');
    await refreshAcpCatalog(scope);
    await controller.sendPrompt({ sessionAddress: qaAddress('s1'), prompt: 'List the available backends.' });
    const starts = [...streams.values()];
    expect(starts).toHaveLength(2);
    const pending = readLocalVoiceHttpRequests().filter(request => request.method === 'POST'
      && request.path === '/v2/sessions/voice-hidden-s1/pending');
    expect(pending).toHaveLength(1);
    const body = pending[0]!.body;
    if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') {
      throw new Error('Expected the canonical pending local id');
    }
    expect(starts[0]?.userTranscript).toEqual({ mode: 'suppress', localId: body.localId });
    expect(starts[1]?.userTranscript).toEqual({ mode: 'suppress' });
    const followUp = starts[1]?.message;
    if (!followUp?.startsWith(VOICE_TOOL_RESULTS_JSON_PREFIX)) throw new Error('Expected actual tool-result custody');
    expect(JSON.parse(followUp.slice(VOICE_TOOL_RESULTS_JSON_PREFIX.length).trim().split('\n')[0]!)).toMatchObject({
      toolResults: [{ t: 'listAgentBackends', result: { ok: true, items: expect.arrayContaining([
        expect.objectContaining({ agentId: 'claude' }), expect.objectContaining({ agentId: 'codex' }),
        expect.objectContaining({ agentId: 'opencode' }),
      ]) } }],
    });
    expect(useVoiceQaStore.getState()).toMatchObject({ targetSessionAddress: qaAddress('s1'), runtimeSessionId: 'voice-hidden-s1' });
    expect(useVoiceQaStore.getState().entries.filter(entry => entry.kind === 'user')).toHaveLength(1);
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'assistant'
      && entry.text === 'Available backends: claude, codex, opencode.')).toBe(true);
    await controller.sendPrompt({ prompt: 'Answer the absent request' });
    const failedFollowUp = [...streams.values()][3];
    expect(failedFollowUp?.userTranscript).toEqual({ mode: 'suppress' });
    expect(failedFollowUp?.message).toContain('no_permission_request');
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text.includes('answerUserActionRequest') && entry.text.includes('no_permission_request'))).toBe(true);
    await controller.stop();
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
  });

  const exerciseDaemonQaFailure = async (typedRefusal: boolean) => {
    const dispatch = sessionRpcWithServerScope.getMockImplementation();
    if (!dispatch) throw new Error('Expected the genuine daemon transport responder');
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload);
        if (typedRefusal) throw Object.assign(new Error('RPC method not available'), {
          rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
        throw new Error('Daemon acknowledgement lost after dispatch');
      }
      return await dispatch(request);
    });
    setLocalVoiceHttpResponder(request => request.method === 'POST' && request.path.endsWith('/delivery/block')
      ? Response.json({}) : undefined);
    try {
        const refusal = typedRefusal;
        const controller = prepareLocalQaSession();
        const requestOffset = readLocalVoiceHttpRequests().length;
        const rpcOffset = sessionRpcWithServerScope.mock.calls.length;
        const prompt = refusal ? 'Probe typed provider refusal' : 'Probe lost daemon acknowledgement';
        const sending = controller.sendPrompt({ sessionAddress: qaAddress('s1'), prompt });
        if (refusal) await expect(sending).rejects.toThrow();
        else await expect(sending).rejects.toThrow('voice_turn_dispatch_ambiguous');
        const requests = readLocalVoiceHttpRequests().slice(requestOffset);
        const pending = requests.find(request => request.method === 'POST'
          && request.path === '/v2/sessions/voice-hidden-s1/pending');
        const body = pending?.body;
        if (!body || typeof body !== 'object' || !('localId' in body) || typeof body.localId !== 'string') {
          throw new Error('Expected canonical refused-turn pending custody');
        }
        const blocked = requests.filter(request => request.method === 'POST' && request.path.endsWith('/delivery/block'));
        expect(blocked).toHaveLength(1);
        expect(blocked[0]?.path).toContain(encodeURIComponent(body.localId));
        expect(blocked[0]?.body).toEqual({ reason: refusal
          ? 'provider_unavailable_before_acceptance' : 'delivery_outcome_uncertain' });
        const calls = sessionRpcWithServerScope.mock.calls.slice(rpcOffset).map(([request]) => request);
        const v2Calls = calls.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
        expect(v2Calls.length).toBeGreaterThan(0);
        expect(v2Calls.every(request => {
          const transcript = ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload).userTranscript;
          return transcript?.mode === 'suppress' && transcript.localId === body.localId;
        })).toBe(true);
        expect(calls.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START)).toBe(false);
        expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'error')).toBe(true);
        if (refusal) expect(useVoiceQaStore.getState().status).toBe('error');
        await controller.stop();
        expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
    } finally {
      setLocalVoiceHttpResponder(null);
    }
  };

  it('classifies a physical daemon method refusal as pre-effect QA custody rejection', async () => {
    await exerciseDaemonQaFailure(true);
  });

  it('retains a physical lost post-dispatch acknowledgement as ambiguous QA custody', async () => {
    await exerciseDaemonQaFailure(false);
  });

  it('delivers actual pending target context after native bootstrap and reports its permission mode', async () => {
    const target = storage.getState().sessions.s1;
    storage.getState().applySessions([createSessionFixture({ ...target,
      metadata: { ...target.metadata!, permissionMode: 'read-only' },
      agentState: { requests: { actual_permission: {
        kind: 'permission', tool: 'WriteFile', arguments: { filePath: '/project/qa.txt' }, createdAt: 1,
      } }, completedRequests: {} },
    })]);
    replaceLocalVoiceSessionHttpSeed('s1');
    const controller = prepareLocalQaSession();
    await controller.start({ sessionAddress: qaAddress('s1') });
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text.includes('Pending requests detected in target-session context: yes'))).toBe(true);
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text.includes('permission=1(actual_permission)'))).toBe(true);
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text.includes('permission mode is Read Only') && entry.text.includes('auto-deny'))).toBe(true);
    await controller.sendPrompt({ prompt: 'Describe the pending permission.' });
    const start = localVoiceAgentRpc.requests.find(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2);
    expect(start).toBeDefined();
    expect(ExecutionRunTurnStreamStartV2RequestSchema.parse(start!.input).message).toContain('## Pending Requests');
    await controller.stop();
  });

  it('refreshes actual target context from held Home HTTP without holding online QA startup', async () => {
    await expect(sync.ensureSessionVisibleForMessageRoute('s1', { serverId: localVoiceHomeId, forceRefresh: true }))
      .resolves.toMatchObject({ kind: 'available', sessionId: 's1' });
    const held = createDeferred<void>();
    const refreshEntered = createDeferred<void>();
    setLocalVoiceHttpResponder(async request => {
      if (request.method !== 'GET' || request.path !== '/v2/sessions/s1'
        || useVoiceQaStore.getState().status !== 'running') return undefined;
      // Startup may migrate the legacy owner tuple. Publish the new request
      // from that settled tuple instead of returning a stale pre-start version.
      const target = storage.getState().sessions.s1;
      const remoteTarget = createSessionFixture({ ...target, updatedAt: Date.now(),
        agentStateVersion: (target.agentStateVersion ?? 0) + 1, agentState: {
          requests: { actual_question: { kind: 'user_action', tool: 'AskUserQuestion',
            arguments: { questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] }, createdAt: 1,
          } }, completedRequests: {},
        },
      });
      const response = Response.json(createPlainSessionByIdResponseFixture(remoteTarget));
      refreshEntered.resolve();
      await held.promise;
      return response;
    });
    const controller = prepareLocalQaSession();
    let starting: ReturnType<typeof controller.start> | null = null;
    // Runner timeouts do not reject the suspended test body. Release its HTTP
    // request even then, so Sync's real hydration cannot poison later cases.
    onTestFinished(async () => {
      held.resolve();
      setLocalVoiceHttpResponder(null);
      await starting?.catch(() => {});
      await voiceAgentSessions.stop('voice-hidden-s1');
    });
    try {
      starting = controller.start({ sessionAddress: qaAddress('s1') });
      await starting;
      expect(useVoiceQaStore.getState().status).toBe('running');
      await refreshEntered.promise;
      expect(readLocalVoiceHttpRequests().some(request => {
        const input = SessionReadBatchRequestV1Schema.safeParse(request.body);
        return request.path === '/v2/sessions/read-batch' && input.success && input.data.sessionIds.includes('s1');
      })).toBe(true);
      expect(useVoiceQaStore.getState().entries.some(entry => entry.text.includes('user_action=1(actual_question)'))).toBe(false);
      held.resolve();
      await waitForTestEvent(useVoiceQaStore.subscribe, useVoiceQaStore.getState, state => state.entries.some(entry => entry.kind === 'system'
        && entry.text.includes('Pending requests detected in target-session context after refresh: yes')));
      expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
        && entry.text.includes('Pending requests detected in target-session context after refresh: yes'))).toBe(true);
      expect(useVoiceQaStore.getState().entries.some(entry => entry.text.includes('user_action=1(actual_question)'))).toBe(true);
      await controller.stop();
    } finally {
      held.resolve();
      setLocalVoiceHttpResponder(null);
    }
  });

  it('actual target guard reports a missing global voice-home target through the real binding owner', async () => {
    const controller = prepareLocalQaSession();
    fixtureStorage.__setState({ sessions: {}, machines: {}, sessionMessages: {},
      machineListByServerId: { [localVoiceHomeId]: [] }, sessionListRowsByServerId: {},
      sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
    });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
    await expect(controller.start()).rejects.toThrow('voice_conversation_spawn_target_missing');
    expect(useVoiceQaStore.getState().status).toBe('error');
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'error'
      && entry.text === 'No local session or machine is available to start global local voice. Open or create a local session first, or enter a Session ID override.')).toBe(true);
  });

  it('actual target guard reports an unavailable explicit local target through the real binding owner', async () => {
    const controller = prepareLocalQaSession();
    await expect(controller.start({ sessionAddress: qaAddress('s-explicit') }))
      .rejects.toMatchObject({ code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    expect(useVoiceQaStore.getState().status).toBe('error');
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text === 'Starting local_voice_agent QA session for the selected session')).toBe(true);
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'error'
      && entry.text === 'voice_agent_selection_unavailable')).toBe(true);
  });

  it('actual target guard does not expose a raw metadata id as the selected-session human label', async () => {
    const controller = prepareLocalQaSession();
    storage.getState().applySessions([createSessionFixture({ id: 's-explicit', serverId: localVoiceHomeId,
      active: false, pendingVersion: 0, pendingCount: 0, metadata: { path: '', host: '', name: 's-explicit' },
    })]);
    replaceLocalVoiceSessionHttpSeed('s-explicit');
    await expect(controller.start({ sessionAddress: qaAddress('s-explicit') }))
      .rejects.toMatchObject({ code: 'VOICE_AGENT_TARGET_SESSION_INACTIVE' });
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text === 'Starting local_voice_agent QA session for the selected session')).toBe(true);
  });

  it('actual target guard excludes a hidden carrier from the default QA target', async () => {
    const controller = prepareLocalQaSession();
    const hidden = storage.getState().sessions['voice-hidden-s1'];
    fixtureStorage.__setState({ sessions: { 'voice-hidden-s1': hidden }, machines: {}, sessionMessages: {},
      machineListByServerId: { [localVoiceHomeId]: [] }, sessionListRowsByServerId: {},
      sessionListIndexByServerId: {}, ordinarySessionListMembershipByServerId: {},
    });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(qaAddress('voice-hidden-s1'));
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(qaAddress('voice-hidden-s1'));
    await expect(controller.start()).rejects.toThrow('voice_conversation_spawn_target_missing');
    expect(useVoiceQaStore.getState().targetSessionAddress).toBeNull();
  });

  it('records whether pending requests were detected in the target-session context during local QA start', async () => {
    fixtureStorage.__setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          encryptionMode: 'plain',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: {
          messages: [
            {
              kind: 'tool-call',
              id: 'tool_perm_1',
              localId: null,
              createdAt: 1,
              children: [],
              tool: {
                id: 'tool_perm_1',
                name: 'write',
                description: 'Write a file',
                state: 'completed',
                input: { filePath: '/tmp/voice-permission-test.txt' },
                createdAt: 1,
                startedAt: 1,
                completedAt: 2,
                result: {},
                permission: {
                  id: 'perm_voice_1',
                  kind: 'permission',
                  status: 'pending',
                },
              },
            },
          ],
        },
      },
    } as any);

    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        conversationSessionAddress: qaAddress('voice-hidden-s1'),
        transcriptMode: 'native_session' as const,
        targetSessionAddress: qaAddress('s1'),
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionAddress: qaAddress('s1') });

    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending requests detected in target-session context') &&
          entry.text.includes('yes'),
      ),
    ).toBe(true);
  });


  it('forces a target-session refresh when the known session state is stale before building local QA context', async () => {
    const target = storage.getState().sessions.s1;
    const remoteTarget = createSessionFixture({ ...target, updatedAt: Date.now(),
      agentStateVersion: (target.agentStateVersion ?? 0) + 1,
      agentState: { requests: { req_question: {
        tool: 'AskUserQuestion', kind: 'user_action', createdAt: 1,
        arguments: { questions: [{ question: 'Continue with local voice QA?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
      } }, completedRequests: {} },
    });
    const remote = createSessionMetadataHttpBoundary(() => ({ s1: remoteTarget }));
    const targetRefresh = vi.fn<NonNullable<Parameters<typeof setLocalVoiceHttpResponder>[0]>>(request => request.method === 'GET' && request.path === '/v2/sessions/s1'
      && useVoiceQaStore.getState().status === 'running'
      ? remote.handle('https://local-voice-actions.example.test/v2/sessions/s1') ?? undefined : undefined);
    setLocalVoiceHttpResponder(targetRefresh);
    const controller = prepareLocalQaSession();
    onTestFinished(async () => {
      setLocalVoiceHttpResponder(null);
      await voiceAgentSessions.stop('voice-hidden-s1');
    });
    await controller.start({ sessionAddress: qaAddress('s1') });
    await waitForTestEvent(useVoiceQaStore.subscribe, useVoiceQaStore.getState, state => state.entries.some(entry => entry.kind === 'system'
      && entry.text.includes('Pending requests detected in target-session context after refresh: yes')));
    expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'system'
      && entry.text.includes('Pending requests detected in target-session context after refresh: yes'))).toBe(true);
    expect(targetRefresh).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/v2/sessions/s1' }));
    const breakdowns = useVoiceQaStore.getState().entries.filter(entry => entry.kind === 'system'
      && entry.text.includes('Pending request breakdown:')).map(entry => entry.text);
    expect(breakdowns, breakdowns.join('\n')).toContain(
      'Pending request breakdown: user_action=1(req_question) permission=0(none) transcript=1(req_question)',
    );
    await controller.sendPrompt({ prompt: 'Describe the refreshed pending question.' });
    const starts = localVoiceAgentRpc.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2)
      .map(request => ExecutionRunTurnStreamStartV2RequestSchema.parse(request.input));
    expect(starts.some(start => start.message.includes('## Pending Requests')
      && start.message.includes('Continue with local voice QA?'))).toBe(true);
    await controller.stop();
  });

  it('re-runs target-session message hydration after a forced visibility refresh when pending transcript requests only appear once the session becomes visible', async () => {
    fixtureStorage.__setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          encryptionMode: 'plain',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
      sessionMessages: {
        ...((storage.getState() as any).sessionMessages ?? {}),
        s1: { messages: [] },
      },
    } as any);

    let sessionVisible = false;
    const ensureSessionVisibleForMessageRoute = vi.fn(async (_address: SessionAddress, options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh === true) {
        sessionVisible = true;
      }
    });
    const refreshSessionMessages = vi.fn(async (_address: SessionAddress) => {
      if (!sessionVisible) return;
      storage.setState((state: any) => ({
        ...state,
        sessionMessages: {
          ...(state.sessionMessages ?? {}),
          s1: {
            messages: [
              {
                kind: 'tool-call',
                id: 'tool_question_1',
                localId: null,
                createdAt: 1,
                children: [],
                tool: {
                  id: 'tool_question_1',
                  name: 'AskUserQuestion',
                  description: 'Ask the user a question',
                  state: 'running',
                  input: {
                    questions: [
                      {
                        header: 'Permission',
                        question: 'May I create QA_APPROVE_FRESH.txt?',
                        options: [
                          { label: 'Yes, go ahead', description: 'Create the file' },
                          { label: `No, don't create it`, description: 'Skip file creation' },
                        ],
                        multiSelect: false,
                      },
                    ],
                  },
                  createdAt: 1,
                  startedAt: 1,
                  completedAt: null,
                  result: undefined,
                  permission: {
                    id: 'req_question_transcript',
                    kind: 'user_action',
                    status: 'pending',
                  },
                },
              },
            ],
          },
        },
      }));
    });

    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null }),
      ensureLocalBinding: vi.fn(async () => ({
        adapterId: 'local_conversation',
        controlSessionId: '__voice_agent__',
        conversationSessionId: 'voice-hidden-s1',
        conversationSessionAddress: qaAddress('voice-hidden-s1'),
        transcriptMode: 'native_session' as const,
        targetSessionAddress: qaAddress('s1'),
        updatedAt: 1,
      })),
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute,
      refreshSessionMessages,
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn: vi.fn(async () => ({ assistantText: 'ok', actions: [] })),
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start({ sessionAddress: qaAddress('s1') });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ensureSessionVisibleForMessageRoute).toHaveBeenCalledWith(qaAddress('s1'), { forceRefresh: true });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('Pending requests detected in target-session context') &&
          entry.text.includes('yes'),
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'system' &&
          entry.text.includes('transcript=1(req_question_transcript)'),
      ),
    ).toBe(true);
  });

  it('updates the QA target session after a global local-voice retarget even if the binding store lags behind', async () => {
    const getVoiceTargetState = vi
      .fn()
      .mockReturnValueOnce({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null })
      .mockReturnValue({ primaryActionSessionAddress: qaAddress('session_matrix'), lastFocusedSessionAddress: null });
    const binding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: qaAddress('voice-hidden-s1'),
      transcriptMode: 'native_session' as const,
      targetSessionAddress: null,
      updatedAt: 1,
    };
    const ensureLocalBinding = vi.fn(async () => binding);
    const getLocalBinding = vi.fn(() => binding);
    const sendLocalTurn = vi.fn(async () => ({ assistantText: 'Retargeted.', actions: [] }));

    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState,
      ensureLocalBinding,
      getLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.start();
    await controller.sendPrompt({
      prompt: 'Switch to Session QA Voice Matrix.',
      autoStart: false,
    });

    expect(useVoiceQaStore.getState().targetSessionAddress).toEqual(qaAddress('session_matrix'));
    expect(useVoiceQaStore.getState().runtimeSessionId).toBe('voice-hidden-s1');
  });



  it('tracks the rebound target session after a global local QA turn changes the binding', async () => {
    let currentBinding = {
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-home-hidden',
      conversationSessionAddress: qaAddress('voice-home-hidden'),
      transcriptMode: 'native_session' as const,
      targetSessionAddress: null as SessionAddress | null,
      updatedAt: 1,
    };
    const ensureLocalBinding = vi.fn(async () => currentBinding);
    const sendLocalTurn = vi.fn(async () => {
      currentBinding = {
        ...currentBinding,
        conversationSessionId: 'voice-hidden-s1',
        conversationSessionAddress: qaAddress('voice-hidden-s1'),
        targetSessionAddress: qaAddress('s1'),
        updatedAt: 2,
      };
      return { assistantText: 'Teleported.', actions: [] };
    });
    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: null, lastFocusedSessionAddress: null }),
      ensureLocalBinding,
      getLocalBinding: () => currentBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
      refreshSessionMessages: vi.fn(async () => {}),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn: vi.fn(async () => null),
      qaStore: useVoiceQaStore,
    });

    await controller.sendPrompt({ prompt: 'Teleport into the active coding session.' });

    expect(useVoiceQaStore.getState().targetSessionAddress).toEqual(qaAddress('s1'));
    expect(useVoiceQaStore.getState().runtimeSessionId).toBe('voice-hidden-s1');
    expect(sendLocalTurn).toHaveBeenCalledWith(
      'voice-home-hidden',
      'Teleport into the active coding session.',
      expect.objectContaining({
        userTranscript: { mode: 'suppress', localId: expect.any(String) },
        onUserTranscriptAccepted: expect.any(Function),
      }),
    );
  });



  it('recovers an actual hidden Home reply after a public higher-priority context update interrupts QA', async () => {
    const controller = prepareLocalQaSession();
    await controller.start({ sessionAddress: qaAddress('s1') });
    const dispatch = sessionRpcWithServerScope.getMockImplementation();
    if (!dispatch) throw new Error('Expected the genuine daemon transport responder');
    const prompt = 'Wait for the permission decision.';
    const reply = 'A read-only permission request is pending. Should I allow or deny it?';
    const readStarted = createDeferred<void>();
    const heldRead = createDeferred<ReturnType<typeof ExecutionRunTurnStreamReadResponseSchema.parse>>();
    let interruptedStreamId: string | null = null;
    let cancelled = false;
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        const input = ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload);
        const result = ExecutionRunTurnStreamStartResponseSchema.parse(await dispatch(request));
        if (input.message.includes(prompt)) {
          interruptedStreamId = 'qa-interrupted-outer-stream';
          return ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: interruptedStreamId });
        }
        return result;
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        const input = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
        if (input.streamId === interruptedStreamId) {
          readStarted.resolve();
          return await heldRead.promise;
        }
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL) {
        const input = ExecutionRunTurnStreamCancelRequestSchema.parse(request.payload);
        if (input.streamId === interruptedStreamId) {
          cancelled = true;
          await publishLocalVoiceAssistantMessage({ sessionId: 'voice-hidden-s1', id: 'qa-interrupted-followup', text: reply });
        }
      }
      return await dispatch(request);
    });
    try {
      const sending = controller.sendPrompt({ sessionAddress: qaAddress('s1'), prompt });
      await Promise.race([
        readStarted.promise,
        sending.then(() => { throw new Error('QA turn settled before its held daemon read'); }),
      ]);
      await voiceAgentSessions.sendInterruptingTextUpdate('voice-hidden-s1', 'The target now needs a permission decision.', {
        userTranscript: { mode: 'suppress' },
      });
      expect(cancelled).toBe(true);
      await expect(sending).resolves.toMatchObject({ assistantText: reply });
      expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'assistant' && entry.text === reply)).toBe(true);
    } finally {
      heldRead.resolve(ExecutionRunTurnStreamReadResponseSchema.parse({
        streamId: interruptedStreamId ?? 'qa-interrupted-outer-stream', events: [], nextCursor: 1, done: true,
      }));
      await controller.stop();
      expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
    }
  });

  it('surfaces the follow-up assistant reply when a local QA turn is interrupted by a higher-priority update', async () => {
    const sendLocalTurn = vi.fn(async () => {
      throw Object.assign(new Error('turn_aborted'), { name: 'AbortError' });
    });
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: qaAddress('voice-hidden-s1'),
      transcriptMode: 'native_session' as const,
      targetSessionAddress: qaAddress('s1'),
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'A read-only permission request is pending. Should I allow or deny it?');
    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionAddress: qaAddress('s1'),
        prompt: 'Ask the coding session to create a file and then ask me for permission.',
      }),
    ).resolves.toMatchObject({ assistantText: 'A read-only permission request is pending. Should I allow or deny it?' });

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 20_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'assistant' && entry.text === 'A read-only permission request is pending. Should I allow or deny it?',
      ),
    ).toBe(true);
  });

  it('reads the actual hidden Home transcript when the daemon completes without a direct QA reply', async () => {
    const controller = prepareLocalQaSession();
    await controller.start({ sessionAddress: qaAddress('s1') });
    const dispatch = sessionRpcWithServerScope.getMockImplementation();
    if (!dispatch) throw new Error('Expected the genuine daemon transport responder');
    const reply = 'The coding session finished and needs your approval.';
    const prompt = 'Wait for the coding session.';
    const streams = new Set<string>();
    const readStreamIds: string[] = [];
    const emptyDaemonReply = createDeferred<void>();
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2) {
        const input = ExecutionRunTurnStreamStartV2RequestSchema.parse(request.payload);
        const result = ExecutionRunTurnStreamStartResponseSchema.parse(await dispatch(request));
        // Initial context admission can also stream; publish the later reply
        // only for this outer prompt, after its real QA transcript baseline.
        if (input.message.includes(prompt)) {
          const outer = ExecutionRunTurnStreamStartResponseSchema.parse({ streamId: 'qa-later-outer-stream' });
          streams.add(outer.streamId);
          return outer;
        }
        return result;
      }
      if (request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_READ) {
        const input = ExecutionRunTurnStreamReadRequestSchema.parse(request.payload);
        readStreamIds.push(input.streamId);
        if (streams.has(input.streamId)) {
          emptyDaemonReply.resolve();
          return ExecutionRunTurnStreamReadResponseSchema.parse({
            streamId: input.streamId, nextCursor: 1, done: true,
            events: [{ t: 'done', assistantText: '', actions: [] }],
          });
        }
      }
      return await dispatch(request);
    });
    try {
      const sending = controller.sendPrompt({ sessionAddress: qaAddress('s1'), prompt });
      await Promise.race([
        emptyDaemonReply.promise,
        sending.then(() => { throw new Error('QA turn settled before its empty daemon reply'); }),
      ]);
      // The real turn transport must see its empty terminal before the Home
      // emits the later assistant record; otherwise its eager collector wins.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(readStoredSessionMessages(storage.getState(), 'voice-hidden-s1')
        .some(message => message.kind === 'agent-text' && message.text === reply)).toBe(false);
      await publishLocalVoiceAssistantMessage({ sessionId: 'voice-hidden-s1', id: 'qa-later-assistant', text: reply });
      await waitForTestEvent(storage.subscribe, () => readStoredSessionMessages(storage.getState(), 'voice-hidden-s1'),
        messages => messages.some(message => message.kind === 'agent-text' && message.text === reply));
      expect(readStoredSessionMessages(storage.getState(), 'voice-hidden-s1')
        .some(message => message.kind === 'agent-text' && message.text === reply), JSON.stringify({
          consumption: resolveSessionLiveConsumption('voice-hidden-s1', localVoiceHomeId),
          sessionSeq: storage.getState().sessions['voice-hidden-s1']?.seq,
          messagesLoaded: storage.getState().sessionMessages['voice-hidden-s1']?.isLoaded,
          qaStatus: useVoiceQaStore.getState().status,
        })).toBe(true);
      const result = await sending;
      expect(streams.size).toBeGreaterThan(0);
      expect(readStreamIds).toContain('qa-later-outer-stream');
      expect(useVoiceQaStore.getState().entries.some(entry => entry.kind === 'assistant' && entry.text === reply)).toBe(true);
      expect(result).toMatchObject({ assistantText: reply });
    } finally {
      await controller.stop();
      expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
      setLocalVoiceHttpResponder(null);
    }
  });

  it('surfaces the next hidden-session assistant reply when a local turn completes without a direct assistant response', async () => {
    const sendLocalTurn = vi.fn(async () => ({ assistantText: '', actions: [] }));
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: qaAddress('voice-hidden-s1'),
      transcriptMode: 'native_session' as const,
      targetSessionAddress: qaAddress('s1'),
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'The coding session finished and needs your approval.');
    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionAddress: qaAddress('s1'),
        prompt: 'Ask the coding session to create a file, then tell me when it needs approval.',
      }),
    ).resolves.toMatchObject({ assistantText: 'The coding session finished and needs your approval.' });

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 5_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) => entry.kind === 'assistant' && entry.text === 'The coding session finished and needs your approval.',
      ),
    ).toBe(true);
  });

  it('appends a later hidden-session assistant update after acknowledging sendSessionMessage', async () => {
    fixtureStorage.__setState({
      ...(storage.getState() as any),
      sessions: {
        ...((storage.getState() as any).sessions ?? {}),
        s1: {
          id: 's1',
          encryptionMode: 'plain',
          presence: 'online',
          active: true,
          updatedAt: 1,
          metadata: { path: '/tmp/project-a', host: 'test-machine', summary: { text: 'Target summary' } },
          agentState: null,
        },
      },
    } as any);
    vi.spyOn(sync, 'sendMessage').mockResolvedValue(undefined as any);
    // The singleton's encryption owner is replaced only for this case and restored after it.
    const previousEncryption = Reflect.get(sync, 'encryption');
    onTestFinished(() => { Reflect.set(sync, 'encryption', previousEncryption); });
    Reflect.set(sync, 'encryption', { getSessionEncryption: vi.fn(() => ({ encryptRawRecord: vi.fn() })) });

    // Action-bearing text is not a spoken answer; only the follow-up after the tool result is.
    const sendLocalTurn = vi.fn(async () => ({
      assistantText: '',
      actions: [
        {
          t: 'sendSessionMessage',
          args: {
            sessionId: 's1',
            message: 'Ask me which color I prefer using a structured question with Red and Blue options.',
          },
        },
      ],
    })).mockResolvedValueOnce({
      assistantText: '',
      actions: [
        {
          t: 'sendSessionMessage',
          args: {
            sessionId: 's1',
            message: 'Ask me which color I prefer using a structured question with Red and Blue options.',
          },
        },
      ],
    }).mockResolvedValueOnce({
      assistantText: 'The message was sent to the coding assistant. Waiting for it to respond with the structured question.',
      actions: [],
    });
    const ensureLocalBinding = vi.fn(async () => ({
      adapterId: 'local_conversation',
      controlSessionId: '__voice_agent__',
      conversationSessionId: 'voice-hidden-s1',
      conversationSessionAddress: qaAddress('voice-hidden-s1'),
      transcriptMode: 'native_session' as const,
      targetSessionAddress: qaAddress('s1'),
      updatedAt: 1,
    }));
    const waitForInterruptedLocalAssistantTurn = vi.fn(async () => 'The coding session is now asking which color you prefer: Red or Blue.');
    selectLocalVoiceAgentFixture();
    const controller = createVoiceQaController({
      getSettings: () => storage.getState().settings,
      getVoiceTargetState: () => ({ primaryActionSessionAddress: qaAddress('s1'), lastFocusedSessionAddress: null }),
      ensureLocalBinding,
      ensureLocalRunningAndMaybeWelcome: vi.fn(async () => null),
      pendingPort: createAcceptedPendingPort(),
      sendLocalTurn,
      stopLocal: vi.fn(async () => {}),
      appendLocalContextUpdate: vi.fn(),
      startRealtime: vi.fn(async () => {}),
      isRealtimeStarted: () => false,
      stopRealtime: vi.fn(async () => {}),
      getRealtimeSession: () => null,
      getRealtimeBinding: () => null,
      sendRealtimeTextTurn: vi.fn(async () => {}),
      waitForInterruptedLocalAssistantTurn,
      qaStore: useVoiceQaStore,
    });

    await expect(
      controller.sendPrompt({
        sessionAddress: qaAddress('s1'),
        prompt: 'Ask the coding session which color I prefer.',
      }),
    ).resolves.toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitForInterruptedLocalAssistantTurn).toHaveBeenCalledWith({
      conversationSessionId: 'voice-hidden-s1',
      timeoutMs: 15_000,
      baseline: {
        baselineCount: 0,
        baselineIds: expect.any(Set),
      },
    });
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'assistant'
          && entry.text === 'The message was sent to the coding assistant. Waiting for it to respond with the structured question.',
      ),
    ).toBe(true);
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'assistant'
          && entry.text === 'The coding session is now asking which color you prefer: Red or Blue.',
      ),
    ).toBe(true);
  });


  it('rejects local QA when the current provider is not the local voice agent mode', async () => {
    const voice = storage.getState().settings.voice;
    storage.getState().applySettingsLocal({ voice: {
      ...writeVoiceProviderSettingsConfig(voice, 'local_conversation', { conversationMode: 'direct_session' }),
      providerId: 'local_direct',
    } });
    const controller = createVoiceQaController();

    await expect(controller.start({ sessionAddress: qaAddress('s1') })).rejects.toThrow('voice_qa_local_agent_requires_local_conversation_agent_mode');
    expect(useVoiceQaStore.getState().status).toBe('error');
    expect(
      useVoiceQaStore.getState().entries.some(
        (entry) =>
          entry.kind === 'error'
          && entry.text === 'Local QA requires Local voice with conversation mode set to Agent.',
      ),
    ).toBe(true);
  });

  it('retains native QA Stop custody after the selected provider changes', async () => {
    const controller = prepareLocalQaSession({ welcome: true });
    await controller.start({ sessionAddress: qaAddress('s1') });
    expect(localVoiceAgentRpc.readRetainedRun()).toMatchObject({ intent: 'voice_agent', status: 'running' });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({
      voice: { ...storage.getState().settings.voice, providerId: 'happier.voice.elevenlabs/realtime-elevenlabs' },
    }, storage.getState().settings));
    await controller.stop({ sessionId: 's1' });
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
    expect(useVoiceQaStore.getState().status).toBe('idle');
  });

  describe('actual media lifecycle', () => {
    let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
    let previousLifecycle: ReturnType<typeof getVoiceSessionLifecycleController>;
    beforeEach(() => {
      const voice = storage.getState().settings.voice;
      const config = readLocalConversationVoiceSettings(voice);
      storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice:
        writeVoiceProviderSettingsConfig(voice, 'local_conversation', { ...config, conversationMode: 'direct_session' }),
      }, storage.getState().settings));
      previousLifecycle = getVoiceSessionLifecycleController();
      lifecycle = createVoiceSessionLifecycleController();
      lifecycle.setConfiguredProviderId('local_conversation');
      setVoiceSessionLifecycleController(lifecycle);
      vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    });
    afterEach(async () => {
      await lifecycle?.dispose();
      setVoiceSessionLifecycleController(previousLifecycle);
      vi.unstubAllEnvs();
    });

    it('delegates media-mode start and stop to the production voice session owner', async () => {
      const controller = createVoiceQaController();
      await controller.start({ sessionAddress: qaAddress('s1'), mode: 'media' });
      expect(voiceSessionManager.getSnapshot()).toMatchObject({
        adapterId: 'local_conversation', sessionId: 's1', status: 'connected', mode: 'listening',
      });
      expect(useVoiceQaStore.getState()).toMatchObject({ status: 'running', runtimeSessionId: 's1' });
      await controller.stop({ sessionId: 's1' });
      expect(voiceSessionManager.getSnapshot().status).toBe('disconnected');
      expect(useVoiceQaStore.getState().status).toBe('idle');
    });

    it('scopes a forced relay requirement to the active media QA attempt', async () => {
      const controller = createVoiceQaController();
      await controller.start({ sessionAddress: qaAddress('s1'), mode: 'media', transportRouteRequirement: 'server_relay' });
      expect(readDaemonSpeechStreamQaRouteRequirement('s1')).toBe('server_relay');
      expect(readDaemonSpeechStreamQaRouteRequirement('other-session')).toBeNull();
      await controller.stop();
      expect(voiceSessionManager.getSnapshot().status).toBe('disconnected');
      expect(readDaemonSpeechStreamQaRouteRequirement('s1')).toBeNull();
    });

    it('coalesces repeated media Start attempts without toggling the production lifecycle or leaking a forced route', async () => {
      const permission = createDeferred<{ granted: boolean; canAskAgain: boolean }>();
      const permissionRequested = createDeferred<void>();
      nativeMicRequestPermissionsAsync.mockImplementationOnce(() => {
        permissionRequested.resolve();
        return permission.promise;
      });
      const controller = createVoiceQaController();
      const params = { sessionAddress: qaAddress('s1'), mode: 'media' as const, transportRouteRequirement: 'server_relay' as const };
      const first = controller.start(params);
      const repeated = controller.start(params);
      await Promise.race([permissionRequested.promise, first]);
      expect(nativeMicRequestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(readDaemonSpeechStreamQaRouteRequirement('s1')).toBe('server_relay');
      permission.resolve({ granted: true, canAskAgain: true });
      await expect(Promise.all([first, repeated])).resolves.toEqual([
        { provider: 'local_voice_agent', sessionId: 's1' },
        { provider: 'local_voice_agent', sessionId: 's1' },
      ]);
      await expect(controller.start(params)).resolves.toEqual({ provider: 'local_voice_agent', sessionId: 's1' });
      expect(nativeMicRequestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(voiceSessionManager.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening' });
      await controller.stop();
      expect(voiceSessionManager.getSnapshot().status).toBe('disconnected');
      expect(readDaemonSpeechStreamQaRouteRequirement('s1')).toBeNull();
    });

    it('releases a forced relay requirement when media start fails', async () => {
      setNextRecorderPrepareError(new Error('recorder_start_failed'));
      const controller = createVoiceQaController();
      await expect(controller.start({
        sessionAddress: qaAddress('s1'), mode: 'media', transportRouteRequirement: 'server_relay',
      })).rejects.toThrow('recorder_start_failed');
      expect(useVoiceQaStore.getState().status).toBe('error');
      expect(readDaemonSpeechStreamQaRouteRequirement('s1')).toBeNull();
    });

    it('fails media mode when the production session owner does not establish an active session', async () => {
      nativeMicRequestPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });
      const controller = createVoiceQaController();
      const start = controller.start({ sessionAddress: qaAddress('s1'), mode: 'media' });
      await expect(start).rejects.toThrow('voice_qa_media_session_not_started:adapter=local_conversation');
      await expect(start).rejects.toThrow('mic_permission_denied');
      await expect(start).rejects.toHaveProperty('cause', getVoiceConversationRuntimeSnapshot().error);
      expect(nativeMicRequestPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(voiceSessionManager.getSnapshot().status).not.toBe('connected');
      expect(useVoiceQaStore.getState().status).toBe('error');
    });
  });
});
